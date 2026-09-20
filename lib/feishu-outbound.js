/**
 * dsh-feishu-assistant — 飞书出站消息。
 *
 * 四种发法：回复某条消息（卡片，带文本回退）、主动私聊文本、主动私聊卡片。统一在这里
 * 做凭据检查、失败重试和长文本分片，调用方只管给出目标和内容。
 */

import { setTimeout as delay } from 'node:timers/promises';

import {
  INTERACTIVE_MESSAGE_TYPE,
  REPLY_MAX_ATTEMPTS,
  REPLY_RETRY_BASE_MS,
  TEXT_MESSAGE_TYPE,
} from './constants.js';
import { buildMarkdownCard } from './feishu-cards.js';
import { errorMessage } from './http.js';
import { splitReplyText } from './reply.js';

/**
 * 建出站发送器。
 *
 * @param deps.logger 日志
 * @param deps.getClient 取当前 REST 客户端；凭据没配时返回 undefined
 * @returns 发送器句柄
 */
export function createOutbound({ logger, getClient }) {
  /**
   * 发一次请求，失败按 REPLY_MAX_ATTEMPTS 重试，退避间隔随次数递增。
   *
   * @param request 拿到客户端后真正要发的请求
   * @param describe 日志里用来描述这次发送的短句
   * @returns 发出去了返回 true；放弃或没有客户端返回 false
   */
  async function send(request, describe) {
    const client = getClient();
    if (!client) {
      logger.warn('凭据未配置，消息无法回写飞书');
      return false;
    }
    for (let attempt = 1; attempt <= REPLY_MAX_ATTEMPTS; attempt += 1) {
      try {
        await request(client);
        return true;
      } catch (error) {
        if (attempt === REPLY_MAX_ATTEMPTS) {
          logger.warn(`${describe}失败，已放弃（尝试 ${attempt} 次）：${errorMessage(error)}`);
          return false;
        }
        logger.warn(`${describe}失败，准备第 ${attempt + 1} 次尝试：${errorMessage(error)}`);
        await delay(REPLY_RETRY_BASE_MS * attempt);
      }
    }
    return false;
  }

  /**
   * 回复某条已有的飞书消息。
   *
   * 超过飞书单条消息上限的正文按换行切开，分多条发；否则整段会发不出去。
   *
   * @param messageId 被回复的飞书消息 ID
   * @param text 回复正文
   * @returns 每一段都发出去时返回 true
   */
  async function replyTo(messageId, text) {
    if (!messageId) {
      logger.warn('没有可回复的飞书消息，回复被丢弃');
      return false;
    }
    let sent = true;
    for (const chunk of splitReplyText(text)) {
      const ok = await replyChunk(messageId, chunk);
      sent = sent && ok;
    }
    return sent;
  }

  /**
   * 回复其中一段正文：先按卡片发，卡片发不出去再退回文本。
   *
   * 飞书的文本消息不渲染 Markdown，所以正常走卡片；卡片这条路失败（例如正文超过卡片
   * 上限）时退回文本，至少让用户拿到内容。
   *
   * @param messageId 被回复的飞书消息 ID
   * @param chunk 这一段回复正文
   * @returns 发出去了返回 true
   */
  async function replyChunk(messageId, chunk) {
    const sentByCard = await send(
      (client) => client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: INTERACTIVE_MESSAGE_TYPE,
          content: JSON.stringify(buildMarkdownCard(chunk)),
        },
      }),
      '回复飞书卡片',
    );
    if (sentByCard) return true;
    logger.warn('回复飞书卡片失败，退回文本消息');
    return send(
      (client) => client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: TEXT_MESSAGE_TYPE, content: JSON.stringify({ text: chunk }) },
      }),
      '回复飞书',
    );
  }

  /**
   * 主动私聊发一条文本。
   *
   * @param openId 接收人 OpenId
   * @param text 正文
   * @returns 发出去了返回 true
   */
  async function sendText(openId, text) {
    if (!openId) return false;
    return send(
      (client) => client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: TEXT_MESSAGE_TYPE,
          content: JSON.stringify({ text }),
        },
      }),
      '发送飞书消息',
    );
  }

  /**
   * 主动私聊发一张交互卡片。
   *
   * @param openId 接收人 OpenId
   * @param card 卡片对象
   * @returns 发出去了返回 true
   */
  async function sendCard(openId, card) {
    if (!openId) return false;
    return send(
      (client) => client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: INTERACTIVE_MESSAGE_TYPE,
          content: JSON.stringify(card),
        },
      }),
      '发送飞书卡片',
    );
  }

  return { replyTo, sendText, sendCard };
}
