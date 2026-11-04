/* ResearchGrid project mind map. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const LIMIT = 100000;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const copy = value => JSON.parse(JSON.stringify(value));
  const finite = (value, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? clamp(value, -LIMIT, LIMIT) : fallback;
  const nodeID = row => `paper:${encodeURIComponent(String(row.libraryID ?? ""))}:${encodeURIComponent(String(row.key || row.id))}`;
  const text = value => value == null ? "" : String(value);
  const preview = (value, length = 96) => text(value).replace(/\s+/g, " ").trim().slice(0, length) + (text(value).replace(/\s+/g, " ").trim().length > length ? "…" : "");
  function normalizeLayout(input) {
    const value = input && typeof input === "object" && input.version === 1 ? input : {};
    const entries = value.positions && typeof value.positions === "object" && !Array.isArray(value.positions) ? Object.entries(value.positions) : [];
    const positions = Object.fromEntries(entries.slice(0, 20000).filter(([id, point]) => typeof id === "string" && id.length < 1000 && point
      && typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y))
      .map(([id, point]) => [id, { x: finite(point.x), y: finite(point.y) }]));
    const collapsed = [...new Set((Array.isArray(value.collapsed) ? value.collapsed : []).filter(id => typeof id === "string" && id.length < 1000))].slice(0, 20000);
    const viewport = value.viewport && typeof value.viewport === "object" ? value.viewport : {};
    return { version: 1, positions, collapsed, viewport: { x: finite(viewport.x), y: finite(viewport.y),
      scale: typeof viewport.scale === "number" && Number.isFinite(viewport.scale) ? clamp(viewport.scale, .1, 2.5) : 1 } };
  }
  function buildGraph(project, rows, fields) {
    const activeFields = (Array.isArray(fields) ? fields : []).filter(field => field && typeof field.id === "string" && !field.archived);
    const graph = { nodes: [], byID: new Map(), fields: activeFields, project };
    const add = node => { graph.nodes.push(node); graph.byID.set(node.id, node); return node; };
    const base = add({ id: "project", kind: "project", label: text(project?.name || "研究项目"), parent: null, children: [], width: 220, height: 82 });
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || (row.projectID && row.projectID !== project?.id)) continue;
      const id = nodeID(row);
      if (seen.has(id)) continue;
      seen.add(id);
      const paper = add({ id, kind: "paper", label: text(row.title || "未命名文献"), row,
        subtitle: `${row.authors || "作者未记录"}${row.year ? `（${row.year}）` : ""}`, parent: base.id, children: [], width: 272, height: 102 });
      base.children.push(id);
      for (const field of activeFields) {
        const value = text(row.values?.[field.id]);
        if (!value.trim()) continue;
        const item = add({ id: `${id}:field:${encodeURIComponent(field.id)}`, kind: "field", label: text(field.label || field.id),
          row, field, value, parent: id, children: [], width: 282, height: 120 });
        paper.children.push(item.id);
      }
    }
    return graph;
  }
  function automaticPositions(graph, collapsed) {
    const result = {}, papers = graph.byID.get("project").children.map(id => graph.byID.get(id));
    let cursor = 40;
    for (const paper of papers) {
      const count = collapsed.has(paper.id) ? 0 : paper.children.length;
      const height = Math.max(paper.height, count * 144 - 24);
      result[paper.id] = { x: 382, y: cursor + (height - paper.height) / 2 };
      paper.children.forEach((id, index) => { result[id] = { x: 800, y: cursor + index * 144 }; });
      cursor += height + 42;
    }
    result.project = { x: 40, y: papers.length ? (result[papers[0].id].y + result[papers.at(-1).id].y + papers[0].height) / 2 - 41 : 40 };
    return result;
  }
  class Manager {
    constructor(options) {
      this.options = options; this.document = options.document; this.container = options.container;
      this.visible = false; this.busy = false; this.destroyed = false; this.epoch = 0;
      this.graph = null; this.project = null; this.selected = "project"; this.gesture = null; this.suppressClickUntil = 0;
      this.moveHandler = event => this.pointerMove(event);
      this.upHandler = event => this.pointerEnd(event, false);
      this.cancelHandler = event => this.pointerEnd(event, true);
      this.keyHandler = event => { if (event.key === "Escape" && this.gesture) { event.preventDefault(); this.cancelGesture(); } };
      this.blurHandler = () => this.cancelGesture();
      this.document.addEventListener("pointermove", this.moveHandler);
      this.document.addEventListener("pointerup", this.upHandler);
      this.document.addEventListener("pointercancel", this.cancelHandler);
      this.document.addEventListener("keydown", this.keyHandler);
      this.document.defaultView?.addEventListener?.("blur", this.blurHandler);
      this.container.classList.add("rg-mindmap"); this.container.hidden = true;
    }
    el(tag, attrs = {}, ...children) {
      const node = this.document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else if (key === "disabled") node.disabled = !!value;
        else node.setAttribute(key, String(value));
      }
      for (const child of children.flat()) if (child != null) node.append(typeof child === "string" ? this.document.createTextNode(child) : child);
      return node;
    }
    notify(message) { try { this.options.notify?.(message); } catch (_) { /* UI notification cannot change a saved layout. */ } }
    isOpen() { return this.visible && !this.destroyed; }
    dirty() { return !!this.gesture?.moved; }
    show() {
      if (this.destroyed || this.busy) return false;
      this.visible = true; this.container.hidden = false;
      if (!this.update()) { this.visible = false; this.container.hidden = true; return false; }
      return true;
    }
    hide() {
      if (this.busy) return false;
      this.cancelGesture(); this.visible = false; this.container.hidden = true; return true;
    }
    update() {
      if (!this.isOpen()) return false;
      if (this.busy) { this.pendingUpdate = true; return false; }
      this.cancelGesture();
      try {
        const project = this.options.getProject();
        if (!project?.id) throw new Error("请先选择一个研究项目，再打开思维导图。");
        const changed = this.project?.id !== project.id;
        this.project = { ...project }; this.epoch++;
        this.graph = buildGraph(this.project, this.options.getRows(this.project), this.options.getFields(this.project));
        const saved = this.options.getLayout?.(this.project);
        this.layout = normalizeLayout(saved);
        if (!saved || saved.version !== 1) this.layout.collapsed = this.graph.nodes.filter(node => node.kind === "paper" && node.children.length).map(node => node.id);
        if (changed || !this.graph.byID.has(this.selected)) this.selected = "project";
        this.render();
        if (!saved || saved.version !== 1) this.initialViewport();
        this.savedLayout = copy(this.layout);
        return true;
      } catch (error) { this.notify(error?.message || "无法打开项目思维导图。"); return false; }
    }
    render() {
      this.titleNode = this.el("strong", { class: "rg-mm-project" }, this.project.name || "研究项目");
      this.zoomNode = this.el("span", { class: "rg-mm-zoom", "aria-label": "当前缩放" });
      this.statusNode = this.el("span", { class: "rg-mm-status", role: "status", "aria-live": "polite" });
      this.canvas = this.el("div", { class: "rg-mm-canvas", tabindex: "0", role: "region", "aria-label": "思维导图画布，拖动空白处平移",
        onpointerdown: event => this.pointerStart(event, null), onkeydown: event => this.canvasKey(event),
        onlostpointercapture: event => { if (this.gesture && (event.pointerId == null || event.pointerId === this.gesture.pointerID)) this.cancelGesture(); } });
      this.stage = this.el("div", { class: "rg-mm-stage" }); this.canvas.append(this.stage);
      this.details = this.el("aside", { class: "rg-mm-details", "aria-label": "选中节点详情" });
      const button = (label, action, title, extra = {}) => this.el("button", { type: "button", "aria-label": title || label, title: title || label, onclick: action, ...extra }, label);
      this.container.replaceChildren(this.el("div", { class: "rg-mm-toolbar" }, this.titleNode,
        button("−", () => this.zoom(.8), "缩小思维导图"), this.zoomNode, button("+", () => this.zoom(1.25), "放大思维导图"),
        button("100%", () => this.actualSize(), "实际大小（100%）"),
        button("适应画布", () => this.fit(), "缩放并居中显示全部可见节点"),
        button("展开全部", () => this.collapseAll(false)), button("折叠文献", () => this.collapseAll(true)),
        button("自动排布", () => this.resetPositions(), "清除本项目手动位置并自动排布")),
        this.el("p", { class: "rg-mm-hint" }, "拖动节点及其分支 · 拖动空白平移 · 双击分析节点编辑 · 选中节点后用方向键微调"),
        this.el("div", { class: "rg-mm-workspace" }, this.canvas, this.details),
        this.el("div", { class: "rg-mm-footer" }, this.el("span", { class: "rg-mm-count" }, `${this.graph.nodes.filter(node => node.kind === "paper").length} 篇文献 · ${this.graph.nodes.filter(node => node.kind === "field").length} 项已填分析`),
          this.el("div", { class: "rg-mm-pan", "aria-label": "平移画布" }, button("←", () => this.pan(80, 0), "向左查看画布"),
            button("↑", () => this.pan(0, 80), "向上查看画布"), button("↓", () => this.pan(0, -80), "向下查看画布"), button("→", () => this.pan(-80, 0), "向右查看画布")), this.statusNode));
      this.renderGraph(); this.renderDetails();
    }
    visibleNodes() {
      const output = [], collapsed = new Set(this.layout.collapsed);
      const visit = id => { const node = this.graph.byID.get(id); if (!node) return; output.push(node); if (!collapsed.has(id)) node.children.forEach(visit); };
      visit("project"); return output;
    }
    positions() {
      return { ...automaticPositions(this.graph, new Set(this.layout.collapsed)), ...this.layout.positions };
    }
    renderGraph() {
      const nodes = this.visibleNodes(), positions = this.positions(), visible = new Set(nodes.map(node => node.id));
      const svg = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "rg-mm-edges"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("width", "1"); svg.setAttribute("height", "1");
      for (const node of nodes) if (node.parent && visible.has(node.parent)) {
        const parent = this.graph.byID.get(node.parent), a = positions[parent.id], b = positions[node.id];
        const startX = a.x + parent.width, startY = a.y + parent.height / 2, endX = b.x, endY = b.y + node.height / 2;
        const middle = (startX + endX) / 2;
        const edge = this.document.createElementNS("http://www.w3.org/2000/svg", "path");
        edge.setAttribute("d", `M ${startX} ${startY} C ${middle} ${startY}, ${middle} ${endY}, ${endX} ${endY}`); svg.append(edge);
      }
      this.stage.replaceChildren(svg, ...nodes.map(node => {
        const card = this.el("div", { class: `rg-mm-node rg-mm-${node.kind}${this.selected === node.id ? " selected" : ""}`, "data-mm-node": node.id,
          style: `left:${positions[node.id].x}px;top:${positions[node.id].y}px;width:${node.width}px;height:${node.height}px;` });
        const body = this.el("button", { type: "button", class: "rg-mm-node-body", "data-mm-select": node.id,
          "aria-label": `${node.kind === "project" ? "项目" : node.kind === "paper" ? "文献" : "分析字段"}：${node.label}，按回车查看，方向键移动`,
          title: node.kind === "field" ? `${node.label}：${node.value}` : node.label,
          onpointerdown: event => { event.stopPropagation(); this.pointerStart(event, node.id); },
          onclick: event => { if (Date.now() < this.suppressClickUntil) { event.preventDefault(); return; } this.select(node.id); },
          ondblclick: event => { event.preventDefault(); if (node.kind === "field") this.invoke("onEdit", node.id); else if (node.children.length) this.toggle(node.id); },
          onkeydown: event => this.nodeKey(event, node.id) }, this.el("span", { class: "rg-mm-label" }, preview(node.label, 100)),
          this.el("span", { class: "rg-mm-subtitle" }, node.kind === "project" ? `${node.children.length} 篇文献` : node.kind === "paper" ? node.subtitle : preview(node.value, 110)));
        card.append(body);
        if (node.children.length) card.append(this.el("button", { type: "button", class: "rg-mm-toggle", "data-mm-toggle": node.id,
          "aria-expanded": String(!this.layout.collapsed.includes(node.id)),
          "aria-label": `${this.layout.collapsed.includes(node.id) ? "展开" : "折叠"}：${node.label}`, title: `包含 ${node.children.length} 个子节点`,
          onclick: event => { event.stopPropagation(); this.toggle(node.id); } }, this.layout.collapsed.includes(node.id) ? "+" : "−"));
        return card;
      }));
      this.applyViewport();
    }
    applyViewport() {
      const viewport = this.layout.viewport;
      this.stage.style.transform = `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.scale})`;
      this.zoomNode.textContent = `${Math.round(viewport.scale * 100)}%`;
    }
    select(id) {
      if (!this.graph.byID.has(id)) return false;
      this.selected = id;
      for (const card of this.stage.querySelectorAll("[data-mm-node]")) card.classList.toggle("selected", card.getAttribute("data-mm-node") === id);
      this.renderDetails(); this.focusNode(id); return true;
    }
    renderDetails() {
      const node = this.graph.byID.get(this.selected) || this.graph.byID.get("project");
      const children = [this.el("span", { class: "rg-mm-detail-kind" }, node.kind === "project" ? "研究项目" : node.kind === "paper" ? "文献" : "分析字段"), this.el("h2", {}, node.label)];
      if (node.row) {
        children.push(this.el("p", { class: "rg-mm-detail-authors" }, `${node.row.authors || "作者未记录"}${node.row.year ? `（${node.row.year}）` : ""}`),
          this.el("div", { class: "rg-mm-detail-actions" }, this.el("button", { type: "button", "data-mm-open": node.id,
            onclick: () => this.invoke("onOpenPaper", node.id) }, node.row.attachmentID ? "打开原文" : "定位文献"),
          this.el("button", { type: "button", "data-mm-locate": node.id, onclick: () => this.invoke("onLocate", node.id) }, "Zotero 条目")));
      }
      const fieldSection = (row, field, value, id) => this.el("section", { class: "rg-mm-detail-field" },
        this.el("div", { class: "rg-mm-field-heading" }, this.el("h3", {}, text(field.label || field.id)),
          this.el("button", { type: "button", "data-mm-edit": field.id, disabled: !row.editable,
            onclick: () => this.invokeEdit(row, field, id) }, value.trim() ? "编辑" : "填写")),
        field.requirement ? this.el("p", { class: "rg-mm-requirement" }, `填写要求：${field.requirement}`) : null,
        this.el("p", { class: `rg-mm-fulltext${value.trim() ? "" : " rg-mm-unfilled"}` }, value.trim() ? value : "尚未填写"));
      if (node.kind === "field") children.push(fieldSection(node.row, node.field, node.value, node.id));
      else if (node.kind === "paper") {
        for (const field of this.graph.fields) children.push(fieldSection(node.row, field, text(node.row.values?.[field.id]), node.id));
        if (!this.graph.fields.length) children.push(this.el("p", {}, "本项目尚未设置分析字段。可在“项目字段与模板”中添加。"));
      } else {
        children.push(this.el("p", {}, "点击节点查看完整内容。文献节点右侧的加号可以展开分析字段；空字段可在文献详情中填写。"),
          this.el("p", {}, "节点位置、折叠状态和缩放在当前项目中自动保存。分析内容与表格共用同一份项目笔记。"));
        if (!node.children.length) children.push(this.el("p", {}, "当前筛选没有文献。清除搜索或调整分析状态后再查看。"));
      }
      this.details.replaceChildren(...children);
    }
    guard(id) {
      if (!this.isOpen() || this.busy || this.options.getProject()?.id !== this.project?.id) return null;
      return this.graph.byID.get(id) || null;
    }
    invoke(name, id) {
      const node = this.guard(id);
      if (!node?.row) return false;
      if (name === "onEdit") return this.invokeEdit(node.row, node.field, id);
      try { Promise.resolve(this.options[name]?.(node.row)).catch(error => this.notify(error?.message || String(error))); return true; }
      catch (error) { this.notify(error?.message || String(error)); return false; }
    }
    invokeEdit(row, field, id) {
      if (!this.guard(id) || !row?.editable || !field || !this.graph.fields.some(item => item.id === field.id)) return false;
      try { Promise.resolve(this.options.onEdit?.(row, field)).catch(error => this.notify(error?.message || String(error))); return true; }
      catch (error) { this.notify(error?.message || String(error)); return false; }
    }
    descendants(id) {
      const ids = [], visit = key => { const node = this.graph.byID.get(key); if (!node) return; ids.push(key); node.children.forEach(visit); };
      visit(id); return ids;
    }
    moveNodes(ids, deltaX, deltaY, positions) {
      for (const id of ids) this.layout.positions[id] = { x: finite(positions[id].x + deltaX), y: finite(positions[id].y + deltaY) };
    }
    pointerStart(event, id) {
      if (!this.isOpen() || this.busy || this.gesture || this.options.getProject()?.id !== this.project.id || (event.button != null && event.button !== 0)) return;
      if (!id && event.target.closest?.("[data-mm-node],button,input,textarea")) return;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      event.preventDefault();
      // The canvas survives redraws while nodes are replaced during a drag.
      const capture = this.canvas;
      this.gesture = { id, ids: id ? this.descendants(id) : [], startX: event.clientX, startY: event.clientY, pointerID: event.pointerId,
        epoch: this.epoch, projectID: this.project.id, capture, captured: false, layout: copy(this.layout), positions: this.positions(), moved: false };
      if (id) this.select(id);
      else this.canvas.focus?.();
    }
    pointerMove(event) {
      const gesture = this.gesture;
      if (!gesture || (event.pointerId != null && gesture.pointerID != null && event.pointerId !== gesture.pointerID)) return;
      if (gesture.epoch !== this.epoch || this.options.getProject()?.id !== gesture.projectID || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) { this.cancelGesture(); return; }
      const x = event.clientX - gesture.startX, y = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(x, y) < 4) return;
      if (!gesture.moved) {
        // Capture only actual drags: capturing a simple press on the canvas
        // would retarget button clicks/double-clicks away from their node.
        try {
          if (typeof gesture.capture.setPointerCapture === "function") { gesture.capture.setPointerCapture(gesture.pointerID); gesture.captured = true; }
        } catch (_) { /* Document listeners cover unavailable native capture. */ }
      }
      gesture.moved = true; event.preventDefault(); this.canvas.classList.add("rg-mm-dragging");
      if (gesture.id) { this.moveNodes(gesture.ids, x / gesture.layout.viewport.scale, y / gesture.layout.viewport.scale, gesture.positions); this.renderGraph(); }
      else { this.layout.viewport.x = finite(gesture.layout.viewport.x + x); this.layout.viewport.y = finite(gesture.layout.viewport.y + y); this.applyViewport(); }
    }
    releaseGesture() {
      const gesture = this.gesture; this.gesture = null; this.canvas?.classList.remove("rg-mm-dragging");
      try { if (gesture?.captured) gesture.capture.releasePointerCapture?.(gesture.pointerID); } catch (_) { /* Gesture may already have lost native capture. */ }
      return gesture;
    }
    cancelGesture() {
      const gesture = this.releaseGesture();
      if (!gesture) return;
      this.layout = gesture.layout;
      if (this.stage) this.renderGraph();
    }
    pointerEnd(event, cancelled) {
      const gesture = this.gesture;
      if (!gesture || (event.pointerId != null && gesture.pointerID != null && event.pointerId !== gesture.pointerID)) return;
      if (cancelled || gesture.epoch !== this.epoch || this.options.getProject()?.id !== gesture.projectID) { this.cancelGesture(); return; }
      this.releaseGesture();
      if (gesture.moved) { this.suppressClickUntil = Date.now() + 200; if (gesture.id) this.focusNode(gesture.id); this.commit(gesture.layout); }
    }
    nodeKey(event, id) {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.select(id); return; }
      const vector = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!vector || !this.guard(id) || this.gesture) return;
      event.preventDefault(); event.stopPropagation();
      const previous = copy(this.layout), step = event.shiftKey ? 40 : 10;
      this.moveNodes(this.descendants(id), vector[0] * step, vector[1] * step, this.positions());
      this.renderGraph(); this.select(id); this.commit(previous);
    }
    canvasKey(event) {
      if (event.target !== this.canvas || this.busy) return;
      if (["+", "="].includes(event.key)) { event.preventDefault(); this.zoom(1.25); }
      else if (event.key === "-") { event.preventDefault(); this.zoom(.8); }
      else {
        const vector = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }[event.key];
        if (vector) { event.preventDefault(); this.pan(...vector); }
      }
    }
    focusNode(id) { [...this.stage.querySelectorAll("[data-mm-select]")].find(node => node.getAttribute("data-mm-select") === id)?.focus?.(); }
    toggle(id) {
      const node = this.guard(id);
      if (!node?.children.length || this.gesture) return false;
      const previous = copy(this.layout), collapsed = new Set(this.layout.collapsed), before = this.positions()[id];
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      this.layout.collapsed = [...collapsed];
      const after = this.positions()[id], viewport = this.layout.viewport;
      // A single branch should open in place at the readable current scale.
      // Fitting the entire project here would shrink every label on each click.
      viewport.x = finite(viewport.x + (before.x - after.x) * viewport.scale);
      viewport.y = finite(viewport.y + (before.y - after.y) * viewport.scale);
      this.renderGraph(); this.focusNode(id); this.commit(previous); return true;
    }
    collapseAll(collapse) {
      if (!this.guard("project") || this.gesture) return false;
      const previous = copy(this.layout), collapsed = new Set(this.layout.collapsed);
      collapsed.delete("project");
      for (const node of this.graph.nodes) if (node.kind === "paper" && node.children.length) { if (collapse) collapsed.add(node.id); else collapsed.delete(node.id); }
      this.layout.collapsed = [...collapsed]; this.renderGraph(); this.fit(false); this.commit(previous); return true;
    }
    resetPositions() {
      if (!this.guard("project") || this.gesture) return false;
      const previous = copy(this.layout); this.layout.positions = {}; this.renderGraph(); this.fit(false); this.commit(previous); return true;
    }
    initialViewport() {
      const positions = this.positions(), root = this.graph.byID.get("project"), point = positions.project;
      const papers = root.children.map(id => this.graph.byID.get(id));
      const right = papers.length ? Math.max(...papers.map(node => positions[node.id].x + node.width)) : point.x + root.width;
      const scale = .85, width = this.canvas.clientWidth || 800, height = this.canvas.clientHeight || 480;
      this.layout.viewport = { scale, x: finite(width / 2 - (point.x + right) * scale / 2),
        y: finite(height / 2 - (point.y + root.height / 2) * scale) };
      this.applyViewport();
    }
    actualSize() {
      if (!this.guard("project") || this.gesture) return false;
      const previous = copy(this.layout), node = this.graph.byID.get(this.selected) || this.graph.byID.get("project"), point = this.positions()[node.id];
      this.layout.viewport = { scale: 1, x: finite((this.canvas.clientWidth || 800) / 2 - point.x - node.width / 2),
        y: finite((this.canvas.clientHeight || 480) / 2 - point.y - node.height / 2) };
      this.applyViewport(); this.commit(previous); return true;
    }
    fit(persist = true) {
      if (!this.isOpen() || (persist && !this.guard("project")) || this.gesture) return false;
      const previous = copy(this.layout), positions = this.positions(), nodes = this.visibleNodes();
      const minX = Math.min(...nodes.map(node => positions[node.id].x)), minY = Math.min(...nodes.map(node => positions[node.id].y));
      const maxX = Math.max(...nodes.map(node => positions[node.id].x + node.width)), maxY = Math.max(...nodes.map(node => positions[node.id].y + node.height));
      const width = this.canvas.clientWidth || 800, height = this.canvas.clientHeight || 480;
      const scale = clamp(Math.min((width - 70) / Math.max(1, maxX - minX), (height - 70) / Math.max(1, maxY - minY)), .1, 1.3);
      this.layout.viewport = { scale, x: finite((width - (maxX - minX) * scale) / 2 - minX * scale), y: finite((height - (maxY - minY) * scale) / 2 - minY * scale) };
      this.applyViewport(); if (persist) this.commit(previous); return true;
    }
    zoom(factor) {
      if (!this.guard("project") || this.gesture || !Number.isFinite(factor) || factor <= 0) return false;
      const previous = copy(this.layout), viewport = this.layout.viewport, scale = clamp(viewport.scale * factor, .1, 2.5);
      const centerX = (this.canvas.clientWidth || 800) / 2, centerY = (this.canvas.clientHeight || 480) / 2;
      viewport.x = finite(centerX - (centerX - viewport.x) * scale / viewport.scale);
      viewport.y = finite(centerY - (centerY - viewport.y) * scale / viewport.scale);
      viewport.scale = scale; this.applyViewport(); this.commit(previous); return true;
    }
    pan(x, y) {
      if (!this.guard("project") || this.gesture || !Number.isFinite(x) || !Number.isFinite(y)) return false;
      const previous = copy(this.layout); this.layout.viewport.x = finite(this.layout.viewport.x + x); this.layout.viewport.y = finite(this.layout.viewport.y + y);
      this.applyViewport(); this.commit(previous); return true;
    }
    setBusy(value) {
      this.busy = value; this.container.setAttribute("aria-busy", String(value));
      for (const button of this.container.querySelectorAll("button")) {
        if (value) { button.dataset.mmDisabled = button.disabled ? "1" : "0"; button.disabled = true; }
        else if (button.dataset.mmDisabled !== undefined) { button.disabled = button.dataset.mmDisabled === "1"; delete button.dataset.mmDisabled; }
      }
    }
    rememberFocus() {
      const active = this.document.activeElement;
      if (!active || !this.container.contains(active)) return null;
      for (const attribute of ["data-mm-select", "data-mm-toggle", "data-mm-edit", "data-mm-open", "data-mm-locate", "aria-label"]) {
        if (active.hasAttribute(attribute)) return { attribute, value: active.getAttribute(attribute) };
      }
      return null;
    }
    restoreFocus(focus) {
      if (!focus) return;
      const active = this.document.activeElement;
      if (active && active !== this.document.body && !this.container.contains(active)) return;
      const target = [...this.container.querySelectorAll(`[${focus.attribute}]`)].find(node => node.getAttribute(focus.attribute) === focus.value);
      if (target && !target.disabled) target.focus?.();
    }
    async commit(previous) {
      if (this.busy || this.destroyed) return false;
      const project = { ...this.project }, epoch = this.epoch, layout = normalizeLayout(this.layout), focus = this.rememberFocus();
      this.setBusy(true); this.statusNode.textContent = "正在保存布局…";
      try {
        await this.options.saveLayout(project, copy(layout));
        if (!this.destroyed && epoch === this.epoch && this.project.id === project.id) { this.savedLayout = copy(layout); this.statusNode.textContent = "布局已保存"; }
        return true;
      } catch (error) {
        if (!this.destroyed && epoch === this.epoch && this.project.id === project.id) {
          this.layout = copy(previous || this.savedLayout); this.renderGraph(); this.renderDetails();
          this.statusNode.textContent = "布局保存失败，已恢复原布局。";
        }
        this.notify(error?.message || "思维导图布局保存失败。"); return false;
      } finally {
        if (!this.destroyed) {
          this.setBusy(false);
          if (this.pendingUpdate) { this.pendingUpdate = false; this.update(); }
          if (epoch === this.epoch && this.options.getProject()?.id === project.id && this.isOpen()) this.restoreFocus(focus);
        }
      }
    }
    dispose() {
      this.cancelGesture(); this.visible = false; this.destroyed = true;
      this.document.removeEventListener("pointermove", this.moveHandler);
      this.document.removeEventListener("pointerup", this.upHandler);
      this.document.removeEventListener("pointercancel", this.cancelHandler);
      this.document.removeEventListener("keydown", this.keyHandler);
      this.document.defaultView?.removeEventListener?.("blur", this.blurHandler);
      this.container.replaceChildren(); this.container.hidden = true;
    }
  }
  const api = { Manager, normalizeLayout, buildGraph, nodeID };
  root.RGMindmap = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
