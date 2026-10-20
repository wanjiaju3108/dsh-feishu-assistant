/**
 * 非管理员请求的整轮对话合并转发：
 *
 * - 卡片翻页时每一页的消息 ID 都进 `messageIds`
 * - 开卡失败、回答退回普通消息时也要转发（这条路径上 `answerText` 一直是空的）
 * - 合并转发被拒不影响请求收尾，队列继续放行
 */

import { assistantText, createAgent, createCheck, registry, resetCalls, startPlugin, tick } from './harness.mjs';

const { eq, ok, finish } = createCheck();

const { createOutbound } = await import('../lib/feishu-outbound.js');
const { Client } = await import('./fake-lark.mjs');

const logger = { warn: () => {}, info: () => {}, error: () => {} };

/** 一条飞书私聊文本消息事件。 */
function messageEvent(messageId, text, openId) {
  return {
    message: {
      chat_type: 'p2p',
      message_id: messageId,
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: openId } },
  };
}

/** 管理员在审批卡片上点同意。 */
function approve(messageId) {
  return registry.dispatcher.dispatch('card.action.trigger', {
    operator: { open_id: 'ou_boss' },
    action: { value: { action: 'approve', messageId } },
  });
}

/** 走完一条非管理员请求：消息进来 → 审批 → 注入 → 一段回答 → turn/end。 */
async function guestTurn(agent, emit, messageId, text) {
  await registry.dispatcher.dispatch('im.message.receive_v1', messageEvent(messageId, text, 'ou_guest'));
  await tick();
  await approve(messageId);
  await tick();
  const injected = agent.followups.at(-1);
  emit('user/message', { id: injected.id, role: 'user', content: [{ type: 'text', text }] });
  emit('assistant/message', { ...assistantText('查到了两处'), turn: 1, step: 1 });
  await tick();
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await tick();
  return injected;
}

// ---------------------------------------------------------------- 1) 卡片翻页：每一页都记下来
{
  resetCalls();
  const client = new Client({});
  const outbound = createOutbound({ logger, getClient: () => client });
  const card = await outbound.openAnswerCard({ messageId: 'om_page', initialText: '正在处理' });
  ok('① 开卡返回第一页的消息 ID', Boolean(card) && card.messageIds.length === 1);
  const long = Array.from({ length: 1200 }, (_, i) => `第 ${i} 行的内容，写点字凑长度凑长度`).join('\n');
  await card.update(long);
  await card.close();
  ok(`② 翻页后每一页都在 messageIds 里（${card.messageIds.length} 页）`, card.messageIds.length >= 2);
  eq('③ 每一页都是回复请求人那条消息',
    registry.calls.filter((c) => c.kind === 'message.reply').every((c) => c.messageId === 'om_page'), true);
}

// ---------------------------------------------------------------- 2) 开卡失败：回答走普通消息，也要转发
{
  resetCalls();
  registry.failCardCreate = true;
  const { agent, log, emit } = await startPlugin({ agent: createAgent() });
  const injected = await guestTurn(agent, emit, 'om_guest', '帮我查一下');
  ok('④ 开卡失败后回答仍被注入会话', Boolean(injected?.id));
  const forward = registry.calls.find((c) => c.kind === 'message.mergeForward');
  ok('⑤ 开卡失败、回答退回普通消息时也发起了合并转发', Boolean(forward));
  eq('⑥ 转发目标是管理员 open_id', [forward?.receiveId, forward?.receiveIdType], ['ou_boss', 'open_id']);
  eq('⑦ 列表第一项是请求人的原话', forward?.messageIdList?.[0], 'om_guest');
  ok('⑧ 列表里还有普通消息路径发出的回答', (forward?.messageIdList?.length ?? 0) >= 2);
  ok('⑨ 没有被 answerText 为空的判断挡掉', log.lines.info.some((l) => l.includes('已合并转发')));
  registry.failCardCreate = false;
}

// ---------------------------------------------------------------- 3) 合并转发被拒：收尾照常，队列放行
{
  resetCalls();
  registry.failCardCreate = true;
  registry.rejectMergeForward = true;
  const { agent, log, emit, incoming } = await startPlugin({ agent: createAgent({ id: 'sess-2' }) });
  await guestTurn(agent, emit, 'om_guest2', '再查一下');
  ok('⑩ 合并转发被拒时只记日志',
    log.lines.warn.some((l) => l.includes('合并转发') && l.includes('失败')));
  const before = agent.followups.length;
  await incoming('om_admin', '管理员问的');
  await tick();
  ok('⑪ 请求收尾没有卡住，队列继续放行', agent.followups.length > before);
  registry.failCardCreate = false;
  registry.rejectMergeForward = false;
}

finish();
