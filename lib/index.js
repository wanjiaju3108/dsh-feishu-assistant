/**
 * dsh-feishu-assistant — 宿主半边。
 *
 * 用飞书官方 SDK 的长连接接飞书机器人：消息事件与卡片回调都由 DSH 进程主动连出接收，
 * 不需要公网入口。私聊消息注入指定会话并唤醒它，会话产出的回答再回写到飞书。
 */

import { randomUUID } from 'node:crypto';

import {
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from '@larksuiteoapi/node-sdk';

/** Cordis 插件名。 */
export const name = 'dsh-feishu-assistant';

/** 需要的服务：agent 注册表，用来拿目标会话的驱动器。 */
export const inject = ['agents'];

/** 飞书接收消息事件类型。 */
const MESSAGE_RECEIVE_EVENT_TYPE = 'im.message.receive_v1';

/** 飞书卡片按钮回调事件类型。 */
const CARD_ACTION_EVENT_TYPE = 'card.action.trigger';

/** 飞书文本消息类型。 */
const TEXT_MESSAGE_TYPE = 'text';

/** 只处理私聊：群聊要 @ 机器人，把内容转进会话会打扰其他人。 */
const DIRECT_CHAT_TYPE = 'p2p';

/** 会话产出的 assistant 消息事件类型。 */
const ASSISTANT_MESSAGE_EVENT_TYPE = 'assistant/message';

/**
 * 存活探测窗口（秒）。
 *
 * SDK 默认关闭该探测（只等 socket 层报错），飞书侧静默断连时不会触发重连，
 * 表现为机器人突然不再响应。这里显式打开。
 */
const PING_TIMEOUT_SECONDS = 120;

/**
 * 插件入口。
 *
 * @param ctx Cordis 上下文
 * @param config 插件配置：appId、appSecret、sessionId
 */
export function apply(ctx, config) {
  const { appId, appSecret, sessionId } = config ?? {};
  if (!appId || !appSecret || !sessionId) {
    throw new Error('dsh-feishu-assistant 需要配置 appId、appSecret 与 sessionId');
  }

  const logger = ctx.logger('feishu-assistant');

  /** 发消息用的 REST 客户端；长连接只负责收。 */
  const restClient = new Client({ appId, appSecret, domain: Domain.Feishu });

  /** 最近一条待回复的飞书消息 ID：会话产出回答时回复到它上面。 */
  let replyToMessageId = '';

  /** 把一条飞书消息注入目标会话并唤醒驱动。 */
  function injectToSession(text) {
    const agent = ctx.agents.get(sessionId);
    if (!agent) {
      logger.warn(`会话 ${sessionId} 没有活动的 agent，本条消息被丢弃`);
      return;
    }
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    logger.info(`飞书消息已注入会话 ${sessionId}`);
  }

  /** 回复飞书原消息。 */
  async function replyToFeishu(text) {
    if (!replyToMessageId) {
      logger.warn('没有可回复的飞书消息，回答被丢弃');
      return;
    }
    await restClient.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { msg_type: TEXT_MESSAGE_TYPE, content: JSON.stringify({ text }) },
    });
  }

  const eventDispatcher = new EventDispatcher({});
  eventDispatcher.register({
    [MESSAGE_RECEIVE_EVENT_TYPE]: async (data) => {
      const message = data?.message;
      if (message?.chat_type !== DIRECT_CHAT_TYPE) return;
      const text = readMessageText(message);
      if (!text) return;
      replyToMessageId = message.message_id;
      injectToSession(text);
    },
    [CARD_ACTION_EVENT_TYPE]: async () => ({
      toast: { type: 'info', content: '已收到操作' },
    }),
  });

  // 回答回写：DSH 只发已提交的 assistant 消息，没有原始增量，所以一段一段地回。
  ctx.on('session/event', (session, event) => {
    if (session?.id !== sessionId || event?.type !== ASSISTANT_MESSAGE_EVENT_TYPE) return;
    const text = readAssistantText(event.data);
    if (!text) return;
    void replyToFeishu(text).catch((error) => {
      logger.warn(`回复飞书失败：${error?.message ?? error}`);
    });
  });

  const wsClient = new WSClient({
    appId,
    appSecret,
    domain: Domain.Feishu,
    loggerLevel: LoggerLevel.info,
    source: name,
    autoReconnect: true,
    wsConfig: { pingTimeout: PING_TIMEOUT_SECONDS },
    onReady: () => logger.info('飞书长连接已建立'),
    onReconnecting: () => logger.warn('飞书长连接断开，开始重连'),
    onReconnected: () => logger.info('飞书长连接已重连'),
    onError: (error) => logger.error(`飞书长连接终止：${error?.message ?? error}`),
  });
  void wsClient.start({ eventDispatcher });

  ctx.effect(() => () => wsClient.close({ force: true }));
}

/**
 * 取飞书文本消息的正文。
 *
 * @param message 飞书消息对象
 * @returns 去掉首尾空白的正文；不是文本消息或解析失败时返回空串
 */
function readMessageText(message) {
  if (message?.message_type !== TEXT_MESSAGE_TYPE) return '';
  try {
    return (JSON.parse(message.content ?? '{}').text ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 取 assistant 消息里的文本块。
 *
 * @param eventData assistant/message 事件的数据
 * @returns 拼接后的正文；没有文本块时返回空串
 */
function readAssistantText(eventData) {
  const content = eventData?.message?.content ?? eventData?.content ?? [];
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}
