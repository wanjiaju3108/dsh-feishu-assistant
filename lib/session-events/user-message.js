/**
 * dsh-feishu-assistant — `user/message`：认领轮次。
 *
 * 会话事件里的用户消息带 `id`。插件注入飞书消息时自己生成这个 id（见宿主半边的
 * `injectToSession`），所以这里对上了就说明**这一轮是飞书请求发起的**——之后的 assistant 产出
 * 要回到请求人那条消息上；对不上就是 DSH 界面或别的自动化发起的，走外部推送。
 *
 * 只认领一次：对上之后清掉 id，后面同一轮再出现用户消息（例如多条消息被并进同一轮）不会重复认领。
 */

/**
 * 建 `user/message` 处理器。
 *
 * @param deps.routing 路由状态
 * @returns 事件处理器
 */
export function createUserMessageHandler({ routing }) {
  return (event) => {
    if (!routing.injectedMessageId) return;
    if (event.data?.id !== routing.injectedMessageId) return;
    routing.injectedMessageId = '';
    routing.ownsCurrentTurn = true;
  };
}
