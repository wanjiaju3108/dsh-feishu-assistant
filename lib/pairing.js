/**
 * dsh-feishu-assistant — 配对码生成与规范化。
 */

import { randomInt } from 'node:crypto';

import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH } from './constants.js';

/**
 * 生成一个配对码。
 *
 * @returns PAIRING_CODE_LENGTH 位的随机码
 */
export function createPairingCode() {
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
export function normalizePairingText(text) {
  return String(text ?? '').replace(/[\s-]/g, '').toUpperCase();
}
