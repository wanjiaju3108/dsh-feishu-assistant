# dsh-feishu-assistant

用飞书长连接驱动一条 DSH 会话的插件：私聊消息注入指定会话并唤醒它，会话产出的回答回写到飞书。

**不需要公网入口** —— 由 DSH 进程主动连出飞书，事件和卡片回调都走同一条长连接。

## 安装

```bash
dsh plugin --profile web add dsh-feishu-assistant
```

装完重启 `dsh web`（客户端 bundle 的 rev 在启动时算，改完不重启看不到）。

## 首次配置

打开 设置 → 「飞书AI助理」，依次填三样：

| 项 | 存哪 | 说明 |
|---|---|---|
| App ID / App Secret | `$DSH_HOME/.credentials.yaml` | 飞书自建应用凭据。写入后不回显；被环境变量或 `.env` 遮蔽时页面显示为只读 |
| 目标会话 | `$DSH_HOME/settings.yaml` | 从下拉里选本机已有会话。会话必须能被本进程打开（插件会自己 resume） |
| 管理员 | `$DSH_HOME/settings.yaml` | 不手填。点「生成配对码」，把 8 位口令私聊发给机器人，发送者即被设为管理员 |

飞书侧需要：应用开启机器人能力，权限 `im:message.p2p_msg:readonly` + `im:message:send_as_bot`，
事件订阅 `im.message.receive_v1` 与卡片回调都选**长连接**方式。

配对码 8 位、10 分钟有效、用一次即废，只存在内存里。

## 行为

```
飞书私聊文本
  ├─ 配对码            → 把发送者设为管理员，回执
  ├─ 管理员            → 直接进请求队列
  └─ 其他人            → 发审批卡片给管理员；同意后进请求队列，拒绝则回执
                          （待审批最多 20 条、30 分钟过期，作废时回消息告知）
```

- **请求队列串行**：先进先出，前一条整轮 `turn/end` 结束才注入下一条
- **回答增量回写**：每产出一条 `assistant/message` 回一条，不做整轮聚合；超过 3000 字按换行分多条发
- **回写重试**：单条失败重试 3 次（500ms / 1000ms 退避）
- **会话主动打开**：启动、换目标会话、收到消息时都会 `sessionController.resolveAgent()` 把会话拉起来，失败原因显示在设置页
- **审批人校验**：卡片回调校验点击人的 open_id / user_id / union_id，非管理员点不了

## 配置项

设置页改的都会即时生效（`applies: 'live'`），不需要重启；但改 `lib/client.js` 那半边要重启进程。

补丁层也可以给初始值：

```yaml
- id: feishu-assistant
  name: dsh-feishu-assistant
  config:
    sessionId: ''
```

## 已知边界

- 只处理**私聊**文本消息：群聊、图片、文件、富文本、语音一律忽略
- 目标会话必须能被本进程 resume；被另一个进程占着时会失败（DSH 会话是单进程独占的）
- 待审批缓存是内存态，DSH 重启即丢
- 没有发送者限流；没有 `/` 命令

## 依赖的 DSH 服务

`agents`、`settings`、`credentials`、`webServer`、`sessionController`（前四个之外必须列进 `inject`，
否则启动时拿不到会话控制器，主动打开会话会失败）。
