/**
 * dsh-feishu-assistant — 人设文件。
 *
 * 「飞书AI助理模式」的人设由用户自己写文件，插件只读不写：设置页里配路径，
 * 插件把文件内容作为目标会话的个人设定（persona prefix）在运行时注入，盖掉该会话
 * 原本的个人设定。文件没配、读不到或空文件时，这个模式就是不可用状态，插件不会
 * 假装它开着，也不会自己造一份人设出来。
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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

/** 人设文件字节上限。 */
export const MAX_PERSONA_BYTES = 64 * 1024;

/**
 * 把人设文件路径解析成绝对路径。
 *
 * `~` 按用户主目录展开，相对路径按 `$DSH_HOME` 解析，这样设置页里写 `AGENTS.md`
 * 指的就是 `~/.dsh/AGENTS.md`，不用关心 DSH 进程的工作目录。
 *
 * @param file 设置页里配的路径
 * @returns 绝对路径；路径为空时返回空串
 */
export function resolvePersonaPath(file) {
  const trimmed = typeof file === 'string' ? file.trim() : '';
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed)) return trimmed;
  return resolve(dshHome(), trimmed);
}

/**
 * 取 DSH 主目录。
 *
 * 不依赖 DSH 的路径包，只用它公开的环境变量；没设时按默认约定拼。
 *
 * @returns DSH 主目录的绝对路径
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv || join(homedir(), '.dsh');
}

/**
 * 读人设文件并判断它能不能用。
 *
 * 不抛异常：读不出来是正常状态（用户还没写），调用方拿 error 直接展示即可。
 *
 * @param file 设置页里配的路径
 * @returns 读成功时 { ok: true, path, text }，否则 { ok: false, path, error }
 */
export async function loadPersona(file) {
  const path = resolvePersonaPath(file);
  if (!path) return { ok: false, path: '', error: '还没有配置文件路径' };
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    return { ok: false, path, error: `读不到 ${path}：${errorMessage(error)}` };
  }
  if (!info.isFile()) return { ok: false, path, error: `${path} 不是普通文件` };
  if (info.size > MAX_PERSONA_BYTES) {
    return { ok: false, path, error: `${path} 有 ${info.size} 字节，超过 ${MAX_PERSONA_BYTES} 字节上限` };
  }
  let text;
  try {
    text = (await readFile(path, 'utf8')).trim();
  } catch (error) {
    return { ok: false, path, error: `读不到 ${path}：${errorMessage(error)}` };
  }
  if (!text) return { ok: false, path, error: `${path} 是空文件` };
  return { ok: true, path, text };
}

/**
 * 建人设注入器：把配置文件的内容挂到目标会话上。
 *
 * 每个会话记住自己的注册句柄，内容变了就换一份；文件失效时撤掉，别让上一次的人设
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
