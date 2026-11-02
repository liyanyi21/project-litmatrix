/* Project LitMatrix. Native DOM patterns adapted from LitMatrix 1.1.0. AGPL-3.0-or-later. */
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
  generation: 0, pendingReload: false, editing: null, saving: false, preferences: { version: 1, projects: {} } };

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
  const key = state.project?.id;
  if (!key) return { columns: C.FIELDS.filter(f => f.visible).map(f => f.id), recursive: true, sort: "title" };
  const saved = state.preferences.projects[key] || {};
  const columns = Array.isArray(saved.columns) ? saved.columns.filter(id => C.fieldByID(id)) : C.FIELDS.filter(f => f.visible).map(f => f.id);
  return { ...saved, columns, recursive: saved.recursive !== false, sort: saved.sort || "title" };
}
function savePrefs(patch = {}) {
  if (!state.project) return;
  state.preferences.projects[state.project.id] = { ...prefs(), ...patch };
  state.preferences.lastProject = state.project.id;
  Z.Prefs.set(PREF, JSON.stringify(state.preferences), true);
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
  for (const id of ["project", "current", "recursive", "refresh"]) $("#" + id).disabled = value;
  $("#export").disabled = value || !state.shown.length;
  $("#results").setAttribute("aria-busy", String(value));
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
}
async function selectProject(target) {
  const project = state.projects.find(p => typeof target === "string" ? p.id === target :
    p.libraryID === Number(target.libraryID) && p.collectionKey === target.collectionKey);
  if (state.editing && !closeEditor()) { $("#project").value = state.project?.id || ""; return; }
  if (!project) {
    if (target) throw new Error("找不到这个分类，请刷新项目列表。");
    state.generation++;
    state.project = null;
    state.rows = [];
    syncControls(); render(); return;
  }
  state.project = project;
  $("#project").value = project.id;
  syncControls();
  savePrefs();
  await reload();
}
async function reload() {
  if (state.editing || state.saving) { state.pendingReload = true; return; }
  const generation = ++state.generation;
  refreshChoices();
  if (state.project) state.project = state.projects.find(p => p.id === state.project.id) || null;
  if (!state.project) {
    state.rows = [];
    setBusy(false); syncControls(); render(); return;
  }
  const project = state.project;
  state.pendingReload = false;
  setBusy(true);
  state.rows = [];
  render();
  try {
    const rows = await repo.loadProject(project, prefs().recursive);
    if (generation !== state.generation) return;
    state.rows = rows;
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
  const scroll = $("#results").scrollTop;
  const p = prefs();
  state.shown = C.filterRows(state.rows, $("#search").value, $("#analysisState").value);
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
  const fields = p.columns.map(C.fieldByID).filter(Boolean);
  const widths = [320, ...fields.map(f => f.id === "remarks" ? 320 : 290)];
  $("#grid").style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
  $("#grid colgroup").replaceChildren(...widths.map(width => h("col", { style: `width:${width}px` })));
  $("#grid thead").replaceChildren(h("tr", {}, h("th", { scope: "col" }, "文献与原文"),
    ...fields.map(f => h("th", { scope: "col" }, f.label))));
  const fragment = document.createDocumentFragment();
  for (const row of state.shown) {
    const identity = h("td", { class: "identity" },
      h("div", { class: "paper-author" }, `${row.authors || "作者未记录"}${row.year ? `（${row.year}）` : ""}`),
      h("button", { class: "paper-title", onclick: safe(() => repo.openPaper(row)), title: row.attachmentID ? "打开原文" : "在 Zotero 中定位文献" }, row.title),
      h("div", { class: "citekey" }, row.citekey),
      h("div", { class: "tags" }, ...row.tags.map(t => h("span", { class: "tag" }, t))),
      h("div", { class: "paper-actions" },
        h("button", { onclick: safe(() => repo.openPaper(row)) }, row.attachmentID ? "打开原文" : "定位文献"),
        h("button", { onclick: () => showAnnotations(row), disabled: !row.annotations.length }, `批注 ${row.annotations.length}`),
        h("button", { onclick: safe(() => repo.selectItem(row.id)) }, "Zotero 条目")),
      row.noteError ? h("p", { class: "error" }, row.noteError) : null,
      !row.editable && !row.noteError ? h("p", { class: "hint" }, row.paper.isAttachment() ? "独立附件：创建父条目后可填写分析" : "只读文献库") : null);
    const cells = fields.map(field => {
      const td = h("td", { class: row.editable ? "analysis-cell" : "", tabindex: row.editable ? "0" : null,
        "aria-label": `${row.title} · ${field.label}${row.editable ? "，按回车编辑" : ""}` },
        row.values[field.id] ? h("div", { class: "cell-text" }, row.values[field.id]) : h("span", { class: "placeholder" }, row.editable ? "点击填写…" : "—"));
      if (row.editable) {
        td.addEventListener("click", () => openEditor(row, field));
        td.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); openEditor(row, field); } });
      }
      return td;
    });
    fragment.append(h("tr", {}, identity, ...cells));
  }
  $("#grid tbody").replaceChildren(fragment);
  $("#grid").hidden = !state.shown.length;
  $("#empty").hidden = state.shown.length > 0;
  $("#empty").replaceChildren(h("h2", {}, state.loading ? "正在整理文献…" : !state.project ? "从一个研究项目开始" : state.rows.length ? "没有符合条件的文献" : "这个分类还没有文献"),
    h("p", {}, !state.project ? "在 Zotero 主窗口选择分类后，点击“使用当前分类”。" : state.rows.length ? "可以清空搜索或切换分析状态。" : "添加文献后点击刷新；子分类可通过上方开关包含。"));
  $("#results").scrollTop = scroll;
}
function openEditor(row, field) {
  state.editing = { row, field, project: state.project, original: row.values[field.id] || "" };
  $("#editHeading").textContent = field.label;
  $("#editContext").textContent = `${state.project.name} · ${row.title}`;
  $("#editValue").value = state.editing.original;
  $("#editError").textContent = "";
  $("#editDialog").showModal();
  $("#editValue").focus();
}
function closeEditor(force = false) {
  if (state.saving) return false;
  if (!force && state.editing && $("#editValue").value !== state.editing.original && !window.confirm("放弃尚未保存的分析内容？")) return false;
  state.editing = null;
  $("#editDialog").close();
  if (state.pendingReload) scheduleReload();
  return true;
}
async function saveEditor(event) {
  event?.preventDefault();
  if (!state.editing || state.saving) return;
  const { row, field, project, original } = state.editing;
  state.saving = true;
  $("#editSave").disabled = true;
  $("#editCancel").disabled = true;
  $("#editClose").disabled = true;
  $("#editValue").disabled = true;
  $("#editError").textContent = "";
  let successful = false;
  try {
    const saved = await repo.saveField(project, row, field.id, $("#editValue").value, original);
    row.values = saved.values;
    row.noteKey = saved.note?.key || null;
    row.noteURL = row.noteKey ? C.itemLink(project.library, row.noteKey) : "";
    $("#saveStatus").textContent = "已保存到项目子笔记";
    successful = true;
  } catch (e) {
    Z.logError(e);
    $("#editError").textContent = e.message || String(e);
  } finally {
    state.saving = false;
    for (const id of ["editSave", "editCancel", "editClose", "editValue"]) $("#" + id).disabled = false;
  }
  if (successful) { closeEditor(true); render(); toast(`已保存“${field.label}”`); }
}
function showColumns() {
  $("#fieldChoices").replaceChildren(...C.FIELDS.map(field => h("label", {},
    h("input", { type: "checkbox", checked: prefs().columns.includes(field.id), onchange: event => {
      const ids = new Set(prefs().columns);
      if (event.target.checked) ids.add(field.id); else ids.delete(field.id);
      savePrefs({ columns: C.FIELDS.filter(f => ids.has(f.id)).map(f => f.id) });
      render();
    } }), field.label)));
  $("#columnsDialog").showModal();
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
async function exportCSV() {
  if (!state.project || !state.shown.length) return;
  const project = state.project;
  const csv = C.toCSV(state.shown, project.name, project.id);
  const count = state.shown.length;
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
  const fp = new FilePicker();
  fp.init(window, "导出项目文献矩阵", fp.modeSave);
  fp.defaultString = `${project.name.replace(/[\\/:*?"<>|]/g, "_")}-文献矩阵.csv`;
  fp.defaultExtension = "csv";
  fp.appendFilter("CSV 文献矩阵", "*.csv");
  const result = await fp.show();
  if (result !== fp.returnOK && result !== fp.returnReplace) return;
  await Z.File.putContentsAsync(fp.file, csv);
  toast(`已导出 ${count} 篇文献（包含全部中文分析字段）`);
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
  $("#columns").addEventListener("click", showColumns);
  $("#columnsClose").addEventListener("click", () => $("#columnsDialog").close());
  $("#annotationsClose").addEventListener("click", () => $("#annotationsDialog").close());
  let searchTimer;
  $("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { savePrefs({ search: $("#search").value }); render(); }, 150); });
  $("#analysisState").addEventListener("change", () => { savePrefs({ analysisState: $("#analysisState").value }); render(); });
  $("#sort").addEventListener("change", () => { savePrefs({ sort: $("#sort").value }); render(); });
  $("#editForm").addEventListener("submit", safe(saveEditor));
  for (const id of ["editCancel", "editClose"]) $("#" + id).addEventListener("click", () => closeEditor());
  $("#editDialog").addEventListener("cancel", event => { event.preventDefault(); closeEditor(); });
  $("#editValue").addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); safe(saveEditor)(); }
  });
  window.addEventListener("beforeunload", event => {
    if (state.saving || (state.editing && $("#editValue").value !== state.editing.original)) { event.preventDefault(); event.returnValue = ""; }
  });
  const observerID = Z.Notifier.registerObserver({ notify: () => scheduleReload() },
    ["item", "item-tag", "collection", "collection-item"], "projectlitmatrix");
  window.addEventListener("unload", () => { Z.Notifier.unregisterObserver(observerID); clearTimeout(reloadTimer); clearTimeout(toastTimer); clearTimeout(searchTimer); });
  window.ProjectLitMatrixUI = { selectProject, reload };
  const query = new URLSearchParams(location.search);
  const requested = window.__plmRequestedProject || (query.get("collection") ? { libraryID: query.get("library"), collectionKey: query.get("collection") } : null);
  const initial = requested || repo.currentProject()?.id || state.preferences.lastProject;
  if (initial) {
    const exists = state.projects.some(p => typeof initial === "string" ? p.id === initial : p.libraryID === Number(initial.libraryID) && p.collectionKey === initial.collectionKey);
    if (exists) await selectProject(initial); else render();
  } else render();
}
init().catch(error => { $("#status").textContent = error.message || String(error); if (Z) Z.logError(error); });
