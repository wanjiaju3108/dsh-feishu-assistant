/**
 * dsh-feishu-assistant — 目标会话只接受飞书输入。
 *
 * 这条会话一旦被指定成飞书助理会话，就**不再接受别处的用户输入**：DSH 界面里手打的、别的自动化
 * 塞进来的消息一律不处理。不然同一条会话会有两个驱动源——哪一轮的产出算谁的说不清。
 *
 * **只拦"人在说话"，不拦会话操作**：切模型/推理深度走的是 `model/selection` 会话事件，停止走
 * `agent.cancel`，斜杠命令走 `command/run`，都不经过 `agent/pre-step`，所以在界面里照样可用。
 * 换句话说，界面变成"只能看和调，不能往会话里说话"。
 *
 * 落点是 `agent/pre-step`：DSH 在每轮开始前把这一轮要处理的 `messages` 交给插件，允许拦下来。
 * 这里的分寸：
 *
 * - **只丢外来输入**，飞书那条留下来（两者被并进同一轮时，请求人照样能拿到回答）；
 * - 工具结果、技能注入、运行时上下文都不是"人在说话"，一律放过——只认 `source.kind === 'user'`；
 * - 丢完之后这一轮没有可处理的东西时返回 `reject`，让这一轮以 `blocked` 结束，而不是拿着空输入
 *   去调一次模型；
 * - 别的插件的 `pre-step` 逻辑照常执行（先 `next()` 再过滤），不做短路。
 *
 * 关掉这个行为：profile 补丁层里给插件写 `lockInput: false`。
 */

/**
 * 建输入锁。
 *
 * @param deps.ctx Cordis 上下文
 * @param deps.logger 日志
 * @param deps.routing 路由状态（用它认出自己注入的那条消息）
 * @param deps.getSessionId 取目标会话 ID
 * @returns 锁句柄：start() 开始拦截
 */
export function createInputLock({ ctx, logger, routing, getSessionId }) {
  /**
   * 这条消息是不是"别处的人在说话"。
   *
   * 只认 `role: 'user'` + `source.kind: 'user'`：工具结果是 `kind: 'tool'`，技能注入是
   * `kind: 'skill-invocation'`，运行时上下文是 system 消息，都不算。
   *
   * @param message 会话消息
   * @returns 是外来输入时 true
   */
  function isForeign(message) {
    if (message?.role !== 'user') return false;
    if (message.source?.kind !== 'user') return false;
    return message.id !== routing.injectedMessageId;
  }

  /**
   * 这条消息还值不值得为它跑一轮。
   *
   * @param message 会话消息
   * @returns 值得时 true
   */
  function isWorthRunning(message) {
    if (message?.role !== 'user') return false;
    if (message.source?.kind === 'tool') return true;
    return message.id !== undefined && message.id === routing.injectedMessageId;
  }

  /**
   * 每轮开始前的拦截。
   *
   * @param payload.agent 这一轮的 agent
   * @param payload.messages 这一轮要处理的消息
   * @param next 交给后续处理器
   * @returns 决策：原样放行、丢掉外来输入、或整轮拒绝
   */
  async function onPreStep({ agent, messages }, next) {
    if (agent?.id !== getSessionId()) return next();
    if (!messages.some(isForeign)) return next();
    // 先让别的插件把它们该加的（技能内容、hook 上下文）加上，再过滤。
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    // 按对象身份过滤：上下文消息没有 id，用 id 过滤会把它一起丢掉。
    const foreign = new Set(messages.filter(isForeign));
    const kept = decision.messages.filter((message) => !foreign.has(message));
    logger.warn(`忽略 ${foreign.size} 条不是飞书发来的输入（目标会话只接受飞书输入）`);
    return kept.some(isWorthRunning) ? { ...decision, messages: kept } : { kind: 'reject' };
  }

  /** 开始拦截。 */
  function start() {
    ctx.on('agent/pre-step', onPreStep);
  }

  return { start };
}
