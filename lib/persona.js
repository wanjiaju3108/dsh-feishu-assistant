/**
 * dsh-feishu-assistant — 人设注入。
 *
 * 「飞书AI助理模式」的人设由用户提供，内容存在插件自己的配置里（settings 命名空间，
 * 落 $DSH_HOME/settings.yaml）：设置页里直接写，或者从本地文件导入一份。插件把这段
 * 内容作为目标会话的个人设定（persona prefix）在运行时注入，盖掉该会话原本的个人设定。
 * 内容为空时这个模式就是关的，插件不会假装它开着，也不会自己造一份人设出来。
 */

import { errorMessage } from './http.js';

/**
 * 段名与 DSH 的 PERSONA_PREFIX_SECTION 保持一致。
 *
 * 只有同名才能盖掉会话原本的个人设定；DSH 里同名注册在会话自己的 scope 上会遮蔽
 * 上层（agent preset / 部署默认）注册的那一份。
 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';

/** 同层已被注册时的兜底段名：盖不掉也要让人设进得去。 */
const PERSONA_FALLBACK_SECTION = 'feishu-assistant:persona-prefix';

/** DSH 中央编排里 persona prefix 的排序位名。 */
const PERSONA_PREFIX_ORDER = 'DEPLOYMENT_PERSONA_PREFIX';

/** 人设内容字节上限。 */
export const MAX_PERSONA_BYTES = 64 * 1024;

/**
 * 建人设注入器：把一段人设文本挂到目标会话上。
 *
 * 每个会话记住自己的注册句柄，内容变了就换一份；内容清空时撤掉，别让上一次的人设
 * 继续生效。会话的 agent 被关掉时，注册跟着 agent 的 scope 一起回收，这里只会剩下
 * 一个已经失效的句柄，重复撤销是安全的。
 *
 * @param deps.logger 日志
 * @returns 注入器句柄
 */
export function createPersonaInjector({ logger }) {
  /** 会话 ID → 已挂上的人设。 */
  const attached = new Map();

  /**
   * 把一份人设文本挂到目标会话的 agent 上。
   *
   * @param agent 目标会话的 agent
   * @param sessionId 目标会话 ID
   * @param text 人设文本
   * @returns 挂上或本来就是这一份时为 true
   */
  function sync(agent, sessionId, text) {
    if (!agent || !sessionId || !text) {
      release(sessionId);
      return false;
    }
    const prompt = agent.ctx?.systemPrompt;
    if (!prompt) {
      logger.warn('目标会话没有 systemPrompt 服务，人设没法注入');
      return false;
    }
    const previous = attached.get(sessionId);
    if (previous && previous.agent === agent && previous.text === text) return true;
    release(sessionId);
    const dispose = register(prompt, text);
    if (!dispose) return false;
    attached.set(sessionId, { agent, text, dispose });
    return true;
  }

  /**
   * 注册人设段。
   *
   * 先按同名段注册（盖掉会话原本的个人设定）；同层已经注册过同名段时退回一个
   * 独立段名，宁可两份都在，也不能因为撞名让人设整个丢出去。
   *
   * @param prompt 目标会话的 systemPrompt 服务
   * @param text 人设文本
   * @returns 撤销句柄；两条路都失败时 undefined
   */
  function register(prompt, text) {
    const order = sectionOrder(prompt);
    for (const section of [PERSONA_PREFIX_SECTION, PERSONA_FALLBACK_SECTION]) {
      try {
        return prompt.section({ name: section, order, text });
      } catch (error) {
        logger.warn(`注册人设段 ${section} 失败：${errorMessage(error)}`);
      }
    }
    return undefined;
  }

  /**
   * 取 persona prefix 的排序位；取不到就放在最前面。
   *
   * @param prompt 目标会话的 systemPrompt 服务
   * @returns 段排序值
   */
  function sectionOrder(prompt) {
    try {
      const order = prompt.getSectionOrder?.(PERSONA_PREFIX_ORDER);
      if (Number.isFinite(order)) return order;
    } catch (error) {
      logger.warn(`取 persona 排序位失败：${errorMessage(error)}`);
    }
    return 0;
  }

  /**
   * 撤掉某个会话的人设。
   *
   * @param sessionId 目标会话 ID
   */
  function release(sessionId) {
    const entry = attached.get(sessionId);
    if (!entry) return;
    attached.delete(sessionId);
    try {
      entry.dispose?.();
    } catch (error) {
      logger.warn(`撤掉人设失败：${errorMessage(error)}`);
    }
  }

  /**
   * 只留下一个会话的人设，其余撤掉。
   *
   * 目标会话换掉时用：旧会话不该继续带着飞书助理的人设。
   *
   * @param sessionId 要保留的会话 ID；空串表示全部撤掉
   */
  function releaseExcept(sessionId) {
    for (const id of [...attached.keys()]) {
      if (id !== sessionId) release(id);
    }
  }

  return { sync, release, releaseExcept };
}
