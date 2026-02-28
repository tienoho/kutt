const { Router } = require("express");

const helpers = require("./../handlers/helpers.handler");
const locals = require("./../handlers/locals.handler");
const renders = require("./renders.routes");
const domains = require("./domain.routes");
const health = require("./health.routes");
const link = require("./link.routes");
const user = require("./user.routes");
const auth = require("./auth.routes");
const i18n = require("./../i18n");

/**
 * Middleware để đảm bảo locale được truyền đến tất cả các templates
 * Bổ sung thêm req.locale và res.locals.lng cho mọi request
 */
function localeMiddleware(req, res, next) {
  // Đã có i18n.i18nMiddleware chạy trước, nhưng đảm bảo an toàn
  if (!res.locals.lng) {
    res.locals.lng = i18n.getLocale(req);
  }
  // Thêm helper function t cho templates
  if (!res.locals.t) {
    res.locals.t = (key, options = {}) => i18n.t(key, options, res.locals.lng);
  }
  next();
}

const renderRouter = Router();
// Áp dụng locale middleware cho tất cả render routes
renderRouter.use(localeMiddleware);
renderRouter.use(renders);

const apiRouter = Router();
apiRouter.use(locals.noLayout);
// API routes cũng cần locale để trả về messages đúng ngôn ngữ
apiRouter.use(i18n.i18nMiddleware);
apiRouter.use("/domains", domains);
apiRouter.use("/health", health);
apiRouter.use("/links", link);
apiRouter.use("/users", user);
apiRouter.use("/auth", auth);

module.exports = {
  api: apiRouter,
  render: renderRouter,
  localeMiddleware, // Export để có thể dùng ở nơi khác nếu cần
};
