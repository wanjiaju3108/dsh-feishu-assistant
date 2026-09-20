/**
 * 会话打不开时的回执行为：
 *
 * 1. 第一次坏：还是先开了卡片（那时还不知道坏），失败后关掉卡片 + 回一句报错
 * 2. 已经知道坏：不再白开卡片，直接回一句报错（看不到卡片闪烁）
 * 3. 会话修好：请求照样被处理（错误标记被清掉），回答先以普通卡片回来，下一轮恢复回答卡片
 */

import { assistantText, createAgent, createCheck, registry, startPlugin, tick } from './harness.mjs';

const { eq, ok, finish } = createCheck();

const agent = createAgent();
/** 会话"在不在"由这里控制：false 模拟打不开（没有 agent、也没有会话控制器）。 */
let sessionAlive = false;
const { emit, incoming } = await startPlugin({ agent, hasAgent: () => sessionAlive });

const cards = () => registry.calls.filter((c) => c.kind === 'card.create').length;
const failures = () => registry.calls.filter((c) => c.kind === 'message.reply'
  && JSON.stringify(c.content ?? '').includes('目标会话不可用'));

// 1) 会话打不开的第一次：卡片开了才发现，失败后关掉并回一句报错
await incoming('om_1', '第一条');
await tick();
await tick();
eq('① 第一次坏：开了卡片（那时还不知道坏）', cards(), 1);
eq('② 失败后回了一句会话不可用', failures().length, 1);

// 2) 已经知道坏：不再白开卡片
registry.calls.length = 0;
await incoming('om_2', '第二条');
await tick();
await tick();
eq('③ 已知坏：不再开卡片', cards(), 0);
eq('④ 仍然回一句会话不可用', failures().length, 1);

// 3) 会话修好：请求照常处理，回答先以普通卡片回来
registry.calls.length = 0;
sessionAlive = true;
await incoming('om_3', '第三条');
await tick();
await tick();
eq('⑤ 修好后也不再抢着开卡片（错误标记还在）', cards(), 0);
eq('⑥ 但请求真的被处理了（注入了一次）', agent.followups.length, 1);
const injected = agent.followups[0];
emit('user/message', { id: injected.id, role: 'user', content: [{ type: 'text', text: '第三条' }] });
emit('assistant/message', { ...assistantText('修好后的回答'), turn: 1, step: 1 });
await tick();
emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
await tick();
ok('⑦ 回答以普通卡片（回复请求人）回来',
  registry.calls.some((c) => c.kind === 'message.reply' && c.msgType === 'interactive'
    && JSON.stringify(c.content).includes('修好后的回答')));

// 4) 错误标记被清掉：下一条恢复回答卡片
registry.calls.length = 0;
await incoming('om_4', '第四条');
await tick();
eq('⑧ 下一条恢复成回答卡片', cards(), 1);

finish();
