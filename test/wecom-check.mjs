/**
 * 企微提醒的发送逻辑：
 *
 * - 开关关闭、配置不全、Secret 缺失时不发任何请求
 * - 正常发送：gettoken → message/send，body 是 touser / msgtype / agentid / text
 * - token 复用；正文按 2048 UTF-8 字节切分
 * - 接口 errcode 非 0 时返回 false
 */

import { createCheck } from './harness.mjs';

const { createWecomSender } = await import('../lib/wecom.js');

const { eq, ok, finish } = createCheck();

const logger = { warn: () => {}, info: () => {}, error: () => {} };

/** 装一个假 fetch；handler 按调用返回 { body, ok, status }。 */
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const call = {
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const result = handler(call) ?? {};
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      text: async () => JSON.stringify(result.body ?? {}),
    };
  };
  return calls;
}

/** 默认响应：gettoken 成功，message/send 成功。 */
function defaultHandler(call) {
  if (call.path === '/cgi-bin/gettoken') {
    return { body: { errcode: 0, access_token: 'token-1', expires_in: 7200 } };
  }
  if (call.path === '/cgi-bin/message/send') return { body: { errcode: 0, errmsg: 'ok' } };
  return {};
}

const credentials = {
  resolve: async (ref) => ({ value: ref === 'FEISHU_ASSISTANT_WECOM_SECRET' ? 'secret-1' : '' }),
};

const senderFor = (config, creds = credentials) => createWecomSender({
  logger,
  credentials: creds,
  getConfig: () => config,
});

// 1) 开关关闭：不发请求
{
  const calls = installFetch(defaultHandler);
  const sender = senderFor({ enabled: false, corpId: 'ww', agentId: 1000008, toUser: 'u1' });
  eq('① 开关关闭时不发请求', [await sender.sendText('hello'), calls.length], [false, 0]);
}

// 2) 配置不全：不发请求
{
  const calls = installFetch(defaultHandler);
  const sender = senderFor({ enabled: true, corpId: '', agentId: 1000008, toUser: 'u1' });
  eq('② 缺 corpId 时不发请求', [await sender.sendText('hello'), calls.length], [false, 0]);
}

// 3) 正常发送 + token 复用
{
  const calls = installFetch(defaultHandler);
  const sender = senderFor({ enabled: true, corpId: 'ww', agentId: 1000008, toUser: 'u1' });
  eq('③ 正常发送返回 true', await sender.sendText('hello'), true);
  eq('④ 先取 token 再发消息', calls.map((c) => c.path), ['/cgi-bin/gettoken', '/cgi-bin/message/send']);
  eq('⑤ message/send 的 body', calls[1].body, {
    touser: 'u1',
    msgtype: 'text',
    agentid: 1000008,
    text: { content: 'hello' },
    safe: 0,
  });
  eq('⑥ token 放在 query 里', calls[1].query.access_token, 'token-1');

  eq('⑦ 第二次发送复用缓存 token', await sender.sendText('again'), true);
  eq('⑧ gettoken 只请求一次', calls.filter((c) => c.path === '/cgi-bin/gettoken').length, 1);
  eq('⑨ 第二次只发消息', calls.filter((c) => c.path === '/cgi-bin/message/send').length, 2);
}

// 4) 正文按 2048 UTF-8 字节切分
{
  const calls = installFetch(defaultHandler);
  const sender = senderFor({ enabled: true, corpId: 'ww', agentId: 1000008, toUser: 'u1' });
  const text = '汉'.repeat(1000); // 3000 UTF-8 字节
  eq('⑩ 长正文发送成功', await sender.sendText(text), true);
  const sends = calls.filter((c) => c.path === '/cgi-bin/message/send');
  ok(`⑪ 按 2048 字节切成 ${sends.length} 段`, sends.length >= 2);
  ok('⑫ 每段都不超过 2048 字节',
    sends.every((c) => Buffer.byteLength(c.body.text.content, 'utf8') <= 2048));
  eq('⑬ 拼起来和原文一致', sends.map((c) => c.body.text.content).join(''), text);
}

// 5) Secret 缺失：不发请求
{
  const calls = installFetch(defaultHandler);
  const sender = senderFor(
    { enabled: true, corpId: 'ww', agentId: 1000008, toUser: 'u1' },
    { resolve: async () => undefined },
  );
  eq('⑭ Secret 缺失时不发请求', [await sender.sendText('hello'), calls.length], [false, 0]);
}

// 6) 接口 errcode 非 0
{
  installFetch((call) => {
    if (call.path === '/cgi-bin/gettoken') {
      return { body: { errcode: 0, access_token: 'token-1', expires_in: 7200 } };
    }
    return { body: { errcode: 40001, errmsg: 'invalid credential' } };
  });
  const sender = senderFor({ enabled: true, corpId: 'ww', agentId: 1000008, toUser: 'u1' });
  eq('⑮ message/send 报错时返回 false', await sender.sendText('hello'), false);
}

// 7) corpId 变了要重新取 token
{
  const calls = installFetch(defaultHandler);
  const config = { enabled: true, corpId: 'ww-1', agentId: 1000008, toUser: 'u1' };
  const sender = senderFor(config);
  await sender.sendText('one');
  config.corpId = 'ww-2';
  await sender.sendText('two');
  eq('⑯ corpId 变了重新取 token',
    calls.filter((c) => c.path === '/cgi-bin/gettoken').length, 2);
}

// 8) 第二个参数可以覆盖配置里的接收人
{
  const calls = installFetch(defaultHandler);
  const sender = senderFor({ enabled: true, corpId: 'ww', agentId: 1000008, toUser: 'u1' });
  eq('⑰ 第二个参数覆盖接收人时返回 true', await sender.sendText('hello', 'u2'), true);
  eq('⑱ touser 用覆盖值', calls[1].body.touser, 'u2');
}

finish();

