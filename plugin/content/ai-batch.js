/* ResearchGrid sequential multi-paper AI drafts. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const AI = root.RGAI || (typeof require === "function" ? require("./ai.js") : null);
  const copy = value => JSON.parse(JSON.stringify(value));
  const signature = fields => JSON.stringify(fields.filter(field => !field.archived)
    .map(field => [field.id, field.label, field.requirement || ""]));
  const detail = id => AI.SUMMARY_DETAILS.find(option => option.id === id) || AI.SUMMARY_DETAILS[0];
  const MAX_PAPERS = 100;
  const PAGE_SIZE = 10;
  const states = { idle: "待生成", running: "正在生成", success: "草稿已生成", saved: "已写入", error: "生成失败", cancelled: "已取消", skipped: "无需生成" };

  class Manager {
    constructor(options) {
      this.options = options;
      this.document = options.document;
      this.dialog = null;
      this.busy = this.loading = this.generating = this.saving = false;
      this.generation = 0;
      this.entries = [];
    }
    el(tag, attrs = {}, ...children) {
      const element = this.document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
        else if (["value", "checked", "disabled"].includes(key)) element[key] = value;
        else element.setAttribute(key, value === true ? "" : String(value));
      }
      if (element.classList.contains("rg-batch-input")) element.dataset.batchBaseDisabled = element.disabled ? "1" : "0";
      for (const child of children.flat()) if (child != null) {
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
    dirty() { return this.entries.some(entry => entry.drafts.size > 0); }
    ensureDialog() {
      if (this.dialog) return;
      this.dialog = this.el("dialog", { id: "aiBatchDialog", "aria-labelledby": "rg-batch-title" });
      this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
      this.document.body.append(this.dialog);
    }
    async open(rows) {
      if (this.isOpen()) { this.dialog.focus(); return false; }
      if (this.options.beforeOpen && !await this.options.beforeOpen()) return false;
      if (this.isOpen()) { this.dialog.focus(); return false; }
      const project = this.options.getProject();
      if (!project) { this.options.notify?.("请先选择一个研究项目。"); return false; }
      if (!Array.isArray(rows) || !rows.length) { this.options.notify?.("请先勾选需要总结的文献。"); return false; }
      if (rows.length > MAX_PAPERS) { this.options.notify?.(`一次最多总结 ${MAX_PAPERS} 篇文献，请分批选择。`); return false; }
      const identities = rows.map(row => `${row.libraryID || ""}:${row.key || row.id}`);
      if (new Set(identities).size !== rows.length) { this.options.notify?.("选择中有重复文献，请重新选择。"); return false; }
      this.ensureDialog();
      this.project = { ...project };
      this.fields = copy(this.options.getFields().filter(field => !field.archived));
      this.fieldSignature = signature(this.fields);
      this.entries = rows.map((row, index) => ({
        index, row, title: String(row.title || "未命名文献"),
        expected: Object.fromEntries(this.fields.map(field => [field.id, String(row.values?.[field.id] ?? "")])),
        expectedHighlights: Object.fromEntries(this.fields.map(field => [field.id, copy(row.highlights?.[field.id] || [])])),
        source: null, sourceState: "waiting", sourceError: "", generateState: "idle", error: "",
        drafts: new Map(), applySelected: new Set(), origins: new Map(), origin: null,
      }));
      this.selected = new Set(this.fields.map(field => field.id));
      this.overwriteExisting = false;
      this.mode = "indexed"; this.summaryDetail = "brief";
      this.config = null; this.configError = ""; this.error = ""; this.status = "正在读取本机 API 设置…";
      this.page = 0; this.completed = 0;
      this.loading = this.busy = true; this.generating = this.saving = false;
      const token = ++this.generation;
      this.render(); this.dialog.showModal();
      let config = null, configError = "";
      try { config = copy(await this.options.getConfig()); }
      catch (error) { configError = error.message || "请先配置 API。"; }
      if (!this.isOpen() || token !== this.generation) return false;
      this.config = config; this.configError = configError;
      this.summaryDetail = detail(config?.summaryDetail).id;
      this.loading = this.busy = false;
      await this.prepareSources(this.mode);
      return true;
    }
    guardProject() {
      if (this.options.getProject()?.id !== this.project.id) throw new Error("当前项目已变化，请保留需要的草稿，关闭批量窗口后重新选择文献。");
      if (signature(this.options.getFields()) !== this.fieldSignature) throw new Error("项目字段或填写要求已变化，请关闭窗口后重新核对并生成。");
    }
    async guardSettings(config) {
      const settings = value => {
        const { summaryDetail, ...rest } = AI.normalizeConfig(value);
        return JSON.stringify(rest);
      };
      if (settings(await this.options.getConfig()) !== settings(config)) throw new Error("API 设置已变化，请点击“刷新 API 设置”后再生成；已完成草稿仍保留。");
    }
    fail(error) {
      this.error = error?.message || String(error);
      if (this.errorNode) this.errorNode.textContent = this.error;
      this.syncControls();
    }
    eligibleFields(entry) {
      return this.fields.filter(field => this.selected.has(field.id) && (this.overwriteExisting || !entry.expected[field.id].trim()));
    }
    async refreshConfig() {
      if (this.busy || !this.isOpen()) return false;
      const token = ++this.generation;
      this.busy = this.loading = true; this.error = ""; this.status = "正在读取本机 API 设置…"; this.render();
      let config = null, configError = "";
      try { config = copy(await this.options.getConfig()); }
      catch (error) { configError = error.message || "无法读取 API 设置。"; }
      if (!this.isOpen() || token !== this.generation) return false;
      this.config = config; this.configError = configError;
      this.summaryDetail = detail(config?.summaryDetail).id;
      this.busy = this.loading = false;
      await this.prepareSources(this.mode);
      return !!config?.baseURL && !!config?.model;
    }
    async prepareSources(mode = this.mode, { entries = this.entries } = {}) {
      if (this.busy || !this.isOpen()) return false;
      this.guardProject();
      if (!["indexed", "abstract"].includes(mode)) throw new Error("请选择有效的论文内容来源。");
      this.mode = mode;
      const targets = [...entries];
      const Controller = root.AbortController || this.document.defaultView.AbortController;
      const controller = this.controller = new Controller();
      const token = ++this.generation;
      this.loading = this.busy = true; this.error = "";
      for (const entry of targets) { entry.source = null; entry.sourceState = "waiting"; entry.sourceError = ""; }
      this.status = `正在准备 ${targets.length} 篇论文的本地文本…`; this.render();
      try {
        for (let index = 0; index < targets.length; index++) {
          if (!this.isOpen() || token !== this.generation || controller.signal.aborted) return false;
          this.guardProject();
          const entry = targets[index]; entry.sourceState = "loading";
          this.status = `正在准备原文 ${index + 1} / ${targets.length}：${entry.title}`; this.render();
          try {
            const source = await this.options.getSource(entry.row, { mode, maxChars: this.config?.maxChars || 60000, signal: controller.signal });
            if (!this.isOpen() || token !== this.generation || controller.signal.aborted) return false;
            this.guardProject();
            if (typeof source?.text !== "string" || !source.text.trim()) throw new Error("没有可用的论文文本，请补充可提取文字的 PDF 或摘要。");
            entry.source = copy(source); entry.sourceState = "ready"; entry.sourceError = "";
          } catch (error) {
            if (!this.isOpen() || token !== this.generation || controller.signal.aborted) return false;
            entry.sourceState = "error"; entry.sourceError = error.message || "无法读取本地论文文本。";
            if (!entry.drafts.size) entry.generateState = "error";
          }
        }
        this.status = "本地文本已准备。核对每篇来源与字段后，点击生成才会调用 API。";
        return true;
      } catch (error) { this.fail(error); return false; }
      finally {
        if (this.isOpen() && token === this.generation) {
          this.loading = this.busy = false; this.controller = null; this.render();
        }
      }
    }
    setSummaryDetail(id) {
      if (this.busy || !AI.SUMMARY_DETAILS.some(option => option.id === id)) return false;
      this.summaryDetail = id; this.render(); return true;
    }
    candidates(retryOnly = false, regenerate = false) {
      return this.entries.filter(entry => entry.sourceState === "ready" && this.eligibleFields(entry).length &&
        (retryOnly ? ["error", "cancelled"].includes(entry.generateState) : regenerate || !["success", "saved"].includes(entry.generateState)));
    }
    async generate(retryOnly = false, regenerate = false) {
      if (this.busy || !this.isOpen()) return false;
      try {
        this.guardProject();
        if (!this.config?.baseURL || !this.config?.model) throw new Error("请先在研矩设置中填写 API 地址和模型，再刷新设置。");
        if (!this.selected.size) throw new Error("请至少选择一个需要总结的字段。");
        const targets = this.candidates(retryOnly, regenerate);
        if (!targets.length) throw new Error("没有可生成的论文。请检查来源、空字段，或主动开启覆盖已有分析。");
        if (targets.some(entry => entry.drafts.size) && !this.document.defaultView.confirm("重新生成会替换这些论文尚未写入的草稿，是否继续？")) return false;
        const config = copy({ ...this.config, summaryDetail: this.summaryDetail });
        const opening = this.generation;
        await this.guardSettings(config);
        if (opening !== this.generation || this.busy || !this.isOpen()) return false;
        this.guardProject();
        const work = targets.map(entry => ({ entry, fields: copy(this.eligibleFields(entry)), source: copy(entry.source) }));
        const Controller = root.AbortController || this.document.defaultView.AbortController;
        const controller = this.controller = new Controller();
        const token = ++this.generation;
        this.generating = this.busy = true; this.error = ""; this.completed = 0;
        this.status = `开始逐篇生成，共 ${work.length} 篇…`; this.render();
        try {
          for (let index = 0; index < work.length; index++) {
            if (!this.isOpen() || token !== this.generation || controller.signal.aborted) return false;
            this.guardProject();
            await this.guardSettings(config);
            if (!this.isOpen() || token !== this.generation || controller.signal.aborted) return false;
            const { entry, fields, source } = work[index];
            entry.generateState = "running"; entry.error = "";
            this.currentEntry = entry;
            this.status = `正在生成 ${index + 1} / ${work.length}：${entry.title}`; this.render();
            try {
              const values = await this.options.generate({ config: copy(config), source, project: { ...this.project, fields: copy(this.fields) }, fields,
                paper: source.paper || { title: entry.title, authors: entry.row.authors, year: entry.row.year }, signal: controller.signal });
              if (!this.isOpen() || token !== this.generation || controller.signal.aborted) return false;
              this.guardProject();
              if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("模型未返回有效的字段草稿。");
              const next = new Map();
              for (const field of fields) {
                if (values[field.id] != null && typeof values[field.id] !== "string") throw new Error("模型返回的字段内容格式不正确。");
                next.set(field.id, values[field.id] || "");
              }
              if (![...next.values()].some(value => value.trim())) throw new Error("模型没有返回可用的字段内容。");
              const origin = { baseURL: config.baseURL, model: config.model, summaryDetail: config.summaryDetail, sourceLabel: source.label || "论文文本" };
              for (const [id, value] of next) {
                entry.drafts.set(id, value); entry.origins.set(id, { ...origin });
                if (entry.row.editable && value.trim() && value.trim() !== entry.expected[id].trim()) entry.applySelected.add(id);
                else entry.applySelected.delete(id);
              }
              entry.origin = origin;
              entry.generateState = "success";
            } catch (error) {
              if (!this.isOpen() || token !== this.generation || controller.signal.aborted) return false;
              entry.generateState = "error"; entry.error = error.message || "API 请求失败。";
            }
            this.currentEntry = null; this.completed = index + 1;
            this.render();
          }
          const errors = work.filter(({ entry }) => entry.generateState === "error").length;
          this.status = `本轮完成 ${work.length} 篇${errors ? `，${errors} 篇失败可单独重试` : ""}。草稿尚未写入，请逐篇核对后确认。`;
          return !errors;
        } catch (error) { this.fail(error); this.status = "已停止后续请求；已完成的草稿保留。"; return false; }
        finally {
          if (this.isOpen() && token === this.generation) {
            this.generating = this.busy = false; this.controller = null; this.currentEntry = null; this.render();
          }
        }
      } catch (error) { this.fail(error); return false; }
    }
    async retryFailed() {
      if (this.busy || !this.isOpen()) return false;
      const failedSources = this.entries.filter(entry => entry.sourceState === "error");
      if (failedSources.length) await this.prepareSources(this.mode, { entries: failedSources });
      // Include papers whose work never started before cancellation. Completed
      // or already-written papers remain excluded by the normal candidate rule.
      if (this.isOpen() && !this.busy) return this.generate();
      return false;
    }
    cancelRequest() {
      if (!this.loading && !this.generating) return false;
      ++this.generation;
      this.controller?.abort(); this.controller = null;
      if (this.currentEntry?.generateState === "running") this.currentEntry.generateState = "cancelled";
      for (const entry of this.entries) if (["loading", "waiting"].includes(entry.sourceState)) {
        entry.sourceState = "error"; entry.sourceError = "尚未完成本地文本准备，可点击“重试失败 / 继续未完成”。";
        if (!entry.drafts.size) entry.generateState = "cancelled";
      }
      this.currentEntry = null; this.busy = this.loading = this.generating = false;
      this.error = ""; this.status = "已取消后续处理，已完成的草稿保留。点击“重试失败 / 继续未完成”可继续尚未完成的论文。"; this.render(); return true;
    }
    selectedOperations() {
      const operations = [];
      for (const entry of this.entries) {
        if (!entry.row.editable) continue;
        const ids = this.fields.filter(field => entry.applySelected.has(field.id) && entry.drafts.has(field.id)
          && entry.drafts.get(field.id).trim() !== entry.expected[field.id].trim()).map(field => field.id);
        if (!ids.length) continue;
        operations.push({ row: entry.row,
          changes: Object.fromEntries(ids.map(id => [id, entry.drafts.get(id)])),
          expected: Object.fromEntries(ids.map(id => [id, entry.expected[id]])),
          expectedHighlights: Object.fromEntries(ids.map(id => [id, copy(entry.expectedHighlights[id])])),
        });
      }
      return operations;
    }
    async apply() {
      if (this.busy || !this.isOpen()) return false;
      try {
        this.guardProject();
        const operations = this.selectedOperations();
        if (!operations.length) throw new Error("请选择至少一项有变化且可写入的草稿字段。");
        this.saving = this.busy = true; this.error = ""; this.status = "正在统一写入选中的论文与字段…"; this.render();
        try {
          const result = await this.options.save({ ...this.project, fields: copy(this.fields) }, operations);
          for (const operation of operations) {
            const entry = this.entries.find(entry => entry.row === operation.row);
            const record = result?.records?.find(record => record.row === operation.row ||
              (record.row?.id === operation.row.id && record.row?.key === operation.row.key));
            for (const id of Object.keys(operation.changes)) {
              entry.expected[id] = record?.values?.[id] ?? operation.changes[id];
              entry.expectedHighlights[id] = copy(record?.highlights?.[id] || []);
              entry.drafts.delete(id); entry.applySelected.delete(id); entry.origins.delete(id);
            }
            if (!entry.drafts.size) entry.generateState = "saved";
          }
          this.status = `已写入 ${operations.length} 篇文献、${operations.reduce((sum, operation) => sum + Object.keys(operation.changes).length, 0)} 项字段。其余草稿保留。`;
          this.options.notify?.(this.status); return true;
        } finally { this.saving = this.busy = false; this.render(); }
      } catch (error) {
        this.status = "本次未写入；已编辑草稿和选择保持不变，请核对错误后重试。";
        this.render(); this.fail(error); return false;
      }
    }
    syncControls() {
      if (!this.dialog) return;
      for (const control of this.dialog.querySelectorAll(".rg-batch-input")) {
        control.disabled = this.busy || control.dataset.batchBaseDisabled === "1";
      }
      const configured = !!this.config?.baseURL && !!this.config?.model;
      if (this.generateButton) this.generateButton.disabled = this.busy || !configured || !this.candidates().length;
      if (this.retryButton) this.retryButton.disabled = this.busy || !configured || !this.entries.some(entry => entry.sourceState === "error" || ["error", "cancelled"].includes(entry.generateState));
      if (this.regenerateButton) this.regenerateButton.disabled = this.busy || !configured || !this.entries.some(entry => entry.drafts.size) || !this.candidates(false, true).length;
      if (this.cancelButton) this.cancelButton.disabled = !this.loading && !this.generating;
      if (this.closeButton) this.closeButton.disabled = this.saving;
      const operations = this.selectedOperations();
      if (this.applyButton) {
        this.applyButton.disabled = this.busy || !operations.length;
        this.applyButton.textContent = `写入选中草稿（${operations.length} 篇）`;
      }
      if (this.countNode) this.countNode.textContent = `已选 ${operations.length} 篇、${operations.reduce((sum, operation) => sum + Object.keys(operation.changes).length, 0)} 项字段变更`;
      this.dialog.setAttribute("aria-busy", String(this.busy));
    }
    render() {
      const E = (tag, attrs, ...children) => this.el(tag, attrs, ...children);
      this.closeButton = E("button", { type: "button", class: "rg-batch-close", "aria-label": "关闭批量 AI 总结", onclick: () => this.close() }, "×");
      const sourceMode = E("select", { id: "rg-batch-source-mode", class: "rg-batch-input", "aria-label": "批量总结的论文内容", onchange: this.safe(event => this.prepareSources(event.target.value)) },
        E("option", { value: "indexed" }, "原文提取文本与摘要"), E("option", { value: "abstract" }, "仅摘要"));
      sourceMode.value = this.mode;
      const fields = E("section", { class: "rg-batch-section" }, E("h3", {}, "总结字段"),
        E("p", { class: "rg-batch-hint" }, "默认逐篇只填空字段。开启覆盖后，已有分析仍不会发送给 AI；生成的草稿需核对后单独确认写入。"),
        E("div", { class: "rg-batch-field-grid" }, ...this.fields.map(field => E("label", {},
          E("input", { type: "checkbox", class: "rg-batch-input", "data-batch-field": field.id, checked: this.selected.has(field.id), onchange: event => {
            if (this.busy) return;
            if (event.target.checked) this.selected.add(field.id); else this.selected.delete(field.id);
            this.render();
          } }), E("span", {}, field.label, field.requirement ? E("small", {}, field.requirement) : null)))),
        E("label", { class: "rg-batch-overwrite" }, E("input", { type: "checkbox", id: "rg-batch-overwrite", class: "rg-batch-input", checked: this.overwriteExisting, onchange: event => {
          if (this.busy) return; this.overwriteExisting = event.target.checked; this.render();
        } }), "允许为已有分析生成替换草稿（默认只填空字段）"));
      const level = detail(this.summaryDetail);
      const settings = E("section", { class: "rg-batch-section" }, E("h3", {}, "本次生成范围"),
        E("p", {}, "发送到：", E("span", { id: "rg-batch-endpoint" }, this.config?.baseURL || "尚未配置")),
        E("p", {}, "模型：", E("span", { id: "rg-batch-model" }, this.config?.model || "尚未配置")),
        E("p", { class: "rg-batch-hint" }, "每篇文献分别调用一次 API，顺序处理。发送项目名称、选中字段的名称和填写要求、论文标题/作者/年份及各篇选定文本；不发送批注、已有分析、个人备注或 PDF 文件。"),
        this.configError || !this.config?.baseURL || !this.config?.model ? E("p", { class: "rg-batch-error" }, this.configError || "请先在 Zotero 设置 → 研矩中配置 API。") : null,
        E("div", { class: "rg-batch-actions" },
          E("button", { type: "button", id: "rg-batch-settings", class: "rg-batch-input", onclick: this.safe(() => this.options.openSettings?.()) }, "打开 API 设置"),
          E("button", { type: "button", id: "rg-batch-refresh-config", class: "rg-batch-input", onclick: this.safe(() => this.refreshConfig()) }, "刷新 API 设置")),
        E("label", { class: "rg-batch-source-label" }, "论文内容", sourceMode),
        E("div", { class: "rg-batch-actions", role: "group", "aria-label": "每字段总结篇幅" }, ...AI.SUMMARY_DETAILS.map(option =>
          E("button", { type: "button", class: "rg-batch-input rg-batch-detail", "data-batch-detail": option.id,
            "aria-pressed": String(option.id === level.id), title: option.hint, onclick: () => this.setSummaryDetail(option.id) }, option.label))),
        E("p", { class: "rg-batch-hint" }, level.hint, " 只整理原文明确报告的客观事实。切换篇幅影响下一次生成，已完成草稿保留。"));
      this.generateButton = E("button", { type: "button", id: "rg-batch-generate", class: "primary", onclick: this.safe(() => this.generate()) }, "生成未完成论文的草稿");
      this.retryButton = E("button", { type: "button", id: "rg-batch-retry", onclick: this.safe(() => this.retryFailed()) }, "重试失败 / 继续未完成");
      this.regenerateButton = E("button", { type: "button", id: "rg-batch-regenerate", onclick: this.safe(() => this.generate(false, true)) }, "重新生成全部");
      this.cancelButton = E("button", { type: "button", id: "rg-batch-cancel", onclick: () => this.cancelRequest() }, "取消后续处理");
      const progress = E("section", { class: "rg-batch-section" }, E("h3", {}, `文献与草稿（${this.entries.length} 篇）`));
      const start = this.page * PAGE_SIZE;
      for (const entry of this.entries.slice(start, start + PAGE_SIZE)) progress.append(this.renderEntry(entry));
      const pages = Math.max(1, Math.ceil(this.entries.length / PAGE_SIZE));
      if (pages > 1) progress.append(E("div", { class: "rg-batch-actions rg-batch-pages" },
        E("button", { type: "button", class: "rg-batch-input", disabled: this.page === 0, id: "rg-batch-prev", onclick: () => { if (!this.busy) { this.page--; this.render(); } } }, "上一页"),
        E("span", {}, `第 ${this.page + 1} / ${pages} 页 · 每页 ${PAGE_SIZE} 篇`),
        E("button", { type: "button", class: "rg-batch-input", disabled: this.page >= pages - 1, id: "rg-batch-next", onclick: () => { if (!this.busy) { this.page++; this.render(); } } }, "下一页")));
      this.errorNode = E("p", { id: "rg-batch-error", class: "rg-batch-error", role: "alert" }, this.error || "");
      this.countNode = E("span", { id: "rg-batch-selected-count", class: "rg-batch-hint" });
      this.applyButton = E("button", { type: "button", id: "rg-batch-apply", class: "primary", onclick: this.safe(() => this.apply()) }, "写入选中草稿");
      this.dialog.replaceChildren(
        E("div", { class: "rg-batch-heading" }, E("h2", { id: "rg-batch-title" }, "批量 AI 总结"), this.closeButton),
        E("p", { class: "rg-batch-project" }, this.project.name),
        E("p", { class: "rg-batch-hint" }, `已选择 ${this.entries.length} 篇文献。生成后逐篇核对，所选内容统一写入当前项目。`),
        settings, fields,
        E("div", { class: "rg-batch-actions" }, E("button", { type: "button", id: "rg-batch-prepare", class: "rg-batch-input", onclick: this.safe(() => this.prepareSources()) }, "重新准备本地文本"), this.generateButton, this.retryButton, this.regenerateButton, this.cancelButton),
        E("p", { id: "rg-batch-status", class: "rg-batch-status", role: "status", "aria-live": "polite" }, this.status || ""),
        progress, this.errorNode,
        E("div", { class: "rg-batch-footer" }, this.countNode,
          E("button", { type: "button", id: "rg-batch-close", disabled: this.saving, onclick: () => this.close() }, "关闭"), this.applyButton));
      this.syncControls();
    }
    renderEntry(entry) {
      const E = (tag, attrs, ...children) => this.el(tag, attrs, ...children);
      const source = entry.source;
      const coverage = entry.sourceState === "ready"
        ? `${source.label || "论文文本"} · ${source.chars ?? source.text.length} 字符${source.truncated ? " · 已截断，不代表全文" : ""}`
        : entry.sourceState === "loading" ? "正在读取本地文本…" : entry.sourceState === "error" ? "原文准备失败" : "等待读取本地文本";
      const card = E("article", { class: "rg-batch-paper", "data-batch-paper": entry.index },
        E("h4", {}, `${entry.index + 1}. ${entry.title}`),
        E("p", { class: "rg-batch-hint", "data-batch-coverage": entry.index }, coverage),
        source?.warning ? E("p", { class: "rg-batch-hint" }, source.warning) : null,
        entry.sourceError ? E("p", { class: "rg-batch-error" }, entry.sourceError) : null,
        E("p", { class: "rg-batch-state" }, `${states[entry.generateState] || entry.generateState} · 本次可总结 ${this.eligibleFields(entry).length} 个字段${entry.row.editable ? "" : " · 只读，仅预览"}`),
        entry.error ? E("p", { class: "rg-batch-error" }, entry.error) : null,
        source ? E("details", {}, E("summary", {}, "查看将发送的论文文本"), E("pre", { class: "rg-batch-source-text" }, source.text)) : null,
        entry.origin ? E("p", { class: "rg-batch-hint rg-batch-origin" }, `最近生成：${entry.origin.baseURL} · ${entry.origin.model} · ${entry.origin.sourceLabel} · ${detail(entry.origin.summaryDetail).label}`) : null);
      for (const field of this.fields.filter(field => entry.drafts.has(field.id))) {
        const key = `${entry.index}:${field.id}`;
        const input = E("textarea", { rows: "4", class: "rg-batch-input rg-batch-draft", "data-batch-draft": key,
          "aria-label": `${entry.title} · ${field.label}草稿`, oninput: event => { if (!this.busy) { entry.drafts.set(field.id, event.target.value); this.syncControls(); } } });
        input.value = entry.drafts.get(field.id);
        card.append(E("section", { class: "rg-batch-draft-card" },
          E("label", {}, E("input", { type: "checkbox", class: "rg-batch-input", "data-batch-apply": key,
            checked: entry.applySelected.has(field.id), disabled: !entry.row.editable, onchange: event => {
              if (this.busy || !entry.row.editable) return;
              if (event.target.checked) entry.applySelected.add(field.id); else entry.applySelected.delete(field.id); this.syncControls();
            } }), E("strong", {}, field.label)),
          entry.origins.get(field.id) ? E("p", { class: "rg-batch-hint" }, `字段草稿来源：${entry.origins.get(field.id).model} · ${entry.origins.get(field.id).sourceLabel} · ${detail(entry.origins.get(field.id).summaryDetail).label}`) : null,
          entry.expected[field.id].trim() ? E("details", {}, E("summary", {}, "将覆盖的原内容"), E("pre", {}, entry.expected[field.id])) : null,
          input));
      }
      return card;
    }
    close(force = false) {
      if (this.saving) return false;
      if (this.generating || this.loading) this.cancelRequest();
      if (!force && this.dirty() && !this.document.defaultView.confirm("放弃尚未写入的批量 AI 草稿？已保存的项目内容会保留。")) return false;
      ++this.generation; this.controller?.abort(); this.controller = null;
      this.busy = this.loading = this.generating = false;
      this.dialog?.close(); return true;
    }
    cancel() { return this.close(); }
  }
  const api = { Manager, MAX_PAPERS };
  root.RGAIBatch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
