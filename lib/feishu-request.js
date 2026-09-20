/**
 * dsh-feishu-assistant — 出站请求的公共层。
 *
 * 凭据检查、失败重试、飞书错误码判断只写这一处：文本/卡片发送和流式回答卡片都走它。
 */

import { setTimeout as delay } from 'node:timers/promises';

import { REPLY_MAX_ATTEMPTS, REPLY_RETRY_BASE_MS } from './constants.js';
import { errorMessage } from './http.js';

/**
 * 判断飞书接口返回体是不是成功。
 *
 * SDK 在 HTTP 非 2xx 时会抛错，但也有返回 200 + 业务错误码的情况，两种都要认；
 * 没有 code 时看有没有 data（老接口的形态）。
 *
 * @param response 飞书接口返回体
 * @returns 成功时 true
 */
function isFeishuOk(response) {
  if (response === undefined || response === null) return false;
  if (response.code === undefined) return response.data !== undefined;
  return response.code === 0;
}

/**
 * 建请求发送器。
 *
 * @param deps.logger 日志
 * @param deps.getClient 取当前 REST 客户端；凭据没配时返回 undefined
 * @returns 发送器句柄
 */
export function createRequester({ logger, getClient }) {
  /**
   * 发一次请求：没客户端直接放弃；抛错按 REPLY_MAX_ATTEMPTS 重试，退避随次数递增。
   *
   * @param request 拿到客户端后真正要发的请求
   * @param describe 日志里用来描述这次发送的短句
   * @returns 成功时返回响应体；放弃、没凭据或业务失败时 undefined
   */
  async function send(request, describe) {
    const client = getClient();
    if (!client) {
      logger.warn('凭据未配置，消息无法回写飞书');
      return undefined;
    }
    for (let attempt = 1; attempt <= REPLY_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await request(client);
        if (isFeishuOk(response)) return response;
        // 业务层被拒（参数、权限、超限这类）：重试同一个请求没意义，如实报出来。
        logger.warn(`${describe}被拒：code=${response?.code} msg=${response?.msg}`);
        return undefined;
      } catch (error) {
        if (attempt === REPLY_MAX_ATTEMPTS) {
          logger.warn(`${describe}失败，已放弃（尝试 ${attempt} 次）：${errorMessage(error)}`);
          return undefined;
        }
        logger.warn(`${describe}失败，准备第 ${attempt + 1} 次尝试：${errorMessage(error)}`);
        await delay(REPLY_RETRY_BASE_MS * attempt);
      }
    }
    return undefined;
  }

  return { send };
}
