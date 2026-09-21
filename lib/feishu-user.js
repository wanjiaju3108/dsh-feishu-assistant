/**
 * dsh-feishu-assistant — 发送者姓名解析。
 *
 * 飞书的消息事件和卡片回调里只有 ID（open_id / user_id / union_id），没有名字。想在人看的
 * 地方显示名字，只能拿 ID 去通讯录接口换，所以这里单独收一层，顺带做缓存。
 *
 * 这一步是**尽力而为**：缺权限、被拒、超时都只返回空串，由调用方退回显示 ID，不能因为它
 * 把审批卡片的发送拖住。
 */

import { LRUCache } from 'lru-cache';

import { USER_NAME_TTL_MS } from './constants.js';

/**
 * 建姓名解析器。
 *
 * @param deps.logger 日志
 * @param deps.send 出站请求发送器（feishu-request.js 的 send：**返回响应体**的那个）
 * @returns 解析器句柄：resolve(openId)
 */
export function createUserNameResolver({ logger, send }) {
  /**
   * open_id → 姓名。命中失败也缓存空串，避免反复去打一个必然失败的接口。
   *
   * TTL 存在的意义是权限：没开通讯录权限时全是空串，开通之后最多等一个 TTL 就会重新探测。
   */
  const cache = new LRUCache({ max: 200, ttl: USER_NAME_TTL_MS, ttlAutopurge: true });

  /**
   * 按 open_id 查姓名。
   *
   * @param openId 发送者的 open_id
   * @returns 姓名；查不到时返回空串（调用方负责退回显示 ID）
   */
  async function resolve(openId) {
    if (!openId) return '';
    const cached = cache.get(openId);
    if (cached !== undefined) return cached;
    const response = await send(
      (client) => client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      }),
      '查询发送者姓名',
    );
    // 需要通讯录权限，两级都要：API 级（contact:contact:readonly 等）决定能不能调这个接口，
    // 字段级（contact:user.base:readonly 等）才让响应带上 name；缺任一级都会被拒并返回 undefined。
    const name = typeof response?.data?.user?.name === 'string' ? response.data.user.name : '';
    if (!name) logger.info(`取不到 ${openId} 的姓名，退回显示 ID`);
    cache.set(openId, name);
    return name;
  }

  return { resolve };
}
