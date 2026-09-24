/** dsh-feishu-assistant — 会话目录：给设置页的会话下拉供数。 */

import { errorMessage } from './http.js';

/**
 * 建会话目录：给设置页的会话下拉供数。
 *
 * @param deps.ctx Cordis 上下文
 * @param deps.agents agent 注册表
 * @param deps.logger 日志
 * @returns 目录句柄
 */
export function createSessionCatalog({ ctx, agents, logger }) {
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
      // 第二个参数是「要哪几个投影字段」，不传就是要全部；传日志偏移量是老版本的用法，现在传数字会抛。
      const block = cache.cachedSnapshot(header) ?? cache.cachedPredecessorTitle(header);
      return block?.values;
    } catch (error) {
      logger.warn(`读取会话 ${header.id} 的投影失败：${errorMessage(error)}`);
      return undefined;
    }
  }

  return { listSessions };
}
