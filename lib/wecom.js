/**
 * dsh-feishu-assistant — 企业微信发送。
 *
 * 照 classroom 的 wecom 逻辑抄成 Node：gettoken（corpid + corpsecret）→ 按 corpId + agentId + secret
 * 缓存 access_token（提前 60 秒过期）→ message/send 发文本，正文按 2048 UTF-8 字节切分。
 *
 * 只提供发送函数，不做 HTTP 入口。开关关闭、corpId / agentId / 接收人 / Secret 任一缺失时
 * 直接跳过，不发请求。
 */

import { errorMessage } from './http.js';

/** 企业微信 Secret 的凭据名；写在 $DSH_HOME/.credentials.yaml 的 refs 下。 */
export const WECOM_SECRET_REF = 'FEISHU_ASSISTANT_WECOM_SECRET';

/** 企业微信开放接口基础地址。 */
const API_BASE_URL = 'https://qyapi.weixin.qq.com';

/** 获取 access_token 的接口路径。 */
const ACCESS_TOKEN_PATH = '/cgi-bin/gettoken';

/** 发送应用消息的接口路径。 */
const APP_MESSAGE_PATH = '/cgi-bin/message/send';

/** 接口超时。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 单条文本消息的 UTF-8 字节上限。 */
const MAX_TEXT_BYTES = 2048;

/** access_token 提前刷新的时长。 */
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/** access_token 取不到有效期时的兜底（企业微信默认 7200 秒）。 */
const DEFAULT_TOKEN_TTL_SECONDS = 7200;

/**
 * 建企业微信发送器。
 *
 * @param deps.logger 日志
 * @param deps.credentials 凭据服务（resolve Secret）
 * @param deps.getConfig 取当前配置：{ enabled, corpId, agentId, toUser }
 * @returns 发送器句柄
 */
