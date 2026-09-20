/** dsh-feishu-assistant — 会话目录与目标会话的打开。 */

import {
  TURN_END_EVENT_TYPE,
  TURN_IDLE_POLLS_BEFORE_FINISH,
  TURN_WATCH_INTERVAL_MS,
} from './constants.js';
import { errorMessage } from './http.js';

/**
 * 建会话目录：给设置页的会话下拉供数。
 *
 * @param deps.ctx Cordis 上下文
 * @param deps.agents agent 注册表
 * @param deps.logger 日志
 * @returns 目录句柄
 */
export function createSessionCatalog({ ctx, agents, logger }) {
  /**
   * 列出可选会话：本机所有带工作目录的会话，标注哪些当前已打开。
   *
   * 设置页用这份数据渲染下拉列表，省得手打会话 ID。会话查询服务按需取，
   * 没挂载这个服务的部署返回空列表，前端会回落到手动输入。
   *
   * @returns 按最近活动倒序的会话摘要
   */
  async function listSessions() {
    const engine = ctx.get('sessionQuery');
    if (!engine) return [];
    const records = await engine.listSessions();
    return records
      .filter((record) => record?.header?.cwd !== undefined)
      .map((record) => sessionSummary(record.header))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * 把一个会话 header 压成设置页需要的摘要。
   *
   * @param header 会话 header
   * @returns 会话摘要
   */
  function sessionSummary(header) {
    const agent = agents.get(header.id);
    const projection = readProjection(header);
    return {
      id: header.id,
      title: typeof projection?.title === 'string' ? projection.title : '',
      cwd: header.cwd ?? '',
      live: agent !== undefined,
      running: agent?.status === 'running',
      updatedAt: projection?.sessionListMetadata?.lastPromptAt ?? header.createdAt,
    };
  }

  /**
   * 读会话的标题投影。
   *
   * 投影缓存只是折叠日志的快捷方式、不是权威数据，所以读不到或版本不匹配都按「没有」处理。
   *
   * @param header 会话 header
   * @returns 投影值；读不到时 undefined
   */
  function readProjection(header) {
    const cache = ctx.get('sessionProjectionCache');
    if (!cache) return undefined;
    try {
      // isSeeded 是 fork 出来的会话，缓存前缀对不上，官方列表同样跳过。
      if (header.isSeeded) return undefined;
      // SessionLogOffset 在运行时是恒等函数，0 即日志起点。
      const block = cache.cachedSnapshot(header, 0) ?? cache.cachedPredecessorTitle(header, 0);
      return block?.values;
    } catch (error) {
      logger.warn(`读取会话 ${header.id} 的投影失败：${errorMessage(error)}`);
      return undefined;
    }
  }

  return { listSessions };
}

/**
 * 建目标会话的打开器。
 *
 * @param deps.ctx Cordis 上下文
 * @param deps.agents agent 注册表
 * @param deps.logger 日志
 * @param deps.getSessionId 取目标会话 ID
 * @param deps.setError 记录打开失败的原因，供设置页展示
 * @returns 打开器句柄
 */
export function createAgentOpener({ ctx, agents, logger, getSessionId, setError }) {
  /**
   * 确保目标会话有活着的 agent；没有就主动 resume 起来。
   *
   * resume 是复用 sessionController 的公开入口，它内部会带上会话原本的 agent preset
   * 和当前模型选择，和界面上点开这个会话是同一套动作。
   *
   * @returns 活着的 agent；拿不到时 undefined
   */
  async function ensureAgent() {
    const sessionId = getSessionId();
    if (!sessionId) {
      // 没配目标会话时，不该继续挂着上一条会话留下的失败。
      setError('');
      return undefined;
    }
    const live = agents.get(sessionId);
    if (live) {
      // 会话已经活着：之前那条失败（很可能是换目标会话之前留下的）到此为止。
      // 少了这一步，换了会话也不会清掉旧错误，设置页会一直指着已经不用的那条会话报错。
      setError('');
      return live;
    }
    const controller = ctx.get('sessionController');
    if (!controller) {
      fail('会话控制器不可用（本部署没有挂 dsh-api-session-controller）');
      return undefined;
    }
    try {
      // resolveAgent 就是「有就复用、没有就 resume」，并且会去重并发 resume。
      const found = await controller.resolveAgent(sessionId);
      if ('error' in found) {
        fail(`打开目标会话失败：${errorMessage(found.error)}`);
        return undefined;
      }
      setError('');
      logger.info(`已主动打开目标会话 ${sessionId}`);
      return found.agent;
    } catch (error) {
      fail(`打开目标会话失败：${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * 记下打开失败的原因，供设置页展示。
   *
   * @param message 失败原因
   */
  function fail(message) {
    setError(message);
    logger.warn(message);
  }

  /**
   * 等目标会话的下一轮 turn 跑完。
   *
   * turn/end 表示这一轮彻底结束（工具调用后的续跑都算在内），正好当「这条请求处理完」的信号。
   * 但它不一定送得到：事件是先写会话日志再派发的，日志写不进去（例如目录被删）这一条就发不出来。
   * 所以额外巡检两层兜底，避免队列被一条永远等不到 turn/end 的请求卡死：
   * - agent 从注册表里没了：会话被关掉了；
   * - agent 从 running 回到 idle：这一轮已经跑完，只是 turn/end 没送到。
   *
   * @param sessionId 目标会话 ID
   * @returns 这一轮结束时 resolve 的 Promise
   */
  function nextTurnEnd(sessionId) {
    return new Promise((resolve) => {
      let settled = false;
      /** 连续几次看到 agent 不在跑；刚注入那一下可能还没转成 running，所以要多看几次。 */
      let idlePolls = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        dispose();
        clearInterval(watchdog);
        resolve();
      };
      const dispose = ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId) return;
        if (event?.type !== TURN_END_EVENT_TYPE) return;
        finish();
      });
      const watchdog = setInterval(() => {
        const agent = agents.get(sessionId);
        if (!agent) {
          finish();
          return;
        }
        if (agent.status === 'running') {
          idlePolls = 0;
          return;
        }
        idlePolls += 1;
        if (idlePolls >= TURN_IDLE_POLLS_BEFORE_FINISH) finish();
      }, TURN_WATCH_INTERVAL_MS);
    });
  }

  /**
   * 处理一条飞书请求：注入目标会话，等这一轮 turn 跑完才返回。
   *
   * 队列保证一次只有一条在跑，所以回复目标可以安全地绑到当前这条消息上。
   *
   * @param messageId 飞书消息 ID，回答回复到它上面
   * @param text 消息正文
   */

  return { ensureAgent, waitForTurnEnd: nextTurnEnd };
}
