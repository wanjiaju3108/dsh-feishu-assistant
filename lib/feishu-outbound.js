/**
 * dsh-feishu-assistant — 飞书出站消息。
 *
 * 五种发法：回复某条消息（卡片，带文本回退）、主动私聊文本、主动私聊卡片、回答卡片、合并转发。
 * 目标与载荷的拼装在 feishu-messages.js，凭据检查、重试在 feishu-request.js，
 * 长文本分片在 reply.js——这一层只把"发什么、发去哪"组合起来。
 *
 * 另外挂两个不属于「发什么、发去哪」、但也要跟飞书说话的能力：只读的姓名解析（feishu-user.js）
 * 和对已发出消息的加急（feishu-urgent.js）。它们和发送共用同一个带重试的请求器。
 */

import { createAnswerCardFlow } from './feishu-answer-card.js';
import { buildMarkdownCard } from './feishu-cards.js';
import { cardMessage, sendMessage, sendTarget, textMessage } from './feishu-messages.js';
import { createRequester } from './feishu-request.js';
import { createUrgentSender } from './feishu-urgent.js';
import { createUserNameResolver } from './feishu-user.js';
import { splitReplyText } from './reply.js';

/**
 * 建出站发送器。
 *
 * @param deps.logger 日志
 * @param deps.getClient 取当前 REST 客户端；凭据没配时返回 undefined
 * @returns 发送器句柄
 */
export function createOutbound({ logger, getClient }) {
  // sendRaw 是"返回响应体"的发送器；sendMessage 要靠响应体里的 message_id 判断是否发出，
  // 所以这里别自己折成布尔值再传进去。
  const { send: sendRaw } = createRequester({ logger, getClient });
  const answerCards = createAnswerCardFlow({ logger, send: sendRaw });
  const userNames = createUserNameResolver({ logger, send: sendRaw });
  const urgent = createUrgentSender({ logger, send: sendRaw });

  /**
   * 开一张回答卡片（初始正文通常是「正在处理」）。
   *
   * 飞书请求的回答回复到请求人那条消息上；非飞书发起的轮次（网页、别的自动化）没有可回复的
   * 消息，就换成主动私聊，目标用 openId。
   *
   * @param options.messageId 被回复的飞书消息 ID；与 openId 二选一
   * @param options.openId 主动私聊的接收人；与 messageId 二选一
   * @param options.initialText 初始正文
   * @returns 卡片句柄；开不出来时 undefined
   */
  function openAnswerCard(options) {
    return answerCards.open(options);
  }

  /**
   * 回复某条已有的飞书消息。
   *
   * 超过飞书单条消息上限的正文按换行切开，分多条发；否则整段会发不出去。
   *
   * @param messageId 被回复的飞书消息 ID
   * @param text 回复正文
   * @param collected 收集每段发出的消息 ID 的数组；不传就只关心成败
   * @returns 每一段都发出去时返回 true
   */
  async function replyTo(messageId, text, collected) {
    if (!messageId) {
      logger.warn('没有可回复的飞书消息，回复被丢弃');
      return false;
    }
    let sent = true;
    for (const chunk of splitReplyText(text)) {
      const chunkMessageId = await replyChunk(messageId, chunk);
      if (chunkMessageId) collected?.push(chunkMessageId);
      sent = sent && Boolean(chunkMessageId);
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
   * @returns 发出了返回消息 ID；两路都没发出去返回空串
   */
  async function replyChunk(messageId, chunk) {
    const target = sendTarget(messageId);
    const sentByCard = await sendMessage(sendRaw, target, cardMessage(buildMarkdownCard(chunk)), '回复飞书卡片');
    if (sentByCard) return sentByCard;
    logger.warn('回复飞书卡片失败，退回文本消息');
    return sendMessage(sendRaw, target, textMessage(chunk), '回复飞书');
  }

  /**
   * 主动私聊发一条文本。
   *
   * @param openId 接收人 OpenId
   * @param text 正文
   * @returns 发出去了返回 true
   */
  async function sendText(openId, text) {
    return Boolean(await sendMessage(sendRaw, sendTarget(undefined, openId), textMessage(text), '发送飞书消息'));
  }

  /**
   * 主动私聊发一张交互卡片。
   *
   * @param openId 接收人 OpenId
   * @param card 卡片对象
   * @returns 发出去了返回 true
   */
  function sendCard(openId, card) {
    return sendMessage(sendRaw, sendTarget(undefined, openId), cardMessage(card), '发送飞书卡片');
  }

  /**
   * 把同一个会话里的多条消息合并转发给某个人。
   *
   * 用来把非管理员这一轮的整轮对话（原话 + 回答卡片发出去的每一条）转给管理员：飞书要求这些
   * 消息来自同一个会话，转发出来的子消息保留原发送者，管理员点开就是完整的一问一答。
   *
   * 飞书单次最多 100 条（`message_id_list` 的长度上限）；超了接口会拒，这里不截断，失败只记日志。
   *
   * @param messageIds 待转发的消息 ID，必须来自同一个会话
   * @param openId 接收人 OpenId
   * @returns 转发成功时 true
   */
  async function forwardMerged(messageIds, openId) {
    if (!openId || !messageIds || messageIds.length === 0) return false;
    const forwarded = await sendRaw(
      (client) => client.im.message.mergeForward({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, message_id_list: messageIds },
      }),
      '合并转发整轮对话',
    );
    return forwarded !== undefined;
  }

  return {
    replyTo,
    sendText,
    sendCard,
    forwardMerged,
    sendUrgentApp: urgent.sendUrgentApp,
    sendUrgentSms: urgent.sendUrgentSms,
    openAnswerCard,
    resolveUserName: userNames.resolve,
  };
}
