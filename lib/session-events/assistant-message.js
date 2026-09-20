/**
 * dsh-feishu-assistant — `assistant/message`：回答上屏。
 *
 * 这是插件**唯一的输出触发点**，粒度是 step：DSH 一个 step 结束提交一条，所以一轮里模型每说完
 * 一段（去调工具之前）就会有一条。取 `message.content` 里 `type: 'text'` 的块拼起来，没有文本块
 * （纯 reasoning + 工具调用）就什么都不发。
 *
 * 两条路：
 * - 自己发起的轮次（`ownsCurrentTurn`）→ 回到请求人那条消息上：有回答卡片就按累计正文更新，
 *   没有（卡片开不出来）就退回"每段一张普通卡片"；
 * - 别的来源发起的轮次 → 交给外部推送，主动私聊给管理员。
 */

import { readAssistantText } from '../feishu-events.js';
import { errorMessage } from '../http.js';

/**
 * 建 `assistant/message` 处理器。
 *
 * @param deps.logger 日志
 * @param deps.routing 路由状态
 * @param deps.outbound 出站发送器（退回普通卡片 + 私聊文本）
 * @param deps.externalAnswer 非飞书发起的轮次的推送器
 * @returns 事件处理器
 */
export function createAssistantMessageHandler({ logger, routing, outbound, externalAnswer }) {
  return (event) => {
    const text = readAssistantText(event.data);
    if (!text) return;
    if (!routing.ownsCurrentTurn) {
      externalAnswer.push(routing, text);
      return;
    }
    // 有产出就记下来：这一轮结束时不用再补失败文案。
    routing.replied = true;
    if (routing.answerCard) {
      // 流式卡片要的是累计正文：把这一段接在后面，第一段正好整体替换掉「正在处理」。
      routing.answerText = routing.answerText ? `${routing.answerText}\n\n${text}` : text;
      void routing.answerCard.update(routing.answerText);
      return;
    }
    void outbound.replyTo(routing.replyToMessageId, text).catch((error) => {
      logger.warn(`回复飞书失败：${errorMessage(error)}`);
    });
  };
}
