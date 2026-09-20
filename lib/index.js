/**
 * dsh-feishu-assistant — 宿主半边。
 *
 * 用飞书官方 SDK 的长连接接飞书机器人：消息事件与卡片回调都由 DSH 进程主动连出接收，
 * 不需要公网入口。私聊消息先塞进队列，先进先出、一次处理一条，注入指定会话并唤醒它，
 * 会话产出的回答再回写到飞书。
 *
 * 配置分两类，都在 Web 设置页「飞书AI助理」里维护：
 * - 目标会话 ID 走 settings 命名空间（落 $DSH_HOME/settings.yaml）
 * - App ID / App Secret 走凭据存储（落 $DSH_HOME/.credentials.yaml）
 * 两类都可以缺席：缺凭据时插件停用并说明原因，不会阻塞 DSH 启动。
 */

import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import z from '@deepseek-ai/schemastery';
import {
  Client,
  Domain,
} from '@larksuiteoapi/node-sdk';

import { createQueue } from './queue.js';

import {
  APP_ID_REF,
  APP_SECRET_REF,
  ASSISTANT_MESSAGE_EVENT_TYPE,
  DIRECT_CHAT_TYPE,
  INTERACTIVE_MESSAGE_TYPE,
  PAIRING_TTL_MS,
  REPLY_MAX_ATTEMPTS,
  REPLY_RETRY_BASE_MS,
  REPLY_TEXT,
  SETTINGS_NAMESPACE,
  TEXT_MESSAGE_TYPE,
} from './constants.js';
import { createApprovalFlow } from './approval.js';
import { createConnection } from './connection.js';
import { createAgentOpener, createSessionCatalog } from './session-catalog.js';
import { registerSettingRoutes } from './routes.js';
import { requireRef } from './credentials.js';
import { buildApprovalCard, buildApprovalResultCard, callbackCardResponse, toastResponse } from './feishu-cards.js';
import {
  cardOperatorIds,
  messageSenderIds,
  readAssistantText,
  readCardActionValue,
  readMessageText,
} from './feishu-events.js';
import { errorMessage } from './http.js';
import { createPairingCode, normalizePairingText } from './pairing.js';
import { splitReplyText } from './reply.js';

/** Cordis 插件名。 */
export const name = 'dsh-feishu-assistant';

/**
 * 需要的服务：agent 注册表、设置、凭据、Web 服务器（设置页路由）、会话控制器（主动打开目标会话）。
 *
 * sessionController 必须列进来：启动时要靠它 resume 目标会话，而它在 apply 执行时
 * 还没注册好，用 ctx.get 只会拿到 undefined。
 */
export const inject = ['agents', 'settings', 'credentials', 'webServer', 'sessionController'];
/** 普通配置的 schema；带默认值，所以缺席也能加载。 */
const SettingsSchema = z.object({
  sessionId: z.string().default(''),
  managerId: z.string().default(''),
});

/** 补丁层可选的初始值；只在设置里还没有值时作为种子。 */
export const Config = z.object({
  sessionId: z.string().default(''),
  managerId: z.string().default(''),
});

/**
 * 插件入口。
 *
 * @param ctx Cordis 上下文
 * @param config 补丁层给的初始配置（可为空对象）
 */
