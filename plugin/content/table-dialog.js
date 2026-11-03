/* ResearchGrid table import preview. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const IO = () => root.RGTable || (typeof require === "function" ? require("./table-io.js") : null);
  const PAGE_SIZE = 50;
  const copy = value => JSON.parse(JSON.stringify(value));
  const signature = fields => JSON.stringify(fields.filter(f => !f.archived)
    .map(f => [f.id, f.label, f.requirement || "", f.aliases || []]));
  const META = [
    ["ignore", "忽略此列"], ["meta:recordType", "记录类型（填写要求 / 文献）"],
    ["meta:projectID", "项目标识（校验）"], ["meta:itemURL", "文献标识 / Zotero 链接（匹配）"],
    ["meta:itemKey", "文献 Key（匹配）"], ["meta:title", "论文标题（匹配）"], ["meta:citekey", "引用键（匹配）"],
  ];
  const MATCH_LABELS = { itemURL: "文献标识匹配", itemKey: "文献 Key 匹配", citekey: "引用键匹配", title: "标题匹配，请核对" };

  class Manager {
    constructor(options) {
      this.options = options;
      this.document = options.document;
      this.dialog = null;
      this.busy = this.saving = false;
      this.generation = 0;
      this.selected = new Set();
    }
    el(tag, attrs = {}, ...children) {
      const element = this.document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
        else if (["value", "checked", "disabled"].includes(key)) element[key] = value;
        else element.setAttribute(key, value === true ? "" : String(value));
      }
      if (element.classList.contains("rg-table-input")) element.dataset.rgTableBaseDisabled = element.disabled ? "1" : "0";
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
    dirty() { return !this.applied && !!this.text?.trim(); }
    ensureDialog() {
      if (this.dialog) return;
      this.dialog = this.el("dialog", { id: "tableImportDialog", "aria-labelledby": "rg-table-title" });
      this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
      this.document.body.append(this.dialog);
    }
    async open() {
      if (this.isOpen()) { this.dialog.focus(); return; }
      if (this.options.beforeOpen && !await this.options.beforeOpen()) return;
      if (this.isOpen()) { this.dialog.focus(); return; }
      const project = this.options.getProject();
      if (!project) { this.options.notify?.("请先选择一个研究项目。"); return; }
      this.ensureDialog();
      this.project = { ...project };
      this.fields = copy(this.options.getFields().filter(f => !f.archived));
      this.fieldSignature = signature(this.fields);
      this.rows = this.options.getRows().slice();
      this.text = ""; this.fileName = ""; this.table = this.plan = null;
      this.mappings = []; this.selected = new Set(); this.page = 0;
      this.overwrite = this.clearBlanks = this.applied = false;
      this.error = this.status = ""; this.busy = this.saving = false;
      ++this.generation;
      this.render(); this.dialog.showModal();
    }
    guardProject() {
      if (this.options.getProject()?.id !== this.project.id) throw new Error("当前项目已变化，请关闭并在正确项目中重新导入。");
      if (signature(this.options.getFields()) !== this.fieldSignature) throw new Error("项目字段已变化，请关闭窗口后重新导入并核对列对应关系。");
    }
    fail(error) {
      this.error = error?.message || String(error);
      if (this.errorNode) this.errorNode.textContent = this.error;
      this.syncControls();
    }
    clearPreview() {
      this.table = this.plan = null;
      this.mappings = []; this.selected.clear(); this.page = 0; this.applied = false;
    }
    async chooseFile() {
      if (this.busy) return;
      if (this.dirty() && !this.document.defaultView.confirm("选择新文件会替换当前尚未导入的表格，是否继续？")) return;
      const token = ++this.generation;
      this.busy = true; this.error = ""; this.status = "正在选择并读取本地表格…"; this.render();
      try {
        const file = await this.options.readFile();
        if (!this.isOpen() || token !== this.generation) return;
        if (!file) { this.status = "已取消选择文件，当前输入保持不变。"; return; }
        if (typeof file.text !== "string") throw new Error("无法读取表格文本，请使用 UTF-8 CSV 或 TSV 文件。");
        this.text = file.text; this.fileName = String(file.name || "本地表格");
        this.clearPreview(); this.status = "文件已读取。请解析并核对预览，再确认导入。";
      } catch (error) {
        if (this.isOpen() && token === this.generation) this.error = error.message || "无法读取表格文件。";
      } finally {
        if (this.isOpen() && token === this.generation) { this.busy = false; this.render(); }
      }
    }
    parse() {
      if (this.busy) return false;
      try {
        this.guardProject();
        this.table = IO().parse(this.text);
        this.mappings = IO().inferMappings(this.table.headers, this.fields);
        this.applied = false; this.page = 0; this.error = "";
        this.rebuild(false);
        return true;
      } catch (error) {
        this.plan = null; this.selected.clear(); this.status = "表格尚未导入。请检查内容与格式。";
        this.render(); this.fail(error); return false;
      }
    }
    key(row, index) { return `${row.line}:${row.target?.libraryID || ""}:${row.target?.key || ""}:${index}`; }
    rebuild(preserveSelection = true) {
      if (!this.table || this.busy) return false;
      const excluded = new Set();
      if (preserveSelection && this.plan) this.plan.rows.forEach((row, index) => {
        if (row.status === "ready" && !this.selected.has(this.key(row, index))) excluded.add(this.key(row, index));
      });
      try {
        this.guardProject();
        this.plan = IO().buildPlan(this.table, { project: this.project, fields: this.fields, rows: this.rows,
          mappings: this.mappings, overwrite: this.overwrite, clearBlanks: this.clearBlanks });
        this.selected = new Set(this.plan.rows.flatMap((row, index) =>
          row.status === "ready" && !excluded.has(this.key(row, index)) ? [this.key(row, index)] : []));
        this.error = ""; this.status = "预览已更新，确认前不会写入任何文献。"; this.applied = false;
        this.page = Math.min(this.page, Math.max(0, Math.ceil(this.plan.rows.length / PAGE_SIZE) - 1));
        this.render(); return true;
      } catch (error) {
        this.plan = null; this.selected.clear(); this.render(); this.fail(error); return false;
      }
    }
    selectedRows() {
      return this.plan?.rows.filter((row, index) => row.status === "ready" && this.selected.has(this.key(row, index))) || [];
    }
    syncControls() {
      if (!this.dialog) return;
      for (const control of this.dialog.querySelectorAll(".rg-table-input")) {
        control.disabled = this.busy || control.dataset.rgTableBaseDisabled === "1";
      }
      if (this.clearInput) this.clearInput.disabled = this.busy || !this.overwrite;
      if (this.closeButton) this.closeButton.disabled = this.saving;
      if (this.parseButton) this.parseButton.disabled = this.busy || !this.text.trim();
      const selected = this.selectedRows();
      if (this.applyButton) {
        this.applyButton.disabled = this.busy || !selected.length || this.applied;
        this.applyButton.textContent = `确认导入选中内容（${selected.length} 篇）`;
      }
      if (this.selectionCount) this.selectionCount.textContent = `已选 ${selected.length} 篇文献，共 ${selected.reduce((sum, row) => sum + Object.keys(row.changes || {}).length, 0)} 项字段变更。`;
      this.dialog.setAttribute("aria-busy", String(this.busy));
    }
    render() {
      const E = (tag, attrs, ...children) => this.el(tag, attrs, ...children);
      this.closeButton = E("button", { type: "button", class: "rg-table-close", "aria-label": "关闭表格导入", onclick: () => this.close() }, "×");
      const source = E("textarea", { id: "rg-table-source", class: "rg-table-input", rows: "6", "aria-label": "待导入的 CSV 或 TSV 表格",
        placeholder: "选择 CSV/TSV 文件，或把其他 AI 生成的 CSV/TSV 表格粘贴到这里。", oninput: event => {
          this.text = event.target.value; this.fileName = "粘贴的表格"; this.clearPreview();
          this.error = ""; this.status = "内容已变化，请重新解析并预览。";
          if (this.previewNode) this.previewNode.replaceChildren();
          if (this.mappingNode) this.mappingNode.replaceChildren();
          if (this.statusNode) this.statusNode.textContent = this.status;
          if (this.errorNode) this.errorNode.textContent = "";
          this.syncControls();
        } });
      source.value = this.text;
      this.parseButton = E("button", { type: "button", id: "rg-table-parse", class: "rg-table-input", onclick: this.safe(() => this.parse()) }, "解析并预览");
      this.mappingNode = E("section", { id: "rg-table-mappings", class: "rg-table-mappings" });
      if (this.table) {
        this.mappingNode.append(E("h3", {}, "列对应关系"),
          E("p", { class: "rg-table-hint" }, "匹配列只用来定位已有文献，不修改标题、作者等元数据。未识别的分析列可手动对应到当前项目字段。"),
          E("div", { class: "rg-table-mapping-grid" }, ...this.table.headers.map((header, index) => {
            const select = E("select", { class: "rg-table-input", "data-table-column": index, "aria-label": `表格列对应：${header || `第 ${index + 1} 列`}`,
              onchange: event => { this.mappings[index] = event.target.value; this.rebuild(); } });
            for (const [value, label] of META) select.append(E("option", { value }, label));
            for (const field of this.fields) select.append(E("option", { value: `field:${field.id}` }, `填写字段 · ${field.label}`));
            select.value = this.mappings[index] || "ignore";
            return E("label", {}, E("span", {}, `${index + 1}. ${header || "（空列名）"}`), select);
          })));
      }
      const overwrite = E("input", { id: "rg-table-overwrite", class: "rg-table-input", type: "checkbox", checked: this.overwrite,
        onchange: event => { this.overwrite = event.target.checked; if (!this.overwrite) this.clearBlanks = false; this.rebuild(); if (!this.table) this.render(); } });
      this.clearInput = E("input", { id: "rg-table-clear-blanks", class: "rg-table-input", type: "checkbox", checked: this.clearBlanks,
        onchange: event => { this.clearBlanks = event.target.checked; this.rebuild(); } });
      this.previewNode = E("section", { id: "rg-table-preview", class: "rg-table-preview" });
      if (this.plan) this.renderPreview(this.previewNode);
      this.statusNode = E("p", { id: "rg-table-status", class: "rg-table-status", role: "status", "aria-live": "polite" }, this.status || "");
      this.errorNode = E("p", { id: "rg-table-error", class: "rg-table-error", role: "alert" }, this.error || "");
      this.applyButton = E("button", { type: "button", id: "rg-table-apply", class: "primary", onclick: this.safe(() => this.apply()) }, "确认导入选中内容");
      this.selectionCount = E("span", { id: "rg-table-selected-count", class: "rg-table-hint" });
      this.dialog.replaceChildren(
        E("div", { class: "rg-table-heading" }, E("h2", { id: "rg-table-title" }, "导入已填写表格"), this.closeButton),
        E("p", { class: "rg-table-project" }, this.project.name),
        E("p", { class: "rg-table-hint" }, "只把表格内容写入当前项目中已有文献的分析字段。建议保留导出模板中的文献标识与项目标识；优先使用稳定标识匹配，唯一标题匹配时请特别核对。"),
        E("div", { class: "rg-table-actions" }, E("button", { type: "button", id: "rg-table-file", class: "rg-table-input", onclick: this.safe(() => this.chooseFile()) }, "选择 CSV/TSV 文件"), this.parseButton,
          this.fileName ? E("span", { id: "rg-table-file-name", class: "rg-table-hint" }, this.fileName) : null),
        source, this.mappingNode,
        E("section", { class: "rg-table-options" },
          E("label", {}, overwrite, "允许覆盖已有分析（默认保留）"),
          E("label", {}, this.clearInput, "把空单元格清空已有值（需要同时允许覆盖）"),
          E("p", { class: "rg-table-hint" }, "默认忽略空单元格，只填空字段。选择覆盖或清空后请重新核对预览；公式与 HTML 均按纯文本处理。")),
        this.statusNode, this.previewNode, this.errorNode,
        E("div", { class: "rg-table-footer" }, this.selectionCount,
          E("button", { type: "button", disabled: this.saving, onclick: () => this.close() }, "取消"), this.applyButton));
      this.syncControls();
    }
    renderPreview(node) {
      const E = (tag, attrs, ...children) => this.el(tag, attrs, ...children);
      const rows = this.plan.rows;
      const ready = rows.filter(row => row.status === "ready").length;
      const errors = rows.filter(row => row.status === "error").length;
      const skipped = rows.filter(row => row.status === "skip").length;
      node.append(E("h3", {}, `导入预览：${ready} 行可导入 · ${skipped} 行跳过 · ${errors} 行需处理`));
      if (this.plan.warnings?.length) node.append(E("ul", { class: "rg-table-warnings" }, ...this.plan.warnings.map(warning => E("li", {}, String(warning)))));
      node.append(E("p", { class: "rg-table-hint" }, "只有已勾选的可导入行会写入；跳过和错误行不会写入。全选与全不选作用于全部分页。"),
        E("div", { class: "rg-table-actions" },
          E("button", { type: "button", class: "rg-table-input", id: "rg-table-select-all", onclick: () => {
            this.selected = new Set(rows.flatMap((row, index) => row.status === "ready" ? [this.key(row, index)] : [])); this.render();
          } }, `全选全部可导入行（${ready}）`),
          E("button", { type: "button", class: "rg-table-input", id: "rg-table-select-none", onclick: () => { this.selected.clear(); this.render(); } }, "全部取消选择")));
      const titleColumn = this.mappings.indexOf("meta:title");
      const pageRows = rows.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
      for (const [offset, row] of pageRows.entries()) {
        const index = this.page * PAGE_SIZE + offset;
        const record = this.table.records.find(record => record.line === row.line);
        const title = row.target?.title || (titleColumn >= 0 ? record?.cells?.[titleColumn] : "") || "未匹配文献";
        const key = this.key(row, index);
        const selection = E("input", { type: "checkbox", class: "rg-table-input", "data-table-row": index,
          "aria-label": `导入第 ${row.line} 行：${title}`, checked: this.selected.has(key), disabled: row.status !== "ready",
          onchange: event => { if (event.target.checked) this.selected.add(key); else this.selected.delete(key); this.syncControls(); } });
        const card = E("article", { class: `rg-table-row rg-table-row-${row.status}`, "data-table-line": row.line },
          E("label", { class: "rg-table-row-title" }, selection, E("strong", {}, `第 ${row.line} 行 · ${title}`)),
          E("p", { class: "rg-table-hint" }, `${row.status === "ready" ? "可导入" : row.status === "error" ? "需处理" : "跳过"}${row.matchBy ? ` · ${MATCH_LABELS[row.matchBy] || row.matchBy}` : ""}${row.message ? ` · ${row.message}` : ""}`));
        for (const [id, value] of Object.entries(row.changes || {})) {
          card.append(E("section", { class: "rg-table-change" }, E("h4", {}, this.fields.find(field => field.id === id)?.label || id),
            E("div", { class: "rg-table-values" },
              E("div", {}, E("span", { class: "rg-table-hint" }, "原内容"), E("pre", {}, row.expected?.[id] || "（空）")),
              E("div", {}, E("span", { class: "rg-table-hint" }, "导入内容"), E("pre", {}, value || "（将清空）")))));
        }
        node.append(card);
      }
      const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      node.append(E("div", { class: "rg-table-pagination" },
        E("button", { type: "button", class: "rg-table-input", disabled: this.page === 0, id: "rg-table-prev", onclick: () => { this.page--; this.render(); } }, "上一页"),
        E("span", {}, `第 ${this.page + 1} / ${pages} 页 · 每页 ${PAGE_SIZE} 行`),
        E("button", { type: "button", class: "rg-table-input", disabled: this.page >= pages - 1, id: "rg-table-next", onclick: () => { this.page++; this.render(); } }, "下一页")));
    }
    async apply() {
      if (this.busy || this.applied) return false;
      try {
        this.guardProject();
        const selected = this.selectedRows();
        if (!selected.length) throw new Error("请先选择至少一行可导入内容。");
        const operations = selected.map(row => ({ row: row.target, changes: { ...row.changes }, expected: { ...row.expected } }));
        this.busy = this.saving = true; this.error = ""; this.status = "正在写入所选项目字段…"; this.render();
        try {
          await this.options.save(this.project, operations);
          this.applied = true; this.selected.clear();
          this.status = `已导入 ${selected.length} 篇文献、${operations.reduce((sum, operation) => sum + Object.keys(operation.changes).length, 0)} 项字段内容。`;
          this.options.notify?.(this.status);
          return true;
        } finally { this.busy = this.saving = false; this.render(); }
      } catch (error) {
        this.status = "本次未写入；输入、列对应关系和预览仍保留，请核对错误后重试。";
        this.render(); this.fail(error); return false;
      }
    }
    close(force = false) {
      if (this.saving) return false;
      if (!force && this.dirty() && !this.document.defaultView.confirm("放弃尚未导入的表格内容？已保存的项目内容会保留。")) return false;
      ++this.generation; this.busy = false;
      this.dialog?.close(); return true;
    }
  }
  root.RGTableDialog = { Manager };
  if (typeof module !== "undefined" && module.exports) module.exports = root.RGTableDialog;
})(globalThis);
