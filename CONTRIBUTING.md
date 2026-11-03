# 开发说明

环境：Node.js 22、Python 3.10 或更高版本、Zotero 7–11。运行时使用 Zotero 自带的 JS/DOM，不需要 Node.js。

```sh
npm ci
npm test
npm run build
```

`dist/` 生成可安装的 XPI、对应源代码包和 SHA256SUMS。提交 PR 前运行上述命令，并在 Zotero 实际安装检查窗口、保存与跳转；自动化测试不替代应用内验证。

## 维护约定

- 项目身份和字段 ID 属于持久数据协议；改变时必须设计迁移，不能仅改显示标签。
- 只通过 Zotero Item API 写入本插件项目笔记；保持事务、权限与冲突检查。
- 不依赖本地数字 ID 作为可同步身份，不覆盖原版 LitMatrix 或其他笔记。
- `validation/`、个人文献导出、工作日志及凭据不得提交或打包。
- 修改构建文件允许清单时检查源代码包，避免携带私人文件。
- 发布时同步修改 `package.json` 与 `plugin/manifest.json` 版本，更新 CHANGELOG 与验证范围。
- GitHub Release 同时提供 XPI、对应源码 ZIP 和 SHA256SUMS，保留 LICENSE、NOTICE 与上游署名。

当前采用手动 XPI 更新。启用自动更新前需要配置自己的 HTTPS 更新清单及发布流程，并验证 Zotero 的更新规则。

提交问题时说明 Zotero/系统版本、复现步骤及错误信息；请先移除文献内容、私人分类名称及其他个人数据。

## 扩展原生设置页

`bootstrap.js` 在启动时注册 `research-grid-preferences`，停用时注销。`content/preferences.xhtml` 是由 Zotero 加载的 XUL/XHTML 片段；Zotero 8 起，`preferences.js` 在该面板专属沙盒中运行，内联事件通过 `Zotero_Preferences.getScope()` 访问控制器；Zotero 7 回退到设置窗口作用域。新增功能设置可放入 `research-grid-feature-settings` 分组，并在控制器内实现读取和保存。全局配置与每项目显示偏好应分别存储，避免覆盖既有项目数据；新增的配置键应使用插件独立命名空间。

相关官方接口：[Zotero 7 设置页注册](https://www.zotero.org/support/dev/zotero_7_for_developers#preference_panes)、[Zotero 8 作用域变化](https://www.zotero.org/support/dev/zotero_8_for_developers)。

## 动态字段与编辑草稿

字段依靠稳定 ID 匹配笔记，改名需把旧名称保留在 aliases 中，以便原生笔记编辑器移除自定义属性后仍可恢复。移出字段只设 archived，禁止删笔记分区。默认字段的原中文名称作为旧数据身份保留。字段定义和模板存本机偏好，模板应用必须复制定义，不共享可变对象。

表格内编辑和弹窗共享原值与草稿，保存事务的并发检查继续使用打开时原值。键盘事件和表单提交需要同步 preventDefault，再执行异步保存。
