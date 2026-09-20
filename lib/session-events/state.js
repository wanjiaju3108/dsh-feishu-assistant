/**
 * dsh-feishu-assistant — 会话事件路由的共享状态。
 *
 * 会话是共享的：飞书消息、DSH 界面、别的自动化都可能在同一条会话上说话。这里的字段回答
 * "这一轮归谁、回答发去哪"，把原先散在宿主半边里的十来个模块级变量收成一份显式状态，
 * 每个字段自己说明用途：
 *
 * - 认领：`injectedMessageId` 是本次请求注入的那条消息 id，`user/message` 里对上它就认领这一轮；
 * - 请求回答：`replyToMessageId` / `answerCard` / `answerText` 由飞书请求使用；
 * - 外部回答：`external*` 是非飞书发起的轮次（DSH 界面、别的自动化）推给管理员私聊的那张卡片。
 */

/**
 * 建一份路由状态。
 *
 * @returns 状态对象；字段含义见文件头与各字段注释
 */
export function createRoutingState() {
  return {
    /** 本次请求注入的消息 id；在 `user/message` 里对上之后清空。 */
    injectedMessageId: '',
    /** 当前这一轮里有没有插件自己注入的消息；false 说明这一轮不是飞书发起的。 */
    ownsCurrentTurn: false,
    /** 本次飞书请求要回复的消息 id。 */
    replyToMessageId: '',
    /** 本次飞书请求的回答卡片句柄；开不出来时为 undefined（退回"每段一张普通卡片"）。 */
    answerCard: undefined,
    /** 本次飞书请求的累计正文；流式卡片每次都要传全量，所以自己攒着。 */
    answerText: '',
    /** 本次飞书请求有没有产出过回答；一个字都没有时要补一条失败文案。 */
    replied: false,
    /** 本次飞书请求有没有因为 agent 反问而提示过；同一轮只打扰一次。 */
    askHinted: false,
    /** 非飞书发起的轮次：私聊卡片句柄。 */
    externalCard: undefined,
    /** 非飞书发起的轮次：累计正文。 */
    externalText: '',
    /** 非飞书发起的轮次：卡片正在开；开卡期间又来一段就不再开第二张。 */
    externalOpening: false,
    /** 非飞书发起的轮次：已经收尾；开卡慢一步回来时据此立刻把它关掉。 */
    externalClosed: false,
  };
}

/**
 * 一条飞书请求开始：重置请求级状态。
 *
 * @param routing 路由状态
 * @param options.messageId 要回复的飞书消息 id
 * @param options.card 审批流程已经开好的回答卡片；没有时 undefined
 */
export function beginRequest(routing, { messageId, card }) {
  routing.replyToMessageId = messageId;
  routing.answerCard = card;
  routing.answerText = '';
  routing.replied = false;
  routing.askHinted = false;
}

/**
 * 一条飞书请求结束：把请求级状态全部交还。
 *
 * 不清的话，紧接着由 DSH 界面发起的轮次会被误当成这条请求的产出，回答打在已经关掉的卡片上——
 * 用户那边就是一片静默。
 *
 * @param routing 路由状态
 */
export function endRequest(routing) {
  routing.replyToMessageId = '';
  routing.answerCard = undefined;
  routing.answerText = '';
  routing.injectedMessageId = '';
  routing.ownsCurrentTurn = false;
}
