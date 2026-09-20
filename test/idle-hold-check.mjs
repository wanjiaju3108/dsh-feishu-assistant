/**
 * 「注入前等会话空下来」的回归：
 *
 * 1. 会话忙（界面那一轮在跑）时收到飞书消息 → 只开卡片、不注入
 * 2. 刚空闲就被人插了一条 → 继续等，不抢着注入
 * 3. 会话真空下来才注入；之后任何一个 turn/end 都属于它自己 → 回答回到请求人那条消息上
 * 4. 前提被破坏（注入还没被取走就来了 turn/end）时留一条告警，行为不变
 */

import { assistantText, createAgent, createCheck, createLogger, registry, startPlugin, tick } from './harness.mjs';

const { eq, ok, finish } = createCheck();

const log = createLogger();
const agent = createAgent({ status: 'running', manualIdle: true });
const { emit, incoming } = await startPlugin({ agent, log });

const kindOf = (call) => `${call.kind}:${call.msgType ?? ''}`;

// ---------------------------------------------------------------- 会话忙着
await incoming('om_hold', '飞书这条');
await tick();
eq('① 会话忙时先开卡片（回复请求人）', kindOf(registry.calls[0]), 'card.create:');
ok('② 卡片回复到请求人那条消息上',
  registry.calls.some((c) => c.kind === 'message.reply' && c.messageId === 'om_hold'));
eq('③ 会话忙时不注入', agent.followups.length, 0);
ok('④ 请求人能看到「正在处理」',
  registry.calls.some((c) => c.kind === 'card.create' && c.card.body.elements[0].content === '正在处理'));

// 界面那一轮结束：刚空闲就有人插了一条界面消息 → 应该继续等
agent.inbox.nextTurn.push({ id: 'web-again', role: 'user', source: { kind: 'user' } });
await agent.becomeIdle();
eq('⑤ 刚空闲又有人插队：仍不注入', agent.followups.length, 0);

// 队列真的空了 → 注入
agent.inbox.nextTurn.length = 0;
await agent.becomeIdle();
await tick();
eq('⑥ 会话真空下来才注入', agent.followups.length, 1);
const injected = agent.followups[0];

// 这一轮（只有它一条待处理项）跑完
registry.calls.length = 0;
emit('user/message', { id: injected.id, role: 'user', content: [{ type: 'text', text: '飞书这条' }] });
emit('assistant/message', { ...assistantText('飞书那条真正的回答'), turn: 9, step: 1 });
await tick();
emit('turn/end', { turn: 9, reason: { kind: 'completed' } });
await tick();
await tick();
ok('⑦ 回答正文推到了请求人那张卡片上',
  registry.calls.some((c) => c.kind === 'element.update'
    && JSON.stringify(c.element ?? '').includes('飞书那条真正的回答')));
eq('⑧ 没有走成私聊卡片', registry.calls.filter((c) => c.kind === 'message.create').length, 0);
eq('⑨ 也没有"没有产出回答"的多余回执',
  registry.calls.filter((c) => c.kind === 'message.reply'
    && JSON.stringify(c.content ?? '').includes('这一轮没有产出回答')).length, 0);

// ---------------------------------------------------------------- 前提被破坏时的告警
// 新的飞书请求：注入之后、我们那一轮开始之前，先来一条别人的 turn/end
log.lines.warn.length = 0;
await incoming('om_warn', '再来一条');
await tick();
await agent.becomeIdle(); // 会话空下来 → 这时才注入
await tick();
const beforeWarn = registry.calls.length;
emit('turn/end', { turn: 99, reason: { kind: 'completed' } });
await tick();
ok('⑩ 别人的 turn/end 提前放行时留下告警',
  log.lines.warn.some((line) => line.includes('不是飞书请求自己的')));
ok('⑪ 告警之外行为不变：请求被提前收尾（这是已接受的取舍）',
  registry.calls.slice(beforeWarn).some((c) => c.kind === 'message.reply'
    && JSON.stringify(c.content ?? '').includes('这一轮没有产出回答')));

finish();
