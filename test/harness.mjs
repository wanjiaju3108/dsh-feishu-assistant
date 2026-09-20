/**
 * 测试脚手架：假 SDK 的挂载、断言、假 agent、假 Cordis 上下文。
 *
 * 各用例只关心自己的场景，公共部分（注册 hook、建 ctx、派发飞书事件、断言计数）都在这里。
 */

import { realpathSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const url = (relative) => pathToFileURL(realpathSync(fileURLToPath(new URL(relative, import.meta.url)))).href;

register(url('./lark-hooks.mjs'));
const { registry } = await import(url('./fake-lark.mjs'));

export { registry };

/** 等一拍，让插件里的异步流程跑完。 */
export function tick(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 断言收集器：跑完调用 finish()，有失败就以非 0 退出。 */
export function createCheck() {
  let bad = 0;
  return {
    eq(name, actual, expected) {
      if (JSON.stringify(actual) === JSON.stringify(expected)) {
        console.log(`ok   ${name}`);
        return;
      }
      bad += 1;
      console.log(`FAIL ${name}\n  want ${JSON.stringify(expected)}\n  got  ${JSON.stringify(actual)}`);
    },
    ok(name, condition) {
      if (condition) {
        console.log(`ok   ${name}`);
        return;
      }
      bad += 1;
      console.log(`FAIL ${name}`);
    },
    finish() {
      console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
      process.exit(bad ? 1 : 0);
    },
  };
}

/** 记账日志：用例可以断言"有没有留下告警"。 */
export function createLogger() {
  const lines = { info: [], warn: [], error: [] };
  const push = (kind) => (line) => lines[kind].push(String(line));
  return { lines, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

/**
 * 假 agent。
 *
 * @param options.status 初始状态；`running` 用来模拟"界面那一轮正在跑"
 * @param options.manualIdle true 时 `whenIdle()` 要等 `becomeIdle()` 才 resolve
 */
export function createAgent({ id = 'sess-1', status = 'idle', manualIdle = false } = {}) {
  const waiters = [];
  const agent = {
    id,
    status,
    followups: [],
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 } },
    followup(message) { this.followups.push(message); },
    whenIdle() {
      if (!manualIdle) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
  /** 手动模式：把会话置成空闲并放行等待者。 */
  agent.becomeIdle = async () => {
    agent.status = 'idle';
    for (const resolve of waiters.splice(0)) resolve();
    await tick(50);
  };
  return agent;
}

/**
 * 起一个插件实例（真实 `apply()`，只有 SDK 和 ctx 是假的）。
 *
 * @param options.agent 目标会话的假 agent
 * @param options.hasAgent 会话"在不在"；`broken-session` 用例用它模拟打不开
 * @param options.log 记账日志（默认新建）
 * @param options.config 传给 `apply()` 的配置
 * @returns 句柄：ctx / agent / log / emit / incoming
 */
export async function startPlugin({ agent = createAgent(), hasAgent = () => true, log = createLogger(), config } = {}) {
  const handlers = new Map();
  const services = {
    agents: { get: (id) => (hasAgent() && id === agent.id ? agent : undefined) },
    credentials: { resolve: async (ref) => ({ value: ref === 'FEISHU_APP_ID' ? 'cli_stub' : 'secret_stub' }) },
    settings: { register: () => ({ get: () => ({}), replace: async () => {} }) },
  };
  const ctx = {
    logger: () => log.logger,
    get: (name) => services[name],
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    inject: () => {},
    effect: (fn) => { fn(); },
  };

  const plugin = await import('../lib/index.js');
  await plugin.apply(ctx, { sessionId: agent.id, managerId: 'ou_boss', persona: '你是助理', ...config });

  /** 派发一条会话事件。 */
  const emit = (type, data) => {
    for (const handler of handlers.get('session/event') ?? []) handler({ id: agent.id }, { type, data });
  };
  /** 派发一条管理员私聊消息。 */
  const incoming = (messageId, text) => registry.dispatcher.dispatch('im.message.receive_v1', {
    message: {
      chat_type: 'p2p',
      message_id: messageId,
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: 'ou_boss' } },
  });

  return { ctx, agent, log, emit, incoming, plugin };
}

/** 一条 assistant 消息事件的数据（正文按 step 提交）。 */
export function assistantText(value) {
  return { turn: 0, step: 0, message: { content: [{ type: 'text', text: value }] } };
}

/** 当前记账里的调用类型序列。 */
export function callKinds() {
  return registry.calls.map((call) => call.kind);
}

/** 清空记账。 */
export function resetCalls() {
  registry.calls.length = 0;
}
