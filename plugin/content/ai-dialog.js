/* ResearchGrid single-paper AI drafts. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const AI = root.RGAI || (typeof require === "function" ? require("./ai.js") : null);
  const clone = value => JSON.parse(JSON.stringify(value));
  const signature = fields => JSON.stringify(fields.filter(f => !f.archived)
    .map(f => [f.id, f.label, f.requirement || ""]));
  const detailOption = id => AI.SUMMARY_DETAILS.find(option => option.id === id) || AI.SUMMARY_DETAILS[0];

  class Manager {
    constructor(options) {
      this.options = options;
      this.document = options.document;
      this.dialog = null;
      this.busy = false;
      this.saving = false;
      this.generating = false;
      this.loading = false;
      this.generation = 0;
      this.sourceGeneration = 0;
      this.drafts = new Map();
      this.applySelected = new Set();
    }
    el(tag, attrs = {}, ...children) {
      const element = this.document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
        else if (["checked", "disabled", "value"].includes(key)) element[key] = value;
        else element.setAttribute(key, value === true ? "" : String(value));
      }
      for (const child of children.flat()) {
        if (child == null) continue;
        element.append(typeof child === "string" ? this.document.createTextNode(child) : child);
      }
      return element;
    }
    safe(fn) {
      return event => {
        event?.preventDefault();
        try { Promise.resolve(fn(event)).catch(error => this.fail(error)); }
        catch (error) { this.fail(error); }
      };
    }
    isOpen() { return !!this.dialog?.open; }
    dirty() {
      return [...this.drafts].some(([id, value]) => value.trim() ||
        (this.applySelected.has(id) && value !== this.expected[id]));
    }
    ensureDialog() {
      if (this.dialog) return;
      this.dialog = this.el("dialog", { id: "aiSummaryDialog", "aria-labelledby": "rg-ai-title" });
      this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
      this.document.body.append(this.dialog);
    }
    async open(row) {
      if (this.isOpen()) { this.dialog.focus(); return; }
      if (this.options.beforeOpen && !await this.options.beforeOpen()) return;
      const project = this.options.getProject();
      if (!project) { this.options.notify?.("请先选择一个研究项目。"); return; }
      this.ensureDialog();
      this.row = row;
      this.project = { ...project };
      this.fields = clone(this.options.getFields().filter(field => !field.archived));
      this.fieldSignature = signature(this.fields);
      this.expected = Object.fromEntries(this.fields.map(field => [field.id, String(row.values?.[field.id] || "")]));
      this.selected = new Set(this.fields.filter(field => !this.expected[field.id].trim()).map(field => field.id));
      this.drafts = new Map(); this.applySelected = new Set(); this.draftInfo = null;
      this.error = ""; this.status = ""; this.configError = "";
      this.source = null; this.config = null; this.mode = "indexed"; this.summaryDetail = "brief";
      this.loading = this.busy = true; this.saving = this.generating = false;
      const generation = ++this.generation;
      this.render(); this.dialog.showModal();
      let config = null, configError = "";
      try { config = clone(await this.options.getConfig()); }
      catch (error) { configError = error.message || "请先在研矩设置中配置 API。"; }
      if (!this.isOpen() || generation !== this.generation) return;
      this.config = config; this.configError = configError;
      this.summaryDetail = detailOption(config?.summaryDetail).id;
      await this.loadSource(this.mode);
    }
    async refreshConfig() {
      if (this.busy || !this.isOpen()) return false;
      const token = ++this.generation;
      this.loading = this.busy = true; this.error = "";
      this.status = "正在读取本机 API 设置…"; this.render();
      let config = null, configError = "";
      try { config = clone(await this.options.getConfig()); }
      catch (error) { configError = error.message || "请先在研矩设置中配置 API。"; }
      if (!this.isOpen() || token !== this.generation) return false;
      this.config = config; this.configError = configError;
      this.summaryDetail = detailOption(config?.summaryDetail).id;
      await this.loadSource(this.mode);
      return !!this.config?.baseURL && !!this.config?.model;
    }
    fail(error) {
      this.error = error?.message || String(error);
      if (this.errorNode) this.errorNode.textContent = this.error;
      this.syncControls();
    }
    guardProject() {
      if (this.options.getProject()?.id !== this.project.id) throw new Error("当前项目已变化，请保留需要的草稿，关闭后重新打开 AI 总结。");
      if (signature(this.options.getFields()) !== this.fieldSignature) throw new Error("项目字段或填写要求已经变化，请关闭后重新生成草稿。");
    }
    async loadSource(mode) {
      if (this.generating || this.saving) return;
      this.sourceController?.abort();
      const token = ++this.sourceGeneration;
      const Controller = root.AbortController || this.document.defaultView.AbortController;
      this.sourceController = new Controller();
      this.mode = mode; this.loading = this.busy = true; this.source = null;
      this.error = ""; this.status = "正在准备本地论文文本…";
      this.render();
      try {
        const source = await this.options.getSource(this.row, {
          mode, maxChars: this.config?.maxChars || 48000, signal: this.sourceController.signal,
        });
        if (!this.isOpen() || token !== this.sourceGeneration) return;
        this.source = source;
        this.status = "文本已准备好；点击发送按钮后才会调用 API。";
      } catch (error) {
        if (!this.isOpen() || token !== this.sourceGeneration) return;
        this.error = error?.name === "AbortError" ? "已取消读取论文文本。" : error.message || "无法读取论文文本。";
        this.status = "";
      } finally {
        if (this.isOpen() && token === this.sourceGeneration) {
          this.loading = this.busy = false; this.render();
        }
      }
    }
    selectedFields() { return this.fields.filter(field => this.selected.has(field.id)); }
    setSummaryDetail(id) {
      if (this.busy || !AI.SUMMARY_DETAILS.some(option => option.id === id)) return false;
      this.summaryDetail = id;
      this.render();
      this.dialog.querySelector(`[data-ai-detail="${id}"]`)?.focus();
      return true;
    }
    canGenerate() {
      return !this.busy && !!this.config?.baseURL && !!this.config?.model && !!this.source?.text?.trim() && this.selected.size > 0;
    }
    syncControls() {
      if (!this.dialog) return;
      if (this.generateButton) this.generateButton.disabled = !this.canGenerate();
      if (this.applyButton) this.applyButton.disabled = this.busy || !this.row?.editable || !this.applySelected.size;
      if (this.cancelButton) this.cancelButton.disabled = !this.generating;
      if (this.closeButton) this.closeButton.disabled = this.saving;
      if (this.sourceSelect) this.sourceSelect.disabled = this.busy;
      if (this.refreshButton) this.refreshButton.disabled = this.busy;
      if (this.settingsButton) this.settingsButton.disabled = this.busy;
      for (const input of this.dialog.querySelectorAll(".rg-ai-input")) input.disabled = this.busy;
      if (this.selectionCount) this.selectionCount.textContent = `选择要总结的字段（${this.selected.size} / ${this.fields.length}）`;
      if (this.applyButton) this.applyButton.textContent = `写入选中字段（${this.applySelected.size}）`;
      this.dialog.setAttribute("aria-busy", String(this.busy));
    }
    render() {
      const E = (tag, attrs, ...children) => this.el(tag, attrs, ...children);
      this.closeButton = E("button", { type: "button", class: "rg-ai-close", "aria-label": "关闭 AI 总结", onclick: () => this.close() }, "×");
      const endpoint = this.config?.baseURL || "尚未配置";
      const model = this.config?.model || "尚未配置";
      this.settingsButton = E("button", { type: "button", id: "rg-ai-settings", onclick: this.safe(() => this.options.openSettings?.()) }, "打开 API 设置");
      this.refreshButton = E("button", { type: "button", id: "rg-ai-refresh-config", onclick: this.safe(() => this.refreshConfig()) }, "刷新 API 设置");
      const destination = E("section", { class: "rg-ai-destination", "aria-label": "API 发送范围" },
        E("p", {}, "发送到：", E("span", { id: "rg-ai-endpoint" }, endpoint)),
        E("p", {}, "模型：", E("span", { id: "rg-ai-model" }, model)),
        E("p", { class: "rg-ai-hint" }, "将发送项目名称、选中字段的名称和填写要求、论文标题/作者/年份，以及下方选定的原文或摘要文本。不发送批注、已有分析、个人备注或 PDF 文件。"),
        this.configError || !this.config?.baseURL || !this.config?.model
          ? E("p", { class: "rg-ai-error" }, this.configError || "请先在 Zotero 设置 → 研矩中填写 API 地址和模型。") : null,
        E("div", { class: "rg-ai-actions" }, this.settingsButton, this.refreshButton));
      this.sourceSelect = E("select", { id: "rg-ai-source-mode", "aria-label": "发送的论文内容", onchange: event => this.loadSource(event.target.value) });
      this.sourceSelect.append(E("option", { value: "indexed" }, "原文提取文本与摘要"), E("option", { value: "abstract" }, "仅摘要"));
      this.sourceSelect.value = this.mode;
      const source = this.source;
      const sourceSection = E("section", { class: "rg-ai-source" },
        E("label", { class: "rg-ai-source-label" }, "论文内容", this.sourceSelect),
        E("p", { id: "rg-ai-source-coverage", class: "rg-ai-hint" }, this.loading ? "正在读取本地内容…" : source
          ? `${source.label || "论文文本"} · ${source.chars ?? source.text?.length ?? 0} 字符${source.truncated ? " · 内容已截断，不代表全文" : ""}` : "尚无可用文本"),
        source?.warning ? E("p", { class: "rg-ai-warning" }, source.warning) : null,
        source ? E("details", {}, E("summary", {}, "查看将发送的原文 / 摘要文本"), E("pre", { id: "rg-ai-source-preview" }, source.text || "")) : null);
      this.selectionCount = E("h3", { id: "rg-ai-selection-count" }, "选择要总结的字段");
      const fieldChoices = E("section", { class: "rg-ai-choices" }, this.selectionCount,
        E("p", { class: "rg-ai-hint" }, "默认只选尚未填写的字段。已有内容需要主动勾选，生成结果仍需单独确认写入。"),
        ...this.fields.map(field => E("label", { class: "rg-ai-field-choice" },
          E("input", { type: "checkbox", class: "rg-ai-input", "data-ai-field": field.id, checked: this.selected.has(field.id),
            onchange: event => { if (event.target.checked) this.selected.add(field.id); else this.selected.delete(field.id); this.syncControls(); } }),
          E("span", {}, field.label, this.expected[field.id].trim() ? E("span", { class: "rg-ai-existing" }, " 已填写") : null,
            field.requirement ? E("small", {}, field.requirement) : null))));
      const detail = detailOption(this.summaryDetail);
      const summaryDetail = E("section", { class: "rg-ai-summary-detail" },
        E("h3", { id: "rg-ai-detail-heading" }, "每字段总结篇幅"),
        E("div", { class: "rg-ai-detail-buttons", role: "group", "aria-labelledby": "rg-ai-detail-heading", "aria-describedby": "rg-ai-detail-hint" },
          ...AI.SUMMARY_DETAILS.map(option => E("button", { type: "button", class: "rg-ai-input rg-ai-detail-button",
            "data-ai-detail": option.id, "aria-pressed": String(option.id === detail.id), title: option.hint,
            onclick: () => this.setSummaryDetail(option.id) }, option.label))),
        E("p", { id: "rg-ai-detail-hint", class: "rg-ai-hint", "aria-live": "polite" }, detail.hint),
        E("p", { class: "rg-ai-hint" }, "只整理论文明确报告的客观事实，保留原文条件和数值；未提及的内容不作推断。切换篇幅只影响下一次生成，已有草稿保留。"));
      this.generateButton = E("button", { type: "button", id: "rg-ai-generate", class: "primary", onclick: this.safe(() => this.generate()) }, "发送到 API 并生成草稿");
      this.cancelButton = E("button", { type: "button", id: "rg-ai-cancel-request", onclick: () => this.cancelRequest() }, "取消生成");
      const drafts = this.drafts.size ? E("section", { class: "rg-ai-drafts" },
        E("h3", {}, "AI 草稿 · 请核对原文后写入"),
        this.draftInfo ? E("p", { class: "rg-ai-hint rg-ai-draft-origin" }, `草稿来源：${this.draftInfo.baseURL} · ${this.draftInfo.model} · ${this.draftInfo.sourceLabel} · ${detailOption(this.draftInfo.summaryDetail).label}`) : null,
        E("p", { class: "rg-ai-warning" }, "以下是 AI 提取的事实草稿，请核对原文。可修改内容、取消勾选，再写入当前项目笔记。"),
        ...this.fields.filter(field => this.drafts.has(field.id)).map(field => {
          const value = this.drafts.get(field.id);
          const textarea = E("textarea", { rows: "4", class: "rg-ai-input rg-ai-draft", "data-ai-draft": field.id,
            "aria-label": `AI 草稿：${field.label}`, oninput: event => { this.drafts.set(field.id, event.target.value); } });
          textarea.value = value;
          return E("article", { class: "rg-ai-draft-card" },
            E("label", { class: "rg-ai-draft-title" }, E("input", { type: "checkbox", class: "rg-ai-input", "data-ai-apply": field.id,
              checked: this.applySelected.has(field.id), onchange: event => {
                if (event.target.checked) this.applySelected.add(field.id); else this.applySelected.delete(field.id); this.syncControls();
              } }), field.label),
            field.requirement ? E("p", { class: "rg-ai-hint" }, field.requirement) : null,
            this.expected[field.id].trim() ? E("details", { class: "rg-ai-original" }, E("summary", {}, "将覆盖的原内容"), E("pre", {}, this.expected[field.id])) : null,
            !value.trim() ? E("p", { class: "rg-ai-warning" }, "模型没有返回此字段的有效文本；默认不写入。") : null,
            textarea);
        })) : null;
      this.errorNode = E("p", { id: "rg-ai-error", class: "rg-ai-error", role: "alert" }, this.error || "");
      this.applyButton = E("button", { type: "button", id: "rg-ai-apply", class: "primary", onclick: this.safe(() => this.apply()) }, "写入选中字段");
      this.dialog.replaceChildren(...[
        E("div", { class: "rg-ai-heading" }, E("h2", { id: "rg-ai-title" }, "AI 总结项目字段"), this.closeButton),
        E("p", { class: "rg-ai-project" }, this.project.name), E("p", { class: "rg-ai-paper" }, this.row.title),
        destination, sourceSection, fieldChoices, summaryDetail,
        E("div", { class: "rg-ai-actions" }, this.generateButton, this.cancelButton),
        E("p", { id: "rg-ai-status", class: "rg-ai-status", role: "status", "aria-live": "polite" }, this.status || ""),
        drafts, !this.row.editable ? E("p", { class: "rg-ai-warning" }, "此文献当前只读，可预览 AI 草稿，但不能写入项目笔记。") : null,
        this.errorNode,
        E("div", { class: "rg-ai-footer" }, E("button", { type: "button", disabled: this.saving, onclick: () => this.close() }, "关闭"), this.applyButton),
      ].filter(Boolean));
      this.syncControls();
    }
    async generate() {
      if (this.busy) return;
      try {
        this.guardProject();
        if (!this.config?.baseURL || !this.config?.model) throw new Error("请先在研矩设置中填写 API 地址和模型。");
        const fields = clone(this.selectedFields());
        if (!fields.length) throw new Error("请至少选择一个需要总结的字段。");
        if (!this.source?.text?.trim()) throw new Error("没有可发送的论文文本，请检查摘要或原文是否可读取。");
        if (this.dirty() && !this.document.defaultView.confirm("重新生成会替换当前未写入的 AI 草稿，是否继续？")) return;
        const config = clone({ ...this.config, summaryDetail: this.summaryDetail }), source = clone(this.source), project = { ...this.project, fields: clone(this.fields) };
        const Controller = root.AbortController || this.document.defaultView.AbortController;
        const controller = this.controller = new Controller();
        const token = ++this.generation;
        this.generating = this.busy = true; this.error = "";
        this.status = "正在请求 API…可以取消生成。"; this.render();
        try {
          const values = await this.options.generate({ config, source, project, fields,
            paper: source.paper || { title: this.row.title, authors: this.row.authors, year: this.row.year }, signal: controller.signal });
          if (!this.isOpen() || token !== this.generation || controller.signal.aborted) return;
          this.guardProject();
          if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("模型未返回有效的字段草稿，请重新生成。");
          const next = new Map();
          for (const field of fields) {
            const value = values[field.id];
            if (value != null && typeof value !== "string") throw new Error("模型返回的字段内容格式不正确，请重新生成。");
            next.set(field.id, value || "");
          }
          if (![...next.values()].some(value => value.trim())) throw new Error("模型没有返回可用的字段内容；请检查接口和论文文本后重试。");
          this.drafts = next;
          this.draftInfo = { baseURL: config.baseURL, model: config.model, sourceLabel: source.label || "论文文本", summaryDetail: config.summaryDetail };
          this.applySelected = new Set([...next].filter(([, value]) => value.trim()).map(([id]) => id));
          this.status = "草稿已生成，尚未写入。请核对并选择要写入的字段。";
        } catch (error) {
          if (!this.isOpen() || token !== this.generation) return;
          this.error = controller.signal.aborted || error?.name === "AbortError" ? "已取消生成。" : error.message || "API 请求失败，请检查设置后重试。";
          this.status = "已有内容与未写入草稿保持不变。";
        } finally {
          if (this.isOpen() && token === this.generation) {
            this.generating = this.busy = false; this.controller = null; this.render();
          }
        }
      } catch (error) { this.fail(error); }
    }
    cancelRequest() {
      if (!this.generating) return;
      ++this.generation;
      this.controller?.abort(); this.controller = null;
      this.generating = this.busy = false;
      this.error = ""; this.status = "已取消生成，已有内容与未写入草稿保持不变。";
      this.render();
    }
    async apply() {
      if (this.busy) return false;
      try {
        this.guardProject();
        if (!this.row.editable) throw new Error("此文献当前只读，无法写入项目笔记。");
        const ids = this.fields.filter(field => this.applySelected.has(field.id) && this.drafts.has(field.id)).map(field => field.id);
        if (!ids.length) throw new Error("请选择至少一个需要写入的草稿字段。");
        const changes = Object.fromEntries(ids.map(id => [id, this.drafts.get(id)]));
        const expected = Object.fromEntries(ids.map(id => [id, this.expected[id]]));
        this.saving = this.busy = true; this.error = ""; this.status = "正在写入当前项目笔记…"; this.render();
        try {
          const result = await this.options.save(this.project, this.row, changes, expected);
          for (const id of ids) {
            this.expected[id] = result?.values?.[id] ?? changes[id];
            this.drafts.delete(id); this.applySelected.delete(id); this.selected.delete(id);
          }
          this.status = `已写入 ${ids.length} 个字段${this.drafts.size ? "，其余草稿尚未写入。" : "。"}`;
          this.options.notify?.(this.status);
          return true;
        } finally { this.saving = this.busy = false; this.render(); }
      } catch (error) {
        this.status = "尚未写入；草稿仍保留，请核对错误后重试。";
        this.render(); this.fail(error); return false;
      }
    }
    close(force = false) {
      if (this.saving) return false;
      if (this.generating) this.cancelRequest();
      if (!force && this.dirty() && !this.document.defaultView.confirm("放弃尚未写入的 AI 草稿？已保存的项目内容会保留。")) return false;
      ++this.generation; ++this.sourceGeneration;
      this.controller?.abort(); this.sourceController?.abort();
      this.controller = this.sourceController = null;
      this.loading = this.generating = this.busy = false;
      this.dialog?.close();
      return true;
    }
    cancel() { return this.close(); }
  }
  const api = { Manager };
  root.RGAIDialog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
