/**
 * dsh-feishu-assistant — `tool/call`：agent 反问的旁观提示。
 *
 * `ask_user_question` 的问题只会出现在 DSH 界面上等人回答，飞书这边看不到、也答不了，这一轮会一直
 * 挂着。这里只做旁观提示：不去抢"回答者"通道（那会和界面那边打架），每条请求最多提示一次，并建议
 * 用人设让 agent 把问题写进回答正文。
 *
 * 只提示**自己发起的轮次**：DSH 界面发起的轮次里，人就在界面前等着，不需要再往飞书推一条。
 */

import { ASK_QUESTION_HINT } from '../constants.js';
import { readAskUserQuestion } from '../feishu-events.js';
import { errorMessage } from '../http.js';

/**
 * 建 `tool/call` 处理器。
 *
 * @param deps.logger 日志
 * @param deps.routing 路由状态
 * @param deps.outbound 出站发送器
 * @returns 事件处理器
 */
export function createToolCallHandler({ logger, routing, outbound }) {
  return (event) => {
    if (!routing.ownsCurrentTurn || routing.askHinted) return;
    const question = readAskUserQuestion(event.data);
    if (!question) return;
    routing.askHinted = true;
    logger.warn(`agent 在反问，问题只在 DSH 界面里等回答：${question}`);
    if (!routing.replyToMessageId) return;
    void outbound.replyTo(routing.replyToMessageId, ASK_QUESTION_HINT.replace('{question}', question))
      .catch((error) => {
        logger.warn(`发送反问提示失败：${errorMessage(error)}`);
      });
  };
}
