/**
 * dsh-feishu-assistant — 审批卡片构造与卡片回调响应。
 */

import {
  APPROVAL_CARD_TITLE,
  APPROVAL_HEADER_APPROVED,
  APPROVAL_HEADER_PENDING,
  APPROVAL_HEADER_REJECTED,
  APPROVE_BUTTON_TEXT,
  CARD_CALLBACK_BEHAVIOR,
  CARD_SCHEMA_VERSION,
  REJECT_BUTTON_TEXT,
} from './constants.js';

/**
 * 构造只有一段正文的 Markdown 卡片。
 *
 * 飞书的文本消息不渲染 Markdown，回答只能走卡片里的富文本组件；结构跟审批卡片一致
 * （schema 2.0 + body.elements），只是不带 header 和按钮。
 *
 * @param content Markdown 正文
 * @returns 卡片对象
 */
export function buildMarkdownCard(content) {
  return {
    schema: CARD_SCHEMA_VERSION,
    body: {
      elements: [{ tag: 'markdown', content }],
    },
  };
}

/**
 * 构造审批卡片。
 *
 * 结构照搬 Clock Tower 的新版卡片：schema 2.0 + header + body.elements，
 * 按钮用 column_set 排成等宽两列，behaviors 里带 callback 参数。
 *
 * @param item 待审批请求
 * @returns 卡片对象
 */
export function buildApprovalCard(item) {
  return {
    schema: CARD_SCHEMA_VERSION,
    header: {
      template: APPROVAL_HEADER_PENDING,
      title: { tag: 'plain_text', content: APPROVAL_CARD_TITLE },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `**发送者**\n${item.senderId}` },
        { tag: 'markdown', content: `**消息内容**\n${item.content}` },
        { tag: 'markdown', content: APPROVAL_CARD_TITLE },
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [
            buildButtonColumn(APPROVE_BUTTON_TEXT, 'primary', 'approve', item.messageId),
            buildButtonColumn(REJECT_BUTTON_TEXT, 'default', 'reject', item.messageId),
          ],
        },
      ],
    },
  };
}

/**
 * 构造审批结束后的结果卡片：只换头部配色和标题，去掉按钮。
 *
 * @param title 结果标题
 * @param template 头部配色
 * @param item 已处理的请求
 * @returns 卡片对象
 */
export function buildApprovalResultCard(title, template, item) {
  return {
    schema: CARD_SCHEMA_VERSION,
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `**发送者**\n${item.senderId}` },
        { tag: 'markdown', content: `**消息内容**\n${item.content}` },
      ],
    },
  };
}

/**
 * 构造一个审批按钮列。
 *
 * @param text 按钮文案
 * @param type 按钮样式
 * @param action 回传的操作值
 * @param messageId 原始飞书消息 ID
 * @returns 卡片列对象
 */
export function buildButtonColumn(text, type, action, messageId) {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [{
      tag: 'button',
      type,
      text: { tag: 'plain_text', content: text },
      behaviors: [{
        type: CARD_CALLBACK_BEHAVIOR,
        value: { action, messageId },
      }],
    }],
  };
}

/**
 * 构造只带提示（不改卡片）的回调响应。
 *
 * @param type 提示类型
 * @param content 提示文案
 * @returns 回调响应对象
 */
export function toastResponse(type, content) {
  return { toast: { type, content } };
}

/**
 * 构造带提示并替换卡片的回调响应。
 *
 * @param type 提示类型
 * @param content 提示文案
 * @param card 替换后的卡片
 * @returns 回调响应对象
 */
export function callbackCardResponse(type, content, card) {
  return { toast: { type, content }, card: { type: 'raw', data: card } };
}
