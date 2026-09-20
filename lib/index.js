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
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from '@larksuiteoapi/node-sdk';

import { createQueue } from './queue.js';

/** Cordis 插件名。 */
export const name = 'dsh-feishu-assistant';

/**
 * 需要的服务：agent 注册表、设置、凭据、Web 服务器（设置页路由）、会话控制器（主动打开目标会话）。
 *
 * sessionController 必须列进来：启动时要靠它 resume 目标会话，而它在 apply 执行时
 * 还没注册好，用 ctx.get 只会拿到 undefined。
 */
export const inject = ['agents', 'settings', 'credentials', 'webServer', 'sessionController'];

/** App ID 的凭据名。 */
const APP_ID_REF = 'FEISHU_APP_ID';

/** App Secret 的凭据名。 */
const APP_SECRET_REF = 'FEISHU_APP_SECRET';

/** 凭据名必须是 POSIX 标识符，与 credentialRef 的约束一致。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 设置命名空间。 */
const SETTINGS_NAMESPACE = 'feishu-assistant';

/** 设置页读取状态的路径。 */
const STATE_ROUTE = '/dsh-feishu-assistant/state';

/** 设置页写入普通配置的路径。 */
const CONFIG_ROUTE = '/dsh-feishu-assistant/config';

/** 设置页写入凭据的路径。 */
const CREDENTIALS_ROUTE = '/dsh-feishu-assistant/credentials';

/** 设置页读取可选会话列表的路径。 */
const SESSIONS_ROUTE = '/dsh-feishu-assistant/sessions';

/** 设置页生成配对口令的路径。 */
const PAIRING_ROUTE = '/dsh-feishu-assistant/pairing';

/** 配对码字符集：去掉 0/O/1/I 这类容易看混的字符。 */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 配对码长度；够挡住盲猜。 */
const PAIRING_CODE_LENGTH = 8;

/** 配对码有效期。 */
const PAIRING_TTL_MS = 10 * 60 * 1000;

/** 飞书接收消息事件类型。 */
const MESSAGE_RECEIVE_EVENT_TYPE = 'im.message.receive_v1';

/** 飞书卡片按钮回调事件类型。 */
const CARD_ACTION_EVENT_TYPE = 'card.action.trigger';

/** 飞书文本消息类型。 */
const TEXT_MESSAGE_TYPE = 'text';

/** 飞书交互卡片消息类型。 */
const INTERACTIVE_MESSAGE_TYPE = 'interactive';

/** 飞书新版卡片 JSON 版本。 */
const CARD_SCHEMA_VERSION = '2.0';

/** 审批卡片标题。 */
const APPROVAL_CARD_TITLE = '是否进行回应';

/** 审批卡片同意按钮文案。 */
const APPROVE_BUTTON_TEXT = '同意';

/** 审批卡片拒绝按钮文案。 */
const REJECT_BUTTON_TEXT = '拒绝';

/** 审批卡片按钮回调行为类型。 */
const CARD_CALLBACK_BEHAVIOR = 'callback';

/** 待审批卡片的头部配色。 */
const APPROVAL_HEADER_PENDING = 'blue';

/** 审批通过卡片（结果态）的头部配色。 */
const APPROVAL_HEADER_APPROVED = 'green';

/** 审批拒绝卡片（结果态）的头部配色。 */
const APPROVAL_HEADER_REJECTED = 'grey';

/** 待审批缓存上限，防止被陌生人刷爆内存。 */
const MAX_PENDING_APPROVALS = 20;

/** 待审批有效期；超时的请求不再可批。 */
const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** 请求人可见的固定回复文案。 */
const REPLY_TEXT = {
  processing: '正在处理',
  rejected: '无法处理这条消息',
  failure: '暂时无法处理该消息，请稍后重试',
};

/** 只处理私聊：群聊要 @ 机器人，把内容转进会话会打扰其他人。 */
const DIRECT_CHAT_TYPE = 'p2p';

/** 会话产出的 assistant 消息事件类型。 */
const ASSISTANT_MESSAGE_EVENT_TYPE = 'assistant/message';

/** 会话一轮 turn 结束的事件类型。 */
const TURN_END_EVENT_TYPE = 'turn/end';

