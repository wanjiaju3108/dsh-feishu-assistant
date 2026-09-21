/**
 * dsh-feishu-assistant — 非管理员请求的审批流程。
 *
 * 待审批缓存在这里：按请求人的飞书消息 ID 索引，带 TTL 与上限。过期或被挤掉
 * 都要回消息告诉请求人，否则他们会一直等。
 */

import { LRUCache } from 'lru-cache';

import {
  APPROVAL_HEADER_APPROVED,
  APPROVAL_HEADER_REJECTED,
  APPROVAL_TTL_MS,
  MAX_PENDING_APPROVALS,
  REPLY_TEXT,
} from './constants.js';
import {
  buildApprovalCard,
  buildApprovalResultCard,
  callbackCardResponse,
  toastResponse,
} from './feishu-cards.js';
import { cardOperatorIds, messageSenderIds, readCardActionValue } from './feishu-events.js';
import { errorMessage } from './http.js';

/**
 * 建审批流程。
 *
 * @param deps.logger 日志
 * @param deps.getManagerId 取当前管理员 ID
 * @param deps.matchesManager 判断一组 ID 里有没有当前管理员
 * @param deps.resolveSenderName 按 open_id 取姓名（尽力而为，查不到返回空串）
 * @param deps.sendReply 回消息给请求人
 * @param deps.sendCard 给管理员发交互卡片
 * @param deps.enqueue 审批通过后把请求交给请求队列（回答卡片由队列那边开）
 * @returns 审批流程句柄
 */
