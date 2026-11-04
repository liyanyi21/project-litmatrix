/* ResearchGrid searchable collection picker. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const idsOf = input => [...new Set((Array.isArray(input) ? input : []).filter(id => typeof id === "string" && id))];
  const pathOf = project => (Array.isArray(project.path) ? project.path.map(String).join(" / ") : String(project.path || project.name || "")).trim();
  const libraryKey = project => String(project.libraryID ?? project.library?.libraryID ?? project.library?.name ?? "default");
  function makeTree(projects) {
    const nodes = new Map(), groups = new Map(), keys = new Map(), paths = new Map();
    for (const project of Array.isArray(projects) ? projects : []) {
      if (!project || typeof project.id !== "string" || !project.id || nodes.has(project.id)) continue;
      const node = { id: project.id, name: String(project.name || "未命名分类"), path: pathOf(project),
        label: String(project.label || ""), libraryID: libraryKey(project), libraryName: String(project.libraryName || project.library?.name || "文献库"),
        collectionKey: String(project.collectionKey || ""), explicitParent: Object.prototype.hasOwnProperty.call(project, "parentKey"),
        parentKey: project.parentKey ? String(project.parentKey) : null, parent: null, children: [] };
      nodes.set(node.id, node);
      if (!groups.has(node.libraryID)) groups.set(node.libraryID, { id: node.libraryID, name: node.libraryName, roots: [] });
      for (const [index, value] of [[keys, node.collectionKey], [paths, node.path]]) {
        if (!value) continue;
        const key = `${node.libraryID}\0${value}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(node);
      }
    }
    for (const node of nodes.values()) {
      let candidates = [];
      if (node.explicitParent) {
        if (node.parentKey) candidates = keys.get(`${node.libraryID}\0${node.parentKey}`) || [];
      } else {
        const parts = node.path.split(/\s+\/\s+/);
        if (parts.length > 1) candidates = paths.get(`${node.libraryID}\0${parts.slice(0, -1).join(" / ")}`) || [];
      }
      if (candidates.length === 1 && candidates[0] !== node) node.parent = candidates[0];
    }
    // Damaged parent relationships must never hide collections or recurse forever.
    for (const node of nodes.values()) {
      const seen = new Set([node.id]);
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (seen.has(parent.id)) { node.parent = null; break; }
        seen.add(parent.id);
      }
    }
    for (const node of nodes.values()) {
      if (node.parent) node.parent.children.push(node);
      else groups.get(node.libraryID).roots.push(node);
    }
    return { nodes, groups: [...groups.values()] };
  }

  class Manager {
    constructor(options) {
      this.options = options; this.document = options.document;
      this.dialog = null; this.busy = false; this.opening = false;
      this.selected = new Set(); this.initial = "[]";
      this.query = ""; this.expanded = new Set(); this.searchCollapsed = new Set();
      this.tree = makeTree([]); this.errorText = "";
    }
    el(tag, attributes = {}, ...children) {
      const node = this.document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) {
        if (value == null || value === false) continue;
        if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else if (["checked", "disabled", "value"].includes(key)) node[key] = value;
        else node.setAttribute(key, value === true ? "" : String(value));
      }
      for (const child of children.flat()) if (child != null) node.append(typeof child === "string" ? this.document.createTextNode(child) : child);
      return node;
    }
    isOpen() { return !!this.dialog?.open; }
    dirty() { return JSON.stringify([...this.selected]) !== this.initial; }
    notify(message) { try { this.options.notify?.(message); } catch (_) { /* A notification cannot undo a successful selection. */ } }
    async open() {
      if (this.isOpen()) { this.dialog.focus(); return false; }
      if (this.busy || this.opening) return false;
      this.opening = true;
      try {
        if (this.options.beforeOpen && !await this.options.beforeOpen()) return false;
        this.tree = makeTree(this.options.getProjects());
        this.selected = new Set(idsOf(this.options.getSelected()));
        this.initial = JSON.stringify([...this.selected]);
        this.query = ""; this.expanded = new Set(); this.searchCollapsed = new Set(); this.errorText = "";
        for (const id of this.selected) {
          for (let node = this.tree.nodes.get(id); node; node = node.parent) this.expanded.add(node.id);
        }
        this.ensureDialog(); this.render(); this.dialog.showModal();
        this.searchInput.focus(); return true;
      } catch (error) { this.notify(error?.message || "无法读取 Zotero 分类。"); return false; }
      finally { this.opening = false; }
    }
    ensureDialog() {
      if (this.dialog) return;
      this.dialog = this.el("dialog", { id: "projectPickerDialog", "aria-labelledby": "rg-project-title" });
      this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
      this.document.body.append(this.dialog);
    }
    close(force = false) {
      if (this.busy) return false;
      if (!this.isOpen()) return true;
      if (!force && this.dirty() && !this.document.defaultView.confirm("放弃尚未应用的分类选择？")) return false;
      this.dialog.close(); return true;
    }
    matches() {
      const query = this.query.trim().toLocaleLowerCase();
      return [...this.tree.nodes.values()].filter(node => !query || [node.name, node.path, node.label]
        .some(value => value.toLocaleLowerCase().includes(query)));
    }
    visibleIDs(matches = this.matches()) {
      const visible = new Set();
      for (const match of matches) for (let node = match; node; node = node.parent) visible.add(node.id);
      return visible;
    }
    isExpanded(id) { return this.query.trim() ? !this.searchCollapsed.has(id) : this.expanded.has(id); }
    toggleExpanded(id) {
      if (this.busy || !this.isOpen() || !this.tree.nodes.has(id)) return false;
      const target = this.query.trim() ? this.searchCollapsed : this.expanded;
      if (target.has(id)) target.delete(id); else target.add(id);
      this.renderContent(); return true;
    }
    select(id, checked) {
      if (this.busy || !this.isOpen() || (!this.tree.nodes.has(id) && !this.selected.has(id))) return false;
      if (checked) this.selected.add(id); else this.selected.delete(id);
      this.renderContent(); return true;
    }
    selectMatches() {
      if (this.busy || !this.isOpen()) return false;
      for (const node of this.matches()) this.selected.add(node.id);
      this.renderContent(); return true;
    }
    clear() {
      if (this.busy || !this.isOpen()) return false;
      this.selected.clear(); this.renderContent(); return true;
    }
    renderNode(node, visible, matches, level) {
      const children = node.children.filter(child => visible.has(child.id));
      const expanded = this.isExpanded(node.id);
      const row = this.el("div", { class: `rg-project-row${matches.has(node.id) ? " rg-project-match" : ""}` },
        children.length ? this.el("button", { type: "button", class: "rg-project-toggle", "data-project-toggle": node.id,
          "aria-label": `${expanded ? "折叠" : "展开"}分类：${node.name}`, "aria-expanded": String(expanded),
          onclick: () => this.toggleExpanded(node.id) }, expanded ? "▾" : "▸") : this.el("span", { class: "rg-project-toggle-space", "aria-hidden": "true" }),
        this.el("label", { class: "rg-project-name", title: node.label || `${node.libraryName} / ${node.path}` },
          this.el("input", { type: "checkbox", "data-project-check": node.id, checked: this.selected.has(node.id),
            onchange: event => this.select(node.id, event.target.checked) }), this.el("span", {}, node.name)));
      return this.el("li", { role: "treeitem", "aria-level": String(level), "aria-selected": String(this.selected.has(node.id)),
        "aria-expanded": children.length ? String(expanded) : null, "data-project-node": node.id }, row,
      children.length && expanded ? this.el("ul", { role: "group" }, ...children.map(child => this.renderNode(child, visible, matches, level + 1))) : null);
    }
    render() {
      this.searchInput = this.el("input", { type: "search", id: "rg-project-search", placeholder: "搜索分类名称或完整路径", "aria-label": "搜索 Zotero 分类",
        value: this.query, oninput: event => {
          if (this.busy) return;
          this.query = event.target.value; this.searchCollapsed.clear(); this.renderContent(true);
        } });
      this.countNode = this.el("span", { id: "rg-project-results-count", role: "status" });
      this.treeRegion = this.el("div", { id: "rg-project-tree-scroll", class: "rg-project-tree-scroll" });
      this.selectedRegion = this.el("div", { id: "rg-project-selected", class: "rg-project-selected" });
      this.selectedCount = this.el("h3", { id: "rg-project-selected-title" });
      this.errorNode = this.el("p", { id: "rg-project-error", class: "rg-project-error", role: "alert" }, this.errorText);
      this.selectButton = this.el("button", { id: "rg-project-select-results", type: "button", onclick: () => this.selectMatches() }, "全选当前搜索结果");
      this.clearButton = this.el("button", { id: "rg-project-clear", type: "button", onclick: () => this.clear() }, "清空选择");
      this.dialog.replaceChildren(
        this.el("div", { class: "rg-project-heading" }, this.el("h2", { id: "rg-project-title" }, "选择 Zotero 分类"),
          this.el("button", { type: "button", class: "rg-project-close", "aria-label": "关闭分类选择", onclick: () => this.close() }, "×")),
        this.el("p", { class: "rg-project-hint" }, "可搜索、折叠和勾选多个分类。勾选父分类不会自动勾选子分类；是否包含子分类的文献仍由矩阵中的开关控制。"),
        this.el("div", { class: "rg-project-search-row" }, this.searchInput),
        this.el("div", { class: "rg-project-actions" }, this.countNode, this.selectButton, this.clearButton),
        this.el("div", { class: "rg-project-panels" },
          this.el("section", { class: "rg-project-tree-panel", "aria-label": "分类树" }, this.treeRegion),
          this.el("section", { class: "rg-project-selected-panel", "aria-labelledby": "rg-project-selected-title" }, this.selectedCount, this.selectedRegion)),
        this.errorNode,
        this.el("div", { class: "rg-project-footer" },
          this.el("button", { id: "rg-project-cancel", type: "button", onclick: () => this.close() }, "取消"),
          this.el("button", { id: "rg-project-apply", type: "button", class: "primary", onclick: () => this.apply() }, "应用选择")));
      this.renderContent();
    }
    renderContent(resetScroll = false) {
      const focused = this.document.activeElement;
      const focusAttribute = ["data-project-check", "data-project-toggle", "data-project-remove"]
        .find(attribute => focused?.hasAttribute?.(attribute));
      const focusID = focusAttribute && focused.getAttribute(focusAttribute);
      const scroll = resetScroll ? 0 : this.treeRegion.scrollTop || 0;
      const matches = this.matches(), matchIDs = new Set(matches.map(node => node.id)), visible = this.visibleIDs(matches);
      const groups = this.tree.groups.map(group => {
        const roots = group.roots.filter(node => visible.has(node.id));
        if (!roots.length) return null;
        return this.el("section", { class: "rg-project-library" }, this.el("h3", {}, group.name),
          this.el("ul", { role: "tree", "aria-label": group.name }, ...roots.map(node => this.renderNode(node, visible, matchIDs, 1))));
      }).filter(Boolean);
      this.treeRegion.replaceChildren(...(groups.length ? groups : [this.el("p", { class: "rg-project-empty" }, this.query.trim() ? "没有匹配的分类。" : "此文献库中还没有分类。请先在 Zotero 中创建分类。") ]));
      this.treeRegion.scrollTop = scroll;
      this.selectedCount.textContent = `已选择（${this.selected.size}）`;
      this.selectedRegion.replaceChildren(...(this.selected.size ? [...this.selected].map(id => {
        const node = this.tree.nodes.get(id);
        return this.el("div", { class: `rg-project-selected-item${node ? "" : " rg-project-missing"}`, "data-project-selected": id },
          this.el("div", {}, this.el("span", { class: "rg-project-selected-name" }, node?.name || "分类已移除"),
            this.el("small", {}, node ? `${node.libraryName} / ${node.path}` : id)),
          this.el("button", { type: "button", "data-project-remove": id, "aria-label": `取消选择：${node?.name || id}`,
            onclick: () => this.select(id, false) }, "×"));
      }) : [this.el("p", { class: "rg-project-empty" }, "尚未选择分类。勾选会保留，切换搜索不会清空。") ]));
      this.countNode.textContent = this.query.trim() ? `找到 ${matches.length} 个分类` : `共 ${matches.length} 个分类`;
      this.selectButton.disabled = this.busy || !matches.length;
      this.clearButton.disabled = this.busy || !this.selected.size;
      if (focusAttribute) {
        const replacement = [...this.dialog.querySelectorAll(`[${focusAttribute}]`)]
          .find(node => node.getAttribute(focusAttribute) === focusID);
        (replacement || this.searchInput).focus();
      }
    }
    setBusy(value) {
      if (this.busy === value) return;
      this.busy = value; this.dialog.setAttribute("aria-busy", String(value));
      for (const control of this.dialog.querySelectorAll("button,input")) {
        if (value) { control.dataset.projectDisabled = control.disabled ? "1" : "0"; control.disabled = true; }
        else { control.disabled = control.dataset.projectDisabled === "1"; delete control.dataset.projectDisabled; }
      }
    }
    fail(error) {
      this.errorText = error?.message || String(error);
      if (this.errorNode) this.errorNode.textContent = this.errorText;
    }
    async apply() {
      if (this.busy || !this.isOpen()) return false;
      try {
        const ids = [...this.selected], live = makeTree(this.options.getProjects()).nodes;
        const missing = ids.filter(id => !live.has(id));
        if (missing.length) throw new Error(`${missing.length} 个所选分类已不存在，请在已选清单中取消这些分类后重试。`);
        this.setBusy(true); this.errorText = ""; this.errorNode.textContent = "";
        if (await this.options.apply([...ids]) === false) throw new Error("尚未应用分类选择，请核对后重试。");
        this.initial = JSON.stringify(ids); this.setBusy(false); this.close(true);
        this.notify(`已应用 ${ids.length} 个分类。`); return true;
      } catch (error) { this.fail(error); return false; }
      finally { if (this.busy) this.setBusy(false); }
    }
  }
  const api = { Manager };
  root.RGProjectPicker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
