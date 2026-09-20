/**
 * dsh-feishu-assistant — 管理员配对。
 *
 * 陌生人先在设置页生成一个配对码，再在飞书里私聊机器人把这个码发过来；命中就把他设成管理员。
 * 配对码只存在内存里（DSH 重启即失效）、只用一次、有过期时间。
 *
 * 对外的入口只有 `createPairingFlow()`：状态、码的生成与规范化、命中判定都收在它里面；
 * 宿主半边只管把"回执"和"成为管理员"这两件事接进来。
 */

import { randomInt } from 'node:crypto';

import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_TTL_MS } from './constants.js';
import { messageSenderIds } from './feishu-events.js';

/**
 * 生成一个配对码。
 *
 * @returns PAIRING_CODE_LENGTH 位的随机码
 */
function createPairingCode() {
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

/**
 * 规范化用户手输的配对码：去掉空白和连字符、统一大写。
 *
 * @param text 原始输入
 * @returns 规范化后的文本
 */
function normalizePairingText(text) {
  return String(text ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * 建配对流程。
 *
 * @param deps.logger 日志
 * @param deps.reply 回复某条飞书消息（messageId, 正文）
 * @param deps.pair 成为管理员：宿主负责落盘 + 更新内存里的 managerId
 * @returns 流程句柄
 */
export function createPairingFlow({ logger, reply, pair }) {
  /** 当前有效的配对码；没有配对进行时为 undefined。 */
  let active;

  /**
   * 取当前有效的配对码；已过期就地作废。
   *
   * @returns 有效配对码；没有或已过期时返回 undefined
   */
  function current() {
    if (!active) return undefined;
    if (Date.now() > active.expiresAt) {
      active = undefined;
      return undefined;
    }
    return active;
  }

  /**
   * 生成新的配对码；每次覆盖上一个，旧码立刻失效。
   */
  function start() {
    active = { code: createPairingCode(), expiresAt: Date.now() + PAIRING_TTL_MS };
    logger.info('已生成新的配对口令，等待在飞书里私聊机器人');
  }

  /**
   * 判断一条消息是不是配对口令。
   *
   * 忽略空白和连字符、不区分大小写，方便手输。
   *
   * @param text 消息正文
   * @returns 命中时为 true
   */
  function match(text) {
    const code = current();
    if (!code) return false;
    return normalizePairingText(text) === code.code;
  }

  /**
   * 完成配对：把发送者设成管理员。
   *
   * 不管落盘成败都先作废配对码，避免同一个码被重复使用。
   *
   * @param event 命中口令的飞书消息事件
   * @returns Promise
   */
  async function complete(event) {
    active = undefined;
    // sender 和 message 是同一层，所以发送者从事件上取，不能从 message 上取。
    const managerId = messageSenderIds(event)[0] ?? '';
    if (!managerId) {
      logger.warn('配对口令命中但取不到发送者 ID，配对未完成');
      return;
    }
    await pair(managerId);
    await reply(event?.message?.message_id ?? '', `配对成功，你已被设为管理员。\n${managerId}`);
  }

  /**
   * 设置页要展示的配对状态。
   *
   * @returns `{ code, expiresAt }`；没有进行中的配对时为 null
   */
  function snapshot() {
    const code = current();
    return code ? { code: code.code, expiresAt: code.expiresAt } : null;
  }

  return { start, match, complete, snapshot };
}
