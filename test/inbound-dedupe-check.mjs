/**
 * 入站消息去重的回归：飞书长连接是"至少一次"投递，同一条消息重投不能答两遍。
 */

import { assistantText, createAgent, createCheck, createLogger, registry, startPlugin, tick } from './harness.mjs';

const { eq, finish } = createCheck();

const log = createLogger();
const { agent, emit, incoming } = await startPlugin({ agent: createAgent(), log });

const cards = () => registry.calls.filter((c) => c.kind === 'card.create').length;

await incoming('om_1', '第一次问');
await tick();
eq('① 第一条：开一张卡、注入一次', [cards(), agent.followups.length], [1, 1]);

// 同一条消息重投（第一条请求还在等 turn/end）
log.lines.warn.length = 0;
await incoming('om_1', '第一次问');
await tick();
eq('② 重投同一条：不再开卡、不再注入', [cards(), agent.followups.length], [1, 1]);
eq('③ 重投被记了一条日志', log.lines.warn.filter((l) => l.includes('又投递了一次')).length, 1);

// 让第一条请求跑完，再发一条新的
emit('user/message', { id: agent.followups[0].id, role: 'user', content: [{ type: 'text', text: '第一次问' }] });
emit('assistant/message', { ...assistantText('回答'), turn: 1, step: 1 });
await tick();
emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
await tick();
await incoming('om_2', '第二次问');
await tick();
eq('④ 换一条 id：照常处理', [cards(), agent.followups.length], [2, 2]);

finish();
