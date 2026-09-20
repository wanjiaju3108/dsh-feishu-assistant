/**
 * dsh-feishu-assistant — 凭据名校验。
 */

import { CREDENTIAL_REF_PATTERN } from './constants.js';

/**
 * 校验凭据名并返回。
 *
 * 不引用 @deepseek-ai/dsh-credentials：npm 上的版本（0.0.1-rc.1）比运行时旧，
 * 而它的 credentialRef 只是 brandString（运行时返回原值），本地校验即可。
 *
 * @param name 凭据名
 * @returns 同一个名字
 */
export function requireRef(name) {
  if (!CREDENTIAL_REF_PATTERN.test(name)) {
    throw new TypeError(`凭据名不合法：${name}`);
  }
  return name;
}
