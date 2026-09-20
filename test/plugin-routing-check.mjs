/**
 * 端到端验证「这一轮归谁」的路由：
 *
 * - 飞书发起的轮次 → 回答回复到那条飞书消息（一张卡片）
 * - DSH 界面 / 别的自动化发起的轮次 → 回答主动私聊推给管理员，不再静默
 * - 上一轮结束后紧接着的外部轮次，不会碰上一条请求的卡片
 * - agent 反问的提示只在自己发起的轮次里推
 */

import { assistantText, callKinds, createAgent, createCheck, registry, resetCalls, startPlugin, tick } from './harness.mjs';

const { eq, ok, finish } = createCheck();

const { agent, emit, incoming } = await startPlugin({ agent: createAgent() });
ok('插件装上并建好长连接', Boolean(registry.dispatcher && registry.ws));

/** 走一遍「一条飞书消息进来 → 注入会话」。 */
async function feishuMessage(messageId, body) {
  await incoming(messageId, body);
  await tick();
}

// ---------------------------------------------------------------- 1) 界面发起的轮次（插件刚起来，一条飞书请求都没有）
resetCalls();
emit('user/message', { id: 'web-1', role: 'user', content: [{ type: 'text', text: '界面问的' }] });
emit('assistant/message', { ...assistantText('界面第一段'), turn: 1, step: 1 });
await tick();
emit('assistant/message', { ...assistantText('界面第二段'), turn: 1, step: 2 });
await tick();
emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
await tick();
eq('① 外部轮次：建卡 + 主动私聊，不回复任何飞书消息',
  callKinds(), ['card.create', 'message.create', 'element.update']);
eq('② 主动私聊打给管理员', registry.calls[1].receiveId, 'ou_boss');
eq('③ 第一段直接作为初始正文开出来（少一次接口调用）', registry.calls[0].card.body.elements[0].content, '界面第一段');
eq('④ 第二段按累计正文更新', registry.calls[2].element.content, '界面第一段\n\n界面第二段');
eq('⑤ 收尾不做额外调用（非流式卡片没有要关的流）', registry.calls.slice(4).map((c) => c.kind), []);

// ---------------------------------------------------------------- 2) 飞书请求：回答回复到那条消息
resetCalls();
await feishuMessage('om_1', '飞书问的');
const injected = agent.followups.at(-1);
ok('⑥ 飞书消息注入会话，并带上消息 id', typeof injected?.id === 'string' && injected.id.length > 0);
emit('user/message', { id: injected.id, role: 'user', content: [{ type: 'text', text: '飞书问的' }] });
emit('assistant/message', { ...assistantText('飞书第一段'), turn: 2, step: 1 });
await tick();
emit('assistant/message', { ...assistantText('飞书第二段'), turn: 2, step: 2 });
await tick();
eq('⑦ 飞书请求：建卡 + 回复那条消息', callKinds().slice(0, 2), ['card.create', 'message.reply']);
eq('⑧ 回复挂在请求人那条消息上', registry.calls[1].messageId, 'om_1');
eq('⑨ 回答按累计正文上屏', registry.calls[3].element.content, '飞书第一段\n\n飞书第二段');

// ---------------------------------------------------------------- 3) 上一轮结束后，紧接着的外部轮次
resetCalls();
emit('turn/end', { turn: 2, reason: { kind: 'completed' } });
await tick();
ok('⑩ 飞书请求收尾没有多余调用（非流式卡片没有要关的流）',
  registry.calls.every((c) => c.kind !== 'card.settings'));
resetCalls();
emit('user/message', { id: 'web-2', role: 'user', content: [{ type: 'text', text: '界面又问' }] });
emit('assistant/message', { ...assistantText('界面第三段'), turn: 3, step: 1 });
await tick();
emit('turn/end', { turn: 3, reason: { kind: 'completed' } });
await tick();
eq('⑪ 请求结束后的外部轮次走主动私聊，不碰上一条请求的卡片', callKinds(), ['card.create', 'message.create']);
eq('⑪b 正文直接作为初始正文', registry.calls[0].card.body.elements[0].content, '界面第三段');
ok('⑫ 没有把外部回答回复到上一条飞书消息', !registry.calls.some((c) => c.kind === 'message.reply'));

// ---------------------------------------------------------------- 4) 飞书请求一个字都没产出
resetCalls();
await feishuMessage('om_2', '没有产出的问题');
emit('user/message', { id: agent.followups.at(-1).id, role: 'user', content: [] });
emit('turn/end', { turn: 4, reason: { kind: 'error', error: { message: 'boom' } } });
await tick();
await tick();
// 回执类文案走的是"卡片优先"的发送路径（飞书文本不渲染 Markdown），所以按正文找。
const fallback = registry.calls.filter((c) => c.kind === 'message.reply'
  && JSON.stringify(c.content ?? '').includes('这一轮没有产出回答'));
eq('⑬ 没产出时给请求人补一条失败文案', fallback.length, 1);
ok('⑭ 失败原因只给管理员', JSON.stringify(fallback[0]?.content ?? '').includes('boom'));

// ---------------------------------------------------------------- 5) 外部轮次里 agent 反问：不往飞书推提示
resetCalls();
emit('user/message', { id: 'web-3', role: 'user', content: [{ type: 'text', text: '界面里的问题' }] });
emit('tool/call', { turn: 5, step: 1, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ header: '选择', question: '选哪个' }] }) });
await tick();
ok('⑮ 外部轮次的提问不推飞书（提问只在界面上等回答）', callKinds().length === 0);

// ---------------------------------------------------------------- 6) 外部轮次只有一段，收尾紧跟着就来
resetCalls();
registry.delayMs = 40; // 接口有往返耗时的样子
emit('user/message', { id: 'web-4', role: 'user', content: [{ type: 'text', text: '界面单段' }] });
emit('assistant/message', { ...assistantText('只有一段'), turn: 6, step: 1 });
emit('turn/end', { turn: 6, reason: { kind: 'completed' } }); // 不等开卡完成
await tick(250);
registry.delayMs = 0;
eq('⑯ 只有一段的外部轮次也只开一张卡', registry.calls.filter((c) => c.kind === 'card.create').length, 1);
eq('⑰ 只有一段时：建一张卡 + 私聊，正文直接作为初始正文（不必再更新）',
  callKinds(), ['card.create', 'message.create']);
eq('⑲ 正文在开卡时就带上，没丢', registry.calls[0].card.body.elements[0].content, '只有一段');
ok('⑳ 没有多余的补发', !registry.calls.some((c) => c.kind === 'message.create' && c.msgType === 'text'));

finish();
