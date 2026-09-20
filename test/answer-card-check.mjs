/**
 * 回答卡片（非流式整块替换）的回归：
 *
 * - 卡片不带 streaming_mode/streaming_config，靠 cardkit.cardElement.update 整块换组件
 * - 每段传的是累计正文，客户端立刻显示（我们不做打字机）
 * - 超过体积上限翻页；整块替换失败时收尾把没上屏的正文补发成普通消息
 * - 收尾不做任何额外接口调用（没有"关流式""等打字机"这回事）
 */

import { createCheck } from './harness.mjs';

const { createAnswerCardFlow } = await import('../lib/feishu-answer-card.js');

const { eq, ok, finish } = createCheck();

/** 假飞书：记录调用；可指定组件更新一直失败 / 建实体失败。 */
function fakeFeishu({ failElement = false, failCreate = false } = {}) {
  const calls = [];
  let cardSeq = 0;
  let msgSeq = 0;
  const client = {
    cardkit: { v1: {
      card: {
        create: async (args) => {
          calls.push({ kind: 'create', card: JSON.parse(args.data.data) });
          if (failCreate) return { code: 99991672, msg: 'no scope' };
          cardSeq += 1;
          return { code: 0, data: { card_id: `c${cardSeq}` } };
        },
        // 非流式方案不该再用到它；留着是为了让"误调用"暴露出来。
        settings: async (args) => {
          calls.push({ kind: 'settings', cardId: args.path.card_id, seq: args.data.sequence });
          return { code: 0, data: {} };
        },
      },
      cardElement: {
        update: async (args) => {
          calls.push({ kind: 'element.update', cardId: args.path.card_id, elementId: args.path.element_id,
            seq: args.data.sequence, element: JSON.parse(args.data.element) });
          return failElement ? { code: 230099, msg: 'element rejected' } : { code: 0, data: {} };
        },
      },
    } },
    im: { message: {
      reply: async (args) => { calls.push({ kind: 'reply', messageId: args.path.message_id, msgType: args.data.msg_type, content: JSON.parse(args.data.content) });
        msgSeq += 1; return { code: 0, data: { message_id: `m${msgSeq}` } }; },
      create: async (args) => { calls.push({ kind: 'dm', receiveId: args.data.receive_id, msgType: args.data.msg_type, content: JSON.parse(args.data.content) });
        msgSeq += 1; return { code: 0, data: { message_id: `m${msgSeq}` } }; },
    } },
  };
  return { calls, client };
}
const sendVia = (client) => async (fn) => {
  try { const r = await fn(client); return r?.code === 0 ? r : undefined; } catch { return undefined; }
};
const logger = { warn: () => {}, info: () => {}, error: () => {} };
/** 最近一次组件更新的正文。 */
const shownText = (call) => call?.element?.content;

// 1) 正常一轮：开卡（正在处理）→ 第一段 → 累计第二段 → 收尾
{
  const { calls, client } = fakeFeishu();
  const flow = createAnswerCardFlow({ logger, send: sendVia(client) });
  const card = await flow.open({ messageId: 'om_u', initialText: '正在处理' });
  ok('① 开卡返回句柄', Boolean(card));
  eq('② 卡片是普通卡片：update_multi、没有 streaming_mode / streaming_config',
    [calls[0].card.config.update_multi, calls[0].card.config.streaming_mode, calls[0].card.config.streaming_config],
    [true, undefined, undefined]);
  eq('③ 正文组件带 element_id', calls[0].card.body.elements[0].element_id, 'answer');
  eq('④ 用卡片实体回复', [calls[1].kind, calls[1].msgType, calls[1].content],
    ['reply', 'interactive', { type: 'card', data: { card_id: 'c1' } }]);
  await card.update('第一段');
  eq('⑤ 第一段整块换上去', shownText(calls[2]), '第一段');
  await card.update('第一段\n\n第二段');
  eq('⑥ 第二段传的是累计正文', shownText(calls[3]), '第一段\n\n第二段');
  const started = Date.now();
  await card.close();
  const elapsed = Date.now() - started;
  ok(`⑦ 收尾不做额外接口调用、立刻返回（实测 ${elapsed}ms）`, elapsed < 300);
  eq('⑧ 收尾没有产生新的调用', calls.slice(4).map((c) => c.kind), []);
  ok('⑨ 内容都上屏了，没有补发尾巴', calls.filter((c) => c.kind === 'reply' && c.msgType === 'text').length === 0);
  ok('⑩ 全程没用流式接口，也没动过 streaming_mode', calls.every((c) => c.kind !== 'settings'));
  const seqs = calls.filter((c) => c.kind === 'element.update').map((c) => c.seq);
  ok('⑪ 同一张卡 sequence 严格递增', seqs.every((v, i) => i === 0 || v > seqs[i - 1]));
}