export function createWecomSender({ logger, credentials, getConfig }) {
  /** 按 corpId + agentId 缓存的 access_token；Secret 变了就重取。 */
  let cachedToken;

  /** 正在获取的 token，按 corpId + agentId + Secret 分开，不同应用不共用请求。 */
  const tokenRequests = new Map();

  /**
   * 取当前配置，并把缺项列出来。
   *
   * @returns 配置快照与缺失项
   */
  function describe() {
    const config = getConfig() ?? {};
    const corpId = typeof config.corpId === 'string' ? config.corpId.trim() : '';
    const toUser = typeof config.toUser === 'string' ? config.toUser.trim() : '';
    const agentId = Number(config.agentId);
    const missing = [];
    if (config.enabled !== true) missing.push('wecomEnabled');
    if (!corpId) missing.push('wecomCorpId');
    if (!Number.isInteger(agentId) || agentId <= 0) missing.push('wecomAgentId');
    if (!toUser) missing.push('wecomToUser');
    return { enabled: config.enabled === true, corpId, agentId, toUser, missing };
  }

  /**
   * 取 access_token：缓存可用就复用，否则请求一次；并发调用共用同一个请求。
   *
   * @param corpId 企业 ID
   * @param agentId 应用 AgentId
   * @param secret 应用 Secret
   * @returns access_token
   */
  async function getAccessToken(corpId, agentId, secret) {
    if (cachedToken
      && cachedToken.corpId === corpId
      && cachedToken.agentId === agentId
      && cachedToken.secret === secret
      && Date.now() < cachedToken.expiresAt) {
      return cachedToken.token;
    }
    const key = `${corpId}\u0000${agentId}\u0000${secret}`;
    let request = tokenRequests.get(key);
    if (!request) {
      request = fetchAccessToken(corpId, secret).finally(() => {
        tokenRequests.delete(key);
      });
      tokenRequests.set(key, request);
    }
    const token = await request;
    const validMs = Math.max(token.expiresIn * 1000 - TOKEN_REFRESH_BUFFER_MS, 1000);
    cachedToken = {
      corpId,
      agentId,
      secret,
      token: token.accessToken,
      expiresAt: Date.now() + validMs,
    };
    return cachedToken.token;
  }

  /**
   * 请求 access_token。
   *
   * @param corpId 企业 ID
   * @param secret 应用 Secret
   * @returns access_token 与有效期
   */
  async function fetchAccessToken(corpId, secret) {
    const url = new URL(ACCESS_TOKEN_PATH, API_BASE_URL);
    url.searchParams.set('corpid', corpId);
    url.searchParams.set('corpsecret', secret);
    const payload = await requestJson(url, { method: 'GET' }, '获取企业微信 access_token');
    if (payload.errcode !== 0 || !payload.access_token) {
      throw new Error(`获取企业微信 access_token 失败：errcode=${payload.errcode}，errmsg=${payload.errmsg ?? ''}`);
    }
    const expiresIn = Number(payload.expires_in);
    return {
      accessToken: payload.access_token,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * 发一段文本。
   *
   * @param accessToken access_token
   * @param agentId 应用 AgentId
   * @param toUser 接收人 UserId
   * @param content 正文
   * @returns Promise
   */
  async function sendChunk(accessToken, agentId, toUser, content) {
    const url = new URL(APP_MESSAGE_PATH, API_BASE_URL);
    url.searchParams.set('access_token', accessToken);
    const payload = await requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        touser: toUser,
        msgtype: 'text',
        agentid: agentId,
        text: { content },
        safe: 0,
      }),
    }, '发送企业微信应用消息');
    if (payload.errcode !== 0) {
      throw new Error(`发送企业微信应用消息失败：errcode=${payload.errcode}，errmsg=${payload.errmsg ?? ''}`);
    }
  }

  /**
   * 发一次 HTTP 并解析 JSON。
   *
   * @param url 地址
   * @param init fetch 参数
   * @param operation 日志描述
   * @returns 响应对象
   */
  async function requestJson(url, init, operation) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`${operation}失败：HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text.trim()) {
      throw new Error(`${operation}失败：企业微信接口返回空响应`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${operation}失败：企业微信接口响应格式异常`);
    }
  }

  /**
   * 把正文按 2048 UTF-8 字节切分，按码点切，避免截断中文或 emoji。
   *
   * @param content 完整正文
   * @returns 待发送的分段
   */
  function splitContent(content) {
    const chunks = [];
    let current = '';
    let bytes = 0;
    for (const character of content) {
      const size = Buffer.byteLength(character, 'utf8');
      if (bytes + size > MAX_TEXT_BYTES) {
        chunks.push(current);
        current = '';
        bytes = 0;
      }
      current += character;
      bytes += size;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  /**
   * 发一条企微文本消息。
   *
   * 开关关闭、配置不全、Secret 缺失时直接返回 false，不发请求。
   *
   * @param text 正文
   * @param userId 接收人 UserId；不传时用配置里的 wecomToUser
   * @returns 发出去了返回 true
   */
  async function sendText(text, userId) {
    const config = describe();
    if (!config.enabled) return false;
    if (config.missing.length > 0) {
      logger.warn(`企微配置不全（${config.missing.join('、')}），跳过发送`);
      return false;
    }
    const toUser = (typeof userId === 'string' ? userId.trim() : '') || config.toUser;
    const content = String(text ?? '').trim();
    if (!toUser) {
      logger.warn('企微接收人为空，跳过发送');
      return false;
    }
    if (!content) {
      logger.warn('企微消息正文为空，跳过发送');
      return false;
    }
    try {
      const secret = (await credentials.resolve(WECOM_SECRET_REF))?.value ?? '';
      if (!secret) {
        logger.warn('企微 Secret 未配置（FEISHU_ASSISTANT_WECOM_SECRET），跳过发送');
        return false;
      }
      const accessToken = await getAccessToken(config.corpId, config.agentId, secret);
      for (const chunk of splitContent(content)) {
        await sendChunk(accessToken, config.agentId, toUser, chunk);
      }
      logger.info(`企微消息已发送给 ${toUser}`);
      return true;
    } catch (error) {
      logger.warn(`企微消息发送失败：${errorMessage(error)}`);
      return false;
    }
  }

  return { sendText, describe };
}
