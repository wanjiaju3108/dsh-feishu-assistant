/**
 * dsh-feishu-assistant — `turn/end`：一轮结束。
 *
 * 两件事：
 * - 交还轮次归属：这一轮的影响到此为止，下一轮重新认领（否则 DSH 界面发起的下一轮会被误当成
 *   飞书请求的产出）；
 * - 给非飞书发起的轮次收尾：关掉那张私聊卡片，让它可以转发、聊天栏不再显示「生成中…」。
 *
 * 飞书请求自己的"这一轮跑完了"信号不在这里——那是请求的事，见 `session-catalog.js` 的
 * `waitForTurnEnd`（还带巡检兜底）。
 */

/**
 * 建 `turn/end` 处理器。
 *
 * @param deps.routing 路由状态
 * @param deps.externalAnswer 非飞书发起的轮次的推送器
 * @returns 事件处理器
 */
export function createTurnEndHandler({ routing, externalAnswer }) {
  return () => {
    routing.ownsCurrentTurn = false;
    externalAnswer.finish(routing);
  };
}
