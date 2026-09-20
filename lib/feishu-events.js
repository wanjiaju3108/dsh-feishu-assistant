/**
 * dsh-feishu-assistant — 飞书事件与消息取值的纯函数。
 */

import { ASK_USER_TOOL_NAME, TEXT_MESSAGE_TYPE } from './constants.js';

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

/**
 * 读 `ask_user_question` 工具调用里的问题。
 *
 * 工具调用会落进会话事件（`tool/call`），所以这条路不依赖任何"谁接住提问"的通道，
 * 纯粹旁观就能看到 agent 在反问、问的是什么。`arguments` 正常是模型给的 JSON 字符串，
 * 也可能已经是对象。
 *
 * @param data tool/call 事件的数据
 * @returns 问题正文（多条按行拼）；不是提问工具或读不出问题时 undefined
 */
export function readAskUserQuestion(data) {
  if (data?.name !== ASK_USER_TOOL_NAME) return undefined;
  const args = parseToolArguments(data.arguments);
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const lines = questions
    .map((question) => [question?.header, question?.question]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join('：'))
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * 解析工具调用的 arguments：正常是 JSON 字符串，已经是对象时原样返回。
 *
 * @param value 工具调用的 arguments
 * @returns 解析后的对象；解析不了时 undefined
 */
function parseToolArguments(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * 读 `turn/end` 里这一轮失败的原因。
 *
 * 事件体带着 reason：正常结束是 `{ kind: 'completed' }`（还有 blocked / max-tokens /
 * aborted），出错是 `{ kind: 'error', error: { message, code } }`。只有出错才有话说。
 *
 * @param data turn/end 事件的数据
 * @returns 失败原因的简短文本；没失败时 undefined
 */
export function readTurnFailure(data) {
  const reason = data?.reason;
  if (reason?.kind !== 'error') return undefined;
  const message = reason.error?.message;
  return typeof message === 'string' && message.length > 0 ? message : '未知错误';
}
