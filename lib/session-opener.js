/**
 * dsh-feishu-assistant — 目标会话的打开与"这一轮跑完了"。
 *
 * 跟 `session-catalog.js`（设置页的会话下拉）不同：这里管的是**目标会话的生命周期**——确保它有活着的
 * agent（没有就主动 resume），以及等它把一轮 turn 跑完。
 *
 * 后一件事是飞书请求处理的关键一环：`turn/end` 一到，请求就可以收尾、队列放行下一条。
 */

import {
  TURN_END_EVENT_TYPE,
  TURN_IDLE_POLLS_BEFORE_FINISH,
  TURN_WATCH_INTERVAL_MS,
} from './constants.js';
import { errorMessage } from './http.js';

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
   * @returns 这一轮结束时 resolve；带上 turn/end 的事件数据，兜底放行时为 undefined
   */
  function nextTurnEnd(sessionId) {
    return new Promise((resolve) => {
      let settled = false;
      /** 连续几次看到 agent 不在跑；刚注入那一下可能还没转成 running，所以要多看几次。 */
      let idlePolls = 0;
      const finish = (turnEnd) => {
        if (settled) return;
        settled = true;
        dispose();
        clearInterval(watchdog);
        resolve(turnEnd);
      };
      const dispose = ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId) return;
        if (event?.type !== TURN_END_EVENT_TYPE) return;
        finish(event.data);
      });
      const watchdog = setInterval(() => {
        const agent = agents.get(sessionId);
        if (!agent) {
          finish(undefined);
          return;
        }
        if (agent.status === 'running') {
          idlePolls = 0;
          return;
        }
        idlePolls += 1;
        if (idlePolls >= TURN_IDLE_POLLS_BEFORE_FINISH) finish(undefined);
      }, TURN_WATCH_INTERVAL_MS);
    });
  }

  return { ensureAgent, waitForTurnEnd: nextTurnEnd };
}
