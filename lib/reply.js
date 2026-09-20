/**
 * dsh-feishu-assistant — 回答正文的切分。
 */

import { REPLY_CHUNK_CHARS } from './constants.js';

/**
 * 把一段回复正文按飞书单条消息上限切开。
 *
 * 优先在换行处切，切不动就硬切；切完去掉两侧空白，空段不保留。
 *
 * @param text 完整回复正文
 * @returns 待发送的段落列表
 */
export function splitReplyText(text) {
  const value = String(text ?? '');
  if (value.length <= REPLY_CHUNK_CHARS) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > REPLY_CHUNK_CHARS) {
    let cut = rest.lastIndexOf('\n', REPLY_CHUNK_CHARS);
    if (cut <= 0) cut = REPLY_CHUNK_CHARS;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter((chunk) => chunk.length > 0);
}
