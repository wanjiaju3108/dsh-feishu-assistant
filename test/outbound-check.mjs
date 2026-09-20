/**
 * 出站发送器的返回值语义：卡片发出去要返回 true、被拒要退回文本且**只退一次**、
 * 没有目标时不要发。
 *
 * 这层曾经踩过：给 sendMessage 传了"折成布尔值"的发送器，于是它读不到响应体里的 message_id，
 * 把成功的卡片发送当成失败——失败文案被发了两次。
 */

import { createCheck } from './harness.mjs';

const { createOutbound } = await import('../lib/feishu-outbound.js');

const { eq, finish } = createCheck();

/** 假飞书：可指定卡片消息（interactive）是否被拒。 */
function fakeFeishu({ rejectCard = false } = {}) {
  const calls = [];
  let msgSeq = 0;
  const client = {
    im: { message: {
      reply: async (args) => {
        const content = JSON.parse(args.data.content);
        if (rejectCard && args.data.msg_type === 'interactive') {
          calls.push({ kind: 'reply-rejected', msgType: args.data.msg_type });
          return { code: 99991672, msg: 'no scope' };
        }
        calls.push({ kind: 'reply', messageId: args.path.message_id, msgType: args.data.msg_type, content });
        msgSeq += 1;
        return { code: 0, data: { message_id: `m${msgSeq}` } };
      },
      create: async (args) => {
        calls.push({ kind: 'create', receiveId: args.data.receive_id, msgType: args.data.msg_type, content: JSON.parse(args.data.content) });
        msgSeq += 1;
        return { code: 0, data: { message_id: `m${msgSeq}` } };
      },
    } },
  };
  return { calls, client };
}

const logger = { warn: () => {}, info: () => {}, error: () => {} };
const outboundFor = (client) => createOutbound({ logger, getClient: () => client });

// 1) 正常回复：卡片发出去，返回 true，不退回文本
{
  const { calls, client } = fakeFeishu();
  const outbound = outboundFor(client);
  eq('① 回复成功返回 true', await outbound.replyTo('om_1', '短回答'), true);
  eq('② 只发了一张卡片', calls.map((c) => `${c.kind}/${c.msgType}`), ['reply/interactive']);
}

// 2) 卡片被拒：退回文本，且只退一次
{
  const { calls, client } = fakeFeishu({ rejectCard: true });
  const outbound = outboundFor(client);
  eq('③ 卡片被拒时退回文本并返回 true', await outbound.replyTo('om_1', '短回答'), true);
  eq('④ 被拒后只补一条文本', calls.map((c) => `${c.kind}/${c.msgType}`), ['reply-rejected/interactive', 'reply/text']);
}

// 3) 主动私聊文本：发出去返回 true；没有收件人时不发、返回 false
{
  const { calls, client } = fakeFeishu();
  const outbound = outboundFor(client);
  eq('⑤ 私聊文本返回 true', await outbound.sendText('ou_x', '主动消息'), true);
  eq('⑥ 私聊发给了那个人', calls.map((c) => `${c.kind}/${c.receiveId}`), ['create/ou_x']);
  eq('⑦ 没有收件人时返回 false', await outbound.sendText('', '没人收'), false);
  eq('⑧ 没有收件人时不发请求', calls.length, 1);
}

// 4) 主动私聊卡片
{
  const { calls, client } = fakeFeishu();
  const outbound = outboundFor(client);
  eq('⑨ 私聊卡片返回 true', await outbound.sendCard('ou_x', { schema: '2.0', body: {} }), true);
  eq('⑩ 发的是内联卡片', calls.map((c) => `${c.kind}/${c.msgType}`), ['create/interactive']);
}

// 5) 没有可回复的消息：不硬发，返回 false
{
  const { calls, client } = fakeFeishu();
  const outbound = outboundFor(client);
  eq('⑪ 没有可回复的消息时返回 false', await outbound.replyTo('', '没人可回'), false);
  eq('⑫ 也不该发请求', calls.length, 0);
}

finish();
