/* ResearchGrid. Native DOM patterns adapted from LitMatrix 1.1.0. AGPL-3.0-or-later. */
"use strict";
const Z = (() => {
  try { return ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero; }
  catch (_) { return window.opener?.Zotero || window.top?.Zotero; }
})();
const C = PLMCore;
const repo = new PLMRepository(Z);
const PREF = "extensions.projectlitmatrix.ui";
const $ = selector => document.querySelector(selector);
const state = { projects: [], project: null, rows: [], shown: [], loading: false,
  generation: 0, selected: new Set(), pendingReload: false, editing: null, saving: false, preferences: { version: 1, projects: {} } };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) el.append(child instanceof Node ? child : String(child));
  return el;
}
function readPrefs() {
  try {
    const saved = JSON.parse(Z.Prefs.get(PREF, true) || "{}");
    if (saved.version === 1 && saved.projects && typeof saved.projects === "object") state.preferences = saved;
  } catch (_) { /* damaged UI preferences should not affect notes */ }
}
function prefs() {
  const saved = state.preferences.projects[state.project?.id] || {};
  let fields = RGFields.defaults();
  if (Array.isArray(saved.fields)) {
    try { fields = RGFields.normalize(saved.fields); } catch (e) { Z.logError(e); }
  } else if (Array.isArray(saved.columns)) {
    fields = fields.map(f => ({ ...f, visible: saved.columns.includes(f.id) }));
  }
  if (!fields.some(f => !f.archived && f.visible)) {
    const first = fields.find(f => !f.archived);
    if (first) first.visible = true;
  }
  return { ...saved, fields, columns: fields.filter(f => !f.archived && f.visible).map(f => f.id),
    display: RGDisplay.normalize(saved.display), recursive: saved.recursive !== false, sort: saved.sort || "title" };
}
function allFields() { return prefs().fields; }
function activeFields() { return allFields().filter(f => !f.archived); }
function savePrefs(patch = {}) {
  if (!state.project) return;
  const next = { ...state.preferences, lastProject: state.project.id,
    projects: { ...state.preferences.projects, [state.project.id]: { ...prefs(), ...patch } } };
  Z.Prefs.set(PREF, JSON.stringify(next), true);
  state.preferences = next;
  state.project.fields = allFields();
}
let fieldManager;
let displayManager;
let aiManager;
let batchManager;
let highlightManager;
let tableManager;
let templateExport;
function showColumns() {
  if (!state.project || state.loading) return;
  if (displayManager?.isOpen() || aiManager?.isOpen() || batchManager?.isOpen() || tableManager?.isOpen() || $("#templateDialog").open) { toast("请先关闭当前显示选项、AI 或表格窗口。"); return; }
  if (!fieldManager) fieldManager = new RGFields.Manager({
    document, getProject: () => state.project, getFields: allFields,
    getTemplates: () => state.preferences.templates || [],
    beforeOpen: () => !state.editing || closeEditor(),
    saveFields: async fields => {
      const normalized = RGFields.normalize(fields);
      savePrefs({ fields: normalized, columns: normalized.filter(f => !f.archived && f.visible).map(f => f.id) });
      await reload();
    },
    saveTemplates: async templates => {
      const next = { ...state.preferences, templates };
      Z.Prefs.set(PREF, JSON.stringify(next), true);
      state.preferences = next;
    },
    notify: toast,
  });
  return fieldManager.open().catch(failure);
}
function metadataColumns() {
  return prefs().display.metadataColumns.map(id => RGDisplay.COLUMNS.find(column => column.id === id));
}
function syncDisplayControls() {
  $("#showTags").checked = prefs().display.showTags;
  for (const id of ["showTags", "displayOptions"]) $("#" + id).disabled = state.loading || !state.project;
  for (const tags of $("#grid tbody").querySelectorAll(".tags")) tags.hidden = !prefs().display.showTags;
}
function toggleTags() {
  try {
    if (!state.project || state.loading || state.saving || displayManager?.isOpen()) return;
    savePrefs({ display: { ...prefs().display, showTags: $("#showTags").checked } });
  } catch (error) { failure(error); }
  finally { syncDisplayControls(); }
}
async function showDisplayOptions() {
  if (!state.project || state.loading || state.saving) return;
  if (fieldManager?.dialog?.open || aiManager?.isOpen() || batchManager?.isOpen() || tableManager?.isOpen() || $("#templateDialog").open) return;
  highlightManager?.clear();
  if (!displayManager) displayManager = new RGDisplay.Manager({
    document, getProject: () => state.project, getDisplay: () => prefs().display,
    beforeOpen: () => !state.editing || closeEditor(),
    save: async display => { savePrefs({ display: RGDisplay.normalize(display) }); render(); },
    notify: toast,
  });
  return displayManager.open();
}
async function generateAI({ config, project, fields, paper, source, signal }) {
  const current = () => RGAI.normalizeConfig(new RGAI.ConfigStore(Z).getConfig());
  const snapshot = RGAI.normalizeConfig(config);
  const connectionSettings = value => {
    const { summaryDetail, ...settings } = value;
    return JSON.stringify(settings);
  };
  // The dialog may override its summary length for this request. Provider,
  // model, source and transport limits must still match the saved settings.
  const unchanged = () => connectionSettings(current()) === connectionSettings(snapshot);
  if (!unchanged()) throw new Error("API 设置已变化，请点击“刷新 API 设置”后再生成。");
  let key;
  try { key = await Z.ProjectLitMatrix.credentials.getKey(RGAI.endpointFor(snapshot.baseURL)); }
  catch (_) { throw new Error("无法读取当前 API 地址的密钥，请到研矩设置检查密钥存储。"); }
  if (!unchanged()) throw new Error("API 设置已变化，请刷新设置后重试。");
  const messages = RGAI.buildMessages({ project, fields, paper, source, summaryDetail: snapshot.summaryDetail });
  const result = await RGAI.request(snapshot, key, messages, { signal, fetchImpl: (...args) => window.fetch(...args) });
  return RGAI.parseResult(result.content, fields);
}
function updateSavedRecord(project, record) {
  const targets = new Set([record.row, ...state.rows.filter(r => r.id === record.row?.id && r.key === record.row?.key)]);
  for (const target of targets) {
    if (!target) continue;
    target.values = record.values;
    target.highlights = record.highlights || {};
    target.noteKey = record.note?.key || null;
    target.noteURL = target.noteKey ? C.itemLink(project.library, target.noteKey) : "";
  }
}
const rowIdentity = row => `${row.libraryID}:${row.key}`;
function selectedRows() { return state.rows.filter(row => state.selected.has(rowIdentity(row))); }
function syncSelection() {
  const rows = selectedRows();
  const shown = new Set(state.shown.map(rowIdentity));
  const hidden = rows.filter(row => !shown.has(rowIdentity(row))).length;
  $("#selectionCount").textContent = `已选 ${rows.length} 篇${hidden ? `（当前筛选外 ${hidden} 篇）` : ""}`;
  $("#batchAI").textContent = `批量 AI 总结（${rows.length}）`;
  $("#batchAI").disabled = state.loading || !rows.length;
  $("#clearSelection").disabled = state.loading || !rows.length;
  $("#selectShown").disabled = state.loading || !state.shown.length;
  $("#selectZotero").disabled = state.loading || !state.project;
  for (const box of $("#grid tbody").querySelectorAll("[data-paper-select]")) {
    box.checked = state.selected.has(box.dataset.paperSelect);
  }
}
function selectShown() {
  if (state.loading) return;
  for (const row of state.shown) state.selected.add(rowIdentity(row));
  syncSelection();
}
function selectFromZotero() {
  if (state.loading || !state.project) return;
  const items = repo.mainWindow?.()?.ZoteroPane?.getSelectedItems?.() || [];
  const ids = new Set(items.map(item => item.id));
  const matched = state.rows.filter(row => ids.has(row.id));
  if (!matched.length) { toast("请先在 Zotero 主窗口选中当前项目的文献。"); return; }
  for (const row of matched) state.selected.add(rowIdentity(row));
  syncSelection(); toast(`已勾选 Zotero 中所选的 ${matched.length} 篇项目文献`);
}
async function showBatchAI() {
  if (!state.project || state.loading || state.saving || !selectedRows().length) return;
  if (displayManager?.isOpen() || aiManager?.isOpen() || fieldManager?.dialog?.open || batchManager?.isOpen() || tableManager?.isOpen() || $("#templateDialog").open) return;
  highlightManager?.clear();
  if (!batchManager) batchManager = new RGAIBatch.Manager({
    document, getProject: () => state.project ? { ...state.project, recursive: prefs().recursive } : null,
    getFields: activeFields, getConfig: () => new RGAI.ConfigStore(Z).getConfig(),
    getSource: (paper, options) => repo.paperSource(paper, options), generate: generateAI,
    beforeOpen: () => !state.editing || closeEditor(),
    openSettings: () => Z.ProjectLitMatrix.openSettings(),
    save: async (project, operations) => {
      state.saving = true;
      try {
        const result = await repo.importRows({ ...project, fields: allFields() }, operations);
        for (const record of result.records) updateSavedRecord(project, record);
        render(); $("#saveStatus").textContent = "批量 AI 草稿已写入选中字段";
        return result;
      } finally { state.saving = false; if (state.pendingReload) scheduleReload(); }
    }, notify: toast,
  });
  return batchManager.open(selectedRows());
}
async function showAI(row) {
  if (!state.project || state.loading || state.saving) return;
  if (displayManager?.isOpen() || fieldManager?.dialog?.open || batchManager?.isOpen() || tableManager?.isOpen()) return;
  if (!aiManager) aiManager = new RGAIDialog.Manager({
    document, getProject: () => state.project, getFields: activeFields,
    beforeOpen: () => !state.editing || closeEditor(),
    getConfig: () => new RGAI.ConfigStore(Z).getConfig(),
    getSource: (paper, options) => repo.paperSource(paper, options),
    openSettings: () => Z.ProjectLitMatrix.openSettings(),
    generate: generateAI,
    save: async (project, row, changes, expected, options = {}) => {
      state.saving = true;
      try {
        const record = await repo.saveFields(project, row, changes, expected, options);
        const targets = new Set([row, ...state.rows.filter(r => r.id === row.id && r.key === row.key)]);
        for (const target of targets) {
          target.values = record.values;
          target.highlights = record.highlights || {};
          target.noteKey = record.note?.key || null;
          target.noteURL = target.noteKey ? C.itemLink(project.library, target.noteKey) : "";
        }
        $("#saveStatus").textContent = "AI 草稿已写入所选项目字段";
        render();
        return record;
      } finally {
        state.saving = false;
        if (state.pendingReload) scheduleReload();
      }
    },
    notify: toast,
  });
  return aiManager.open(row);
}
let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 4500);
}
function failure(error) { Z.logError(error); toast(error.message || String(error)); }
function safe(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(failure); }
function refreshChoices() {
  state.projects = repo.projects();
  $("#project").replaceChildren(h("option", { value: "" }, "请选择 Zotero 分类作为项目"),
    ...state.projects.map(p => h("option", { value: p.id }, p.label)));
  $("#project").value = state.project?.id || "";
}
function setBusy(value) {
  state.loading = value;
  for (const id of ["project", "current", "recursive", "refresh", "columns"]) $("#" + id).disabled = value;
  $("#export").disabled = value || !state.shown.length;
  $("#exportTemplate").disabled = value || !state.shown.length;
  $("#importTable").disabled = value || !state.project || !state.project.library.editable;
  $("#columns").disabled = value || !state.project;
  $("#results").setAttribute("aria-busy", String(value));
  syncDisplayControls();
}
function syncControls() {
  const p = prefs();
  $("#recursive").checked = p.recursive;
  $("#sort").value = p.sort;
  $("#search").value = p.search || "";
  $("#analysisState").value = p.analysisState || "all";
  $("#projectHint").textContent = state.project
    ? `${state.project.label} · 分析与备注只属于此项目${state.project.library.editable ? "" : " · 此文献库为只读"}`
    : "在 Zotero 中选择分类，再点击“使用当前分类”。每个分类的分析与备注独立保存。";
  syncDisplayControls();
}
async function selectProject(target) {
  const project = state.projects.find(p => typeof target === "string" ? p.id === target :
    p.libraryID === Number(target.libraryID) && p.collectionKey === target.collectionKey);
  if (displayManager?.isOpen()) {
    if (project?.id === state.project?.id) return true;
    $("#project").value = state.project?.id || "";
    toast("请先保存或关闭显示选项，再切换项目。");
    return false;
  }
  if (tableManager?.isOpen() || $("#templateDialog").open) {
    if (project?.id === state.project?.id) return true;
    $("#project").value = state.project?.id || "";
    toast("请先关闭表格导入或模板导出窗口，再切换项目。");
    return false;
  }
  if (aiManager?.isOpen() || batchManager?.isOpen()) {
    if (project?.id === state.project?.id) return true;
    $("#project").value = state.project?.id || "";
    toast("请先关闭 AI 总结窗口，再切换项目。");
    return false;
  }
  if (fieldManager?.dialog?.open) {
    if (project?.id === state.project?.id) return true;
    $("#project").value = state.project?.id || "";
    toast("请先保存或关闭项目字段窗口，再切换项目。");
    return false;
  }
  if (state.editing && !closeEditor()) { $("#project").value = state.project?.id || ""; return; }
  if (!project) {
    if (target) throw new Error("找不到这个分类，请刷新项目列表。");
    state.generation++;
    state.project = null;
    state.selected.clear();
    state.rows = [];
    syncControls(); render(); return;
  }
  if (state.project?.id !== project.id) state.selected.clear();
  highlightManager?.clear();
  state.project = project;
  $("#project").value = project.id;
  syncControls();
  savePrefs();
  await reload();
}
async function reload() {
  if (state.editing || state.saving) { state.pendingReload = true; return; }
  const generation = ++state.generation;
  highlightManager?.clear();
  refreshChoices();
  if (state.project) state.project = state.projects.find(p => p.id === state.project.id) || null;
  if (!state.project) {
    state.rows = [];
    setBusy(false); syncControls(); render(); return;
  }
  const project = state.project;
  project.fields = allFields();
  state.pendingReload = false;
  setBusy(true);
  state.rows = [];
  render();
  try {
    const rows = await repo.loadProject(project, prefs().recursive);
    if (generation !== state.generation) return;
    state.rows = rows;
    const live = new Set(rows.map(rowIdentity));
    state.selected = new Set([...state.selected].filter(id => live.has(id)));
    setBusy(false);
    syncControls();
    render();
  } catch (e) {
    if (generation !== state.generation) return;
    Z.logError(e);
    $("#status").textContent = "加载失败";
    $("#grid").hidden = true;
    $("#empty").hidden = false;
    $("#empty").replaceChildren(h("h2", {}, "文献暂时无法加载"), h("p", {}, e.message || String(e)),
      h("button", { onclick: safe(reload) }, "重试"));
  } finally {
    if (generation === state.generation) {
      setBusy(false);
      if (state.pendingReload) scheduleReload();
    }
  }
}
function render() {
  if (state.editing) return;
  highlightManager?.clear();
  const scroll = $("#results").scrollTop;
  const p = prefs();
  state.shown = C.filterRows(state.rows, $("#search").value, $("#analysisState").value, activeFields());
  const compare = (a, b) => {
    if (p.sort === "yearDesc" || p.sort === "yearAsc") {
      const diff = (Number(a.year) || 0) - (Number(b.year) || 0);
      if (diff) return diff * (p.sort === "yearDesc" ? -1 : 1);
    }
    if (p.sort === "author") return a.authors.localeCompare(b.authors, "zh-CN") || a.title.localeCompare(b.title, "zh-CN");
    return a.title.localeCompare(b.title, "zh-CN");
  };
  state.shown.sort(compare);
  $("#status").textContent = state.loading ? "正在读取项目文献、笔记和批注…" : state.project
    ? `${state.shown.length} / ${state.rows.length} 篇文献 · ${state.shown.reduce((n, r) => n + r.annotations.length, 0)} 条批注 · 包含未批注文献`
    : "请选择研究项目";
  $("#export").disabled = state.loading || !state.shown.length;
  $("#exportTemplate").disabled = state.loading || !state.shown.length;
  $("#importTable").disabled = state.loading || !state.project || !state.project.library.editable;
  const fields = p.fields.filter(f => !f.archived && f.visible);
  const metadata = metadataColumns();
  $("#columns").disabled = state.loading || !state.project;
  const widths = [320, ...metadata.map(column => column.width), ...fields.map(f => f.id === "remarks" ? 320 : 290)];
  $("#grid").style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
  $("#grid colgroup").replaceChildren(...widths.map(width => h("col", { style: `width:${width}px` })));
  $("#grid thead").replaceChildren(h("tr", {}, h("th", { scope: "col" }, "文献与原文"),
    ...metadata.map(column => h("th", { scope: "col", class: "metadata-heading", "data-metadata": column.id,
      title: "来自 Zotero 条目，只读；可在 Zotero 中编辑原条目" }, h("div", {}, column.label), h("span", { class: "metadata-source" }, "Zotero 条目信息"))),
    ...fields.map(f => h("th", { scope: "col", title: f.requirement || f.label }, h("div", {}, f.label), f.requirement ? h("div", { class: "field-requirement" }, f.requirement) : null))));
  const fragment = document.createDocumentFragment();
  for (const row of state.shown) {
    const checkbox = h("input", { type: "checkbox", "data-paper-select": rowIdentity(row),
      "aria-label": `选择文献：${row.title}`, onchange: event => {
        if (event.target.checked) state.selected.add(rowIdentity(row)); else state.selected.delete(rowIdentity(row));
        syncSelection();
      } });
    checkbox.checked = state.selected.has(rowIdentity(row));
    const identity = h("td", { class: "identity" },
      h("label", { class: "paper-select" }, checkbox, "选择文献"),
      h("div", { class: "paper-author" }, `${row.authors || "作者未记录"}${row.year ? `（${row.year}）` : ""}`),
      h("button", { class: "paper-title", onclick: safe(() => repo.openPaper(row)), title: row.attachmentID ? "打开原文" : "在 Zotero 中定位文献" }, row.title),
      h("div", { class: "citekey" }, row.citekey),
      h("div", { class: "tags", hidden: !p.display.showTags }, ...row.tags.map(t => h("span", { class: "tag" }, t))),
      h("div", { class: "paper-actions" },
        h("button", { onclick: safe(() => repo.openPaper(row)) }, row.attachmentID ? "打开原文" : "定位文献"),
        h("button", { class: "ai-summary", onclick: safe(() => showAI(row)), title: "按当前项目字段生成 AI 草稿" }, "AI 总结"),
        h("button", { onclick: () => showAnnotations(row), disabled: !row.annotations.length }, `批注 ${row.annotations.length}`),
        h("button", { onclick: safe(() => repo.selectItem(row.id)) }, "Zotero 条目")),
      row.noteError ? h("p", { class: "error" }, row.noteError) : null,
      !row.editable && !row.noteError ? h("p", { class: "hint" }, row.paper.isAttachment() ? "独立附件：创建父条目后可填写分析" : "只读文献库") : null);
    const cells = fields.map(field => {
      const value = row.values[field.id] || "";
      const td = h("td", { class: row.editable ? "analysis-cell" : "", tabindex: row.editable ? "0" : null,
        "data-row": row.id, "data-field": field.id,
        "aria-label": `${row.title} · ${field.label}${row.editable ? "，双击或按回车编辑" : ""}` },
        value ? h("div", { class: "cell-text", "data-row": row.id, "data-field": field.id }, RGHighlights.render(document, value, row.highlights?.[field.id] || [])) : h("span", { class: "placeholder" }, row.editable ? "双击填写…" : "—"));
      if (row.editable) {
        td.append(h("button", { class: "expand-cell", title: "在弹窗中编辑长内容", onclick: safe(async event => {
          event.stopPropagation(); await openEditor(row, field, "modal");
        }) }, "展开编辑"));
        td.addEventListener("dblclick", safe(event => {
          if (event.target.closest("button, textarea, input")) return;
          return openEditor(row, field);
        }));
        td.addEventListener("keydown", event => {
          if (event.target === td && event.key === "Enter") { event.preventDefault(); safe(() => openEditor(row, field))(); }
        });
      }
      return td;
    });
    const metadataCells = metadata.map(column => h("td", { class: "metadata-cell", "data-metadata": column.id, "data-row": row.id,
      "aria-label": `${row.title} · ${column.label}，Zotero 条目信息，只读` },
      h("div", { class: "metadata-text" }, String(row.metadata?.[column.id] ?? "") || "—")));
    fragment.append(h("tr", {}, identity, ...metadataCells, ...cells));
  }
  $("#grid tbody").replaceChildren(fragment);
  $("#grid").hidden = !state.shown.length;
  $("#empty").hidden = state.shown.length > 0;
  $("#empty").replaceChildren(h("h2", {}, state.loading ? "正在整理文献…" : !state.project ? "从一个研究项目开始" : state.rows.length ? "没有符合条件的文献" : "这个分类还没有文献"),
    h("p", {}, !state.project ? "在 Zotero 主窗口选择分类后，点击“使用当前分类”。" : state.rows.length ? "可以清空搜索或切换分析状态。" : "添加文献后点击刷新；子分类可通过上方开关包含。"));
  $("#results").scrollTop = scroll;
  syncDisplayControls();
  syncSelection();
}
function editorValue() {
  return state.editing?.mode === "inline" ? $("#inlineValue").value : $("#editValue").value;
}
function syncEditorText() {
  const edit = state.editing;
  if (!edit) return;
  const value = editorValue();
  if (value !== edit.textSnapshot) {
    edit.highlights = C.rebaseHighlights(edit.textSnapshot, value, edit.highlights);
    edit.textSnapshot = value;
  }
}
function editorDirty() {
  if (!state.editing) return false;
  syncEditorText();
  return editorValue() !== state.editing.original || JSON.stringify(state.editing.highlights) !== JSON.stringify(state.editing.originalHighlights);
}
function autoSizeInline() {
  const input = $("#inlineValue");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(170, Math.max(70, input.scrollHeight || 70))}px`;
}
async function openEditor(row, field, mode = "inline") {
  if (state.saving) return false;
  highlightManager?.clear();
  if (state.editing) {
    if (state.editing.row.id === row.id && state.editing.field.id === field.id) {
      if (mode === "modal") expandEditor();
      return true;
    }
    // Committing the previous cell must succeed before moving to another one.
    if (!(await saveEditor())) return false;
  }
  const original = row.values[field.id] || "";
  const originalHighlights = C.normalizeHighlights(original, row.highlights?.[field.id] || []);
  state.editing = { row, field, project: { ...state.project, fields: allFields() }, original, mode,
    originalHighlights, highlights: originalHighlights.map(range => ({ ...range })), textSnapshot: original };
  if (mode === "modal") {
    prepareDialog(state.editing.original);
  } else {
    const cell = [...$("#grid tbody").querySelectorAll("td[data-field]")]
      .find(td => td.getAttribute("data-row") === String(row.id) && td.getAttribute("data-field") === field.id);
    if (!cell) { state.editing = null; return false; }
    state.editing.cell = cell;
    cell.classList.add("editing-cell");
    const input = h("textarea", { id: "inlineValue", rows: 3, "aria-label": `${field.label} · 直接填写`,
      placeholder: field.requirement || "直接填写，Shift+Enter 换行", oninput: () => { syncEditorText(); autoSizeInline(); },
      onkeydown: event => {
        if (event.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); closeEditor(); }
        else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); safe(saveEditor)(); }
        else if (event.key === "Tab") { event.preventDefault(); safe(() => saveAndMove(event.shiftKey ? -1 : 1))(); }
      } });
    input.value = state.editing.original;
    cell.replaceChildren(...[input,
      field.requirement ? h("p", { class: "inline-requirement" }, field.requirement) : null,
      h("div", { class: "inline-actions" },
        h("button", { id: "inlineSave", class: "primary", onclick: safe(saveEditor) }, "保存"),
        h("button", { id: "inlineExpand", onclick: expandEditor }, "展开编辑"),
        h("button", { id: "inlineCancel", onclick: () => closeEditor() }, "取消")),
      h("p", { class: "inline-help" }, "Enter 保存 · Shift+Enter 换行 · Tab 下一格"),
      h("p", { id: "inlineError", class: "error", role: "alert" })].filter(Boolean));
    // Events on the inline controls must not open another editor on the parent cell.
    for (const event of ["click", "dblclick", "keydown"]) cell.addEventListener(event, e => e.stopPropagation());
    autoSizeInline(); input.focus();
  }
  return true;
}
function prepareDialog(value) {
  const { row, field, project } = state.editing;
  $("#editHeading").textContent = field.label;
  $("#editContext").textContent = `${project.name} · ${row.title}`;
  $("#editRequirement").textContent = field.requirement || "";
  $("#editRequirement").hidden = !field.requirement;
  $("#editValue").value = value;
  $("#editValue").placeholder = field.requirement || "填写你的分析，支持多行文本…";
  $("#editError").textContent = "";
  $("#editDialog").showModal(); $("#editValue").focus();
}
function expandEditor() {
  if (!state.editing || state.saving || state.editing.mode === "modal") return;
  syncEditorText();
  const value = editorValue();
  state.editing.mode = "modal";
  state.editing.cell.replaceChildren(h("div", { class: "cell-text" }, value), h("span", { class: "placeholder" }, "正在弹窗中编辑…"));
  prepareDialog(value);
}
function collapseEditor() {
  if (!state.editing || state.saving) return;
  syncEditorText();
  const previous = state.editing;
  const { row, field, original } = previous;
  const value = editorValue();
  // Keep the existing row in place: pending search/filter changes must not hide
  // it between collapsing the modal and mounting the inline draft.
  state.editing = null; $("#editDialog").close();
  return openEditor(row, field).then(opened => {
    if (!opened || !state.editing) {
      state.editing = { ...previous, mode: "modal" };
      prepareDialog(value);
      return;
    }
    state.editing.original = original;
    state.editing.originalHighlights = previous.originalHighlights;
    state.editing.highlights = previous.highlights;
    state.editing.textSnapshot = value;
    $("#inlineValue").value = value; autoSizeInline();
  }).catch(failure);
}
function closeEditor(force = false) {
  if (state.saving) return false;
  if (!force && state.editing && editorDirty() && !window.confirm("放弃尚未保存的分析内容？")) return false;
  state.editing = null;
  $("#editDialog").close(); render();
  if (state.pendingReload) scheduleReload();
  return true;
}
async function saveAndMove(direction) {
  const cells = [...$("#grid tbody").querySelectorAll("td.analysis-cell")];
  const old = state.editing;
  const at = cells.findIndex(td => td.getAttribute("data-row") === String(old.row.id) && td.getAttribute("data-field") === old.field.id);
  const next = cells[at + direction];
  const target = next ? { rowID: next.getAttribute("data-row"), fieldID: next.getAttribute("data-field") } : null;
  if (!(await saveEditor()) || !target) return;
  const row = state.shown.find(r => String(r.id) === target.rowID);
  const field = activeFields().find(f => f.id === target.fieldID);
  if (row && field) await openEditor(row, field);
}
async function saveEditor(event) {
  event?.preventDefault(); event?.stopPropagation?.();
  if (!state.editing || state.saving) return false;
  syncEditorText();
  const { row, field, project, original, mode, highlights, originalHighlights } = state.editing;
  const value = editorValue();
  state.saving = true;
  const controls = mode === "inline" ? ["inlineSave", "inlineCancel", "inlineExpand", "inlineValue"] : ["editSave", "editCancel", "editClose", "editCollapse", "editValue"];
  for (const id of controls) $("#" + id).disabled = true;
  const error = mode === "inline" ? $("#inlineError") : $("#editError");
  error.textContent = "";
  let successful = false;
  try {
    const saved = await repo.saveField(project, row, field.id, value, original,
      { highlights, expectedHighlights: originalHighlights });
    row.values = saved.values;
    row.highlights = saved.highlights || {};
    row.noteKey = saved.note?.key || null;
    row.noteURL = row.noteKey ? C.itemLink(project.library, row.noteKey) : "";
    $("#saveStatus").textContent = "已保存到项目子笔记";
    successful = true;
  } catch (e) { Z.logError(e); error.textContent = e.message || String(e); }
  finally {
    state.saving = false;
    for (const id of controls) $("#" + id).disabled = false;
  }
  if (successful) { closeEditor(true); toast(`已保存“${field.label}”`); }
  return successful;
}
function showAnnotations(row) {
  $("#annotationTitle").textContent = row.title;
  $("#annotationsList").replaceChildren(...row.annotations.map(annotation =>
    h("article", { class: "annotation", style: `--annotation-color:${/^#[0-9a-f]{6}$/i.test(annotation.color) ? annotation.color : "#999999"}` },
      h("p", {}, annotation.text || "图片、绘图或无文本批注"),
      annotation.comment ? h("p", { class: "comment" }, annotation.comment) : null,
      h("button", { onclick: safe(() => repo.openAnnotation(annotation)) }, `打开原文 · 第 ${annotation.page || "?"} 页`))));
  $("#annotationsDialog").showModal();
}
function showTemplateExport() {
  if (!state.project || state.loading || !state.shown.length || state.saving) return;
  if (displayManager?.isOpen() || aiManager?.isOpen() || batchManager?.isOpen() || tableManager?.isOpen() || fieldManager?.dialog?.open) return;
  if (state.editing && !closeEditor()) return;
  templateExport = { project: { ...state.project }, fields: activeFields(), rows: [...state.shown] };
  $("#templateContext").textContent = `${state.project.name} · 当前筛选的 ${state.shown.length} 篇文献 · ${activeFields().length} 个字段`;
  $("#templateInstructions").value = "请依据我提供的论文原文或 PDF，填写表格中的项目分析字段。\n"
    + "1. 保留表头、字段 ID、项目标识、文献标识、文献Key和文献链接，保持每篇论文一行，不新增或合并文献。\n"
    + "2. 第一条“填写要求”记录说明每个字段应填写什么，不是一篇论文。只填写“文献”行的分析字段。\n"
    + "3. 根据每列的填写要求，用中文提取原文明确报告的客观事实，保留研究条件与关键数据；不添加个人解读或泛泛评价。原文未提及的内容只写“未提及”，不要仅凭标题编造。\n"
    + "4. 保留逗号、引号和换行的正确 CSV/TSV 转义。返回完整的 UTF-8 CSV 或 TSV 文件，不要转为图片。\n"
    + "5. 不想导入的分析格子请留空。导入默认忽略空白，并保留 Zotero 中已有的内容。";
  $("#templateError").textContent = "";
  $("#templateDialog").showModal();
}
async function saveTemplateFile() {
  if (!templateExport || $("#templateSave").disabled) return;
  const snapshot = templateExport;
  const format = $("#templateFormat").value === "tsv" ? "tsv" : "csv";
  $("#templateSave").disabled = true;
  $("#templateError").textContent = "";
  try {
    const content = RGTable.exportTemplate(snapshot.rows, snapshot.project, snapshot.fields, { delimiter: format === "tsv" ? "\t" : "," });
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const fp = new FilePicker();
    fp.init(window, "导出待填模板", fp.modeSave);
    fp.defaultString = `${snapshot.project.name.replace(/[\\/:*?"<>|]/g, "_")}-待填模板.${format}`;
    fp.defaultExtension = format;
    fp.appendFilter(format === "tsv" ? "TSV 表格" : "CSV 表格", `*.${format}`);
    const result = await fp.show();
    if (result !== fp.returnOK && result !== fp.returnReplace) return;
    await Z.File.putContentsAsync(fp.file, content);
    $("#templateDialog").close(); templateExport = null;
    toast(`已导出 ${snapshot.rows.length} 篇文献的待填模板`);
  } catch (error) { $("#templateError").textContent = error.message || String(error); }
  finally { $("#templateSave").disabled = false; }
}
async function readImportFile() {
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
  const fp = new FilePicker();
  fp.init(window, "选择已填写的 CSV / TSV 表格", fp.modeOpen);
  fp.appendFilter("CSV / TSV 表格", "*.csv; *.tsv; *.txt");
  if (await fp.show() !== fp.returnOK) return null;
  const file = Z.File.pathToFile(fp.file);
  const limit = 10 * 1024 * 1024;
  if (file.fileSize > limit) throw new Error("导入文件超过 10 MB，请拆分后重试。");
  const prefix = await Z.File.getBinaryContentsAsync(fp.file, 3);
  const charset = prefix.startsWith("\xff\xfe") ? "utf-16le" : prefix.startsWith("\xfe\xff") ? "utf-16be" : "utf-8";
  const text = await Z.File.getContentsAsync(fp.file, charset, limit + 4);
  if (file.fileSize > limit) throw new Error("导入文件超过 10 MB，请拆分后重试。");
  if (text.includes("\ufffd") || text.includes("\u0000")) throw new Error("文件编码无法可靠识别，请在 Excel/WPS 中另存为 UTF-8 CSV 或 Unicode TSV。");
  return { name: file.leafName, text };
}
async function showTableImport() {
  if (!state.project || state.loading || state.saving || !state.project.library.editable) return;
  if (displayManager?.isOpen() || aiManager?.isOpen() || batchManager?.isOpen() || fieldManager?.dialog?.open) return;
  if (!tableManager) tableManager = new RGTableDialog.Manager({
    document, getProject: () => state.project ? { ...state.project, recursive: prefs().recursive } : null, getFields: activeFields, getRows: () => state.rows,
    beforeOpen: () => !state.editing || closeEditor(), readFile: readImportFile,
    save: async (project, operations) => {
      state.saving = true;
      try {
        const result = await repo.importRows({ ...project, fields: allFields() }, operations);
        for (const record of result.records) {
          const targets = new Set([record.row, ...state.rows.filter(r => r.id === record.row.id && r.key === record.row.key)]);
          for (const row of targets) {
            row.values = record.values;
            row.highlights = record.highlights || {};
            row.noteKey = record.note?.key || null;
            row.noteURL = row.noteKey ? C.itemLink(project.library, row.noteKey) : "";
          }
        }
        render();
        $("#saveStatus").textContent = "已导入所选表格内容";
        return result;
      } finally {
        state.saving = false;
        if (state.pendingReload) scheduleReload();
      }
    },
    notify: toast,
  });
  return tableManager.open();
}
async function exportCSV() {
  if (!state.project || !state.shown.length) return;
  const project = state.project;
  const csv = C.toCSV(state.shown, project.name, project.id, activeFields(), metadataColumns());
  const count = state.shown.length;
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
  const fp = new FilePicker();
  fp.init(window, "导出研矩", fp.modeSave);
  fp.defaultString = `${project.name.replace(/[\\/:*?"<>|]/g, "_")}-文献矩阵.csv`;
  fp.defaultExtension = "csv";
  fp.appendFilter("CSV 文献矩阵", "*.csv");
  const result = await fp.show();
  if (result !== fp.returnOK && result !== fp.returnReplace) return;
  await Z.File.putContentsAsync(fp.file, csv);
  toast(`已导出 ${count} 篇文献（包含当前项目全部字段）`);
}
let reloadTimer;
function scheduleReload() {
  state.pendingReload = true;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (state.loading || state.editing || state.saving) return;
    safe(reload)();
  }, 650);
}
async function init() {
  if (!Z) throw new Error("无法连接 Zotero，请从 Zotero 工具菜单打开插件。");
  readPrefs(); refreshChoices();
  highlightManager = new RGHighlights.Manager({
    document, getProject: () => state.project, getFields: activeFields, getRows: () => state.rows,
    beforeSave: () => !state.editing && !state.saving && !state.loading && !displayManager?.isOpen() && !aiManager?.isOpen() && !batchManager?.isOpen() && !tableManager?.isOpen() && !fieldManager?.dialog?.open && !$("#templateDialog").open,
    save: async (project, row, fieldID, value, expected, options) => {
      if (state.saving || state.editing) throw new Error("请先保存或关闭正在编辑的内容。");
      state.saving = true;
      try {
        const record = await repo.saveField({ ...project, fields: allFields() }, row, fieldID, value, expected, options);
        updateSavedRecord(project, { ...record, row });
        render(); $("#saveStatus").textContent = "文字高亮已保存到项目笔记";
        return record;
      } finally { state.saving = false; if (state.pendingReload) scheduleReload(); }
    }, notify: toast,
  });
  $("#selectShown").addEventListener("click", selectShown);
  $("#clearSelection").addEventListener("click", () => { state.selected.clear(); syncSelection(); });
  $("#selectZotero").addEventListener("click", selectFromZotero);
  $("#batchAI").addEventListener("click", safe(showBatchAI));
  $("#project").addEventListener("change", safe(() => selectProject($("#project").value)));
  $("#current").addEventListener("click", safe(async () => {
    refreshChoices();
    const project = repo.currentProject();
    if (!project) throw new Error("请先在 Zotero 主窗口选择一个分类，再点击“使用当前分类”。");
    await selectProject(project.id);
  }));
  $("#recursive").addEventListener("change", safe(async () => { savePrefs({ recursive: $("#recursive").checked }); await reload(); }));
  $("#refresh").addEventListener("click", safe(reload));
  $("#export").addEventListener("click", safe(exportCSV));
  $("#exportTemplate").addEventListener("click", showTemplateExport);
  $("#templateSave").addEventListener("click", safe(saveTemplateFile));
  for (const id of ["templateClose", "templateCancel"]) $("#" + id).addEventListener("click", () => { $("#templateDialog").close(); templateExport = null; });
  $("#templateDialog").addEventListener("cancel", () => { templateExport = null; });
  $("#importTable").addEventListener("click", safe(showTableImport));
  $("#columns").addEventListener("click", showColumns);
  $("#displayOptions").addEventListener("click", safe(showDisplayOptions));
  $("#showTags").addEventListener("change", toggleTags);
  $("#annotationsClose").addEventListener("click", () => $("#annotationsDialog").close());
  let searchTimer;
  $("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { savePrefs({ search: $("#search").value }); render(); }, 150); });
  $("#analysisState").addEventListener("change", () => { savePrefs({ analysisState: $("#analysisState").value }); render(); });
  $("#sort").addEventListener("change", () => { savePrefs({ sort: $("#sort").value }); render(); });
  $("#editCollapse").addEventListener("click", collapseEditor);
  $("#editForm").addEventListener("submit", event => { event.preventDefault(); safe(saveEditor)(); });
  for (const id of ["editCancel", "editClose"]) $("#" + id).addEventListener("click", () => closeEditor());
  $("#editDialog").addEventListener("cancel", event => { event.preventDefault(); closeEditor(); });
  $("#editValue").addEventListener("input", syncEditorText);
  $("#editValue").addEventListener("keydown", event => {
    if (!event.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); safe(saveEditor)(); }
  });
  window.addEventListener("beforeunload", event => {
    if (state.saving || (state.editing && editorDirty()) ||
      (displayManager?.isOpen() && (displayManager.busy || displayManager.dirty())) ||
      (fieldManager?.dialog?.open && (fieldManager.busy || fieldManager.dirty())) ||
      (aiManager?.isOpen() && (aiManager.busy || aiManager.dirty())) ||
      (batchManager?.isOpen() && (batchManager.busy || batchManager.dirty())) ||
      (tableManager?.isOpen() && (tableManager.busy || tableManager.dirty()))) { event.preventDefault(); event.returnValue = ""; }
  });
  const observerID = Z.Notifier.registerObserver({ notify: () => scheduleReload() },
    ["item", "item-tag", "collection", "collection-item"], "projectlitmatrix");
  window.addEventListener("unload", () => { aiManager?.cancel(); batchManager?.cancel(); highlightManager?.dispose(); Z.Notifier.unregisterObserver(observerID); clearTimeout(reloadTimer); clearTimeout(toastTimer); clearTimeout(searchTimer); });
  window.ProjectLitMatrixUI = { selectProject, reload, showFields: showColumns };
  const query = new URLSearchParams(location.search);
  const requested = window.__plmRequestedProject || (query.get("collection") ? { libraryID: query.get("library"), collectionKey: query.get("collection") } : null);
  const initial = requested || repo.currentProject()?.id || state.preferences.lastProject;
  if (initial) {
    const exists = state.projects.some(p => typeof initial === "string" ? p.id === initial : p.libraryID === Number(initial.libraryID) && p.collectionKey === initial.collectionKey);
    if (exists) await selectProject(initial); else render();
  } else render();
  if (window.__plmOpenFields) showColumns();
}
init().catch(error => { $("#status").textContent = error.message || String(error); if (Z) Z.logError(error); });
