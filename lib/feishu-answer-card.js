/**
 * dsh-feishu-assistant — 流式回答卡片。
 *
 * 一条回答只用一张卡片：先建**卡片实体**（流式模式）再发出去——飞书请求回答到被回复的那条消息，
 * 非飞书发起的轮次主动私聊推给管理员——初始正文是「正在处理」；之后每产出一段就调流式更新接口，
 * 把**累计正文**全量传过去。飞书客户端会保留共同前缀，把**新增的那部分逐字打出来**（第一段也不例外），
 * 所以：
 *
 * - 打字速度由卡片上的 `streaming_config` 写死，不猜客户端默认值；
 * - 收尾（关流式模式）会把还没打完的内容**一次性刷出来**，所以 `close()` 会先按最后一段的字数
 *   等一会儿再关，否则就会出现"打了几个字突然整段蹦出"。
 *
 * 一张卡片的体积上限是 30KB，装不下就**翻页**：关掉当前卡片的流式模式，再建一张新卡接着写
 * （卡片实体只能发送一次，所以翻页必然是另一条消息）。整轮结束后关掉流式模式，否则卡片不能
 * 转发、聊天栏预览会一直显示「生成中…」。
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ANSWER_CARD_ELEMENT_ID,
  ANSWER_CARD_MAX_BYTES,
  ANSWER_CARD_PRINT_FREQUENCY_MS,
  ANSWER_CARD_PRINT_STEP,
  ANSWER_CARD_TYPING_GRACE_MAX_MS,
  CARD_SCHEMA_VERSION,
} from './constants.js';
import { cardRefMessage, sendMessage, sendTarget, textMessage } from './feishu-messages.js';

/**
 * 建流式回答卡片的入口。
 *
 * @param deps.logger 日志
 * @param deps.send 出站请求发送器（见 feishu-request.js）
 * @returns { open } —— open() 开一张卡并返回句柄；开不出来返回 undefined
 */
