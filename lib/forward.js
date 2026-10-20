/**
 * dsh-feishu-assistant — 非管理员这一轮跑完后，把整轮对话合并转发给管理员。
 *
 * 单独一个文件：它要读路由状态（`answerChain` / `answerMessageIds` / `replied`）和回答卡片句柄的
 * `messageIds`，留在 apply 闭包里会让 index.js 继续变长。
 */

import { errorMessage } from './http.js';

/**
 * 建整轮对话的转发器。
 *
 * @param deps.logger 日志
 * @param deps.getManagerId 取管理员 open_id
 * @param deps.outbound 出站发送器（只用 forwardMerged）
 * @param deps.routing 路由状态
 * @returns 转发函数：forward(messageId, card)
 */
export function createTurnForwarder({ logger, getManagerId, outbound, routing }) {
  /**
   * 把这一轮的整轮对话合并转发给管理员。
   *
   * 只转飞书里真实存在的消息：请求人的原话 + 回答卡片发出去的每一条（翻页会有多条；卡片没走成时
   * 是普通消息的每一条）。合并转发的子消息保留原发送者，管理员点开就是完整的一问一答。
   *
   * 没有产出、或回答消息一条都没发出去时不转：那样转过去只剩一句原话，管理员在审批卡片上已经看过。
   *
   * 这一段夹在请求收尾流程中间：它抛出去的话 endRequest 就执行不到，路由状态会卡住。所以整段兜住，
   * 只记日志。
   *
   * @param messageId 请求人原话的消息 ID
   * @param card 回答卡片句柄；没开出来时 undefined
   */
  return async function forward(messageId, card) {
    try {
      // 走普通消息时发送是异步的，等链排完再取 ID，否则可能只拿到一部分。
      await routing.answerChain;
      const managerId = getManagerId();
      const cardMessageIds = card?.messageIds ?? [];
      const answerMessageIds = cardMessageIds.length > 0 ? cardMessageIds : routing.answerMessageIds;
      // 只看消息 ID 和有没有产出：answerText 只在卡片分支累加，退回普通消息时是空的，
      // 用它判断会把最需要转发的这条路径全挡掉。
      if (!managerId || !routing.replied || answerMessageIds.length === 0) {
        logger.info(`请求 ${messageId} 这一轮没有可转发的回答，跳过合并转发`);
        return;
      }
      const messageIds = [messageId, ...answerMessageIds].filter(Boolean);
      const forwarded = await outbound.forwardMerged(messageIds, managerId);
      if (!forwarded) {
        logger.warn(`请求 ${messageId} 的整轮对话合并转发给管理员失败`);
        return;
      }
      logger.info(`请求 ${messageId} 的整轮对话已合并转发给管理员`);
    } catch (error) {
      logger.warn(`合并转发请求 ${messageId} 的整轮对话失败：${errorMessage(error)}`);
    }
  };
}
