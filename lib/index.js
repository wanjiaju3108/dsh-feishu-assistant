/**
 * dsh-feishu-assistant — 宿主半边。
 *
 * 用飞书官方 SDK 的长连接接飞书机器人：消息事件与卡片回调都由 DSH 进程主动连出接收，
 * 不需要公网入口。私聊消息先塞进队列，先进先出、一次处理一条，注入指定会话并唤醒它，
 * 会话产出的回答再回写到飞书。
 *
 * 配置分三类，都在 Web 设置页「飞书AI助理」里维护：
 * - 目标会话 ID 走 settings 命名空间（落 $DSH_HOME/settings.yaml）
 * - App ID / App Secret 走凭据存储（落 $DSH_HOME/.credentials.yaml）
 * - 人设内容本身也走 settings 命名空间；用户可以在设置页里写，或从本地文件导入
 * 三类都可以缺席：缺凭据时插件停用并说明原因，不会阻塞 DSH 启动。
 */

import { randomInt, randomUUID } from 'node:crypto';
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
  MANAGER_ALERT_SESSION_UNAVAILABLE,
  PAIRING_TTL_MS,
  REPLY_TEXT,
  SETTINGS_NAMESPACE,
} from './constants.js';
import { createApprovalFlow } from './approval.js';
import { createConnection } from './connection.js';
import { createOutbound } from './feishu-outbound.js';
import { createAgentOpener, createSessionCatalog } from './session-catalog.js';
import { MAX_PERSONA_BYTES, createPersonaInjector } from './persona.js';
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

/** Cordis 插件名。 */
export const name = 'dsh-feishu-assistant';

/**
 * 需要的服务：agent 注册表、设置、凭据、Web 服务器（设置页路由）。
 *
 * sessionController（主动打开目标会话）刻意不列进来：它由 @deepseek-ai/dsh-api-session-controller
 * 提供，只有挂了那个包的 profile 才有。列进 inject 会让插件在其他 profile 里永远等不到依赖、
 * 静默不加载；改成等它出现再拉起会话。
 */
export const inject = ['agents', 'settings', 'credentials', 'webServer'];

/** 普通配置的 schema；带默认值，所以缺席也能加载。 */
const SettingsSchema = z.object({
  sessionId: z.string().default(''),
  managerId: z.string().default(''),
  persona: z.string().default(''),
  personaName: z.string().default(''),
});

/** 人设来源文件名最长留几个字符；只是给人看的，别让设置页被超长文件名撑爆。 */
const PERSONA_NAME_MAX_CHARS = 200;