export function createAnswerCardFlow({ logger, send }) {
  /**
   * 开一张回答卡片。
   *
   * 建实体或发送失败都返回 undefined，由调用方退回"每段一张普通卡片"。
   *
   * @param options.messageId 被回复的飞书消息 ID；与 openId 二选一
   * @param options.openId 主动私聊的接收人；与 messageId 二选一
   * @param options.initialText 初始正文，通常是「正在处理」
   * @returns 卡片句柄；开不出来时 undefined
   */
  async function open({ messageId, openId, initialText }) {
    const target = sendTarget(messageId, openId);
    if (!target) {
      logger.warn('回答卡片没有发送目标，放弃建卡');
      return undefined;
    }
    const cardId = await createEntity(initialText);
    if (!cardId) return undefined;
    if (!(await sendEntity(cardId, target, '发送回答卡片'))) {
      logger.warn('回答卡片没能发出去，退回普通卡片');
      return undefined;
    }
    return createHandle({ target, cardId });
  }

  /**
   * 建一个卡片实体。
   *
   * @param text 初始正文
   * @returns 卡片实体 ID；失败时 undefined
   */
  async function createEntity(text) {
    const created = await send(
      (client) => client.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(buildCard(text)) },
      }),
      '建回答卡片实体',
    );
    const cardId = created?.data?.card_id;
    if (!cardId) logger.warn('回答卡片实体没拿到 card_id');
    return cardId;
  }

  /**
   * 用卡片实体发一条消息：回复目标就回复，私聊目标就主动私聊。
   *
   * @param cardId 卡片实体 ID
   * @param target 发送目标
   * @param describe 日志描述
   * @returns 发出了返回 true
   */
  function sendEntity(cardId, target, describe) {
    return sendMessage(send, target, cardRefMessage(cardId), describe);
  }

  /**
   * 建一张卡片的句柄：更新、翻页、关流式、补尾巴都收在这一个对象里。
   *
   * 更新是串行的——调用方可以 fire-and-forget，close() 会等前面排完，避免 sequence 乱序
   * 或者关闭抢在最后一帧前面。
   *
   * @param deps.target 发送目标：回复某条消息，或主动私聊某个人（翻页时新卡也发到它上面）
   * @param deps.cardId 初始卡片实体 ID
   * @returns 句柄
   */
  function createHandle({ target, cardId }) {
    /** 当前页的卡片实体 ID。 */
    let pageCardId = cardId;
    /** 当前页的操作序号；同一张卡上必须严格递增。 */
    let sequence = 0;
    /** 完整正文里当前页从第几个字符开始；翻页时往后挪。 */
    let pageStart = 0;
    /** 已经成功上屏到完整正文的第几个字符；失败时用它算出要补发的尾巴。 */
    let shown = 0;
    /** 完整正文的最新快照。 */
    let fullText = '';
    /** 串行化的更新链。 */
    let chain = Promise.resolve();
    /** 是否已经收尾。 */
    let closed = false;
    /**
     * 客户端还在打的字数：最近一次更新比上一次多出来的部分。
     *
     * 飞书是客户端逐字打在已有内容后面，收到新内容就按"共同前缀 + 新增部分"重排；
     * 收尾时剩下没打完的会被一次性刷出来，所以收尾前要按这个字数留时间。
     */
    let typingChars = 0;
    /** 最近一次内容更新的时间；用来扣掉"更新完到收尾之间"已经过去的时间。 */
    let typingAt = 0;

    /**
     * 把一段文本更新到当前页；被拒时先重开流式模式再试一次。
     *
     * @param text 当前页要显示的全量文本
     * @returns 上屏成功时 true
     */
    async function put(text) {
      if (await putOnce(text)) return true;
      if (!(await setStreaming(true))) return false;
      return putOnce(text);
    }

    /**
     * 发一次流式更新。
     *
     * @param text 当前页要显示的全量文本
     * @returns 成功时 true
     */
    async function putOnce(text) {
      sequence += 1;
      const response = await send(
        (client) => client.cardkit.v1.cardElement.content({
          path: { card_id: pageCardId, element_id: ANSWER_CARD_ELEMENT_ID },
          data: { content: text, sequence, uuid: randomUUID() },
        }),
        '更新回答卡片',
      );
      if (response === undefined) return false;
      // 这一页上一次已经上屏的长度就是 shown 到页首的距离；多出来的部分客户端要逐字打。
      typingChars = Math.max(0, text.length - (shown - pageStart));
      typingAt = Date.now();
      return true;
    }

    /**
     * 开关当前页的流式模式。
     *
     * @param streaming 目标状态
     * @returns 设置成功时 true
     */
    async function setStreaming(streaming) {
      sequence += 1;
      const response = await send(
        (client) => client.cardkit.v1.card.settings({
          path: { card_id: pageCardId },
          data: {
            settings: JSON.stringify({ config: { streaming_mode: streaming } }),
            sequence,
            uuid: randomUUID(),
          },
        }),
        streaming ? '重开回答卡片流式模式' : '关闭回答卡片流式模式',
      );
      return response !== undefined;
    }

    /**
     * 翻页：关掉当前页的流式模式，再建一张新卡接着写。
     *
     * @returns 新页开出来了返回 true
     */
    async function rollover() {
      await setStreaming(false);
      const nextCardId = await createEntity('');
      if (!nextCardId) return false;
      if (!(await sendEntity(nextCardId, target, '发送回答卡片续页'))) return false;
      pageCardId = nextCardId;
      sequence = 0;
      return true;
    }

    /**
     * 这一页装不下时的切点。
     *
     * @param text 当前页要显示的文本
     * @returns 切点下标（优先在换行处切）；装得下时返回 0
     */
    function cutIndex(text) {
      if (cardBytes(text) <= ANSWER_CARD_MAX_BYTES) return 0;
      let low = 0;
      let high = text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (cardBytes(text.slice(0, mid)) <= ANSWER_CARD_MAX_BYTES) low = mid;
        else high = mid - 1;
      }
      const newline = text.lastIndexOf('\n', low);
      return newline > 0 ? newline : Math.max(low, 1);
    }

    /**
     * 把完整正文刷到卡片上：装不下就先发满一页、翻页、继续。
     *
     * @returns Promise
     */
    async function flush() {
      let pageText = fullText.slice(pageStart);
      for (let cut = cutIndex(pageText); cut > 0; cut = cutIndex(pageText)) {
        if (!(await put(pageText.slice(0, cut)))) return;
        shown = pageStart + cut;
        if (!(await rollover())) return;
        // 翻页后这一页从刚发完的那一段之后开始，否则会一直重切同一段。
        pageStart += cut;
        shown = pageStart;
        pageText = fullText.slice(pageStart);
      }
      if (await put(pageText)) shown = pageStart + pageText.length;
    }

    /**
     * 更新整轮回答的正文（全量，不是增量）。
     *
     * @param text 累计到现在的完整正文
     * @returns 排到队尾的 Promise
     */
    function update(text) {
      fullText = text;
      chain = chain.then(() => (closed ? undefined : flush())).catch((error) => {
        logger.warn(`更新回答卡片失败：${String(error)}`);
      });
      return chain;
    }

    /**
     * 收尾：等更新排完、等打字机打完最后一段、关掉流式模式，并把没上屏的尾巴补发成普通消息。
     *
     * @returns Promise
     */
    async function close() {
      await chain;
      if (closed) return;
      closed = true;
      // 关流式会把还没打出来的内容一次性刷出来，所以先留时间给客户端打完。
      await waitForTyping();
      await setStreaming(false);
      const tail = fullText.slice(shown);
      if (tail.length === 0) return;
      // 卡片上没显示出来的部分不能丢：补一条普通消息。
      logger.warn('回答卡片有内容没上屏，补发成普通消息');
      await sendTail(target, tail);
    }

    /**
     * 等客户端把最近那段打完。
     *
     * 按"最后一段新增字数 × 每字耗时"估算，扣掉更新完到现在已经过去的时间，再封顶：
     * 等太久会一直占着"生成中"、卡片也不能转发，超长的那部分只能让它刷出来。
     *
     * @returns Promise
     */
    function waitForTyping() {
      if (typingChars === 0) return undefined;
      const typingMs = typingChars * (ANSWER_CARD_PRINT_FREQUENCY_MS / ANSWER_CARD_PRINT_STEP);
      const left = Math.min(ANSWER_CARD_TYPING_GRACE_MAX_MS, typingMs) - (Date.now() - typingAt);
      return left > 0 ? delay(left) : undefined;
    }

    /**
     * 卡片上没显示出来的正文补一条普通消息：回复目标就回复，私聊目标就私聊。
     *
     * @param target 发送目标
     * @param text 补发的正文
     * @returns Promise
     */
    function sendTail(target, text) {
      return sendMessage(send, target, textMessage(text), '补发回答卡片遗漏内容');
    }

    return { update, close };
  }

  /**
   * 拼一张回答卡片。
   *
   * @param text 正文
   * @returns 卡片对象
   */
  function buildCard(text) {
    return {
      schema: CARD_SCHEMA_VERSION,
      config: {
        update_multi: true,
        streaming_mode: true,
        // 打印速率写死：既让打字机速度可控，也让"收尾要等多久"算得出来。
        streaming_config: {
          print_frequency_ms: { default: ANSWER_CARD_PRINT_FREQUENCY_MS },
          print_step: { default: ANSWER_CARD_PRINT_STEP },
          print_strategy: 'fast',
        },
      },
      body: {
        elements: [{ tag: 'markdown', element_id: ANSWER_CARD_ELEMENT_ID, content: text }],
      },
    };
  }

  /**
   * 一张卡片序列化后的字节数；飞书按卡片体积（≤30KB）卡上限。
   *
   * @param text 正文
   * @returns 字节数
   */
  function cardBytes(text) {
    return Buffer.byteLength(JSON.stringify(buildCard(text)), 'utf8');
  }

  return { open };
}
