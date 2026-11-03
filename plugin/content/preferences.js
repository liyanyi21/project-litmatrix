/* ResearchGrid. AGPL-3.0-or-later. */
/* global Zotero, document, window, RGAI, AbortController */
"use strict";

// Zotero runs each preference pane script in its own sandbox.
var ResearchGridPreferences = {
  init() {
    const version = Zotero.ProjectLitMatrix?.version;
    document.getElementById("research-grid-version").textContent = version ? `v${version}` : "";
    this.loadAIConfig();
    if (!this.aiUnloadBound) {
      window.addEventListener?.("unload", () => this.cancelAITest(), { once: true });
      this.aiUnloadBound = true;
    }
  },

  store() { return new RGAI.ConfigStore(Zotero); },
  credentials() {
    const credentials = Zotero.ProjectLitMatrix?.credentials;
    if (!credentials) throw new Error("密钥存储暂不可用，请重新启用研矩。");
    return credentials;
  },
  status(message) { document.getElementById("rg-ai-status").textContent = message; },
  async loadAIConfig() {
    try {
      const config = this.store().getConfig();
      document.getElementById("rg-ai-url").value = config.baseURL;
      document.getElementById("rg-ai-model").value = config.model;
      document.getElementById("rg-ai-summary-detail").value = config.summaryDetail;
      document.getElementById("rg-ai-max-chars").value = config.maxChars;
      document.getElementById("rg-ai-timeout").value = config.timeoutSeconds;
      document.getElementById("rg-ai-max-tokens").value = config.maxTokens;
      document.getElementById("rg-ai-key").value = "";
      await this.updateKeyStatus();
    } catch (_) { this.status("无法读取 AI 配置，请重新启用插件后重试。"); }
  },
  async updateKeyStatus() {
    let endpoint;
    try { endpoint = RGAI.endpointFor(document.getElementById("rg-ai-url").value); }
    catch (_) { document.getElementById("rg-ai-key-status").textContent = "先填写 API 地址。密钥按地址分别保存在本机 Zotero 密码管理器。"; return; }
    const hasKey = !!(await this.credentials().getKey(endpoint));
    document.getElementById("rg-ai-key-status").textContent = hasKey
      ? "当前 API 地址已有密钥；留空保持不变。不同地址的密钥分别保存。"
      : "尚未保存 API Key。无鉴权的本地服务可以留空。";
  },
  inputConfig() {
    return RGAI.normalizeConfig({
      baseURL: document.getElementById("rg-ai-url").value,
      model: document.getElementById("rg-ai-model").value,
      summaryDetail: document.getElementById("rg-ai-summary-detail").value,
      maxChars: Number(document.getElementById("rg-ai-max-chars").value),
      timeoutSeconds: Number(document.getElementById("rg-ai-timeout").value),
      maxTokens: Number(document.getElementById("rg-ai-max-tokens").value),
    });
  },
  setAIBusy(value) {
    this.aiBusy = value;
    for (const id of ["rg-ai-save", "rg-ai-test", "rg-ai-clear-key", "rg-ai-reset", "rg-ai-url", "rg-ai-model", "rg-ai-summary-detail", "rg-ai-key", "rg-ai-max-chars", "rg-ai-timeout", "rg-ai-max-tokens"]) {
      document.getElementById(id).disabled = value;
    }
    document.getElementById("rg-ai-cancel").disabled = !value || !this.aiController;
  },
  async saveAIConfig() {
    if (this.aiBusy) return;
    let credentials, previousKey, endpoint, changedKey = false, committed = false;
    try {
      const config = this.inputConfig();
      endpoint = RGAI.endpointFor(config.baseURL);
      this.setAIBusy(true);
      const typed = document.getElementById("rg-ai-key").value.trim();
      if (typed) {
        credentials = this.credentials();
        previousKey = await credentials.getKey(endpoint);
        await credentials.setKey(endpoint, typed);
        changedKey = true;
      }
      this.store().saveConfig(config);
      committed = true;
      document.getElementById("rg-ai-key").value = "";
      await this.updateKeyStatus();
      this.status("已保存 AI 设置。论文仅在你主动点击生成时发送到所配置的服务。");
    } catch (e) {
      if (changedKey && !committed) {
        try { if (previousKey) await credentials.setKey(endpoint, previousKey); else await credentials.clearKey(endpoint); }
        catch (_) { this.status("保存失败，密钥回滚也未完成，请重新检查密钥配置。"); return; }
      }
      this.status(e instanceof RGAI.AIError ? e.message : "保存 AI 设置失败，请检查本机密钥存储和输入内容。");
    } finally { this.setAIBusy(false); }
  },
  async clearAIKey() {
    if (this.aiBusy) return;
    try {
      this.setAIBusy(true);
      await this.credentials().clearKey(RGAI.endpointFor(document.getElementById("rg-ai-url").value));
      document.getElementById("rg-ai-key").value = "";
      await this.updateKeyStatus(); this.status("已清除研矩保存的 API Key。");
    } catch (_) { this.status("无法清除密钥，请重试。"); }
    finally { this.setAIBusy(false); }
  },
  async clearAIConfig() {
    if (this.aiBusy) return;
    try {
      this.store().clearConfig();
      await this.loadAIConfig();
      this.status("已清空 API 配置。各地址的密钥仍保留，可单独清除；论文和笔记没有改动。");
    } catch (_) { this.status("无法清空 AI 配置，请重试。"); }
  },
  cancelAITest() { this.aiController?.abort(); },
  async testAI() {
    if (this.aiBusy) return;
    try {
      const config = this.inputConfig();
      this.aiController = new AbortController(); this.setAIBusy(true);
      this.status("正在测试连接，只发送简短测试句…");
      const key = document.getElementById("rg-ai-key").value.trim() || await this.credentials().getKey(RGAI.endpointFor(config.baseURL));
      await RGAI.testConnection(config, key, { signal: this.aiController.signal,
        fetchImpl: (...args) => window.fetch(...args) });
      this.status("连接成功。当前输入只有点击“保存 API 设置”后才会用于文献总结。");
    } catch (e) { this.status(e instanceof RGAI.AIError ? e.message : "连接测试失败，请检查设置后重试。"); }
    finally { this.aiController = null; this.setAIBusy(false); }
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
