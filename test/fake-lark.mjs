/**
 * 假的 @larksuiteoapi/node-sdk。
 *
 * 长连接事件可以手动派发、REST 调用全部记账，这样测试不打真飞书也能跑通
 * 「收到消息 → 注入会话 → 回写飞书」的整条链路。配合 `lark-hooks.mjs` 把插件里的
 * `@larksuiteoapi/node-sdk` 换成本文件。
 */

export const Domain = { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' };
export const LoggerLevel = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

/** 记账与句柄：测试从这里读调用序列、派发事件。 */
export const registry = { calls: [], dispatcher: undefined, ws: undefined, seq: { card: 0, msg: 0 }, delayMs: 0 };

/** 需要模拟"接口有往返耗时"时用它：延迟期间可以发生别的事件（例如 turn/end）。 */
async function pause() {
  if (registry.delayMs) await new Promise((resolve) => setTimeout(resolve, registry.delayMs));
}

export class EventDispatcher {
  constructor() {
    this.handlers = new Map();
    registry.dispatcher = this;
  }

  register(map) {
    for (const [type, handler] of Object.entries(map)) this.handlers.set(type, handler);
  }

  /** 派发一条事件给插件，返回处理结果。 */
  async dispatch(type, data) {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`插件没有注册 ${type}`);
    return handler(data);
  }
}

export class WSClient {
  constructor(options) {
    this.options = options;
    registry.ws = this;
  }

  async start({ eventDispatcher }) {
    this.dispatcher = eventDispatcher;
    this.options?.onReady?.();
  }

  close() {}
}

export class Client {
  constructor(options) {
    this.options = options;
    this.cardkit = {
      v1: {
        card: {
          create: async ({ data }) => {
            await pause();
            registry.calls.push({ kind: 'card.create', card: JSON.parse(data.data) });
            registry.seq.card += 1;
            return { code: 0, data: { card_id: `c${registry.seq.card}` } };
          },
          settings: async ({ path, data }) => {
            await pause();
            registry.calls.push({
              kind: 'card.settings',
              cardId: path.card_id,
              seq: data.sequence,
              settings: JSON.parse(data.settings),
            });
            return { code: 0, data: {} };
          },
        },
        cardElement: {
          // 当前用的：整块替换组件（非流式）
          update: async ({ path, data }) => {
            await pause();
            registry.calls.push({
              kind: 'element.update',
              cardId: path.card_id,
              elementId: path.element_id,
              seq: data.sequence,
              element: JSON.parse(data.element),
            });
            return { code: 0, data: {} };
          },
          // 流式接口：插件已经不用了，留着是为了让"误调用"暴露出来
          content: async ({ path, data }) => {
            await pause();
            registry.calls.push({
              kind: 'element.content',
              cardId: path.card_id,
              elementId: path.element_id,
              seq: data.sequence,
              content: data.content,
            });
            return { code: 0, data: {} };
          },
        },
      },
    };
    this.im = {
      message: {
        reply: async ({ path, data }) => {
          await pause();
          registry.calls.push({
            kind: 'message.reply',
            messageId: path.message_id,
            msgType: data.msg_type,
            content: JSON.parse(data.content),
          });
          registry.seq.msg += 1;
          return { code: 0, data: { message_id: `m${registry.seq.msg}` } };
        },
        create: async ({ params, data }) => {
          await pause();
          registry.calls.push({
            kind: 'message.create',
            receiveId: data.receive_id,
            receiveIdType: params?.receive_id_type,
            msgType: data.msg_type,
            content: JSON.parse(data.content),
          });
          registry.seq.msg += 1;
          return { code: 0, data: { message_id: `m${registry.seq.msg}` } };
        },
      },
    };
  }
}
