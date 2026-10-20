/**
 * 设置页后端的回归：
 *
 * - saveConfig 对 AgentId 的解析（空串、非整数、小于等于 0 都变成 0）
 * - 状态快照不返回 Secret，只返回配没配
 * - 只存企微 Secret 时不重建飞书长连接
 * - apply 把发送器注册到 ctx 的 feishuWecomSender 上
 */

import { Readable } from 'node:stream';

import { createAgent, createCheck, registry, startPlugin } from './harness.mjs';

const { eq, ok, finish } = createCheck();

/** 一条假的 HTTP 请求：guard 只读 socket/method/headers，readJsonBody 只读流。 */
function request(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.socket = { remoteAddress: '127.0.0.1' };
  stream.headers = {};
  return stream;
}

/** 收集响应的假 res。 */
function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(text) { this.body = text; },
  };
}

/** 调一条设置页路由。 */
async function call(handler, method, body) {
  const res = response();
  await handler(request(method, body), res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

const { routes, provided, credentialsSet } = await startPlugin({ agent: createAgent() });
ok('① 设置页路由注册完成', routes.size >= 4);

// 1) AgentId 解析
{
  const handler = routes.get('/dsh-feishu-assistant/config');
  eq('② 空 AgentId 变成 0', (await call(handler, 'PUT', { wecomAgentId: '' })).body.wecomAgentId, 0);
  eq('③ 非数字 AgentId 变成 0', (await call(handler, 'PUT', { wecomAgentId: 'abc' })).body.wecomAgentId, 0);
  eq('④ 负数 AgentId 变成 0', (await call(handler, 'PUT', { wecomAgentId: -5 })).body.wecomAgentId, 0);
  eq('⑤ 合法 AgentId 保留', (await call(handler, 'PUT', { wecomAgentId: '1000008' })).body.wecomAgentId, 1000008);
}

// 2) 快照不返回 Secret
{
  const handler = routes.get('/dsh-feishu-assistant/state');
  const state = await call(handler, 'GET');
  eq('⑥ 快照不返回 Secret 值', Object.prototype.hasOwnProperty.call(state.body, 'wecomSecret'), false);
  ok('⑦ 只返回配没配', typeof state.body.wecomSecretConfigured === 'boolean');
}

// 3) 只存企微 Secret 不重连飞书
{
  const before = registry.ws;
  const handler = routes.get('/dsh-feishu-assistant/credentials');
  const result = await call(handler, 'PUT', { wecomSecret: 'secret-x' });
  eq('⑧ 企微 Secret 写入成功', result.status, 200);
  eq('⑨ 写入的是新凭据名',
    credentialsSet.at(-1), { ref: 'FEISHU_ASSISTANT_WECOM_SECRET', value: 'secret-x' });
  eq('⑩ 没有重建飞书长连接', registry.ws, before);
}

// 4) apply 注册了 feishuWecomSender
{
  ok('⑪ 注册了 feishuWecomSender', provided.has('feishuWecomSender'));
  ok('⑫ 发送器带 sendText', typeof provided.get('feishuWecomSender')?.sendText === 'function');
}

finish();
