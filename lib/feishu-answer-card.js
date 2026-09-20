/**
 * dsh-feishu-assistant — 回答卡片。
 *
 * 一条回答只用一张卡片：先建**卡片实体**再发出去——飞书请求回答到被回复的那条消息，非飞书发起的
 * 轮次主动私聊推给管理员——初始正文是「正在处理」；之后每产出一段就把 markdown 组件**整块换掉**
 * （`cardkit.cardElement.update`），客户端立刻显示。
 *
 * **不用卡片流式接口**（`cardElement.content`）：那是给"逐字生成"准备的，客户端会把新增部分按打字机
 * 慢慢打，一段几百字的正文要打好几秒；而且收尾（关流式模式）会把还没打完的内容一次性刷出来，观感是
 * "打几个字突然整段蹦出"。我们这边本来就是**按步**拿到整段正文，直接整块替换更快也更稳。
 *
 * 一张卡片的体积上限是 30KB，装不下就**翻页**：再建一张新卡接着写（卡片实体只能发送一次，所以翻页
 * 必然是另一条消息）。整块替换失败时，收尾会把还没上屏的正文补发成普通消息，不丢内容。
 */

import { randomUUID } from 'node:crypto';

import {
  ANSWER_CARD_ELEMENT_ID,
  ANSWER_CARD_MAX_BYTES,
  CARD_SCHEMA_VERSION,
} from './constants.js';
import { markdownElement } from './feishu-cards.js';
import { cardRefMessage, sendMessage, sendTarget, textMessage } from './feishu-messages.js';

/**
 * 建回答卡片的入口。
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
   * 建一张卡片的句柄：更新、翻页、补尾巴都收在这一个对象里。
   *
   * 更新是串行的——调用方可以 fire-and-forget，close() 会等前面排完，避免 sequence 乱序。
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
     * 把当前页的正文整块换到卡片上。
     *
     * @param text 当前页要显示的全量文本
     * @returns 上屏成功时 true
     */
    async function put(text) {
      sequence += 1;
      const response = await send(
        (client) => client.cardkit.v1.cardElement.update({
          path: { card_id: pageCardId, element_id: ANSWER_CARD_ELEMENT_ID },
          data: {
            element: JSON.stringify(markdownElement(text, ANSWER_CARD_ELEMENT_ID)),
            sequence,
            uuid: randomUUID(),
          },
        }),
        '更新回答卡片',
      );
      return response !== undefined;
    }

    /**
     * 翻页：建一张新卡接着写。
     *
     * @returns 新页开出来了返回 true
     */
    async function rollover() {
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
     * 收尾：等更新排完，并把还没上屏的尾巴补发成普通消息。
     *
     * 非流式卡片没有"流式模式"要关，也没有打字机要等——这里只剩"别丢内容"。
     *
     * @returns Promise
     */
    async function close() {
      await chain;
      if (closed) return;
      closed = true;
      const tail = fullText.slice(shown);
      if (tail.length === 0) return;
      // 卡片上没显示出来的部分不能丢：补一条普通消息。
      logger.warn('回答卡片有内容没上屏，补发成普通消息');
      await sendMessage(send, target, textMessage(tail), '补发回答卡片遗漏内容');
    }

    return { update, close };
  }

  /**
   * 拼一张回答卡片：非流式，正文整块换。
   *
   * @param text 正文
   * @returns 卡片对象
   */
  function buildCard(text) {
    return {
      schema: CARD_SCHEMA_VERSION,
      config: { update_multi: true },
      body: { elements: [markdownElement(text, ANSWER_CARD_ELEMENT_ID)] },
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
