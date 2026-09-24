/**
 * dsh-feishu-assistant — 宿主半边。
 *
 * 用飞书官方 SDK 的长连接接飞书机器人：消息事件与卡片回调都由 DSH 进程主动连出接收，
 * 不需要公网入口。私聊消息先塞进队列，先进先出、一次处理一条，注入指定会话并唤醒它，
 * 会话产出的回答再回写到飞书。
 *
 * 配置分三类，都在 Web 设置页「飞书AI助理」里维护：
 * - 目标会话 ID 走插件条目的 config（落当前 Profile 的插件配置）
 * - App ID / App Secret 走凭据存储（落 $DSH_HOME/.credentials.yaml）
 * - 人设内容本身也走插件条目的 config；用户可以在设置页里写，或从本地文件导入
 * 三类都可以缺席：缺凭据时插件停用并说明原因，不会阻塞 DSH 启动。
 */

import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import {
  Client,
  Domain,
} from '@larksuiteoapi/node-sdk';

import { LRUCache } from 'lru-cache';

import { createQueue } from './queue.js';

import {
  APP_ID_REF,
  APP_SECRET_REF,
  DIRECT_CHAT_TYPE,
  MANAGER_ALERT_SESSION_UNAVAILABLE,
  REPLY_TEXT,
  SETTINGS_NAMESPACE,
} from './constants.js';
import { createApprovalFlow } from './approval.js';
import { createConnection } from './connection.js';
import { createOutbound } from './feishu-outbound.js';
import { createSessionCatalog } from './session-catalog.js';
import { createAgentOpener } from './session-opener.js';
import { MAX_PERSONA_BYTES, createPersonaInjector } from './persona.js';
import { registerSettingRoutes } from './routes.js';
import { requireRef } from './credentials.js';
import { messageSenderIds, readMessageText, readTurnFailure } from './feishu-events.js';
import { errorMessage } from './http.js';
import { createPairingFlow } from './pairing.js';
import { createSessionEventPump } from './session-events/index.js';
import { beginRequest, createRoutingState, endRequest } from './session-events/state.js';

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

/** 人设来源文件名最长留几个字符；只是给人看的，别让设置页被超长文件名撑爆。 */
const PERSONA_NAME_MAX_CHARS = 200;

/**
 * 插件条目的 config，同时也是设置页那套普通配置的 schema。
 *
 * 字段都标了 volatile：DSH 0.1.7 起设置由当前 Profile 的插件配置持久化，只有 volatile
 * 字段能被 @deepseek-ai/dsh-settings 的 SettingsForms 写入。写入后 loader 会把新值原地
 * 更新到 apply 收到的 config 上，并触发 loader/volatile-update。
 */
export const Config = z.object({
  sessionId: z.string().default('').volatile(),
  managerId: z.string().default('').volatile(),
  persona: z.string().default('').volatile(),
  personaName: z.string().default('').volatile(),
});

/**
 * 读一个 config 字段的值。
 *
 * Config 里标了 volatile 的字段解析出来是带 get() 的引用（见 cosmokit 的 createVolatile），
 * 直接读会拿到引用对象本身；插件被直接挂载、没经过 Loader 时则可能是普通值。
 *
 * @param value config 里的字段值
 * @param fallback 取不到时的兜底值
 * @returns 字段的实际值
 */