/** 等 turn 结束时的兜底巡检间隔：agent 被关掉后不会再发 turn/end，别把队列卡死。 */
const TURN_WATCH_INTERVAL_MS = 1000;

/** 回写飞书的最大尝试次数（含首次）。 */
const REPLY_MAX_ATTEMPTS = 3;

/** 回写重试的基准间隔；第 n 次重试等 REPLY_RETRY_BASE_MS * n。 */
const REPLY_RETRY_BASE_MS = 500;

/** 请求体上限，防止设置页路由被塞大包。 */
const MAX_BODY_BYTES = 64 * 1024;

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

  /**
   * 待审批请求，按请求人的飞书消息 ID 索引。
   *
   * 这不是队列：没有消费者自动取，等人点卡片；所以用 Map 而不是 createQueue，
   * 并且需要上限和过期来兜住陌生人刷消息。
   */
  const pendingApprovals = new Map();

  /** 当前长连接客户端；未连接时为 undefined。 */
  let wsClient;

  /** 发消息用的 REST 客户端，凭据变化时重建。 */
  let restClient;

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
   * 把一条非管理员请求登记进待审批缓存，并推一张审批卡片给管理员。
   *
   * 卡片发失败就撤回登记并回请求人一条失败提示，不让请求悬着。
   *
   * @param event 飞书消息事件
   * @param text 消息正文
   */
  async function requestApproval(event, text) {
    if (!state.managerId) {
      logger.warn('收到非管理员请求，但还没有管理员可以审批，已忽略');
      return;
    }
    const message = event?.message ?? {};
    const messageId = message.message_id ?? '';
    if (!messageId || pendingApprovals.has(messageId)) return;
    purgeExpiredApprovals();
    if (pendingApprovals.size >= MAX_PENDING_APPROVALS) {
      logger.warn(`待审批已满（${MAX_PENDING_APPROVALS} 条），本条请求被拒`);
      await sendReply(messageId, REPLY_TEXT.failure);
      return;
    }
    const item = {
      messageId,
      senderId: messageSenderIds(event)[0] ?? '',
      content: text,
      createdAt: Date.now(),
    };
    pendingApprovals.set(messageId, item);
    try {
      await sendCard(state.managerId, buildApprovalCard(item));
      logger.info(`已把请求 ${messageId} 提交管理员审批`);
    } catch (error) {
      pendingApprovals.delete(messageId);
      logger.warn(`发送审批卡片失败：${errorMessage(error)}`);
      await sendReply(messageId, REPLY_TEXT.failure);
    }
  }

  /**
   * 清掉过期的待审批项。
   */
  function purgeExpiredApprovals() {
    const deadline = Date.now() - APPROVAL_TTL_MS;
    for (const [messageId, item] of pendingApprovals) {
      if (item.createdAt < deadline) pendingApprovals.delete(messageId);
    }
  }

  /**
   * 管理员同意：回请求人「处理中」，然后送进请求队列。
   *
   * @param item 待审批请求
   */
  function approveRequest(item) {
    void sendReply(item.messageId, REPLY_TEXT.processing).catch((error) => {
      logger.warn(`回复处理中提示失败：${errorMessage(error)}`);
    });
    void requestQueue.push(() => handleRequest(item.messageId, item.content)).catch((error) => {
      logger.warn(`处理已审批的飞书消息失败：${errorMessage(error)}`);
    });
    logger.info(`请求 ${item.messageId} 已审批通过并进入请求队列`);
  }

  /**
   * 管理员拒绝：回请求人一条不可处理。
   *
   * @param item 待审批请求
   */
  function rejectRequest(item) {
    void sendReply(item.messageId, REPLY_TEXT.rejected).catch((error) => {
      logger.warn(`回复拒绝提示失败：${errorMessage(error)}`);
    });
    logger.info(`请求 ${item.messageId} 已被拒绝`);
  }

  /**
   * 处理管理员在审批卡片上的点击。
   *
   * 非管理员点的一律不认；已经处理过或已过期的请求回一句提示，不重复入队。
   *
   * @param event 飞书卡片回调事件
   * @returns 卡片回调响应
   */
  function handleCardAction(event) {
    const value = readCardActionValue(event);
    const messageId = typeof value?.messageId === 'string' ? value.messageId : '';
    if (!messageId) {
      return toastResponse('error', '卡片操作参数缺失');
    }
    if (!matchesManager(cardOperatorIds(event))) {
      logger.warn(`非管理员点击了审批卡片（请求 ${messageId}），已忽略`);
      return toastResponse('error', '无权操作');
    }
    purgeExpiredApprovals();
    const item = pendingApprovals.get(messageId);
    if (!item) {
      return toastResponse('error', '该请求已处理或已过期');
    }
    pendingApprovals.delete(messageId);
    if (value.action === 'approve') {
      approveRequest(item);
      return callbackCardResponse('success', '已同意', buildApprovalResultCard('已同意', APPROVAL_HEADER_APPROVED, item));
    }
    if (value.action === 'reject') {
      rejectRequest(item);
      return callbackCardResponse('success', '已拒绝', buildApprovalResultCard('已拒绝', APPROVAL_HEADER_REJECTED, item));
    }
    return toastResponse('error', '不支持的卡片操作');
  }

  /**
   * 确保目标会话有活着的 agent；没有就主动 resume 起来。
   *
   * resume 是复用 sessionController 的公开入口，它内部会带上会话原本的 agent preset
   * 和当前模型选择，和界面上点开这个会话是同一套动作。
   *
   * @returns 活着的 agent；拿不到时 undefined
   */
  async function ensureAgent() {
    if (!state.sessionId) return undefined;
    const live = agents.get(state.sessionId);
    if (live) return live;
    const controller = ctx.get('sessionController');
    if (!controller) {
      state.sessionError = '会话控制器不可用（本部署没有挂 dsh-api-session-controller）';
      logger.warn(state.sessionError);
      return undefined;
    }
    try {
      // resolveAgent 就是「有就复用、没有就 resume」，并且会去重并发 resume。
      const found = await controller.resolveAgent(state.sessionId);
      if ('error' in found) {
        state.sessionError = `打开目标会话失败：${errorMessage(found.error)}`;
        logger.warn(state.sessionError);
        return undefined;
      }
      state.sessionError = '';
      logger.info(`已主动打开目标会话 ${state.sessionId}`);
      return found.agent;
    } catch (error) {
      state.sessionError = `打开目标会话失败：${errorMessage(error)}`;
      logger.warn(state.sessionError);
      return undefined;
    }
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
    const agent = await ensureAgent();
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
   * 等目标会话的下一轮 turn 跑完。
   *
   * turn/end 表示这一轮彻底结束（工具调用后的续跑都算在内），正好当「这条请求处理完」的信号。
   * agent 被关掉后不会再发 turn/end，所以额外巡检一层兜底，避免队列永远卡住。
   *
   * @param sessionId 目标会话 ID
   * @returns 这一轮结束时 resolve 的 Promise
   */
  function nextTurnEnd(sessionId) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        dispose();
        clearInterval(watchdog);
        resolve();
      };
      const dispose = ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId) return;
        if (event?.type !== TURN_END_EVENT_TYPE) return;
        finish();
      });
      const watchdog = setInterval(() => {
        if (!agents.get(sessionId)) finish();
      }, TURN_WATCH_INTERVAL_MS);
    });
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
    if (!(await injectToSession(text))) return;
    await nextTurnEnd(state.sessionId);
  }

  /** 断开当前长连接。 */
  function stopConnection() {
    const client = wsClient;
    wsClient = undefined;
    state.connected = false;
    if (!client) return;
    try {
      client.close({ force: true });
    } catch (error) {
      logger.warn(`断开飞书长连接失败：${errorMessage(error)}`);
    }
  }

  /** 按当前凭据建立长连接；凭据不全时停用插件并说明原因。 */
  async function startConnection() {
    stopConnection();
    if (!state.appId || !state.appSecret) {
      state.lastError = '未配置飞书凭据，请在本页填写 App ID 与 App Secret';
      logger.warn(state.lastError);
      return;
    }

    const eventDispatcher = new EventDispatcher({});
    eventDispatcher.register({
      [MESSAGE_RECEIVE_EVENT_TYPE]: async (data) => {
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
        void requestApproval(data, text).catch((error) => {
          logger.warn(`提交审批失败：${errorMessage(error)}`);
        });
      },
      [CARD_ACTION_EVENT_TYPE]: async (data) => handleCardAction(data),
    });

    const client = new WSClient({
      appId: state.appId,
      appSecret: state.appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.info,
      source: name,
      autoReconnect: true,
      onReady: () => {
        state.connected = true;
        state.lastError = '';
        logger.info('飞书长连接已建立');
      },
      onReconnecting: () => {
        state.connected = false;
        logger.warn('飞书长连接断开，开始重连');
      },
      onReconnected: () => {
        state.connected = true;
        logger.info('飞书长连接已重连');
      },
      onError: (error) => {
        state.connected = false;
        state.lastError = `飞书长连接终止：${errorMessage(error)}`;
        logger.error(state.lastError);
      },
    });
    wsClient = client;
    try {
      await client.start({ eventDispatcher });
    } catch (error) {
      state.connected = false;
      state.lastError = `建立飞书长连接失败：${errorMessage(error)}`;
      logger.error(state.lastError);
    }
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
      void ensureAgent();
    });
  }

  // ---------------------------------------------------------------- 设置页路由

  if (webServer) {
    ctx.effect(() => {
      const disposed = webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: async (req, res) => {
          if (!guard(req, res, 'GET')) return;
          sendJson(res, 200, await buildSnapshot());
        },
      });
      return disposed;
    }, `${name}: state route`);

    ctx.effect(() => {
      const disposed = webServer.register({
        kind: 'exact',
        path: PAIRING_ROUTE,
        handler: async (req, res) => {
          if (!guard(req, res, 'POST')) return;
          try {
            // 每次生成都覆盖上一个，旧口令立刻失效。
            pairing = { code: createPairingCode(), expiresAt: Date.now() + PAIRING_TTL_MS };
            logger.info('已生成新的配对口令，等待在飞书里私聊机器人');
            sendJson(res, 200, await buildSnapshot());
          } catch (error) {
            sendJson(res, 400, { error: errorMessage(error) });
          }
        },
      });
      return disposed;
    }, `${name}: pairing route`);

    ctx.effect(() => {
      const disposed = webServer.register({
        kind: 'exact',
        path: SESSIONS_ROUTE,
        handler: async (req, res) => {
          if (!guard(req, res, 'GET')) return;
          try {
            sendJson(res, 200, { sessions: await listSessions() });
          } catch (error) {
            sendJson(res, 500, { error: errorMessage(error) });
          }
        },
      });
      return disposed;
    }, `${name}: sessions route`);

    ctx.effect(() => {
      const disposed = webServer.register({
        kind: 'exact',
        path: CONFIG_ROUTE,
        handler: async (req, res) => {
          if (!guard(req, res, 'PUT')) return;
          try {
            const body = await readJsonBody(req);
            // 部分更新：没带的字段沿用当前值，避免设置页漏传时把另一项清掉。
            const current = settingsScope?.get() ?? {};
            const next = typeof body?.sessionId === 'string'
              ? body.sessionId.trim()
              : (current.sessionId ?? '');
            const manager = typeof body?.managerId === 'string'
              ? body.managerId.trim()
              : (current.managerId ?? '');
            if (settingsScope) await settingsScope.replace({ sessionId: next, managerId: manager });
            state.sessionId = next;
            state.managerId = manager;
            sendJson(res, 200, await buildSnapshot());
          } catch (error) {
            sendJson(res, 400, { error: errorMessage(error) });
          }
        },
      });
      return disposed;
    }, `${name}: config route`);

    ctx.effect(() => {
      const disposed = webServer.register({
        kind: 'exact',
        path: CREDENTIALS_ROUTE,
        handler: async (req, res) => {
          if (!guard(req, res, 'PUT')) return;
          try {
            const body = await readJsonBody(req);
            // 空字符串表示「不改这一项」：清空要用 unset，这里不支持。
            if (typeof body?.appId === 'string' && body.appId.trim()) {
              await credentials.set(requireRef(APP_ID_REF), body.appId.trim());
            }
            if (typeof body?.appSecret === 'string' && body.appSecret.trim()) {
              await credentials.set(requireRef(APP_SECRET_REF), body.appSecret.trim());
            }
            await loadCredentials();
            await startConnection();
            sendJson(res, 200, await buildSnapshot());
          } catch (error) {
            // 常见失败：环境变量或项目 .env 遮蔽了该凭据，写入会被拒。
            sendJson(res, 400, { error: errorMessage(error) });
          }
        },
      });
      return disposed;
    }, `${name}: credentials route`);
  }

  /**
   * 列出可选会话：本机所有带工作目录的会话，标注哪些当前已打开。
   *
   * 设置页用这份数据渲染下拉列表，省得手打会话 ID。会话查询服务按需取，
   * 没挂载这个服务的部署返回空列表，前端会回落到手动输入。
   *
   * @returns 按最近活动倒序的会话摘要
   */
  async function listSessions() {
    const engine = ctx.get('sessionQuery');
    if (!engine) return [];
    const records = await engine.listSessions();
    return records
      .filter((record) => record?.header?.cwd !== undefined)
      .map((record) => sessionSummary(record.header))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * 把一个会话 header 压成设置页需要的摘要。
   *
   * @param header 会话 header
   * @returns 会话摘要
   */
  function sessionSummary(header) {
    const agent = agents.get(header.id);
    const projection = readProjection(header);
    return {
      id: header.id,
      title: typeof projection?.title === 'string' ? projection.title : '',
      cwd: header.cwd ?? '',
      live: agent !== undefined,
      running: agent?.status === 'running',
      updatedAt: projection?.sessionListMetadata?.lastPromptAt ?? header.createdAt,
    };
  }

  /**
   * 读会话的标题投影。
   *
   * 投影缓存只是折叠日志的快捷方式、不是权威数据，所以读不到或版本不匹配都按「没有」处理。
   *
   * @param header 会话 header
   * @returns 投影值；读不到时 undefined
   */
  function readProjection(header) {
    const cache = ctx.get('sessionProjectionCache');
    if (!cache) return undefined;
    try {
      // isSeeded 是 fork 出来的会话，缓存前缀对不上，官方列表同样跳过。
      if (header.isSeeded) return undefined;
      // SessionLogOffset 在运行时是恒等函数，0 即日志起点。
      const block = cache.cachedSnapshot(header, 0) ?? cache.cachedPredecessorTitle(header, 0);
      return block?.values;
    } catch (error) {
      logger.warn(`读取会话 ${header.id} 的投影失败：${errorMessage(error)}`);
      return undefined;
    }
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

  // ---------------------------------------------------------------- 启动

  await loadCredentials();
  await startConnection();

  // 启动就把目标会话拉起来，这样飞书第一条消息不用先有人在界面上点开它。
  await ensureAgent();

  ctx.effect(() => () => stopConnection());
}

/**
 * 校验凭据名并返回。
 *
 * 不引用 @deepseek-ai/dsh-credentials：npm 上的版本（0.0.1-rc.1）比运行时旧，
 * 而它的 credentialRef 只是 brandString（运行时返回原值），本地校验即可。
 *
 * @param name 凭据名
 * @returns 同一个名字
 */
function requireRef(name) {
  if (!CREDENTIAL_REF_PATTERN.test(name)) {
    throw new TypeError(`凭据名不合法：${name}`);
  }
  return name;
}

/**
 * 生成一个配对码。
 *
 * @returns PAIRING_CODE_LENGTH 位的随机码
 */
function createPairingCode() {
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

/**
 * 规范化用户手输的配对码：去掉空白和连字符、统一大写。
 *
 * @param text 原始输入
 * @returns 规范化后的文本
 */
function normalizePairingText(text) {
  return String(text ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * 取消息事件里发送者的三个 ID。
 *
 * 飞书 v2 事件把 sender 和 message 放在同一层，所以这里收的是整个事件而不是 message。
 *
 * @param event 飞书消息事件
 * @returns 非空的 ID 列表；取不到时为空数组
 */
function messageSenderIds(event) {
  const sender = event?.sender?.sender_id ?? {};
  return [sender.open_id, sender.user_id, sender.union_id].filter(Boolean);
}

/**
 * 取卡片回调里操作人的三个 ID。
 *
 * @param event 飞书卡片回调事件
 * @returns 非空的 ID 列表；取不到时为空数组
 */
function cardOperatorIds(event) {
  const operator = event?.operator ?? {};
  return [operator.open_id, operator.user_id, operator.union_id].filter(Boolean);
}

/**
 * 取卡片按钮回传的参数。
 *
 * v2 卡片把 value 作为对象回传，个别场景会回传 JSON 字符串，两种都认。
 *
 * @param event 飞书卡片回调事件
 * @returns 解析出的参数对象；取不到时 undefined
 */
function readCardActionValue(event) {
  const value = event?.action?.value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === 'object' && value !== null ? value : undefined;
}

/**
 * 构造审批卡片。
 *
 * 结构照搬 Clock Tower 的新版卡片：schema 2.0 + header + body.elements，
 * 按钮用 column_set 排成等宽两列，behaviors 里带 callback 参数。
 *
 * @param item 待审批请求
 * @returns 卡片对象
 */
function buildApprovalCard(item) {
  return {
    schema: CARD_SCHEMA_VERSION,
    header: {
      template: APPROVAL_HEADER_PENDING,
      title: { tag: 'plain_text', content: APPROVAL_CARD_TITLE },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `**发送者**\n${item.senderId}` },
        { tag: 'markdown', content: `**消息内容**\n${item.content}` },
        { tag: 'markdown', content: APPROVAL_CARD_TITLE },
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [
            buildButtonColumn(APPROVE_BUTTON_TEXT, 'primary', 'approve', item.messageId),
            buildButtonColumn(REJECT_BUTTON_TEXT, 'default', 'reject', item.messageId),
          ],
        },
      ],
    },
  };
}

/**
 * 构造审批结束后的结果卡片：只换头部配色和标题，去掉按钮。
 *
 * @param title 结果标题
 * @param template 头部配色
 * @param item 已处理的请求
 * @returns 卡片对象
 */
function buildApprovalResultCard(title, template, item) {
  return {
    schema: CARD_SCHEMA_VERSION,
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `**发送者**\n${item.senderId}` },
        { tag: 'markdown', content: `**消息内容**\n${item.content}` },
      ],
    },
  };
}

