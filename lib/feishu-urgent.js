/**
 * dsh-feishu-assistant — 对已发出消息的加急。
 *
 * 加急不是"再发一条消息"，而是对**已经发出去的那条**做操作（催一下接收人），所以和发送分开收一层，
 * 跟 feishu-user.js 的姓名解析同类：都跟飞书打交道，但不属于"发什么、发去哪"。
 *
 * 两个硬前提：加急只能用**机器人身份**发起，而且机器人必须是这条消息的发送者——所以拿来做加急的
 * 只能是机器人自己发出的那张审批卡片。user_id_type 是必填项，这里固定 open_id（管理员由配对写入，
 * 存的就是 open_id）。
 *
 * 加急只是"催一下"，失败绝不能影响审批本身；失败由 send 记日志，这里只返回 false。
 */

/**
 * 建加急发送器。
 *
 * @param deps.logger 日志
 * @param deps.send 出站请求发送器（feishu-request.js 的 send：**返回响应体**的那个）
 * @returns 加急句柄：sendUrgentApp / sendUrgentSms
 */
export function createUrgentSender({ logger, send }) {
  /**
   * 发应用内加急：把这条消息在飞书里标成"急"。
   *
   * @param messageId 要加急的消息 ID
   * @param userId 加急给谁（管理员的 open_id）
   * @returns 发出去了返回 true
   */
  function sendUrgentApp(messageId, userId) {
    return sendUrgent(messageId, userId, (client, args) => client.im.message.urgentApp(args), '应用内加急');
  }

  /**
   * 发短信加急。
   *
   * @param messageId 要加急的消息 ID
   * @param userId 加急给谁（管理员的 open_id）
   * @returns 发出去了返回 true
   */
  function sendUrgentSms(messageId, userId) {
    return sendUrgent(messageId, userId, (client, args) => client.im.message.urgentSms(args), '短信加急');
  }

  /**
   * 发一次加急。
   *
   * @param messageId 要加急的消息 ID
   * @param userId 加急给谁
   * @param call 具体调哪个加急接口
   * @param describe 日志描述
   * @returns 发出去了返回 true
   */
  async function sendUrgent(messageId, userId, call, describe) {
    if (!messageId || !userId) return false;
    // send 失败时返回 undefined 而不是抛错（见 feishu-request.js），所以看返回值判成败。
    const sent = await send(
      (client) => call(client, {
        path: { message_id: messageId },
        params: { user_id_type: 'open_id' },
        data: { user_id_list: [userId] },
      }),
      describe,
    );
    if (!sent) return false;
    const invalid = sent?.data?.invalid_user_id_list ?? [];
    if (invalid.length > 0) logger.warn(`${describe}未送达：${invalid.join(', ')}`);
    return true;
  }

  return { sendUrgentApp, sendUrgentSms };
}