function readConfigField(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get() ?? fallback;
  }
  return value ?? fallback;
}

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
    sessionId: readConfigField(config?.sessionId, ''),
    managerId: readConfigField(config?.managerId, ''),
    /** 「飞书AI助理模式」的人设内容；空串表示这个模式没开。 */
    persona: readConfigField(config?.persona, ''),
    /** 生效中的人设来自哪个文件；只用来在设置页上说清"现在生效的是哪一份"。 */
    personaName: readConfigField(config?.personaName, ''),
    connected: false,
    lastError: '',
    sessionError: '',
  };

  /**
   * 会话事件的路由状态：这一轮归谁、回答发去哪。
   *
   * 会话是共享的（飞书、DSH 界面、别的自动化都可能在同一条会话上说话），所以这份状态由
   * 宿主半边的请求生命周期和 `session-events/` 下的事件处理器共同读写，字段含义见 state.js。
   */
  const routing = createRoutingState();

  /** 飞书请求队列：先进先出，一次只处理一条，前一条整轮跑完才注入下一条。 */
  const requestQueue = createQueue();

  /**
   * 最近处理过的飞书消息 id。
   *
   * 长连接是"至少一次"投递：断线重连、服务侧重投都可能把同一条消息再送一次。不去重的话
   * 同一条消息会被回答两遍（两张卡片、两轮）。飞书保证每条消息的 id 唯一，所以按 id 记就够了。
   */
  const handledMessages = new LRUCache({ max: 200 });

  /** 发消息用的 REST 客户端，凭据变化时重建。 */
  let restClient;

  /** 出站发送器：回复、主动私聊文本、主动私聊卡片。 */
  const outbound = createOutbound({ logger, getClient: () => restClient });

  /** 非管理员请求的审批流程：登记待审批、推卡片、处理点击。 */
  const approvalFlow = createApprovalFlow({
    logger,
    getManagerId: () => state.managerId,
    matchesManager,
    resolveSenderName: outbound.resolveUserName,
    sendReply: outbound.replyTo,
    sendCard: outbound.sendCard,
    // 把 enqueueRequest 的 Promise 原样交出去：审批那边靠它把异步失败记进日志。
    // 千万别在这里 `void` 掉再返回 undefined，那会让审批卡片的点击直接崩。
    enqueue: (messageId, text) => enqueueRequest(messageId, text, false),
  });

  /**
   * 配对流程：生成口令、判定命中、把命中的人设成管理员。
   *
   * 状态和流程都在 pairing.js，这里只把"回执"和"成为管理员"接进去（落盘 + 更新内存）。
   */
  const pairingFlow = createPairingFlow({
    logger,
    reply: (messageId, text) => outbound.replyTo(messageId, text),
    pair: async (managerId) => {
      if (managerId === state.managerId) {
        logger.info(`配对成功，管理员未变：${managerId}`);
        return;
      }
      await settings.update(SETTINGS_NAMESPACE, { sessionId: state.sessionId, managerId });
      state.managerId = managerId;
      logger.info(`配对成功，管理员已设为 ${managerId}`);
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
    hasPendingInjection: () => routing.injectedMessageId !== '',
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

  // 这个插件自带设置页（settings.section slot），让 DSH 不要再按 Config 自动生成一份重复的表单。
  ctx.effect(() => settings.configure({ auto: false }, ctx.fiber));

  /**
   * 把 config 里的普通配置同步进运行期状态。
   *
   * 启动时 apply 收到的 config 就是这份；之后设置页写入、旧 settings.yaml 被导入，loader
   * 都会原地更新 config 并触发 loader/volatile-update，由那儿再调一次。
   */
  function syncStateFromConfig() {
    const previousSessionId = state.sessionId;
    state.sessionId = readConfigField(config?.sessionId, '');
    state.managerId = readConfigField(config?.managerId, '');
    state.persona = readConfigField(config?.persona, '');
    state.personaName = readConfigField(config?.personaName, '');
    if (previousSessionId !== state.sessionId) persona.release(previousSessionId);
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

  // ---------------------------------------------------------------- 长连接

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
   * 两件前置动作：
   * - 同步人设：用户可能刚改完文件，也可能把目标会话换成了另一个；
   * - **等会话空下来**：目标会话是共享的，DSH 界面里那一轮可能正在跑。这时候注入，我们这条会排在
   *   它后面，而"这一轮跑完了"的判定会被别人那一轮的 turn/end 提前满足（请求人收到"没有产出回答"，
   *   真回答却走成私聊卡片）。等空闲再注入，我们就是下一轮，判定必然落在自己身上。
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
    if (agent.status === 'running') {
      logger.info(`会话 ${state.sessionId} 正在跑，飞书这条等它跑完再注入`);
    }
    await opener.waitUntilIdle(agent);
    // 记下这条消息的 ID：它在会话里落成 `user/message` 事件时，就能认出这一轮是自己发起的。
    const id = randomUUID();
    routing.injectedMessageId = id;
    agent.followup({
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    logger.info(`飞书消息已注入会话 ${state.sessionId}`);
    return true;
  }

  /**
   * 入队一条飞书请求：**先把回答卡片开出来**，再交给请求队列。
   *
   * 队列是串行的，前面那条可能还在等会话空闲（等界面里那一轮的时长）。卡片在入队时就立在请求人
   * 那条消息下面，他就不会对着一句毫无反馈的消息干等。
   *
   * @param messageId 飞书消息 ID，回答回复到它上面
   * @param text 消息正文
   * @param fromManager 是不是管理员发的
   * @returns Promise
   */
  async function enqueueRequest(messageId, text, fromManager) {
    // 回答卡片统一在这里开：审批通过的请求也走这条路，不再各开各的。
    let card;
    if (worthOpeningCard()) {
      card = await outbound.openAnswerCard({ messageId, initialText: REPLY_TEXT.processing });
      // 卡片开不出来就退回一条普通回执，行为跟以前一致。
      if (!card) await outbound.replyTo(messageId, REPLY_TEXT.processing);
    }
    void requestQueue.push(() => handleRequest(messageId, text, fromManager, card)).catch((error) => {
      logger.warn(`处理飞书消息失败：${errorMessage(error)}`);
    });
  }

  /**
   * 这条消息值不值得先开一张回执卡片。
   *
   * 目标会话没配、或者上一次已经确认打不开（`state.sessionError`）时不值得：卡片开了马上又要在失败
   * 路径里关掉，用户只能看到闪一下。**但请求照常入队**——万一会话已经好了，回答会以"每段一张普通
   * 卡片"回来，并且把错误标记清掉；下一轮就恢复正常。
   *
   * @returns 值得开卡时 true
   */
  function worthOpeningCard() {
    return Boolean(state.sessionId) && !state.sessionError;
  }

  /**
   * 处理一条飞书请求：注入目标会话，等这一轮 turn 跑完才返回。
   *
   * 队列保证一次只有一条在跑，所以回复目标可以安全地绑到当前这条消息上。
   *
   * 卡片由入队时的 enqueueRequest 开好（入队的消息可能排很久，不能让它毫无反馈），这里只管注入、
   * 等这一轮跑完、收尾。
   *
   * @param messageId 飞书消息 ID，回答回复到它上面
   * @param text 消息正文
   * @param fromManager 是不是管理员发的
   * @param card 已经开好的回答卡片；没开出来时 undefined
   */
  async function handleRequest(messageId, text, fromManager, card) {
    beginRequest(routing, { messageId, card });
    // 注入本身可能抛（例如会话日志写不进去）：跟"注入失败"一样处理，别让请求人干等。
    let injected = false;
    try {
      injected = await injectToSession(text);
    } catch (error) {
      logger.warn(`注入飞书消息失败：${errorMessage(error)}`);
    }
    if (!injected) {
      // 没法注入时必须给个交代：管理员能自己修，给他指路；请求人只给通用失败文案。
      const reason = state.sessionError || !state.sessionId
        ? REPLY_TEXT.sessionUnavailable
        : REPLY_TEXT.personaUnavailable;
      await routing.answerCard?.close();
      await outbound.replyTo(messageId, fromManager ? reason : REPLY_TEXT.failure);
      endRequest(routing);
      return;
    }
    // 注入之后再挂等待：注入前会话是空的，我们那条就是下一轮，从这里起的 turn/end 必然属于自己。
    const turnEnd = await opener.waitForTurnEnd(state.sessionId);
    // 收尾：没上屏的内容会由卡片句柄补发成普通消息。
    await routing.answerCard?.close();
    // 这一轮结束了却一个字都没产出（例如跑到一半出错）：不能静默，给请求人一个交代。
    if (routing.replied) {
      endRequest(routing);
      return;
    }
    const failure = readTurnFailure(turnEnd);
    logger.warn(`会话 ${state.sessionId} 这一轮没有产出${failure ? `（${failure}）` : ''}，回复失败文案`);
    // 失败原因只给管理员：他能去查，请求人拿到通用文案就够。
    await outbound.replyTo(messageId, fromManager && failure
      ? `${REPLY_TEXT.noAnswer}\n失败原因：${failure}`
      : REPLY_TEXT.noAnswer);
    endRequest(routing);
  }

  // ---------------------------------------------------------------- 会话事件

  // 回写：飞书请求那一轮一段一段回原消息；别的来源发起的轮次推给管理员私聊。
  // 一种事件一个文件，分派见 session-events/index.js。
  const eventPump = createSessionEventPump({
    ctx,
    logger,
    routing,
    outbound,
    getSessionId: () => state.sessionId,
    getManagerId: () => state.managerId,
  });
  eventPump.start();

  // 条目 config 变了（设置页写入、旧 settings.yaml 被导入）：热更新，不需要重连。
  ctx.on('loader/volatile-update', () => {
    syncStateFromConfig();
    logger.info(`目标会话已更新为 ${state.sessionId || '(空)'}，管理员 ${state.managerId || '(未配置)'}`);
    // 换了目标会话就顺手把它打开，别等第一条消息才发现没开。
    void openAndSync();
  });

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
    const pairing = pairingFlow.snapshot();
    return {
      sessionId: state.sessionId,
      managerId: state.managerId,
      sessionLive: Boolean(state.sessionId) && agents.get(state.sessionId) !== undefined,
      sessionError: state.sessionError,
      personaName: state.personaName,
      personaActive: state.persona.length > 0,
      personaBytes: Buffer.byteLength(state.persona, 'utf8'),
      pairing,
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
    pairingFlow.start();
  }

  /**
   * 保存设置页的普通配置。
   *
   * 没带的字段沿用当前值：设置页漏传时不能把另一项清掉。人设内容超上限直接报错——
   * 插件配置是配置文件，不该被塞进一份超长文本。
   *
   * @param body 请求体
   */
  async function saveConfig(body) {
    const current = {
      sessionId: state.sessionId,
      managerId: state.managerId,
      persona: state.persona,
      personaName: state.personaName,
    };
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
    await settings.update(SETTINGS_NAMESPACE, { sessionId, managerId, persona: personaText, personaName });
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
    if (message.message_id) {
      if (handledMessages.has(message.message_id)) {
        logger.warn(`同一条飞书消息又投递了一次（${message.message_id}），忽略`);
        return;
      }
      handledMessages.set(message.message_id, true);
    }
    const text = readMessageText(message);
    if (!text) return;
    // 配对判定必须在管理员判定之前：名单为空时口令消息也得能进来。
    if (pairingFlow.match(text)) {
      void pairingFlow.complete(data).catch((error) => {
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
      void enqueueRequest(message.message_id, text, true);
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
