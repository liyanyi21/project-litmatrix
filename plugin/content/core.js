/* Project LitMatrix, 2026-11-02. AGPL-3.0-or-later. */
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
  const blankValues = () => Object.fromEntries(FIELDS.map(f => [f.id, ""]));
  const fieldByID = (id) => FIELDS.find(f => f.id === id);
  const escapeHTML = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const valueHTML = (s) => String(s).split(/\n\s*\n/).map(p => `<p>${escapeHTML(p).replace(/\n/g, "<br>")}</p>`).join("");
  function plainNode(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(plainNode).join("");
    return text + (node.tagName === "P" ? "\n\n" : ["DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE"].includes(node.tagName) ? "\n" : "");
  }
  function parseNote(html, Parser = root.DOMParser) {
    const doc = new Parser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
    const container = doc.body.querySelector(":scope > div") || doc.body;
    const values = blankValues();
    const headings = new Map();
    const allHeadings = [...container.querySelectorAll("h2")];
    for (const field of FIELDS) {
      const found = allHeadings.filter(h => h.getAttribute("data-plm-field") === field.id ||
        (!h.getAttribute("data-plm-field") && h.textContent.trim() === field.label));
      if (found.length > 1) throw new Error(`笔记中存在重复的“${field.label}”分区，请先在 Zotero 中合并。`);
      if (!found.length) continue;
      const heading = found[0];
      headings.set(field.id, heading);
      let text = "";
      for (let n = heading.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === 1 && ["H1", "H2"].includes(n.tagName)) break;
        text += plainNode(n);
      }
      values[field.id] = text.trim();
    }
    return { doc, container, values, headings };
  }
  function createNote(projectName, values = {}) {
    return `<div data-schema-version="9"><h1>项目文献矩阵 · ${escapeHTML(projectName)}</h1>` +
      FIELDS.map(f => `<h2 data-plm-field="${f.id}">${f.label}</h2>${valueHTML(values[f.id] || "")}`).join("") + "</div>";
  }
  function updateNote(html, id, value, Parser = root.DOMParser) {
    const field = fieldByID(id);
    if (!field) throw new Error("未知的分析字段。");
    const { doc, container, headings } = parseNote(html, Parser);
    let heading = headings.get(id);
    if (heading) {
      for (let n = heading.nextSibling; n && !(n.nodeType === 1 && ["H1", "H2"].includes(n.tagName));) {
        const next = n.nextSibling;
        n.remove();
        n = next;
      }
    } else {
      heading = doc.createElement("h2");
      heading.textContent = field.label;
      container.append(heading);
    }
    heading.setAttribute("data-plm-field", id);
    const fresh = doc.createElement("div");
    // Only escaped plain text produced by valueHTML enters this inert document.
    fresh.innerHTML = valueHTML(value);
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
  function filterRows(rows, query = "", state = "all") {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const hasAnalysis = FIELDS.some(f => (r.values[f.id] || "").trim());
      if (state === "filled" && !hasAnalysis) return false;
      if (state === "empty" && hasAnalysis) return false;
      const text = [r.title, r.authors, r.year, r.citekey, ...(r.tags || []),
        ...Object.values(r.values), ...(r.annotations || []).map(a => `${a.text} ${a.comment}`)].join("\n").toLowerCase();
      return terms.every(t => text.includes(t));
    });
  }
  function csvCell(value) {
    let text = String(value ?? "");
    // Spreadsheet formula injection protection. Quoting alone does not prevent it.
    if (/^[\s\uFEFF]*[=+@-]/u.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function toCSV(rows, projectName, projectKey) {
    const header = ["项目", "项目标识", "作者", "年份", "标题", "引用键", "标签", ...FIELDS.map(f => f.label),
      "批注数量", "项目笔记链接", "文献链接", "原文链接"];
    const data = rows.map(r => [projectName, projectKey, r.authors, r.year, r.title, r.citekey,
      (r.tags || []).join("; "), ...FIELDS.map(f => r.values[f.id] || ""),
      r.annotations.length, r.noteURL || "", r.itemURL, r.pdfURL]);
    return "\uFEFF" + [header, ...data].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
  const api = { FIELDS, NOTE_PREFIX, projectID, noteTag, blankValues, fieldByID, escapeHTML, plainNode,
    parseNote, createNote, updateNote, itemLink, pdfLink, filterRows, toCSV };
  root.PLMCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