// 2) 组件更新被拒：收尾把没上屏的正文补发成普通消息
{
  const { calls, client } = fakeFeishu({ failElement: true });
  const flow = createAnswerCardFlow({ logger, send: sendVia(client) });
  const card = await flow.open({ messageId: 'om_u', initialText: '正在处理' });
  await card.update('这段内容没能上屏');
  await card.close();
  const tail = calls.find((c) => c.kind === 'reply' && c.msgType === 'text');
  ok('⑫ 补发了没上屏的内容', Boolean(tail));
  eq('⑬ 补发的是完整正文', tail?.content, { text: '这段内容没能上屏' });
}

// 3) 正文超一页：翻页（新实体 + 新回复），内容不丢
{
  const { calls, client } = fakeFeishu();
  const flow = createAnswerCardFlow({ logger, send: sendVia(client) });
  const card = await flow.open({ messageId: 'om_u', initialText: '正在处理' });
  const long = Array.from({ length: 1200 }, (_, i) => `第 ${i} 行的内容，写点字凑长度凑长度`).join('\n');
  await card.update(long);
  await card.close();
  const creates = calls.filter((c) => c.kind === 'create');
  const updates = calls.filter((c) => c.kind === 'element.update');
  ok(`⑭ 超长正文翻页（建了 ${creates.length} 张卡，整块换了 ${updates.length} 次）`, creates.length >= 2);
  ok('⑮ 每次内容都不超上限',
    updates.every((c) => Buffer.byteLength(JSON.stringify(c.element)) < 26 * 1024));
  ok('⑯ 内容没丢（合计长度 ≥ 原文，含翻页重叠）',
    updates.map((c) => shownText(c)).join('').length >= long.length - 200);
  eq('⑰ 没有需要补发的尾巴', calls.filter((c) => c.kind === 'reply' && c.msgType === 'text').length, 0);
}

// 4) 私聊目标：卡片主动私聊，不回复任何消息
{
  const { calls, client } = fakeFeishu();
  const flow = createAnswerCardFlow({ logger, send: sendVia(client) });
  const card = await flow.open({ openId: 'ou_boss', initialText: '正在处理' });
  ok('⑱ 私聊目标也能开卡', Boolean(card));
  eq('⑲ 用卡片实体主动私聊', [calls[1].kind, calls[1].receiveId, calls[1].msgType, calls[1].content],
    ['dm', 'ou_boss', 'interactive', { type: 'card', data: { card_id: 'c1' } }]);
  await card.update('第一段');
  await card.close();
  ok('⑳ 私聊目标全程不回复任何消息', calls.every((c) => c.kind !== 'reply'));
}

// 5) 建实体失败 / 没有发送目标：open 返回 undefined
{
  const { client } = fakeFeishu({ failCreate: true });
  const flow = createAnswerCardFlow({ logger, send: sendVia(client) });
  eq('㉑ 没权限时 open 返回 undefined', await flow.open({ messageId: 'om_u', initialText: '正在处理' }), undefined);
  const bare = fakeFeishu();
  const flow2 = createAnswerCardFlow({ logger, send: sendVia(bare.client) });
  eq('㉒ 没有发送目标时 open 返回 undefined', await flow2.open({ initialText: '正在处理' }), undefined);
  eq('㉓ 也不该建卡片实体', bare.calls.length, 0);
}

finish();
