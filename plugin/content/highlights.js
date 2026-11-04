/* ResearchGrid text highlights. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const Core = () => root.PLMCore || (typeof require === "function" ? require("./core.js") : null);
  const LABELS = Object.freeze({ yellow: "黄色高亮", green: "绿色高亮", blue: "蓝色高亮", pink: "粉色高亮" });
  const copy = value => JSON.parse(JSON.stringify(value));
  const fieldSignature = fields => JSON.stringify((fields || []).filter(f => !f.archived).map(f => [f.id, f.label, f.requirement || ""]));
  function normalize(text, ranges) { return Core().normalizeHighlights(text, ranges || []); }
  function element(document, tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value == null || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "disabled") node.disabled = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) if (child != null) node.append(typeof child === "string" ? document.createTextNode(child) : child);
    return node;
  }
  function render(document, text, ranges = []) {
    text = String(text ?? "");
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const range of normalize(text, ranges)) {
      if (range.start > offset) fragment.append(document.createTextNode(text.slice(offset, range.start)));
      fragment.append(element(document, "span", { class: "rg-text-highlight", "data-rg-highlight": range.color,
        style: `background-color:${Core().HIGHLIGHT_COLORS[range.color]};color:#172321` }, text.slice(range.start, range.end)));
      offset = range.end;
    }
    if (offset < text.length) fragment.append(document.createTextNode(text.slice(offset)));
    return fragment;
  }
  function colorButtons(document, run, className = "") {
    const buttons = [];
    for (const color of Object.keys(LABELS)) buttons.push(element(document, "button", {
      type: "button", class: `rg-highlight-color ${className}`.trim(), "data-highlight-color": color,
      title: LABELS[color], "aria-label": LABELS[color],
      style: `--rg-highlight-color:${Core().HIGHLIGHT_COLORS[color]}`,
      onmousedown: event => event.preventDefault(), onclick: event => { event.preventDefault(); event.stopPropagation(); run(color); },
    }, element(document, "span", { "aria-hidden": "true" }, "A")));
    buttons.push(element(document, "button", { type: "button", class: className, "data-highlight-remove": "",
      title: "移除所选文字的高亮", onmousedown: event => event.preventDefault(),
      onclick: event => { event.preventDefault(); event.stopPropagation(); run(null); } }, "清除高亮"));
    return buttons;
  }
  function cellFor(node) {
    const parent = node?.nodeType === 1 ? node : node?.parentElement;
    return parent?.closest?.(".cell-text[data-row][data-field]") || null;
  }
  function readSelection(selection) {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const startCell = cellFor(range.startContainer), endCell = cellFor(range.endContainer);
    if (!startCell || startCell !== endCell || range.collapsed) return null;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(startCell);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset);
    const end = prefix.toString().length;
    if (end <= start || end > startCell.textContent.length) return null;
    return { element: startCell, start, end };
  }
  class Manager {
    constructor(options) {
      this.options = options; this.document = options.document;
      this.busy = false; this.snapshot = null; this.disposed = false;
      this.root = element(this.document, "div", { id: "rg-highlight-selection-toolbar", class: "rg-highlight-selection-toolbar", role: "region", "aria-label": "选中文字高亮" });
      this.root.hidden = true;
      this.context = element(this.document, "span", { class: "rg-highlight-context" });
      this.status = element(this.document, "span", { class: "rg-highlight-toolbar-hint", role: "status", "aria-live": "polite" });
      this.root.append(this.context, ...colorButtons(this.document, color => this.apply(color)),
        element(this.document, "button", { type: "button", class: "rg-highlight-dismiss", "aria-label": "关闭文字高亮工具栏",
          onmousedown: event => event.preventDefault(), onclick: () => this.clear() }, "×"), this.status);
      this.document.body.append(this.root);
      this.onSelection = event => {
        if (event?.target?.closest?.("#rg-highlight-selection-toolbar")) return;
        this.captureSelection();
      };
      for (const type of ["mouseup", "keyup", "selectionchange"]) this.document.addEventListener(type, this.onSelection);
    }
    isOpen() { return !this.root.hidden; }
    captureSelection(selection = this.options.getSelection?.() || this.document.defaultView?.getSelection?.()) {
      if (this.busy || this.disposed) return false;
      let captured;
      try { captured = readSelection(selection); } catch (_) { captured = null; }
      if (!captured) { this.clear(); return false; }
      return this.capture(captured);
    }
    capture({ element: selectedElement, start, end } = {}) {
      if (this.busy || this.disposed) return false;
      const project = this.options.getProject();
      const fieldID = selectedElement?.getAttribute?.("data-field");
      const rowID = selectedElement?.getAttribute?.("data-row");
      const field = this.options.getFields().find(field => field.id === fieldID && !field.archived);
      const row = this.options.getRows().find(row => String(row.id) === rowID);
      if (!project || !field || !row?.editable || !selectedElement?.matches?.(".cell-text[data-row][data-field]")
        || !selectedElement.isConnected || selectedElement.closest("dialog,[contenteditable=true],.editing-cell")
        || !Number.isInteger(start) || !Number.isInteger(end) || end <= start) { this.clear(); return false; }
      const text = String(row.values?.[fieldID] || "");
      if (selectedElement.textContent !== text || start < 0 || end > text.length) { this.clear(); return false; }
      let ranges;
      try { ranges = normalize(text, row.highlights?.[fieldID]); } catch (_) { this.clear(); return false; }
      this.snapshot = { project: { ...project }, field: { ...field }, schema: fieldSignature(this.options.getFields()),
        row: { id: row.id, key: row.key, libraryID: row.libraryID }, text, ranges: copy(ranges), start, end, element: selectedElement };
      this.context.textContent = `${field.label} · 已选 ${end - start} 字符`;
      this.status.textContent = "点颜色立即高亮并自动保存到当前项目笔记。";
      this.root.hidden = false; this.sync(); return true;
    }
    guard() {
      const snap = this.snapshot;
      if (!snap || this.options.getProject()?.id !== snap.project.id) throw new Error("当前项目已变化，请重新选择文字。");
      if (fieldSignature(this.options.getFields()) !== snap.schema) throw new Error("项目字段已变化，请重新选择文字。");
      const row = this.options.getRows().find(row => row.id === snap.row.id && row.key === snap.row.key && row.libraryID === snap.row.libraryID);
      if (!row?.editable || !snap.element.isConnected || snap.element.textContent !== snap.text
        || String(row.values?.[snap.field.id] || "") !== snap.text) throw new Error("单元格内容已变化，请重新选择文字。");
      if (JSON.stringify(normalize(snap.text, row.highlights?.[snap.field.id])) !== JSON.stringify(snap.ranges)) {
        throw new Error("单元格高亮已变化，请重新选择文字。");
      }
      return row;
    }
    sync() {
      for (const button of this.root.querySelectorAll("button")) button.disabled = this.busy;
      this.root.setAttribute("aria-busy", String(this.busy));
    }
    async apply(color) {
      if (this.busy || !this.snapshot || this.disposed) return false;
      this.busy = true; this.sync();
      try {
        if (this.options.beforeSave && !await this.options.beforeSave()) return false;
        const row = this.guard(), snap = this.snapshot;
        const highlights = Core().applyHighlight(snap.text, snap.ranges, snap.start, snap.end, color);
        this.status.textContent = "正在保存高亮…";
        await this.options.save(snap.project, row, snap.field.id, snap.text, snap.text,
          { highlights, expectedHighlights: copy(snap.ranges) });
        if (this.disposed) return true;
        this.busy = false; this.clear(true);
        try { this.options.notify?.(color ? "已保存文字高亮" : "已清除所选高亮"); } catch (_) { /* Saved content does not depend on notification rendering. */ }
        return true;
      } catch (error) {
        if (!this.disposed) this.status.textContent = error.message || "高亮保存失败，请重试。";
        return false;
      } finally { this.busy = false; if (!this.disposed) this.sync(); }
    }
    clear(clearSelection = false) {
      if (this.busy) return false;
      this.snapshot = null; this.root.hidden = true;
      if (clearSelection) (this.options.getSelection?.() || this.document.defaultView?.getSelection?.())?.removeAllRanges?.();
      return true;
    }
    dispose() {
      this.disposed = true;
      for (const type of ["mouseup", "keyup", "selectionchange"]) this.document.removeEventListener(type, this.onSelection);
      this.root.remove(); this.snapshot = null;
    }
  }
  const api = { render, readSelection, Manager };
  root.RGHighlights = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
