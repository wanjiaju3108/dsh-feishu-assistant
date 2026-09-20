/**
 * dsh-feishu-assistant — 非飞书发起的轮次的回答卡片。
 *
 * DSH 界面（或别的自动化）在同一条会话上问的话，飞书这边原本一片静默——用户根本不知道助理答了
 * 什么。这里按轮次开一张流式卡片**主动私聊**推给管理员：这种轮次没有可回复的飞书消息，只能私聊。
 *
 * 开卡要两次接口往返（建实体 + 发消息），而单条回答的 `turn/end` 紧跟着就来了，所以状态里记着
 * "正在开"和"已经收尾"两件事：开完回头看一眼，这一轮要是结束了就立刻关掉，否则卡片会一直挂着
 * 流式模式（聊天栏一直显示「生成中…」、也不能转发）。
 */

/**
 * 建外部回答的推送器。
 *
 * @param deps.openAnswerCard 开一张流式回答卡片（私聊目标）
 * @param deps.sendText 卡片开不出来时退回的普通私聊文本
 * @param deps.getManagerId 取管理员 open_id；取不到就不推
 * @returns 推送器：push 推一段正文，finish 收尾
 */
export function createExternalAnswer({ openAnswerCard, sendText, getManagerId }) {
  /**
   * 推一段正文给管理员。
   *
   * 第一段会把卡片开出来（正文直接作为初始正文），之后每段更新同一张卡。
   *
   * @param routing 路由状态
   * @param text 这一段回答正文
   */
  function push(routing, text) {
    const managerId = getManagerId();
    if (!managerId) return;
    routing.externalText = routing.externalText ? `${routing.externalText}\n\n${text}` : text;
    if (routing.externalCard) {
      void routing.externalCard.update(routing.externalText);
      return;
    }
    // 卡片还在开的路上：正文已经攒进 externalText，开完会把最新正文补上。
    if (routing.externalOpening) return;
    routing.externalClosed = false;
    routing.externalOpening = true;
    void open(routing, managerId);
  }

  /**
   * 开这一轮的卡片；开不出来就退回一条私聊文本。
   *
   * @param routing 路由状态
   * @param managerId 管理员 open_id
   * @returns Promise
   */
  async function open(routing, managerId) {
    const initialText = routing.externalText;
    const card = await openAnswerCard({ openId: managerId, initialText });
    routing.externalOpening = false;
    if (!card) {
      // 卡片开不出来时退回一条私聊文本；这一轮已经收尾、或正文已被清掉，就不用发了。
      if (!routing.externalClosed && routing.externalText) {
        await sendText(managerId, routing.externalText);
      }
      return;
    }
    if (routing.externalClosed) {
      void card.close();
      return;
    }
    routing.externalCard = card;
    // 开卡片这段时间里可能又攒了一段：把最新正文补一次，别只留第一段。
    if (routing.externalText !== initialText) void card.update(routing.externalText);
  }

  /**
   * 这一轮收尾：关掉卡片，等下一轮重新开。
   *
   * @param routing 路由状态
   */
  function finish(routing) {
    routing.externalClosed = true;
    const card = routing.externalCard;
    routing.externalCard = undefined;
    routing.externalText = '';
    // 没有卡片是常态（飞书请求那一轮走的是它自己的卡），这里不需要记日志。
    if (card) void card.close();
  }

  return { push, finish };
}
