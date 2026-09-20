/**
 * dsh-feishu-assistant — 飞书消息的目标与载荷。
 *
 * 出站的几个模块都要把内容发到「回复某条消息」或者「主动私聊某个人」，载荷也有三种：文本、内联卡片
 * JSON、卡片实体引用（先建实体再发引用，才能流式更新）。这一层只管这两件事：
 *
 * - **目标归一**：`sendTarget(消息 id, open id)`，两个都没给就没有目标；
 * - **载荷拼装 + 发送**：`textMessage` / `cardMessage` / `cardRefMessage` 拼载荷，`sendMessage` 按目标
 *   选 `im.message.reply` 还是 `im.message.create`。
 *
 * 凭据检查、失败重试、飞书错误码判断不在这里，在 `feishu-request.js`。
 */

import { INTERACTIVE_MESSAGE_TYPE, TEXT_MESSAGE_TYPE } from './constants.js';

/**
 * 归一化发送目标：优先回复某条消息，其次是主动私聊某个人。
 *
 * @param messageId 被回复的飞书消息 ID
 * @param openId 主动私聊的接收人
 * @returns `{ messageId }` 或 `{ openId }`；两个都没给时 undefined
 */
export function sendTarget(messageId, openId) {
  if (messageId) return { messageId };
  if (openId) return { openId };
  return undefined;
}

/**
 * 文本载荷。
 *
 * @param text 正文
 * @returns 载荷
 */
export function textMessage(text) {
  return { msgType: TEXT_MESSAGE_TYPE, content: JSON.stringify({ text }) };
}

/**
 * 内联卡片 JSON 载荷（卡片对象直接放在消息里，不能流式更新）。
 *
 * @param card 卡片对象
 * @returns 载荷
 */
export function cardMessage(card) {
  return { msgType: INTERACTIVE_MESSAGE_TYPE, content: JSON.stringify(card) };
}

/**
 * 卡片实体引用载荷（卡片实体先建好，消息里只放引用；只有这样才能流式更新）。
 *
 * @param cardId 卡片实体 ID
 * @returns 载荷
 */
export function cardRefMessage(cardId) {
  return {
    msgType: INTERACTIVE_MESSAGE_TYPE,
    content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
  };
}

/**
 * 把一条消息发到目标：有消息 ID 就回复它，否则主动私聊那个人。
 *
 * @param send 出站请求发送器（feishu-request.js 的 send：**返回响应体**的那个，不是折成布尔值的包装）
 * @param target 发送目标（见 sendTarget）
 * @param message 载荷（textMessage / cardMessage / cardRefMessage）
 * @param describe 日志描述
 * @returns 发出了返回 true；没有目标或被拒返回 false
 */
export async function sendMessage(send, target, message, describe) {
  if (!target) return false;
  const data = { msg_type: message.msgType, content: message.content };
  const sent = target.messageId
    ? await send(
      (client) => client.im.message.reply({ path: { message_id: target.messageId }, data }),
      describe,
    )
    : await send(
      (client) => client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: target.openId, ...data },
      }),
      describe,
    );
  return Boolean(sent?.data?.message_id);
}