export async function apply(ctx, config) {
  const logger = ctx.logger('feishu-assistant');
  const agents = ctx.get('agents');
  const credentials = ctx.get('credentials');
  const settings = ctx.get('settings');
  const webServer = ctx.get('webServer');

  /** 运行期配置。 */
  const state = {
    appId: '',
    appSecret: '',
    sessionId: config?.sessionId ?? '',
    managerId: config?.managerId ?? '',
    connected: false,
    lastError: '',
    sessionError: '',
  };

  /** 最近一条待回复的飞书消息 ID：会话产出回答时回复到它上面。 */
  let replyToMessageId = '';

  /**
   * 当前有效的配对码；没有配对进行时为 undefined。
   *
   * 只存在内存里：DSH 重启即失效，不落盘，用完一次就作废。
   */
  let pairing;

  /** 飞书请求队列：先进先出，一次只处理一条，前一条整轮跑完才注入下一条。 */
  const requestQueue = createQueue();

  /** 非管理员请求的审批流程：登记待审批、推卡片、处理点击。 */
  const approvalFlow = createApprovalFlow({
    logger,
    getManagerId: () => state.managerId,
    matchesManager,
    sendReply,
    sendCard,
    enqueue: (messageId, text) => {
      void requestQueue.push(() => handleRequest(messageId, text)).catch((error) => {
        logger.warn(`处理已审批的飞书消息失败：${errorMessage(error)}`);
      });
    },
  });

  /** 当前长连接客户端；未连接时为 undefined。 */
  let wsClient;

  /** 发消息用的 REST 客户端，凭据变化时重建。 */
  let restClient;

  /** 会话目录：给设置页的会话下拉供数。 */
  const catalog = createSessionCatalog({ ctx, agents, logger });

  /** 目标会话打开器：没打开就主动 resume，并把失败原因写回状态。 */
  const opener = createAgentOpener({
    ctx,
    agents,
    logger,
    getSessionId: () => state.sessionId,
    setError: (message) => {
      state.sessionError = message;
    },
  });

  /** 飞书长连接：事件交给 handleIncomingMessage 与审批流程。 */
  const connection = createConnection({
    logger,
    state,
    source: name,
    getCredentials: () => ({ appId: state.appId, appSecret: state.appSecret }),
    onMessage: handleIncomingMessage,
    onCardAction: (data) => approvalFlow.handleCardAction(data),
  });

  // ---------------------------------------------------------------- 设置

  let settingsScope;
  try {
    settingsScope = settings.register(SETTINGS_NAMESPACE, SettingsSchema, { applies: 'live' });
    const stored = settingsScope.get();
    if (stored?.sessionId) state.sessionId = stored.sessionId;
    if (stored?.managerId) state.managerId = stored.managerId;
  } catch (error) {
    logger.warn(`设置注册失败，改用补丁层配置：${errorMessage(error)}`);
  }

  // ---------------------------------------------------------------- 凭据

  /** 从凭据存储解析飞书凭据；缺席是合法状态。 */
  async function loadCredentials() {
    const resolvedAppId = await credentials.resolve(APP_ID_REF);
    const resolvedSecret = await credentials.resolve(APP_SECRET_REF);
    state.appId = resolvedAppId?.value ?? '';
    state.appSecret = resolvedSecret?.value ?? '';
    restClient = state.appId && state.appSecret
      ? new Client({ appId: state.appId, appSecret: state.appSecret, domain: Domain.Feishu })
      : undefined;
  }

  // ---------------------------------------------------------------- 回复飞书

  /**
   * 回复某条飞书消息；失败按 REPLY_MAX_ATTEMPTS 重试，退避间隔随次数递增。
   *
   * 回复目标显式传入，不走全局变量 —— 未授权提示之类不排队发的消息也能安全指定目标。
   *
   * @param messageId 被回复的飞书消息 ID
   * @param text 回复正文
   */
  async function sendReply(messageId, text) {
    if (!restClient) {
      logger.warn('凭据未配置，消息无法回写飞书');
      return;
    }
    if (!messageId) {
      logger.warn('没有可回复的飞书消息，回复被丢弃');
      return;
    }
    // 超过飞书单条文本消息上限的回答按换行切开，分多条发；否则整段会发不出去。
    for (const chunk of splitReplyText(text)) {
      await sendReplyChunk(messageId, chunk);
    }
  }

  /**
   * 发送一段回复；失败按 REPLY_MAX_ATTEMPTS 重试，退避间隔随次数递增。
   *
   * @param messageId 被回复的飞书消息 ID
   * @param text 这一段回复正文
   */
  async function sendReplyChunk(messageId, text) {
    for (let attempt = 1; attempt <= REPLY_MAX_ATTEMPTS; attempt += 1) {
      try {
        await restClient.im.message.reply({
          path: { message_id: messageId },
          data: { msg_type: TEXT_MESSAGE_TYPE, content: JSON.stringify({ text }) },
        });
        return;
      } catch (error) {
        if (attempt === REPLY_MAX_ATTEMPTS) {
          logger.warn(`回复飞书失败，已放弃（尝试 ${attempt} 次）：${errorMessage(error)}`);
          return;
        }
        logger.warn(`回复飞书失败，准备第 ${attempt + 1} 次尝试：${errorMessage(error)}`);
        await delay(REPLY_RETRY_BASE_MS * attempt);
      }
    }
  }

  /**
   * 把会话产出的一段回答回复到当前请求。
   *
   * @param text 回答正文
   */
  async function replyToFeishu(text) {
    await sendReply(replyToMessageId, text);
  }

  // ---------------------------------------------------------------- 长连接

  /**
   * 取当前有效的配对码；已过期就地作废。
   *
   * @returns 有效配对码；没有或已过期时返回 undefined
   */
  function currentPairing() {
    if (!pairing) return undefined;
    if (Date.now() > pairing.expiresAt) {
      pairing = undefined;
      return undefined;
    }
    return pairing;
  }

  /**
   * 判断一条消息是不是配对口令。
   *
   * 忽略空白和连字符、不区分大小写，方便手输。
   *
   * @param text 消息正文
   * @returns 命中时为 true
   */
  function matchPairing(text) {
    const active = currentPairing();
    if (!active) return false;
    return normalizePairingText(text) === active.code;
  }

  /**
   * 完成配对：把发送者加进管理员名单并落盘。
   *
   * 不管写入成败都先作废配对码，避免同一个码被重复使用。
   *
   * @param event 命中口令的飞书消息事件
   */
  async function completePairing(event) {
    pairing = undefined;
    // sender 和 message 是同一层，所以发送者从事件上取，不能从 message 上取。
    const managerId = messageSenderIds(event)[0] ?? '';
    if (!managerId) {
      logger.warn('配对口令命中但取不到发送者 ID，配对未完成');
      return;
    }
    if (managerId === state.managerId) {
      logger.info(`配对成功，管理员未变：${managerId}`);
    } else {
      if (settingsScope) {
        await settingsScope.replace({ sessionId: state.sessionId, managerId });
      }
      state.managerId = managerId;
      logger.info(`配对成功，管理员已设为 ${managerId}`);
    }
    await sendReply(event?.message?.message_id ?? '', `配对成功，你已被设为管理员。\n${managerId}`);
  }

  /**
   * 一组 ID 里是否有当前管理员。
   *
   * 只认一个管理员；open_id / user_id / union_id 任意一个命中就算。
   *
   * @param ids 候选 ID 列表
   * @returns 命中时返回 true
   */
  function matchesManager(ids) {
    return Boolean(state.managerId) && ids.includes(state.managerId);
  }

  /**
   * 发送者是否是管理员。
   *
   * @param event 飞书消息事件
   * @returns 是管理员时返回 true
   */
  function isManager(event) {
    return matchesManager(messageSenderIds(event));
  }

  /**
   * 发一张交互卡片给某个用户。
   *
   * @param openId 接收人 OpenId
   * @param card 卡片对象
   */
  async function sendCard(openId, card) {
    await restClient.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: INTERACTIVE_MESSAGE_TYPE,
        content: JSON.stringify(card),
      },
    });
  }

  /**
   * 把一条飞书消息注入目标会话并唤醒驱动。
   *
   * 会话没打开时先尝试主动打开，失败才丢弃。
   *
   * @param text 消息正文
   * @returns 注入成功时为 true
   */
  async function injectToSession(text) {
    if (!state.sessionId) {
      logger.warn('目标会话未配置，飞书消息被丢弃');
      return false;
    }
    const agent = await opener.ensureAgent();
    if (!agent) {
      logger.warn(`会话 ${state.sessionId} 打不开，本条消息被丢弃`);
      return false;
    }
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    logger.info(`飞书消息已注入会话 ${state.sessionId}`);
    return true;
  }

  /**
   * 处理一条飞书请求：注入目标会话，等这一轮 turn 跑完才返回。
   *
   * 队列保证一次只有一条在跑，所以回复目标可以安全地绑到当前这条消息上。
   *
   * @param messageId 飞书消息 ID，回答回复到它上面
   * @param text 消息正文
   */
  async function handleRequest(messageId, text) {
    replyToMessageId = messageId;
    if (!(await injectToSession(text))) {
      // 会话打不开（没配、或 resume 失败）时请求人已经收到过「正在处理」，得给个交代。
      await sendReply(messageId, REPLY_TEXT.failure);
      return;
    }
    await opener.waitForTurnEnd(state.sessionId);
  }

  // 会话回答回写：DSH 只发已提交的 assistant 消息，没有原始增量，所以一段一段地回。
  ctx.on('session/event', (session, event) => {
    if (!state.sessionId || session?.id !== state.sessionId) return;
    if (event?.type !== ASSISTANT_MESSAGE_EVENT_TYPE) return;
    const text = readAssistantText(event.data);
    if (!text) return;
    void replyToFeishu(text).catch((error) => {
      logger.warn(`回复飞书失败：${errorMessage(error)}`);
    });
  });

  // 设置页改了普通配置：热更新，不需要重连。
  if (settingsScope) {
    ctx.on('settings/updated', (namespace, next) => {
      if (namespace !== SETTINGS_NAMESPACE) return;
      state.sessionId = next?.sessionId ?? '';
      state.managerId = next?.managerId ?? '';
      logger.info(`目标会话已更新为 ${state.sessionId || '(空)'}，管理员 ${state.managerId || '(未配置)'}`);
      // 换了目标会话就顺手把它打开，别等第一条消息才发现没开。
      void opener.ensureAgent();
    });
  }

  /** 设置页状态快照。 */
  async function buildSnapshot() {
    const [appIdInfo, secretInfo] = await Promise.all([
      describeCredential(APP_ID_REF),
      describeCredential(APP_SECRET_REF),
    ]);
    const active = currentPairing();
    return {
      sessionId: state.sessionId,
      managerId: state.managerId,
      sessionLive: Boolean(state.sessionId) && agents.get(state.sessionId) !== undefined,
      sessionError: state.sessionError,
      pairing: active ? { code: active.code, expiresAt: active.expiresAt } : null,
      appIdConfigured: appIdInfo.configured,
      appSecretConfigured: secretInfo.configured,
      appIdSource: appIdInfo.source ?? '',
      appIdWritable: appIdInfo.writable,
      appSecretWritable: secretInfo.writable,
      connected: state.connected,
      lastError: state.lastError,
    };
  }

  /**
   * 查询一个凭据的配置状态。
   *
   * describe 只回状态与来源，不回值，正好适合直接下发给设置页。
   *
   * @param name 凭据名
   * @returns 配置状态与来源；查询失败时按未配置处理，不打断状态页
   */
  async function describeCredential(name) {
    try {
      return await credentials.describe(requireRef(name));
    } catch (error) {
      logger.warn(`查询凭据 ${name} 状态失败：${errorMessage(error)}`);
      return { configured: false, source: '', writable: false };
    }
  }

  // ---------------------------------------------------------------- 设置页动作

  /** 生成新的配对口令；每次覆盖上一个，旧口令立刻失效。 */
  async function startPairing() {
    pairing = { code: createPairingCode(), expiresAt: Date.now() + PAIRING_TTL_MS };
    logger.info('已生成新的配对口令，等待在飞书里私聊机器人');
  }

  /**
   * 保存设置页的普通配置。
   *
   * 没带的字段沿用当前值：设置页漏传时不能把另一项清掉。
   *
   * @param body 请求体
   */
  async function saveConfig(body) {
    const current = settingsScope?.get() ?? {};
    const sessionId = typeof body?.sessionId === 'string'
      ? body.sessionId.trim()
      : (current.sessionId ?? '');
    const managerId = typeof body?.managerId === 'string'
      ? body.managerId.trim()
      : (current.managerId ?? '');
    if (settingsScope) await settingsScope.replace({ sessionId, managerId });
    state.sessionId = sessionId;
    state.managerId = managerId;
  }

  /**
   * 保存设置页写入的凭据，再按新凭据重建连接。
   *
   * @param body 请求体
   */
  async function saveCredentials(body) {
    // 空字符串表示「不改这一项」：清空要用 unset，这里不支持。
    if (typeof body?.appId === 'string' && body.appId.trim()) {
      await credentials.set(requireRef(APP_ID_REF), body.appId.trim());
    }
    if (typeof body?.appSecret === 'string' && body.appSecret.trim()) {
      await credentials.set(requireRef(APP_SECRET_REF), body.appSecret.trim());
    }
    await loadCredentials();
    await connection.start();
  }

  // ---------------------------------------------------------------- 消息分流

  /**
   * 处理一条飞书消息事件：配对 → 管理员直通 → 其余走审批。
   *
   * @param data 飞书消息事件
   */
  async function handleIncomingMessage(data) {
    const message = data?.message;
    if (message?.chat_type !== DIRECT_CHAT_TYPE) return;
    const text = readMessageText(message);
    if (!text) return;
    // 配对判定必须在管理员判定之前：名单为空时口令消息也得能进来。
    if (matchPairing(text)) {
      void completePairing(data).catch((error) => {
        logger.warn(`配对口令处理失败：${errorMessage(error)}`);
      });
      return;
    }
    // 管理员直通请求队列；其他人都要管理员在卡片上点头。
    if (isManager(data)) {
      // 只入队，不等：队列按先进先出逐条处理，前一条整轮跑完才注入下一条。
      void requestQueue.push(() => handleRequest(message.message_id, text)).catch((error) => {
        logger.warn(`处理飞书消息失败：${errorMessage(error)}`);
      });
      return;
    }
    void approvalFlow.requestApproval(data, text).catch((error) => {
      logger.warn(`提交审批失败：${errorMessage(error)}`);
    });
  }

  // ---------------------------------------------------------------- 设置页路由

  if (webServer) {
    registerSettingRoutes({
      ctx,
      webServer,
      name,
      actions: {
        buildSnapshot,
        listSessions: catalog.listSessions,
        saveConfig,
        saveCredentials,
        startPairing,
      },
    });
  }

  // ---------------------------------------------------------------- 启动

  await loadCredentials();
  await connection.start();

  // 启动就把目标会话拉起来，这样飞书第一条消息不用先有人在界面上点开它。
  await opener.ensureAgent();

  ctx.effect(() => () => connection.stop());
}
