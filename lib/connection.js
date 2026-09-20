/** dsh-feishu-assistant — 飞书长连接。 */

import { Domain, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

import { CARD_ACTION_EVENT_TYPE, MESSAGE_RECEIVE_EVENT_TYPE } from './constants.js';
import { errorMessage } from './http.js';

/**
 * 建飞书长连接。
 *
 * 只管连接本身：事件分派器、WSClient、断线状态。收到的事件原样交给两个回调。
 *
 * @param deps.logger 日志
 * @param deps.state 运行期配置；connected / lastError 由这里维护
 * @param deps.source SDK 上报的来源标识
 * @param deps.getCredentials 取当前凭据
 * @param deps.onMessage 收到消息事件
 * @param deps.onCardAction 收到卡片回调
 * @returns 连接句柄
 */
export function createConnection({ logger, state, source, getCredentials, onMessage, onCardAction }) {
  /** 当前长连接客户端；未连接时为 undefined。 */
  let currentClient;

  /** 断开当前长连接。 */
  function stopConnection() {
    const client = currentClient;
    currentClient = undefined;
    state.connected = false;
    if (!client) return;
    try {
      client.close({ force: true });
    } catch (error) {
      logger.warn(`断开飞书长连接失败：${errorMessage(error)}`);
    }
  }

  /** 按当前凭据建立长连接；凭据不全时停用插件并说明原因。 */
  async function startConnection() {
    stopConnection();
    const { appId, appSecret } = getCredentials();
    if (!appId || !appSecret) {
      state.lastError = '未配置飞书凭据，请在本页填写 App ID 与 App Secret';
      logger.warn(state.lastError);
      return;
    }

    const eventDispatcher = new EventDispatcher({});
    eventDispatcher.register({
      [MESSAGE_RECEIVE_EVENT_TYPE]: async (data) => onMessage(data),
      [CARD_ACTION_EVENT_TYPE]: async (data) => onCardAction(data),
    });

    const client = new WSClient({
      appId,
      appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.info,
      source,
      autoReconnect: true,
      onReady: () => {
        state.connected = true;
        state.lastError = '';
        logger.info('飞书长连接已建立');
      },
      onReconnecting: () => {
        state.connected = false;
        logger.warn('飞书长连接断开，开始重连');
      },
      onReconnected: () => {
        state.connected = true;
        logger.info('飞书长连接已重连');
      },
      onError: (error) => {
        state.connected = false;
        state.lastError = `飞书长连接终止：${errorMessage(error)}`;
        logger.error(state.lastError);
      },
    });
    currentClient = client;
    try {
      await client.start({ eventDispatcher });
    } catch (error) {
      state.connected = false;
      state.lastError = `建立飞书长连接失败：${errorMessage(error)}`;
      logger.error(state.lastError);
    }
  }

  return { start: startConnection, stop: stopConnection };
}
