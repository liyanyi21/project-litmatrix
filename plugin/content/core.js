/* ResearchGrid, 2026-11-02. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const FIELDS = Object.freeze([
    { id: "task_evidence", label: "任务与证据类型", visible: true },
    { id: "methods_sample", label: "研究方法与样本", visible: false },
    { id: "outcomes", label: "观测指标", visible: true },
    { id: "findings", label: "核心结论", visible: true },
    { id: "limitations", label: "局限性", visible: false },
    { id: "relevance", label: "与我的研究的关系", visible: false },
    { id: "remarks", label: "我的备注", visible: true },
  ]);
  const NOTE_PREFIX = "_projectlitmatrix:v1:";
  function projectID(library, collectionKey) {
    if (!collectionKey) throw new Error("请先选择一个 Zotero 分类作为研究项目。");
    if (library.libraryType !== "user" && library.libraryType !== "group") throw new Error("此文献库不支持项目矩阵。");
    if (library.libraryType === "group" && !library.groupID) throw new Error("无法识别群组文献库。");
    return `${library.libraryType === "group" ? `group:${library.groupID}` : "user"}:collection:${collectionKey}`;
  }
  const noteTag = (project) => NOTE_PREFIX + project;
  const blankValues = (fields = FIELDS) => Object.fromEntries(fields.map(f => [f.id, ""]));
  const fieldByID = (id, fields = FIELDS) => fields.find(f => f.id === id);
  const escapeHTML = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const HIGHLIGHT_COLORS = Object.freeze({ yellow: "#ffd400", green: "#a3e635", blue: "#7dd3fc", pink: "#f9a8d4" });
  const validBoundary = (text, at) => !(at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]));
  function normalizeHighlights(value, ranges = []) {
    const text = String(value);
    if (!Array.isArray(ranges) || ranges.length > 2000) throw new Error("高亮格式无效或数量过多。");
    const events = new Map();
    for (const [index, range] of ranges.entries()) {
      if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end > text.length
        || range.start >= range.end || !Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, range.color)
        || !validBoundary(text, range.start) || !validBoundary(text, range.end)) throw new Error("高亮范围或颜色无效。");
      for (const [at, type] of [[range.start, "add"], [range.end, "remove"]]) {
        if (!events.has(at)) events.set(at, { add: [], remove: [] });
        events.get(at)[type].push(index);
      }
    }
    const positions = [...events.keys()].sort((a, b) => a - b), active = new Set(), result = [];
    for (let i = 0; i < positions.length - 1; i++) {
      const at = positions[i], event = events.get(at);
      for (const id of event.remove) active.delete(id);
      for (const id of event.add) active.add(id);
      if (!active.size) continue;
      let latest = -1;
      for (const id of active) if (id > latest) latest = id;
      const next = { start: at, end: positions[i + 1], color: ranges[latest].color };
      const previous = result[result.length - 1];
      if (previous && previous.end === next.start && previous.color === next.color) previous.end = next.end;
      else result.push(next);
    }
    if (result.length > 2000) throw new Error("高亮数量过多，请减少部分标记。");
    return result;
  }
  function applyHighlight(value, ranges, start, end, color) {
    const text = String(value), current = normalizeHighlights(text, ranges);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end
      || !validBoundary(text, start) || !validBoundary(text, end)
      || (color !== null && !Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, color))) throw new Error("请先选中要高亮的文字。");
    const result = [];
    for (const range of current) {
      if (range.end <= start || range.start >= end) result.push(range);
      else {
        if (range.start < start) result.push({ ...range, end: start });
        if (range.end > end) result.push({ ...range, start: end });
      }
    }
    if (color !== null) result.push({ start, end, color });
    return normalizeHighlights(text, result);
  }
  function rebaseHighlights(oldValue, newValue, ranges = []) {
    const oldText = String(oldValue), newText = String(newValue), current = normalizeHighlights(oldText, ranges);
    if (oldText === newText) return current;
    let prefix = 0;
    while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++;
    while (!validBoundary(oldText, prefix) || !validBoundary(newText, prefix)) prefix--;
    let suffix = 0;
    while (suffix < oldText.length - prefix && suffix < newText.length - prefix
      && oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]) suffix++;
    while (!validBoundary(oldText, oldText.length - suffix) || !validBoundary(newText, newText.length - suffix)) suffix--;
    const oldEnd = oldText.length - suffix, newEnd = newText.length - suffix, delta = newText.length - oldText.length;
    const result = [];
    for (const range of current) {
      if (range.end <= prefix) result.push(range);
      else if (range.start >= oldEnd) result.push({ ...range, start: range.start + delta, end: range.end + delta });
      else {
        if (range.start < prefix) result.push({ ...range, end: prefix });
        if (range.end > oldEnd) result.push({ ...range, start: newEnd, end: range.end + delta });
      }
    }
    return normalizeHighlights(newText, result.filter(range => range.start < range.end));
  }
  function valueHTML(value, ranges = []) {
    const text = String(value), highlights = normalizeHighlights(text, ranges);
    let at = 0, html = "";
    const escaped = value => escapeHTML(value).replace(/\r/g, "&#13;").replace(/\n/g, "<br>");
    for (const range of highlights) {
      html += escaped(text.slice(at, range.start));
      html += `<span data-rg-highlight="${range.color}" style="background-color: ${HIGHLIGHT_COLORS[range.color]};">${escaped(text.slice(range.start, range.end))}</span>`;
      at = range.end;
    }
    return `<p>${html + escaped(text.slice(at))}</p>`;
  }
  function nodeHighlightColor(node) {
    if (node.nodeType !== 1 || !["SPAN", "MARK"].includes(node.tagName)) return null;
    const attribute = node.getAttribute("data-rg-highlight");
    if (Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, attribute)) return attribute;
    const style = node.getAttribute("style") || "";
    const match = style.match(/(?:^|;)\s*background-color\s*:\s*([^;!]+)(?:\s*!important)?(?:;|$)/i);
    let color = match?.[1]?.trim().toLowerCase();
    if (!color && node.tagName === "MARK") color = HIGHLIGHT_COLORS.yellow;
    if (/^#[a-f0-9]{3}$/i.test(color || "")) color = "#" + [...color.slice(1)].map(c => c + c).join("");
    const rgb = color?.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(?:1(?:\.0*)?|100%))?\s*\)$/);
    if (rgb && rgb.slice(1).every(value => Number(value) <= 255)) color = "#" + rgb.slice(1).map(value => Number(value).toString(16).padStart(2, "0")).join("");
    return Object.keys(HIGHLIGHT_COLORS).find(id => HIGHLIGHT_COLORS[id] === color) || null;
  }
  function sectionContent(nodes) {
    const state = { text: "", ranges: [] };
    const visit = node => {
      if (node.nodeType === 3) { state.text += node.textContent; return; }
      if (node.nodeType !== 1) return;
      if (node.tagName === "BR") { state.text += "\n"; return; }
      const color = nodeHighlightColor(node);
      const range = color ? { start: state.text.length, end: 0, color } : null;
      if (range) state.ranges.push(range);
      for (const child of node.childNodes) visit(child);
      if (range) range.end = state.text.length;
      state.text += node.tagName === "P" ? "\n\n" : ["DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE"].includes(node.tagName) ? "\n" : "";
    };
    for (const node of nodes) visit(node);
    const left = state.text.length - state.text.trimStart().length, text = state.text.trim();
    const ranges = state.ranges.map(range => ({ ...range, start: Math.max(0, range.start - left), end: Math.min(text.length, range.end - left) }))
      .filter(range => range.start < range.end && validBoundary(text, range.start) && validBoundary(text, range.end)).slice(0, 2000);
    let highlights = [];
    try { highlights = normalizeHighlights(text, ranges); } catch (_) { /* malformed external markup must not prevent reading plain values */ }
    return { text, highlights };
  }
  function plainNode(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(plainNode).join("");
    return text + (node.tagName === "P" ? "\n\n" : ["DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE"].includes(node.tagName) ? "\n" : "");
  }
  function parseNote(html, Parser = root.DOMParser, fields = FIELDS) {
    const doc = new Parser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
    const container = doc.body.querySelector(":scope > div") || doc.body;
    const values = blankValues(fields);
    const highlights = Object.fromEntries(fields.map(field => [field.id, []]));
    const headings = new Map();
    const allHeadings = [...container.querySelectorAll("h2")];
    const originalLabels = new Map(FIELDS.map(f => [f.label, f.id]));
    const labelIDs = new Map();
    for (const field of fields) {
      for (const label of [field.label, ...(field.aliases || [])]) {
        if (!labelIDs.has(label)) labelIDs.set(label, new Set());
        labelIDs.get(label).add(field.id);
      }
    }
    for (const heading of allHeadings) {
      const label = heading.textContent.trim();
      let id = heading.getAttribute("data-plm-field");
      if (!id) {
        // Old note editors can strip custom attributes. Original built-in labels
        // keep their original identity, even if a project later renames fields.
        id = originalLabels.get(label);
        if (!id) {
          const candidates = labelIDs.get(label);
          if (candidates?.size > 1) throw new Error(`无法唯一识别“${label}”分区，请先核对字段名称。`);
          id = candidates?.values().next().value;
        }
      }
      if (!id) continue;
      if (headings.has(id)) throw new Error(`笔记中存在重复的“${fieldByID(id, fields)?.label || label}”分区，请先在 Zotero 中合并。`);
      headings.set(id, heading);
      const nodes = [];
      for (let n = heading.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === 1 && ["H1", "H2"].includes(n.tagName)) break;
        nodes.push(n);
      }
      const content = sectionContent(nodes);
      // Preserve archived/unknown IDs too, without invoking magic object setters.
      Object.defineProperty(values, id, { value: content.text, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(highlights, id, { value: content.highlights, enumerable: true, writable: true, configurable: true });
    }
    return { doc, container, values, highlights, headings };
  }
  function createNote(projectName, values = {}, fields = FIELDS, highlights = {}) {
    return `<div data-schema-version="9"><h1>研矩 · ${escapeHTML(projectName)}</h1>` +
      fields.filter(f => !f.archived).map(f => `<h2 data-plm-field="${escapeHTML(f.id)}">${escapeHTML(f.label)}</h2>${valueHTML(values[f.id] || "", highlights[f.id] || [])}`).join("") + "</div>";
  }
  function updateNote(html, id, value, Parser = root.DOMParser, fields = FIELDS, ranges) {
    const field = fieldByID(id, fields);
    if (!field || field.archived) throw new Error("未知或已移除的分析字段。");
    const { doc, container, headings, values, highlights } = parseNote(html, Parser, fields);
    const nextHighlights = ranges === undefined ? rebaseHighlights(values[id] || "", String(value), highlights[id] || []) : normalizeHighlights(value, ranges);
    let heading = headings.get(id);
    if (heading) {
      for (let n = heading.nextSibling; n && !(n.nodeType === 1 && ["H1", "H2"].includes(n.tagName));) {
        const next = n.nextSibling;
        n.remove();
        n = next;
      }
    } else {
      heading = doc.createElement("h2");
      container.append(heading);
    }
    heading.textContent = field.label;
    heading.setAttribute("data-plm-field", id);
    const fresh = doc.createElement("div");
    // Only escaped plain text produced by valueHTML enters this inert document.
    fresh.innerHTML = valueHTML(value, nextHighlights);
    heading.after(...fresh.childNodes);
    return doc.body.innerHTML;
  }
  function libraryPath(library) {
    return library.libraryType === "group" ? `groups/${library.groupID}` : "library";
  }
  const itemLink = (library, key) => `zotero://select/${libraryPath(library)}/items/${key}`;
  function pdfLink(library, attachmentKey, annotationKey) {
    if (!attachmentKey) return "";
    return `zotero://open-pdf/${libraryPath(library)}/items/${attachmentKey}` +
      (annotationKey ? `?annotation=${encodeURIComponent(annotationKey)}` : "");
  }
  function filterRows(rows, query = "", state = "all", fields = FIELDS) {
    const active = fields.filter(f => !f.archived);
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const hasAnalysis = active.some(f => (r.values[f.id] || "").trim());
      if (state === "filled" && !hasAnalysis) return false;
      if (state === "empty" && hasAnalysis) return false;
      const text = [r.title, r.authors, r.year, r.citekey, ...(r.tags || []),
        ...active.map(f => r.values[f.id] || ""), ...(r.annotations || []).map(a => `${a.text} ${a.comment}`)].join("\n").toLowerCase();
      return terms.every(t => text.includes(t));
    });
  }
  function csvCell(value) {
    let text = String(value ?? "");
    // Spreadsheet formula injection protection. Quoting alone does not prevent it.
    if (/^[\s\uFEFF]*[=+@-]/u.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function toCSV(rows, projectName, projectKey, fields = FIELDS) {
    const active = fields.filter(f => !f.archived);
    const header = ["项目", "项目标识", "作者", "年份", "标题", "引用键", "标签", ...active.map(f => f.label),
      "批注数量", "项目笔记链接", "文献链接", "原文链接"];
    const data = rows.map(r => [projectName, projectKey, r.authors, r.year, r.title, r.citekey,
      (r.tags || []).join("; "), ...active.map(f => r.values[f.id] || ""),
      r.annotations.length, r.noteURL || "", r.itemURL, r.pdfURL]);
    return "\uFEFF" + [header, ...data].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
  const api = { FIELDS, NOTE_PREFIX, HIGHLIGHT_COLORS, normalizeHighlights, applyHighlight, rebaseHighlights, valueHTML, projectID, noteTag, blankValues, fieldByID, escapeHTML, plainNode,
    parseNote, createNote, updateNote, itemLink, pdfLink, filterRows, toCSV };
  root.PLMCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
