/**
 * dsh-feishu-assistant — 常量。
 *
 * 事件类型、卡片结构、文案与各项上限集中在这里，供宿主半边各模块共用。
 */

/** App ID 的凭据名。 */
export const APP_ID_REF = 'FEISHU_APP_ID';

/** App Secret 的凭据名。 */
export const APP_SECRET_REF = 'FEISHU_APP_SECRET';

/** 凭据名必须是 POSIX 标识符，与 credentialRef 的约束一致。 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 设置命名空间。 */
export const SETTINGS_NAMESPACE = 'feishu-assistant';

/** 设置页读取状态的路径。 */
export const STATE_ROUTE = '/dsh-feishu-assistant/state';

/** 设置页写入普通配置的路径。 */
export const CONFIG_ROUTE = '/dsh-feishu-assistant/config';

/** 设置页写入凭据的路径。 */
export const CREDENTIALS_ROUTE = '/dsh-feishu-assistant/credentials';

/** 设置页读取可选会话列表的路径。 */
export const SESSIONS_ROUTE = '/dsh-feishu-assistant/sessions';

/** 设置页生成配对口令的路径。 */
export const PAIRING_ROUTE = '/dsh-feishu-assistant/pairing';

/** 配对码字符集：去掉 0/O/1/I 这类容易看混的字符。 */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 配对码长度；够挡住盲猜。 */
export const PAIRING_CODE_LENGTH = 8;

/** 配对码有效期。 */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** 飞书接收消息事件类型。 */
export const MESSAGE_RECEIVE_EVENT_TYPE = 'im.message.receive_v1';

/** 飞书卡片按钮回调事件类型。 */
export const CARD_ACTION_EVENT_TYPE = 'card.action.trigger';

/** 飞书文本消息类型。 */
export const TEXT_MESSAGE_TYPE = 'text';

/** 飞书交互卡片消息类型。 */
export const INTERACTIVE_MESSAGE_TYPE = 'interactive';

/** 飞书新版卡片 JSON 版本。 */
export const CARD_SCHEMA_VERSION = '2.0';

/** 审批卡片标题。 */
export const APPROVAL_CARD_TITLE = '是否进行回应';

/** 审批卡片同意按钮文案。 */
export const APPROVE_BUTTON_TEXT = '同意';

/** 审批卡片拒绝按钮文案。 */
export const REJECT_BUTTON_TEXT = '拒绝';

/** 审批卡片按钮回调行为类型。 */
export const CARD_CALLBACK_BEHAVIOR = 'callback';

/** 待审批卡片的头部配色。 */
export const APPROVAL_HEADER_PENDING = 'blue';

/** 审批通过卡片（结果态）的头部配色。 */
export const APPROVAL_HEADER_APPROVED = 'green';

/** 审批拒绝卡片（结果态）的头部配色。 */
export const APPROVAL_HEADER_REJECTED = 'grey';

/** 待审批缓存上限，防止被陌生人刷爆内存。 */
export const MAX_PENDING_APPROVALS = 20;

/** 待审批有效期；超时的请求不再可批。 */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** 请求人可见的固定回复文案。 */
export const REPLY_TEXT = {
  submitted: '已提交管理员审批，通过后开始处理',
  processing: '正在处理',
  rejected: '无法处理这条消息',
  expired: '这条请求一直没有得到管理员处理，已经失效',
  failure: '暂时无法处理该消息，请稍后重试',
  sessionUnavailable: '目标会话不可用，请在 DSH 设置页「飞书AI助理」里重新选一条会话。',
};

/** 目标会话打不开时主动私聊告知管理员一次的文案。 */
export const MANAGER_ALERT_SESSION_UNAVAILABLE =
  '飞书助手：目标会话打不开了，消息暂时处理不了。请到 DSH 设置页「飞书AI助理」重新选一条会话。';

/** 单条飞书文本消息的最大字符数；超长回答按换行切开分多条发。 */
export const REPLY_CHUNK_CHARS = 3000;

/** 待审批清扫间隔。 */

/** 只处理私聊：群聊要 @ 机器人，把内容转进会话会打扰其他人。 */
export const DIRECT_CHAT_TYPE = 'p2p';

/** 会话产出的 assistant 消息事件类型。 */
export const ASSISTANT_MESSAGE_EVENT_TYPE = 'assistant/message';

/** 会话一轮 turn 结束的事件类型。 */
export const TURN_END_EVENT_TYPE = 'turn/end';

/** 等 turn 结束时的兜底巡检间隔：agent 被关掉后不会再发 turn/end，别把队列卡死。 */
export const TURN_WATCH_INTERVAL_MS = 1000;

/** 回写飞书的最大尝试次数（含首次）。 */
export const REPLY_MAX_ATTEMPTS = 3;

/** 回写重试的基准间隔；第 n 次重试等 REPLY_RETRY_BASE_MS * n。 */
export const REPLY_RETRY_BASE_MS = 500;

/** 请求体上限，防止设置页路由被塞大包。 */
export const MAX_BODY_BYTES = 64 * 1024;
