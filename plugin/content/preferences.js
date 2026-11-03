/* ResearchGrid. AGPL-3.0-or-later. */
/* global Zotero, document */
"use strict";

// Zotero runs each preference pane script in its own sandbox.
var ResearchGridPreferences = {
  init() {
    const version = Zotero.ProjectLitMatrix?.version;
    document.getElementById("research-grid-version").textContent = version ? `v${version}` : "";
  },

  openMatrix() {
    this.launch("open");
  },

  openFields() {
    this.launch("openFields");
  },

  launch(action) {
    const error = document.getElementById("research-grid-preferences-error");
    error.textContent = "";
    try {
      Zotero.ProjectLitMatrix[action]();
    } catch (e) {
      Zotero.logError(e);
      error.textContent = "文献矩阵暂时无法打开，请关闭设置窗口后从工具菜单重试。";
    }
  },
};
