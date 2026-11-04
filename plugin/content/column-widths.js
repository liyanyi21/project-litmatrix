/* ResearchGrid project-scoped table column widths. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const MIN_WIDTH = 100, MAX_WIDTH = 1200, IDENTITY_MIN_WIDTH = 180;
  const validID = id => typeof id === "string" && id.length <= 200
    && (id === "identity" || /^(metadata|field):[^\s]+$/.test(id));
  const minimum = column => Math.min(MAX_WIDTH, Math.max(column.id === "identity" ? IDENTITY_MIN_WIDTH : MIN_WIDTH,
    Number.isFinite(column.min) ? Math.round(column.min) : MIN_WIDTH));
  const clamp = (width, min = MIN_WIDTH) => Math.min(MAX_WIDTH, Math.max(min, Math.round(width)));
  function normalize(input) {
    const result = {};
    if (!input || typeof input !== "object" || Array.isArray(input)) return result;
    for (const [id, width] of Object.entries(input)) {
      if (!validID(id) || typeof width !== "number" || !Number.isFinite(width)) continue;
      result[id] = clamp(width, id === "identity" ? IDENTITY_MIN_WIDTH : MIN_WIDTH);
    }
    return result;
  }
  function columns(input) {
    const seen = new Set();
    return (Array.isArray(input) ? input : []).filter(column => {
      if (!column || !validID(column.id) || seen.has(column.id)) return false;
      seen.add(column.id); return true;
    }).map(column => ({ id: column.id, label: String(column.label || column.id), min: minimum(column),
      width: clamp(Number.isFinite(column.width) ? column.width : 290, minimum(column)) }));
  }
  class Manager {
    constructor(options) {
      this.options = options || {}; this.document = this.options.document;
      this.tables = new Map(); this.gesture = null;
    }
    notify(error) {
      try { this.options.notify?.(error?.message || String(error)); } catch (_) { /* A notice cannot change persistence. */ }
    }
    attach(table, options = {}) {
      this.detach(table);
      if (!table || !this.document || !options.projectID) return false;
      const defs = columns(options.columns), heads = [...table.querySelectorAll("thead th")], cols = [...table.querySelectorAll("colgroup col")];
      if (!defs.length || defs.length !== heads.length || defs.length !== cols.length) return false;
      const data = { table, projectID: String(options.projectID), columns: defs, heads, cols,
        widths: normalize(options.widths), onChange: options.onChange, cleanups: [], handles: [], busy: false };
      this.tables.set(table, data);
      defs.forEach((column, index) => {
        const handle = this.document.createElement("span");
        handle.className = "rg-column-resizer";
        handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("tabindex", "0"); handle.setAttribute("data-column-resize", column.id);
        handle.setAttribute("aria-label", `调整列宽：${column.label}`);
        handle.setAttribute("aria-valuemin", String(column.min)); handle.setAttribute("aria-valuemax", String(MAX_WIDTH));
        handle.setAttribute("title", "拖动调整列宽；双击恢复默认。也可用左右方向键调整，Home 恢复默认。");
        const listen = (name, action) => { handle.addEventListener(name, action); data.cleanups.push(() => handle.removeEventListener(name, action)); };
        listen("pointerdown", event => this.begin(data, index, event));
        listen("dblclick", event => { event.preventDefault(); event.stopPropagation(); this.change(data, index, null); });
        listen("click", event => event.stopPropagation());
        listen("keydown", event => {
          if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          if (data.busy || this.gesture) return;
          if (event.key === "Home") this.change(data, index, null);
          else this.change(data, index, this.effective(data, index) + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 50 : 10));
        });
        data.handles.push(handle); heads[index].append(handle); heads[index].classList.add("rg-resizable-heading");
      });
      this.apply(data); return true;
    }
    effective(data, index) {
      const column = data.columns[index];
      return clamp(data.widths[column.id] ?? column.width, column.min);
    }
    apply(data, draft) {
      let total = 0;
      data.columns.forEach((column, index) => {
        const width = draft && draft.index === index ? draft.width : this.effective(data, index);
        data.cols[index].style.width = `${width}px`;
        data.handles[index].setAttribute("aria-valuenow", String(width));
        data.handles[index].setAttribute("aria-valuetext", `${width} 像素`);
        total += width;
      });
      data.table.style.width = `${total}px`;
      // The stylesheet's min-width:100% would silently stretch narrow columns.
      data.table.style.minWidth = `${total}px`;
    }
    begin(data, index, event) {
      if (data.busy || event.button != null && event.button !== 0 || this.tables.get(data.table) !== data) return;
      if (!Number.isFinite(event.clientX)) return;
      event.preventDefault(); event.stopPropagation(); this.cancel();
      const handle = data.handles[index], id = event.pointerId;
      const gesture = { data, index, handle, pointerID: id, startX: event.clientX, startWidth: this.effective(data, index), width: this.effective(data, index), cleanups: [] };
      this.gesture = gesture;
      this.document.documentElement.classList.add("rg-column-resizing");
      handle.classList.add("rg-column-resizer-active");
      try { handle.focus(); handle.setPointerCapture?.(id); } catch (_) { /* Document listeners cover hosts without capture. */ }
      const samePointer = e => id == null || e.pointerId == null || e.pointerId === id;
      const listen = (target, name, action) => { target.addEventListener(name, action); gesture.cleanups.push(() => target.removeEventListener(name, action)); };
      listen(this.document, "pointermove", e => {
        if (!samePointer(e) || !Number.isFinite(e.clientX) || this.gesture !== gesture) return;
        e.preventDefault();
        gesture.width = clamp(gesture.startWidth + e.clientX - gesture.startX, data.columns[index].min);
        this.apply(data, { index, width: gesture.width });
      });
      listen(this.document, "pointerup", e => {
        if (!samePointer(e) || this.gesture !== gesture) return;
        e.preventDefault(); e.stopPropagation();
        if (Number.isFinite(e.clientX)) gesture.width = clamp(gesture.startWidth + e.clientX - gesture.startX, data.columns[index].min);
        this.endGesture(); this.change(data, index, gesture.width);
      });
      listen(this.document, "pointercancel", e => { if (samePointer(e)) this.cancel(); });
      listen(handle, "lostpointercapture", () => { if (this.gesture === gesture) this.cancel(); });
      listen(this.document, "keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.cancel(); } });
      if (this.document.defaultView?.addEventListener) listen(this.document.defaultView, "blur", () => this.cancel());
    }
    endGesture() {
      const gesture = this.gesture; if (!gesture) return null;
      this.gesture = null;
      for (const cleanup of gesture.cleanups) cleanup();
      gesture.handle.classList.remove("rg-column-resizer-active");
      this.document.documentElement.classList.remove("rg-column-resizing");
      try { gesture.handle.releasePointerCapture?.(gesture.pointerID); } catch (_) { /* It may already have been released. */ }
      return gesture;
    }
    cancel() {
      const gesture = this.endGesture();
      if (gesture && this.tables.get(gesture.data.table) === gesture.data) this.apply(gesture.data);
    }
    async change(data, index, width) {
      if (data.busy || this.tables.get(data.table) !== data) return false;
      const column = data.columns[index], previous = { ...data.widths }, next = { ...previous };
      if (width === null) delete next[column.id];
      else next[column.id] = clamp(width, column.min);
      if (JSON.stringify(next) === JSON.stringify(previous)) { this.apply(data); return true; }
      // A click on the resize grip must not create a new saved override.
      if (width !== null && next[column.id] === this.effective(data, index) && previous[column.id] == null) {
        this.apply(data); return true;
      }
      data.busy = true; data.widths = next; this.apply(data);
      data.handles.forEach(handle => handle.setAttribute("aria-disabled", "true"));
      try {
        const result = await data.onChange?.({ ...next }, { projectID: data.projectID, columnID: column.id,
          width: this.effective(data, index), reset: width === null });
        if (result === false) throw new Error("列宽未保存，请重试。");
        return true;
      } catch (error) {
        data.widths = previous;
        if (this.tables.get(data.table) === data) this.apply(data);
        this.notify(error); return false;
      } finally {
        data.busy = false; data.handles.forEach(handle => handle.removeAttribute("aria-disabled"));
      }
    }
    async reset(table) {
      const data = this.tables.get(table);
      if (!data || data.busy || this.gesture) return false;
      const previous = data.widths;
      if (!Object.keys(previous).length) return true;
      data.busy = true; data.widths = {}; this.apply(data);
      data.handles.forEach(handle => handle.setAttribute("aria-disabled", "true"));
      try {
        const result = await data.onChange?.({}, { projectID: data.projectID, columnID: null, reset: true });
        if (result === false) throw new Error("列宽未保存，请重试。");
        return true;
      } catch (error) {
        data.widths = previous;
        if (this.tables.get(table) === data) this.apply(data);
        this.notify(error); return false;
      } finally { data.busy = false; data.handles.forEach(handle => handle.removeAttribute("aria-disabled")); }
    }
    detach(table) {
      const data = this.tables.get(table); if (!data) return;
      if (this.gesture?.data === data) this.cancel();
      for (const cleanup of data.cleanups) cleanup();
      for (const handle of data.handles) handle.remove();
      for (const head of data.heads) head.classList.remove("rg-resizable-heading");
      this.tables.delete(table);
    }
    dispose() { for (const table of [...this.tables.keys()]) this.detach(table); }
  }
  const api = { MIN_WIDTH, MAX_WIDTH, normalize, Manager };
  root.RGColumnWidths = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
