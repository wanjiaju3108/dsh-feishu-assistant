# 更新日志

这个插件每一版改了什么。版本号按 `package.json` 里的版本走。

## 未发布

### 凭据引用名改成 FEISHU_ASSISTANT_*

- 和 `dsh-feishu-cui` 的 `FEISHU_CUI_*` 对齐：`FEISHU_APP_ID` → `FEISHU_ASSISTANT_APP_ID`，`FEISHU_APP_SECRET` → `FEISHU_ASSISTANT_APP_SECRET`。插件读的是新名字，App ID / App Secret 的值不变。

### 升级注意

- 把 `.credentials.yaml` 里那两个键改名（值不动）：`FEISHU_APP_ID` → `FEISHU_ASSISTANT_APP_ID`、`FEISHU_APP_SECRET` → `FEISHU_ASSISTANT_APP_SECRET`。只改一边插件取不到凭据。

## 0.1.7

### 适配新版 DSH 的设置模型

- 目标会话 ID、管理员、人设内容、人设名这四项普通配置，从 `settings` 命名空间改到插件条目的 config，四个字段都标 `volatile`。
  这么改是因为 DSH 的设置服务只接受标了 `volatile` 的字段写入（`dsh-settings` 的 `write()` 找不到 volatile 字段会直接抛错），
  配置也由当前 Profile 的插件配置持久化。
- 设置变更的监听，从 `settings/updated` 换成 `loader/volatile-update`；写配置从 `settingsScope.replace(...)` 换成 `settings.update(条目 id, ...)`。
- 让 DSH 不要再按 `Config` 自动生成一份设置表单——这个插件自带设置页（走 `settings.section` 槽位）。
- 已在 DSH `0.1.7-rc.1` 上验证。

### 会话名恢复显示

- 修掉设置页里会话名读不出来、只显示会话 ID 的问题。原因：DSH `0.1.7-rc.1` 起 `sessionProjectionCache.cachedSnapshot`
  的第二个参数从日志偏移量改成了「要哪几个投影字段」，原来传的 `0` 会被拿去 `new Set(0)` 直接抛错，
  异常又被自己的 try/catch 吞掉，标题就成了空串。现在不传第二个参数，也就是要全部投影。
- 设置页「状态」区的「当前目标会话」优先显示会话名；列表里没有这个会话、或者它还没有名字时，退回显示会话 ID。

### 审批卡片发不出去时如实告诉请求人

- 修掉审批卡片没发到管理员、请求人却收到「已提交」的问题。原因：发卡片失败时返回 `false` 而不是抛错，
  原来只认抛错，这条请求就挂在待审批里，要等 30 分钟过期才通知请求人。现在发不出去就撤回登记、直接回失败提示。

### 升级注意

- 不用手工搬配置：原来的 `settings.yaml` 会被 DSH 按同名条目导入，导完把文件改名成 `settings.yaml.imported`。
