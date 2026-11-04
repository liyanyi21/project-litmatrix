/* ResearchGrid project display options. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const COLUMNS = Object.freeze([
    { id: "title", label: "文献标题", width: 320 },
    { id: "creators", label: "作者", width: 240 },
    { id: "year", label: "年份", width: 180 },
    { id: "date", label: "出版日期", width: 180 },
    { id: "publicationTitle", label: "期刊/会议/书名", width: 260 },
    { id: "itemType", label: "条目类型", width: 180 },
    { id: "DOI", label: "DOI", width: 260 },
    { id: "url", label: "网址", width: 260 },
    { id: "abstractNote", label: "摘要", width: 360 },
    { id: "volume", label: "卷", width: 180 },
    { id: "issue", label: "期", width: 180 },
    { id: "pages", label: "页码", width: 180 },
    { id: "publisher", label: "出版社", width: 240 },
    { id: "place", label: "出版地", width: 200 },
    { id: "language", label: "语言", width: 180 },
    { id: "ISBN", label: "ISBN", width: 220 },
    { id: "ISSN", label: "ISSN", width: 200 },
    { id: "accessDate", label: "访问日期", width: 220 },
    { id: "dateAdded", label: "添加时间", width: 220 },
    { id: "dateModified", label: "修改时间", width: 220 },
    { id: "extra", label: "其他信息", width: 260 },
    { id: "citationKey", label: "引用键", width: 240 },
  ].map(column => Object.freeze(column)));
  const VALID_IDS = new Set(COLUMNS.map(column => column.id));
  const COLUMN_BY_ID = new Map(COLUMNS.map(column => [column.id, column]));
  function normalize(input) {
    const value = input && typeof input === "object" ? input : {};
    const metadataColumns = [];
    const seen = new Set();
    for (const id of Array.isArray(value.metadataColumns) ? value.metadataColumns : []) {
      if (typeof id !== "string" || !VALID_IDS.has(id) || seen.has(id)) continue;
      seen.add(id); metadataColumns.push(id);
    }
    return { showTags: value.showTags !== false, metadataColumns };
  }
  const signature = value => JSON.stringify(normalize(value));

  class Manager {
    constructor(options) {
      this.options = options; this.document = options.document;
      this.dialog = null; this.busy = false; this.opening = false;
      this.draft = normalize(); this.initial = signature(this.draft);
      this.errorText = "";
    }
    el(tag, attrs = {}, ...children) {
      const node = this.document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else if (["checked", "disabled"].includes(key)) node[key] = !!value;
        else node.setAttribute(key, value === true ? "" : String(value));
      }
      for (const child of children.flat()) if (child != null) {
        node.append(typeof child === "string" ? this.document.createTextNode(child) : child);
      }
      return node;
    }
    isOpen() { return !!this.dialog?.open; }
    dirty() { return signature(this.draft) !== this.initial; }
    ensureDialog() {
      if (this.dialog) return;
      this.dialog = this.el("dialog", { id: "displayDialog", "aria-labelledby": "rg-display-title" });
      this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
      this.document.body.append(this.dialog);
    }
    notify(message) {
      try { this.options.notify?.(message); } catch (_) { /* Notifications do not change the saved result. */ }
    }
    async open() {
      if (this.isOpen()) { this.dialog.focus(); return false; }
      if (this.opening || this.busy) return false;
      this.opening = true;
      try {
        if (this.options.beforeOpen && !await this.options.beforeOpen()) return false;
        if (this.isOpen()) return false;
        const project = this.options.getProject();
        if (!project) { this.notify("请先选择一个研究项目。"); return false; }
        this.project = { id: project.id, name: String(project.name || "未命名项目") };
        this.draft = normalize(this.options.getDisplay());
        this.initial = signature(this.draft); this.errorText = "";
        this.ensureDialog(); this.render(); this.dialog.showModal();
        return true;
      } catch (error) { this.notify(error?.message || "无法打开项目显示选项。"); return false; }
      finally { this.opening = false; }
    }
    close(force = false) {
      if (this.busy) return false;
      if (!this.isOpen()) return true;
      if (!force && this.dirty() && !this.document.defaultView.confirm("放弃尚未保存的显示选项修改？")) return false;
      this.dialog.close(); return true;
    }
    fail(error) {
      this.errorText = error?.message || String(error);
      if (this.errorNode) this.errorNode.textContent = this.errorText;
    }
    setBusy(value) {
      if (this.busy === value) return;
      this.busy = value;
      this.dialog.setAttribute("aria-busy", String(value));
      for (const control of this.dialog.querySelectorAll("button,input")) {
        if (value) {
          control.dataset.displayDisabled = control.disabled ? "1" : "0";
          control.disabled = true;
        } else {
          control.disabled = control.dataset.displayDisabled === "1";
          delete control.dataset.displayDisabled;
        }
      }
    }
    toggleColumn(id, checked) {
      if (this.busy || !this.isOpen() || !VALID_IDS.has(id)) return false;
      const columns = this.draft.metadataColumns;
      if (checked && !columns.includes(id)) columns.push(id);
      else if (!checked) this.draft.metadataColumns = columns.filter(column => column !== id);
      this.render(); return true;
    }
    moveColumn(id, offset) {
      if (this.busy || !this.isOpen() || ![-1, 1].includes(offset)) return false;
      const columns = this.draft.metadataColumns;
      const at = columns.indexOf(id), other = at + offset;
      if (at < 0 || other < 0 || other >= columns.length) return false;
      [columns[at], columns[other]] = [columns[other], columns[at]];
      this.render(); return true;
    }
    render() {
      const selected = this.draft.metadataColumns;
      const selections = this.el("div", { class: "rg-display-catalog" }, ...COLUMNS.map(column =>
        this.el("label", { class: "rg-display-option" }, this.el("input", { type: "checkbox",
          "data-metadata-column": column.id, checked: selected.includes(column.id),
          onchange: event => this.toggleColumn(column.id, event.target.checked) }), column.label)));
      const order = this.el("ol", { class: "rg-display-order", id: "rg-display-order" }, ...selected.map((id, index) => {
        const column = COLUMN_BY_ID.get(id);
        return this.el("li", { "data-display-selected": id },
          this.el("span", { class: "rg-display-column-label" }, column.label),
          this.el("button", { type: "button", "data-display-column": id, "data-display-move": "up", disabled: index === 0,
            "aria-label": `上移：${column.label}`, onclick: () => this.moveColumn(id, -1) }, "↑"),
          this.el("button", { type: "button", "data-display-column": id, "data-display-move": "down", disabled: index === selected.length - 1,
            "aria-label": `下移：${column.label}`, onclick: () => this.moveColumn(id, 1) }, "↓"));
      }));
      this.errorNode = this.el("p", { id: "rg-display-error", class: "rg-display-error", role: "alert" }, this.errorText);
      this.dialog.replaceChildren(
        this.el("div", { class: "rg-display-heading" }, this.el("h2", { id: "rg-display-title" }, "项目显示选项"),
          this.el("button", { type: "button", class: "rg-display-close", "aria-label": "关闭显示选项", onclick: () => this.close() }, "×")),
        this.el("p", { class: "rg-display-project" }, this.project.name),
        this.el("p", { class: "rg-display-hint" }, "选项仅用于当前项目，点击保存后生效。文献资料来自 Zotero，只读显示；请在 Zotero 条目信息中编辑，不参与 AI 总结或手填分析。"),
        this.el("section", { class: "rg-display-section" }, this.el("h3", {}, "文献标签"),
          this.el("label", { class: "rg-display-option" }, this.el("input", { id: "rg-display-tags", type: "checkbox", checked: this.draft.showTags,
            onchange: event => { if (!this.busy) this.draft.showTags = event.target.checked; } }), "显示文献标签")),
        this.el("section", { class: "rg-display-section" }, this.el("h3", {}, "文献资料列"),
          this.el("p", { class: "rg-display-hint" }, "勾选需要额外展示的列。取消勾选只隐藏这一列。"), selections),
        this.el("section", { class: "rg-display-section" }, this.el("h3", {}, `已选列顺序（${selected.length}）`),
          selected.length ? order : this.el("p", { class: "rg-display-hint" }, "尚未添加额外的文献资料列。勾选后可在此调整顺序。")),
        this.errorNode,
        this.el("div", { class: "rg-display-footer" },
          this.el("button", { type: "button", id: "rg-display-cancel", onclick: () => this.close() }, "取消"),
          this.el("button", { type: "button", id: "rg-display-save", class: "primary", onclick: () => this.save() }, "保存项目显示选项")));
      this.dialog.setAttribute("aria-busy", String(this.busy));
    }
    async save() {
      if (this.busy || !this.isOpen()) return false;
      try {
        if (this.options.getProject()?.id !== this.project.id) throw new Error("当前项目已变化，请关闭窗口后重新打开显示选项。");
        if (signature(this.options.getDisplay()) !== this.initial) throw new Error("显示选项已在别处更新，请关闭窗口后重新打开并核对。");
        const display = normalize(this.draft);
        this.errorText = ""; this.errorNode.textContent = "";
        this.setBusy(true);
        await this.options.save(display);
        this.draft = normalize(display); this.initial = signature(this.draft);
        this.setBusy(false); this.close(true);
        this.notify("已保存当前项目的显示选项。");
        return true;
      } catch (error) { this.fail(error); return false; }
      finally { if (this.busy) this.setBusy(false); }
    }
  }
  const api = { COLUMNS, normalize, Manager };
  root.RGDisplay = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
