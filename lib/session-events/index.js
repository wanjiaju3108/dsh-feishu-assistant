/**
 * dsh-feishu-assistant — 会话事件分派。
 *
 * 全插件只有这一个 `ctx.on('session/event')` 订阅点，按事件类型分给各自的文件——一种事件一个文件，
 * 改哪类事件的行为就只动那一个文件：
 *
 * | 事件 | 文件 | 干什么 |
 * |---|---|---|
 * | `user/message` | `user-message.js` | 认出自己注入的那条消息，认领这一轮 |
 * | `assistant/message` | `assistant-message.js` | 取正文上屏（回到飞书请求 / 私聊推给管理员） |
 * | `turn/end` | `turn-end.js` | 交还轮次归属、给外部轮次收尾 |
 * | `tool/call` | `tool-call.js` | agent 反问时提示一次 |
 *
 * 其余会话事件（`turn/start`、`step/start`、`step/end`、`tool/result`、`request/*`、`system/message`
 * …）插件用不到，直接忽略。想接新事件：加一个文件 + 下面 map 里加一行。
 *
 * 状态放在 `state.js`（`createRoutingState`）：事件之间共享的是"这一轮归谁、回答发去哪"，
 * 与其让它散在闭包里，不如摊开成显式字段。
 */

import { ASSISTANT_MESSAGE_EVENT_TYPE, TOOL_CALL_EVENT_TYPE, TURN_END_EVENT_TYPE, USER_MESSAGE_EVENT_TYPE } from '../constants.js';
import { createAssistantMessageHandler } from './assistant-message.js';
import { createExternalAnswer } from './external-answer.js';
import { createToolCallHandler } from './tool-call.js';
import { createTurnEndHandler } from './turn-end.js';
import { createUserMessageHandler } from './user-message.js';

/**
 * 建会话事件泵。
 *
 * @param deps.ctx Cordis 上下文
 * @param deps.logger 日志
 * @param deps.routing 路由状态
 * @param deps.outbound 出站发送器
 * @param deps.getSessionId 取目标会话 id
 * @param deps.getManagerId 取管理员 open_id
 * @returns 泵句柄：start() 开始订阅
 */
export function createSessionEventPump({ ctx, logger, routing, outbound, getSessionId, getManagerId }) {
  const externalAnswer = createExternalAnswer({
    logger,
    openAnswerCard: outbound.openAnswerCard,
    sendText: outbound.sendText,
    getManagerId,
  });

  /** 事件类型 → 处理器。 */
  const handlers = new Map([
    [USER_MESSAGE_EVENT_TYPE, createUserMessageHandler({ routing })],
    [ASSISTANT_MESSAGE_EVENT_TYPE, createAssistantMessageHandler({ logger, routing, outbound, externalAnswer })],
    [TURN_END_EVENT_TYPE, createTurnEndHandler({ routing, externalAnswer })],
    [TOOL_CALL_EVENT_TYPE, createToolCallHandler({ logger, routing, outbound })],
  ]);

  /** 开始订阅目标会话的事件。 */
  function start() {
    ctx.on('session/event', (session, event) => {
      const sessionId = getSessionId();
      // 没配目标会话、或事件来自别的会话：跟这个插件无关。
      if (!sessionId || session?.id !== sessionId) return;
      const handler = handlers.get(event?.type);
      if (handler) handler(event);
    });
  }

  return { start };
}
