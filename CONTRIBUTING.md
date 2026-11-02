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
