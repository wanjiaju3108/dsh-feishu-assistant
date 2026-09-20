/**
 * dsh-feishu-assistant — 飞书事件与消息取值的纯函数。
 */

import { TEXT_MESSAGE_TYPE } from './constants.js';

/**
 * 取消息事件里发送者的三个 ID。
 *
 * 飞书 v2 事件把 sender 和 message 放在同一层，所以这里收的是整个事件而不是 message。
 *
 * @param event 飞书消息事件
 * @returns 非空的 ID 列表；取不到时为空数组
 */
export function messageSenderIds(event) {
  const sender = event?.sender?.sender_id ?? {};
  return [sender.open_id, sender.user_id, sender.union_id].filter(Boolean);
}

/**
 * 取卡片回调里操作人的三个 ID。
 *
 * @param event 飞书卡片回调事件
 * @returns 非空的 ID 列表；取不到时为空数组
 */
export function cardOperatorIds(event) {
  const operator = event?.operator ?? {};
  return [operator.open_id, operator.user_id, operator.union_id].filter(Boolean);
}

/**
 * 取卡片按钮回传的参数。
 *
 * v2 卡片把 value 作为对象回传，个别场景会回传 JSON 字符串，两种都认。
 *
 * @param event 飞书卡片回调事件
 * @returns 解析出的参数对象；取不到时 undefined
 */
export function readCardActionValue(event) {
  const value = event?.action?.value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === 'object' && value !== null ? value : undefined;
}

/**
 * 取飞书文本消息的正文。
 *
 * @param message 飞书消息对象
 * @returns 去掉首尾空白的正文；不是文本消息或解析失败时返回空串
 */
export function readMessageText(message) {
  if (message?.message_type !== TEXT_MESSAGE_TYPE) return '';
  try {
    return (JSON.parse(message.content ?? '{}').text ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 取 assistant 消息里的文本块。
 *
 * @param eventData assistant/message 事件的数据
 * @returns 拼接后的正文；没有文本块时返回空串
 */
export function readAssistantText(eventData) {
  const content = eventData?.message?.content ?? eventData?.content ?? [];
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}
