# 更新日志

这个插件每一版改了什么。版本号按 `package.json` 里的版本走。

## 未发布

### 适配新版 DSH 的设置模型

- 目标会话 ID、管理员、人设内容、人设名这四项普通配置，从 `settings` 命名空间改到插件条目的 config，四个字段都标 `volatile`。
  这么改是因为 DSH 的设置服务只接受标了 `volatile` 的字段写入（`dsh-settings` 的 `write()` 找不到 volatile 字段会直接抛错），
  配置也由当前 Profile 的插件配置持久化。
- 设置变更的监听，从 `settings/updated` 换成 `loader/volatile-update`；写配置从 `settingsScope.replace(...)` 换成 `settings.update(条目 id, ...)`。
- 让 DSH 不要再按 `Config` 自动生成一份设置表单——这个插件自带设置页（走 `settings.section` 槽位）。
- 已在 DSH `0.1.7-rc.1` 上验证。

### 升级注意

- 不用手工搬配置：原来的 `settings.yaml` 会被 DSH 按同名条目导入，导完把文件改名成 `settings.yaml.imported`。