export function createApprovalFlow({
  logger,
  getManagerId,
  matchesManager,
  resolveSenderName = async () => '',
  sendReply,
  sendCard,
  enqueue,
}) {
  /**
   * 待审批缓存，按请求人的飞书消息 ID 索引。
   *
   * 这不是队列：没有消费者自动取，等人点卡片；所以用带 TTL 的 LRU 缓存而不是 createQueue。
   * 过期与挤掉由缓存自己做，两个时机都要回消息告诉请求人。
   */
  const pending = new LRUCache({
    max: MAX_PENDING_APPROVALS,
    ttl: APPROVAL_TTL_MS,
    ttlAutopurge: true,
    dispose: (item, messageId, reason) => {
      if (reason === 'delete') return;
      // expire = 没人处理到期作废；evict = 待审批满了被挤掉。
      logger.info(`待审批 ${messageId} 已作废（${reason}）`);
      const text = reason === 'expire' ? REPLY_TEXT.expired : REPLY_TEXT.failure;
      void sendReply(item.messageId, text).catch((error) => {
        logger.warn(`回复审批作废提示失败：${errorMessage(error)}`);
      });
    },
  });

  /**
   * 把一条非管理员请求登记进待审批缓存，并推一张审批卡片给管理员。
   *
   * 卡片发失败就撤回登记并回请求人一条失败提示，不让请求悬着。
   *
   * @param event 飞书消息事件
   * @param text 消息正文
   */
  async function requestApproval(event, text) {
    const managerId = getManagerId();
    if (!managerId) {
      logger.warn('收到非管理员请求，但还没有管理员可以审批，已忽略');
      return;
    }
    const message = event?.message ?? {};
    const messageId = message.message_id ?? '';
    if (!messageId || pending.has(messageId)) return;
    // 满了就拒掉新来的这条：保持已有待审批不被打乱，请求人也立刻知道没排上。
    if (pending.size >= MAX_PENDING_APPROVALS) {
      logger.warn(`待审批已满（${MAX_PENDING_APPROVALS} 条），本条请求被拒`);
      await sendReply(messageId, REPLY_TEXT.failure);
      return;
    }
    const senderId = messageSenderIds(event)[0] ?? '';
    // 姓名是尽力而为：查不到就空串，卡片那边退回显示 ID，不让通讯录接口拖住审批。
    const senderName = senderId ? await resolveSenderName(senderId) : '';
    const item = {
      messageId,
      senderId,
      senderName,
      content: text,
      createdAt: Date.now(),
    };
    pending.set(messageId, item);
    try {
      await sendCard(managerId, buildApprovalCard(item));
      logger.info(`已把请求 ${messageId} 提交管理员审批`);
    } catch (error) {
      pending.delete(messageId);
      logger.warn(`发送审批卡片失败：${errorMessage(error)}`);
      await sendReply(messageId, REPLY_TEXT.failure);
      return;
    }
    // 卡片发成功才回「已提交」：请求人得知道自己这条在等审批，而不是没人理。
    await sendReply(messageId, REPLY_TEXT.submitted);
  }

  /**
   * 管理员同意：把请求交给请求队列。
   *
   * 回答卡片不在这里开——入队那边（`enqueueRequest`）统一负责，开不出来时由它退回一条普通回执。
   * 这里只管审批本身，跟"回答怎么送"解耦。
   *
   * 这里**绝不能抛**：调用方在卡片回调里，飞书要求回调同步给出响应，一抛就成了 500，
   * 客户端只显示"出错了"，返回的替换卡片也送不出去。所以不假设 `enqueue` 的返回值是
   * Promise——之前对它直接 `.catch`，而接线处是 `void enqueueRequest(...)`（返回 undefined），
   * 于是每次点同意都崩在 `undefined.catch` 上。
   *
   * @param item 待审批请求
   */
  function approveRequest(item) {
    logger.info(`请求 ${item.messageId} 已审批通过并进入请求队列`);
    try {
      const pending = enqueue(item.messageId, item.content);
      // enqueue 返回 Promise 时把异步失败记下来，别让它变成 unhandled rejection。
      if (typeof pending?.catch === 'function') {
        void pending.catch((error) => {
          logger.warn(`审批通过后的处理失败：${errorMessage(error)}`);
        });
      }
    } catch (error) {
      logger.warn(`审批通过后的处理失败：${errorMessage(error)}`);
    }
  }

  /**
   * 管理员拒绝：回请求人一条不可处理。
   *
   * @param item 待审批请求
   */
  function rejectRequest(item) {
    void sendReply(item.messageId, REPLY_TEXT.rejected).catch((error) => {
      logger.warn(`回复拒绝提示失败：${errorMessage(error)}`);
    });
    logger.info(`请求 ${item.messageId} 已被拒绝`);
  }

  /**
   * 处理管理员在审批卡片上的点击。
   *
   * 非管理员点的一律不认；已经处理过或已过期的请求回一句提示，不重复入队。
   *
   * @param event 飞书卡片回调事件
   * @returns 卡片回调响应
   */
  function handleCardAction(event) {
    const value = readCardActionValue(event);
    const messageId = typeof value?.messageId === 'string' ? value.messageId : '';
    if (!messageId) {
      return toastResponse('error', '卡片操作参数缺失');
    }
    if (!matchesManager(cardOperatorIds(event))) {
      logger.warn(`非管理员点击了审批卡片（请求 ${messageId}），已忽略`);
      return toastResponse('error', '无权操作');
    }
    // 过期的条目缓存自己已经清掉，这里取不到就说明已处理或已过期。
    const item = pending.get(messageId);
    if (!item) {
      return toastResponse('error', '该请求已处理或已过期');
    }
    pending.delete(messageId);
    if (value.action === 'approve') {
      // 入队是同步 fire-and-forget（真正的活由 enqueueRequest 自己排），别拖住卡片回调的响应
      // （飞书要求 3 秒内回执）。approveRequest 内部兜底，不会把异常抛回这里。
      approveRequest(item);
      return callbackCardResponse('success', '已同意', buildApprovalResultCard('已同意', APPROVAL_HEADER_APPROVED, item));
    }
    if (value.action === 'reject') {
      rejectRequest(item);
      return callbackCardResponse('success', '已拒绝', buildApprovalResultCard('已拒绝', APPROVAL_HEADER_REJECTED, item));
    }
    return toastResponse('error', '不支持的卡片操作');
  }

  return { requestApproval, handleCardAction };
}
