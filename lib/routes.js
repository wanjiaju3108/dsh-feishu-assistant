/** dsh-feishu-assistant — 设置页的 HTTP 路由。 */

import {
  CONFIG_ROUTE,
  CREDENTIALS_ROUTE,
  PAIRING_ROUTE,
  PICK_ROUTE,
  SESSIONS_ROUTE,
  STATE_ROUTE,
} from './constants.js';
import { errorMessage, guard, readJsonBody, sendJson } from './http.js';

/**
 * 注册设置页的六个路由。
 *
 * 这里只管 HTTP 管道（方法、本机同源守卫、响应包装），业务动作由 actions 提供。
 *
 * @param deps.ctx Cordis 上下文
 * @param deps.webServer Web 服务器
 * @param deps.name 插件名，用于 effect 标签
 * @param deps.actions buildSnapshot / listSessions / saveConfig / saveCredentials / startPairing / pickFile
 */
export function registerSettingRoutes({ ctx, webServer, name, actions }) {
  const { buildSnapshot, listSessions, saveConfig, saveCredentials, startPairing, pickFile } = actions;

  /**
   * 注册一条路由。
   *
   * @param path 路径
   * @param label effect 标签后缀
   * @param handler 处理函数
   */
  function register(path, label, handler) {
    ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), `${name}: ${label} route`);
  }

  register(STATE_ROUTE, 'state', async (req, res) => {
    if (!guard(req, res, 'GET')) return;
    sendJson(res, 200, await buildSnapshot());
  });

  register(PAIRING_ROUTE, 'pairing', async (req, res) => {
    if (!guard(req, res, 'POST')) return;
    try {
      await startPairing();
      sendJson(res, 200, await buildSnapshot());
    } catch (error) {
      sendJson(res, 400, { error: errorMessage(error) });
    }
  });

  register(SESSIONS_ROUTE, 'sessions', async (req, res) => {
    if (!guard(req, res, 'GET')) return;
    try {
      sendJson(res, 200, { sessions: await listSessions() });
    } catch (error) {
      sendJson(res, 500, { error: errorMessage(error) });
    }
  });

  register(PICK_ROUTE, 'pick', async (req, res) => {
    if (!guard(req, res, 'POST')) return;
    try {
      // 取消不是错误：设置页只需要什么都不做，所以照 200 回，靠 cancelled 区分。
      sendJson(res, 200, await pickFile(await readJsonBody(req)));
    } catch (error) {
      sendJson(res, 400, { error: errorMessage(error) });
    }
  });

  register(CONFIG_ROUTE, 'config', async (req, res) => {
    if (!guard(req, res, 'PUT')) return;
    try {
      await saveConfig(await readJsonBody(req));
      sendJson(res, 200, await buildSnapshot());
    } catch (error) {
      sendJson(res, 400, { error: errorMessage(error) });
    }
  });

  register(CREDENTIALS_ROUTE, 'credentials', async (req, res) => {
    if (!guard(req, res, 'PUT')) return;
    try {
      await saveCredentials(await readJsonBody(req));
      sendJson(res, 200, await buildSnapshot());
    } catch (error) {
      // 常见失败：环境变量或项目 .env 遮蔽了该凭据，写入会被拒。
      sendJson(res, 400, { error: errorMessage(error) });
    }
  });
}