/**
 * 构造一个审批按钮列。
 *
 * @param text 按钮文案
 * @param type 按钮样式
 * @param action 回传的操作值
 * @param messageId 原始飞书消息 ID
 * @returns 卡片列对象
 */
function buildButtonColumn(text, type, action, messageId) {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [{
      tag: 'button',
      type,
      text: { tag: 'plain_text', content: text },
      behaviors: [{
        type: CARD_CALLBACK_BEHAVIOR,
        value: { action, messageId },
      }],
    }],
  };
}

/**
 * 构造只带提示（不改卡片）的回调响应。
 *
 * @param type 提示类型
 * @param content 提示文案
 * @returns 回调响应对象
 */
function toastResponse(type, content) {
  return { toast: { type, content } };
}

/**
 * 构造带提示并替换卡片的回调响应。
 *
 * @param type 提示类型
 * @param content 提示文案
 * @param card 替换后的卡片
 * @returns 回调响应对象
 */
function callbackCardResponse(type, content, card) {
  return { toast: { type, content }, card: { type: 'raw', data: card } };
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

/**
 * 请求守卫：只服务本机回环，且写入要求同源。
 *
 * @param req 请求
 * @param res 响应
 * @param method 允许的方法
 * @returns 通过时为 true；已写响应时为 false
 */
function guard(req, res, method) {
  const address = req.socket?.remoteAddress ?? '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  if (!loopback) {
    sendJson(res, 403, { error: '只允许本机访问' });
    return false;
  }
  if (req.method !== method) {
    res.setHeader('allow', method);
    sendJson(res, 405, { error: `只接受 ${method}` });
    return false;
  }
  const origin = req.headers?.origin;
  if (origin && method !== 'GET') {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers?.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      sendJson(res, 403, { error: '写入要求同源请求' });
      return false;
    }
  }
  return true;
}

/**
 * 读取并解析请求体 JSON。
 *
 * @param req 请求
 * @returns 解析结果
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
  });
}

/**
 * 输出 JSON 响应。
 *
 * @param res 响应
 * @param status HTTP 状态码
 * @param body 响应体
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

/**
 * 归一化错误信息。
 *
 * @param error 任意错误值
 * @returns 可读文本
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
