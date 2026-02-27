const { differenceInDays, addMinutes } = require("date-fns");
const { nanoid } = require("nanoid");
const passport = require("passport");
const { randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");

const { ROLES } = require("../consts");
const query = require("../queries");
const utils = require("../utils");
const redis = require("../redis");
const mail = require("../mail");
const env = require("../env");
const i18n = require("../i18n");

const CustomError = utils.CustomError;

function authenticate(type, error, isStrict, redirect) {
  return function auth(req, res, next) {
    if (req.user) return next();

    passport.authenticate(type, (err, user, info) => {
      if (
        (err || info instanceof Error) &&
        type === "oidc"
      ) {
        const lng = res.locals.lng || 'en';
        return next(new CustomError(i18n.t("errors.oidc_failed", {}, lng), 401));
      };

      if (err) return next(err);

      if (
        req.isHTML &&
        redirect &&
        ((!user && isStrict) ||
        (user && isStrict && !user.verified) ||
        (user && user.banned))
      ) {
        if (redirect === "page") {
          res.redirect("/logout");
          return;
        }
        if (redirect === "header") {
          res.setHeader("HX-Redirect", "/logout");
          res.send("NOT_AUTHENTICATED");
          return;
        }
      }
      
      if (!user && isStrict) {
        throw new CustomError(error, 401);
      }

      if (user && user.banned) {
        throw new CustomError(i18n.t("errors.banned"), 403);
      }

      if (user && isStrict && !user.verified) {
        throw new CustomError(i18n.t("errors.not_verified"), 400);
      }

      if (user) {
        res.locals.isAdmin = utils.isAdmin(user);
        req.user = {
          ...user,
          admin: utils.isAdmin(user)
        };

        // renew token if it's been at least one day since the token has been created
        // only do it for html page requests not api requests
        if (info?.exp && req.isHTML && redirect === "page") {
          const diff = Math.abs(differenceInDays(new Date(info.exp * 1000), new Date()));
          if (diff < 6) {
            const token = utils.signToken(user);
            utils.deleteCurrentToken(res);
            utils.setToken(res, token);
          }
        }
      }
      return next();
    })(req, res, next);
  }
}

const local = authenticate("local", i18n.t("errors.invalid_credentials"), true, null);
const jwt = authenticate("jwt", i18n.t("errors.unauthorized"), true, "header");
const jwtPage = authenticate("jwt", i18n.t("errors.unauthorized"), true, "page");
const jwtLoose = authenticate("jwt", i18n.t("errors.unauthorized"), false, "header");
const jwtLoosePage = authenticate("jwt", i18n.t("errors.unauthorized"), false, "page");
const apikey = authenticate("localapikey", i18n.t("errors.apikey_not_correct"), false, null);
const oidc = authenticate("oidc", i18n.t("errors.unauthorized"), true, "page");

function admin(req, res, next) {
  if (req.user.admin) return next();
  throw new CustomError(i18n.t("errors.unauthorized"), 401);
}

async function signup(req, res) {
  const salt = await bcrypt.genSalt(12);
  const password = await bcrypt.hash(req.body.password, salt);
  
  const user = await query.user.add(
    { email: req.body.email, password },
    req.user
  );
  
  await mail.verification(user);

  if (req.isHTML) {
    res.render("partials/auth/verify");
    return;
  }
  
  return res.status(201).send({ message: i18n.t("messages.verification_sent") });
}

async function createAdminUser(req, res) {
  const isThereAUser = await query.user.findAny();
  if (isThereAUser) {
    throw new CustomError(i18n.t("errors.admin_exists"), 400);
  }
  
  const salt = await bcrypt.genSalt(12);
  const password = await bcrypt.hash(req.body.password, salt);

  const user = await query.user.add({
    email: req.body.email, 
    password, 
    role: ROLES.ADMIN, 
    verified: true 
  });

  const token = utils.signToken(user);

  if (req.isHTML) {
    utils.setToken(res, token);
    res.render("partials/auth/welcome");
    return;
  }
  
  return res.status(201).send({ token });
}

function login(req, res) {
  const token = utils.signToken(req.user);

  if (req.isHTML) {
    utils.setToken(res, token);
    res.render("partials/auth/welcome");
    return;
  }
  
  return res.status(200).send({ token });
}

async function verify(req, res, next) {
  if (!req.params.verificationToken) return next();

  const user = await query.user.update(
    {
      verification_token: req.params.verificationToken,
      verification_expires: [">", utils.dateToUTC(new Date())]
    },
    {
      verified: true,
      verification_token: null,
      verification_expires: null
    }
  );
  
  if (user) {
    const token = utils.signToken(user);
    utils.deleteCurrentToken(res);
    utils.setToken(res, token);
    res.locals.token_verified = true;
    req.cookies.token = token;
  }
  
  return next();
}

async function changePassword(req, res) {
  const isMatch = await bcrypt.compare(req.body.currentpassword, req.user.password);
  if (!isMatch) {
    const message = i18n.t("errors.current_password_wrong");
    res.locals.errors = { currentpassword: message };
    throw new CustomError(message, 401);
  }

  const salt = await bcrypt.genSalt(12);
  const newpassword = await bcrypt.hash(req.body.newpassword, salt);
  
  const user = await query.user.update({ id: req.user.id }, { password: newpassword });
  
  if (!user) {
    throw new CustomError(i18n.t("errors.password_change_failed"));
  }

  if (req.isHTML) {
    res.setHeader("HX-Trigger-After-Swap", "resetChangePasswordForm");
    res.render("partials/settings/change_password", {
      success: i18n.t("messages.password_changed")
    });
    return;
  }
  
  return res
    .status(200)
    .send({ message: i18n.t("messages.password_changed") });
}

async function generateApiKey(req, res) {
  const apikey = nanoid(40);
  
  if (env.REDIS_ENABLED) {
    redis.remove.user(req.user);
  }
  
  const user = await query.user.update({ id: req.user.id }, { apikey });
  
  if (!user) {
    throw new CustomError(i18n.t("errors.apikey_failed"));
  }

  if (req.isHTML) {
    res.render("partials/settings/apikey", {
      user: { apikey },
    });
    return;
  }
  
  return res.status(201).send({ apikey });
}

async function resetPassword(req, res) {
  const user = await query.user.update(
    { email: req.body.email },
    {
      reset_password_token: randomUUID(),
      reset_password_expires: utils.dateToUTC(addMinutes(new Date(), 30))
    }
  );

  if (user) {
    mail.resetPasswordToken(user).catch(error => {
      console.error("Send reset-password token email error:\n", error);
    });
  }

  if (req.isHTML) {
    res.render("partials/reset_password/request_form", {
      message: i18n.t("messages.reset_sent")
    });
    return;
  }
  
  return res.status(200).send({
    message: i18n.t("messages.reset_sent")
  });
}

async function newPassword(req, res) {
  const { new_password, reset_password_token } = req.body;

  const salt = await bcrypt.genSalt(12);
  const password = await bcrypt.hash(req.body.new_password, salt);
  
  const user = await query.user.update(
    {
      reset_password_token,
      reset_password_expires: [">", utils.dateToUTC(new Date())]
    },
    { 
      reset_password_expires: null, 
      reset_password_token: null,
      password,
    }
  );

  if (!user) {
    throw new CustomError(i18n.t("errors.password_set_failed"));
  }

  res.render("partials/reset_password/new_password_success");
}

async function changeEmailRequest(req, res) {
  const { email, password } = req.body;
  
  const isMatch = await bcrypt.compare(password, req.user.password);
  
  if (!isMatch) {
    const error = i18n.t("errors.current_password_wrong");
    res.locals.errors = { password: error };
    throw new CustomError(error, 401);
  }
  
  const user = await query.user.find({ email });
  
  if (user) {
    const error = i18n.t("errors.email_already_used");
    res.locals.errors = { email: error };
    throw new CustomError(error, 400);
  }
  
  const updatedUser = await query.user.update(
    { id: req.user.id },
    {
      change_email_address: email,
      change_email_token: randomUUID(),
      change_email_expires: utils.dateToUTC(addMinutes(new Date(), 30))
    }
  );
  
  if (updatedUser) {
    await mail.changeEmail({ ...updatedUser, email });
  }

  const message = i18n.t("messages.change_email_sent")
  
  if (req.isHTML) {
    res.setHeader("HX-Trigger-After-Swap", "resetChangeEmailForm");
    res.render("partials/settings/change_email", {
      success: message
    });
    return;
  }
  
  return res.status(200).send({ message });
}

async function changeEmail(req, res, next) {
  const changeEmailToken = req.params.changeEmailToken;
  
  if (changeEmailToken) {
    const foundUser = await query.user.find({
      change_email_token: changeEmailToken,
      change_email_expires: [">", utils.dateToUTC(new Date())]
    });
  
    if (!foundUser) return next();
  
    const user = await query.user.update(
      { id: foundUser.id },
      {
        change_email_token: null,
        change_email_expires: null,
        change_email_address: null,
        email: foundUser.change_email_address
      }
    );
  
    if (user) {
      const token = utils.signToken(user);
      utils.deleteCurrentToken(res);
      utils.setToken(res, token);
      res.locals.token_verified = true;
      req.cookies.token = token;
    }
  }
  return next();
}

function featureAccess(features, redirect) {
  return function(req, res, next) {
    for (let i = 0; i < features.length; ++i) {
      if (!features[i]) {
        if (redirect) {
          return res.redirect("/");
        } else {
          throw new CustomError(i18n.t("errors.request_not_allowed"), 400);
        }
      } 
    }
    next();
  }
}

function featureAccessPage(features) {
  return featureAccess(features, true);
}

module.exports = {
  admin,
  apikey,
  changeEmail,
  changeEmailRequest,
  changePassword,
  createAdminUser,
  featureAccess,
  featureAccessPage,
  generateApiKey,
  jwt,
  jwtLoose,
  jwtLoosePage,
  jwtPage,
  local,
  login,
  newPassword,
  oidc,
  resetPassword,
  signup,
  verify,
}
