# 研矩 · ResearchGrid

基于 [LitMatrix 1.1.0](https://github.com/bapungiri/litmatrix/tree/v1.1.0) 的独立 Zotero 插件，使用 AGPL-3.0-or-later。可以与 LitMatrix 共存。

## 安装

从 [Releases](https://github.com/liyanyi21/research-grid/releases/latest) 下载 `.xpi` 文件，在 Zotero 的“工具 → 插件”中点击齿轮，选择“Install Plugin From File…”。安装后无需卸载原版 LitMatrix。首次使用建议先选中一个分类。

已在 macOS / Zotero 11.0-beta.3 实测，其他声明版本仍需要兼容性验证。详细记录见 [VALIDATION.md](VALIDATION.md)。

## 使用

1. 在 Zotero 左侧选中一个分类。
2. 选择“工具 → 研矩”，或在分类右键菜单中选择“打开研矩”。
3. 矩阵默认列出当前分类及所有子分类里的文献，包括没有高亮或批注的文献。相同文献去重。
4. 点击分析单元格，填写内容，再点击保存（或 Command/Ctrl + Enter）。取消保留原内容；修改内容后关闭会提示。
5. 通过顶部项目下拉框切换分类，或返回 Zotero 选中另一个分类，再点击“使用当前分类”。
6. 点击“显示字段”选择中文字段；显示偏好按项目保存。
7. 点击“导出 CSV”，选择路径。导出当前搜索/分析状态过滤后的文献，包含全部七个分析字段，即使部分字段隐藏。
8. 点击标题或“打开原文”打开 PDF/EPUB/HTML 阅读器；没有原文时定位 Zotero 条目。“批注”按钮列出原文批注，点击可跳到对应位置。

## 中文字段

任务与证据类型、研究方法与样本、观测指标、核心结论、局限性、与我的研究的关系、我的备注。

默认显示任务与证据类型、观测指标、核心结论和我的备注，其余可在“显示字段”开启。所有字段为纯文本，支持换行。第一版不自动读取全文或生成 AI 总结。

## 项目隔离与数据保存

- 一个分类就是一个项目，主分类与子分类分别打开时是不同项目。
- 父分类包含子分类时，编辑的仍是父分类项目的分析。
- 项目身份由个人库/群组身份与分类 key 构成；分类改名或移动不会改变身份。
- 同一文献可在多个项目拥有独立子笔记。文献即使移出分类，已经写下的项目子笔记仍保留。
- 仅主动保存分析时创建或修改本插件的子笔记；不会改原有 LitMatrix 笔记、元数据或批注。
- 子笔记标题为“研矩 · 项目名”，以专用标签识别项目，以字段属性标识固定字段 ID。不要移除项目笔记上的 `_projectlitmatrix:v1:` 标签。
- 同项目存在重复笔记时阻止编辑，避免静默选错笔记；请在 Zotero 中合并。
- 编辑保存前重新检查当前字段，检测其他窗口修改；发生冲突时保留输入并提示核对。
- 笔记与其标签使用 Zotero 原生同步。显示偏好使用本地 Zotero Prefs，不承诺跨设备同步。
- 只读群组文献库可查看和导出；独立 PDF 附件可展示和跳转，创建父文献条目后可填写分析。

## CSV 格式

UTF-8 BOM，CRLF 换行，所有单元格双引号转义，支持逗号、引号、多行文本及中文。对可能被电子表格当作公式的内容加单引号。包含文献、项目笔记与原文的 Zotero 链接。链接在安装 Zotero 且有对应文献的电脑上可用。

## 开发与打包

当前插件仅使用原生 JS/HTML/CSS，运行时没有 npm 依赖。

```sh
npm ci
npm test
npm run build
```

构建依赖 Python 3 标准库；产物为 `dist/research-grid-0.1.1.xpi`，另附对应源码包与 SHA256SUMS。在 Zotero 插件管理器选择“Install Plugin From File…”安装。插件不提供自动更新，后续使用新 XPI 手动更新。Zotero 强制要求提供 HTTPS 更新地址，因此清单使用本机端口 0 的不可连接地址作为占位；不会向远程服务检查更新。`content/updates.json` 为未来发布时可用的空清单模板。

## 文件组织

- `plugin/bootstrap.js`：独立生命周期、菜单、窗口；不修改 LitMatrix 的全局对象或标签页钩子。
- `plugin/content/core.js`：字段、项目身份、笔记编解码、论文级搜索和 CSV。
- `plugin/content/repository.js`：Zotero 数据读写、项目笔记隔离、权限和冲突检查、原文跳转。
- `plugin/content/matrix.js`：中文矩阵、编辑、字段偏好、刷新和导出交互。
- `tests/`：核心数据行为与 Zotero 适配器测试。
- `scripts/build.py`：XPI 与对应源代码打包。

声明 Zotero 7–11 版本范围；实际验证范围见 `VALIDATION.md`。自动化适配器测试不等同于所有版本的真实运行验证。

## 参与开发与许可

开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。基于 LitMatrix 1.1.0 改造，保留上游署名，按 [AGPL-3.0-or-later](LICENSE) 分发，具体来源与修改说明见 [NOTICE](NOTICE)。

## 从旧版升级

研矩是原 Project LitMatrix 的后续名称。安装新版 XPI 即可原位升级；插件内部 ID、项目笔记标签和字段 ID 保持不变，因此已有分析、备注与显示偏好继续可用。旧笔记标题保留原样，新建笔记使用“研矩 · 项目名”。