/** 补丁层可选的初始值；只在设置里还没有值时作为种子。 */
export const Config = z.object({
  sessionId: z.string().default(''),
  managerId: z.string().default(''),
  persona: z.string().default(''),
  personaName: z.string().default(''),
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
    /** 「飞书AI助理模式」的人设内容；空串表示这个模式没开。 */
    persona: config?.persona ?? '',
    /** 生效中的人设来自哪个文件；只用来在设置页上说清"现在生效的是哪一份"。 */
    personaName: config?.personaName ?? '',
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

  /** 发消息用的 REST 客户端，凭据变化时重建。 */
  let restClient;

  /** 出站发送器：回复、主动私聊文本、主动私聊卡片。 */
  const outbound = createOutbound({ logger, getClient: () => restClient });

  /** 非管理员请求的审批流程：登记待审批、推卡片、处理点击。 */
  const approvalFlow = createApprovalFlow({
    logger,
    getManagerId: () => state.managerId,
    matchesManager,
    sendReply: outbound.replyTo,
    sendCard: outbound.sendCard,
    enqueue: (messageId, text) => {
      void requestQueue.push(() => handleRequest(messageId, text, false)).catch((error) => {
        logger.warn(`处理已审批的飞书消息失败：${errorMessage(error)}`);
      });
    },
  });

  /** 当前长连接客户端；未连接时为 undefined。 */
  let wsClient;

  /** 最近一次已告知管理员的会话失败原因；同一条不重复打扰。 */
  let lastSessionAlert = '';

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
      // 同一条失败只主动告知一次；会话恢复（message 变成空串）之后再坏会重新告知。
      if (message === lastSessionAlert) return;
      lastSessionAlert = message;
      if (!message) return;
      void notifyManager(`${MANAGER_ALERT_SESSION_UNAVAILABLE}\n${message}`).catch((error) => {
        logger.warn(`告知管理员会话不可用失败：${errorMessage(error)}`);
      });
    },
  });

  /** 人设注入器：把配置里的人设内容挂到目标会话上。 */
  const persona = createPersonaInjector({ logger });

  /**
   * 把当前人设同步到目标会话：有内容就挂上，清空了就撤掉。
   *
   * @param agent 目标会话的 agent；拿不到时只做状态核对
   * @returns 挂上或本来就是这一份时为 true
   */
  function syncPersona(agent) {
    if (!state.persona) {
      persona.release(state.sessionId);
      return false;
    }
    return persona.sync(agent, state.sessionId, state.persona);
  }

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
    if (typeof stored?.persona === 'string') state.persona = stored.persona;
    if (typeof stored?.personaName === 'string') state.personaName = stored.personaName;
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
   * 把会话产出的一段回答回复到当前请求。
   *
   * @param text 回答正文
   */
  async function replyToFeishu(text) {
    await outbound.replyTo(replyToMessageId, text);
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
    await outbound.replyTo(event?.message?.message_id ?? '', `配对成功，你已被设为管理员。\n${managerId}`);
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
   * 私聊告知管理员一条文本。
   *
   * @param text 消息正文
   */
  async function notifyManager(text) {
    await outbound.sendText(state.managerId, text);
  }

  /**
   * 把一条飞书消息注入目标会话并唤醒驱动。
   *
   * 注入前先把人设同步一遍：用户可能刚改完文件，也可能把目标会话换成了另一个，
   * 这两件事都必须在这一条消息生效之前完成。
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
    // 人设是空的就说明这个模式没开，注入进去只会让人设凭空消失，不如直接拦住。
    if (!syncPersona(agent)) {
      logger.warn('人设内容为空，飞书AI助理模式没开，本条消息被丢弃');
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
   * @param fromManager 是不是管理员发的
   */
  async function handleRequest(messageId, text, fromManager) {
    replyToMessageId = messageId;
    if (!(await injectToSession(text))) {
      // 没法注入时必须给个交代：管理员能自己修，给他指路；请求人只给通用失败文案。
      const reason = state.sessionError || !state.sessionId
        ? REPLY_TEXT.sessionUnavailable
        : REPLY_TEXT.personaUnavailable;
      await outbound.replyTo(messageId, fromManager ? reason : REPLY_TEXT.failure);
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
      const previousSessionId = state.sessionId;
      state.sessionId = next?.sessionId ?? '';
      state.managerId = next?.managerId ?? '';
      state.persona = typeof next?.persona === 'string' ? next.persona : '';
      state.personaName = typeof next?.personaName === 'string' ? next.personaName : '';
      logger.info(`目标会话已更新为 ${state.sessionId || '(空)'}，管理员 ${state.managerId || '(未配置)'}`);
      if (previousSessionId !== state.sessionId) persona.release(previousSessionId);
      // 换了目标会话就顺手把它打开，别等第一条消息才发现没开。
      void openAndSync();
    });
  }

  /**
   * 打开目标会话并按当前人设同步一遍。
   *
   * @returns 目标会话的 agent；拿不到时 undefined
   */
  async function openAndSync() {
    const agent = await opener.ensureAgent();
    await syncPersona(agent);
    persona.releaseExcept(state.sessionId);
    return agent;
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
      personaName: state.personaName,
      personaActive: state.persona.length > 0,
      personaBytes: Buffer.byteLength(state.persona, 'utf8'),
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
   * 没带的字段沿用当前值：设置页漏传时不能把另一项清掉。人设内容超上限直接报错——
   * settings.yaml 是配置文件，不该被塞进一份超长文本。
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
    const personaText = typeof body?.persona === 'string'
      ? body.persona.trim()
      : (current.persona ?? '');
    const personaBytes = Buffer.byteLength(personaText, 'utf8');
    if (personaBytes > MAX_PERSONA_BYTES) {
      throw new Error(`人设内容有 ${personaBytes} 字节，超过 ${MAX_PERSONA_BYTES} 字节上限`);
    }
    const personaName = typeof body?.personaName === 'string'
      ? body.personaName.trim().slice(0, PERSONA_NAME_MAX_CHARS)
      : (current.personaName ?? '');
    if (settingsScope) {
      await settingsScope.replace({ sessionId, managerId, persona: personaText, personaName });
    }
    const previousSessionId = state.sessionId;
    state.sessionId = sessionId;
    state.managerId = managerId;
    state.persona = personaText;
    state.personaName = personaText ? personaName : '';
    if (previousSessionId !== sessionId) persona.release(previousSessionId);
    await openAndSync();
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
   * 处理一条飞书消息事件：配对 → 人设就绪 → 管理员直通 → 其余走审批。
   *
   * 人设内容为空，「飞书AI助理模式」就是没开：管理员得到一句指路，其他人静默丢弃，
   * 连审批卡片都不发——不要让请求人在一个关着的功能前面排队。
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
    if (!state.persona) {
      if (isManager(data)) {
        await outbound.replyTo(message.message_id, REPLY_TEXT.personaUnavailable);
      }
      return;
    }
    // 管理员直通请求队列；其他人都要管理员在卡片上点头。
    if (isManager(data)) {
      // 只入队，不等：队列按先进先出逐条处理，前一条整轮跑完才注入下一条。
      void requestQueue.push(() => handleRequest(message.message_id, text, true)).catch((error) => {
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

  // 启动就把目标会话拉起来并按人设同步，这样飞书第一条消息不用先有人在界面上点开它。
  // 会话控制器可能比本插件晚注册，等它就绪再拉；没挂那个包的 profile 里这段不会执行，
  // 打开会话的能力在收到消息时降级为「打不开就回失败提示」。
  ctx.inject(['sessionController'], () => {
    void openAndSync();
  });

  ctx.effect(() => () => connection.stop());
}
