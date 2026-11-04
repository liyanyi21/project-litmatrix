const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const C = require('../plugin/content/core.js');
const Table = require('../plugin/content/table-io.js');

const PROJECT_A = 'user:collection:PROJECTA';
const PROJECT_B = 'user:collection:PROJECTB';
const multiProjectPrefs = () => ({ version: 1, projects: {
  [PROJECT_A]: { fields: [
    { id: 'findings', label: '甲项目结论', requirement: '只记录甲项目所需结果。', visible: true, archived: false },
    { id: 'remarks', label: '甲项目备注', requirement: '甲项目个人备注。', visible: true, archived: false },
  ], display: { showTags: true, metadataColumns: ['year'] } },
  [PROJECT_B]: { fields: [
    { id: 'methods_sample', label: '乙项目方法', requirement: '只记录乙项目所需研究方法。', visible: true, archived: false },
    { id: 'remarks', label: '乙项目备注', requirement: '乙项目个人备注。', visible: true, archived: false },
  ], display: { showTags: true, metadataColumns: ['DOI'] } },
} });
const projectGroup = (f, id) => f.document.querySelector(`[data-project-group="${id}"]`);
const projectCell = (f, id, field) => projectGroup(f, id)?.querySelector(`td[data-field="${field}"]`);
const displayedProjects = f => [...f.document.querySelectorAll('[data-project-group]')].map(group => group.dataset.projectGroup);
const selectBothProjects = f => f.run(`selectProjects(['${PROJECT_A}', '${PROJECT_B}'], { fromPicker: true })`);
const clone = value => JSON.parse(JSON.stringify(value));
const settle = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

async function ui({ fail = false, saved = { version: 1, projects: {} },
  aiSaved = { baseURL: 'https://api.example.test/v1', model: 'fixture-model', maxChars: 60000, timeoutSeconds: 30, maxTokens: 0 } } = {}) {
  const { window, document } = parseHTML(fs.readFileSync('plugin/content/matrix.html', 'utf8'));
  // LinkeDOM has no native select value setter or dialog API. Cover both the
  // static editor and dialogs/selects later created by the field manager.
  const prepare = element => {
    if (element.localName === 'select') Object.defineProperty(element, 'value', { writable: true, value: '' });
    if (element.localName === 'dialog') {
      element.showModal = () => { element.open = true; element.setAttribute('open', ''); };
      element.close = () => { element.open = false; element.removeAttribute('open'); };
    }
    return element;
  };
  for (const element of document.querySelectorAll('select,dialog')) prepare(element);
  const createElement = document.createElement.bind(document);
  document.createElement = (...args) => prepare(createElement(...args));
  const projects = ['A', 'B'].map((suffix, index) => ({
    id: index ? PROJECT_B : PROJECT_A, libraryID: 1, collectionKey: 'PROJECT' + suffix,
    name: '测试项目 ' + suffix, label: '文献库 / 测试项目 ' + suffix, library: { editable: true },
  }));
  const paper = { isAttachment: () => false };
  const row = { id: 1, key: 'PAPERKEY', libraryID: 1, title: '未批注文献', authors: '张', year: '2026', citekey: 'Zhang2026', tags: [], annotations: [],
    values: C.blankValues(), highlights: {}, editable: true, paper, itemURL: 'zotero://select/library/items/PAPERKEY', pdfURL: '', attachmentID: null };
  const rowB = { ...row, values: C.blankValues(), highlights: {} };
  const loads = [], saves = [], logs = [], sourceCalls = [], apiCalls = [], keyCalls = [], batchSaves = [], importSaves = [];
  const pickerSelections = [], pickerCalls = [], fileReads = [], fileWrites = [], files = new Map();
  class FilePicker {
    constructor() { this.modeOpen = 0; this.modeSave = 1; this.returnOK = 0; this.returnCancel = 1; this.returnReplace = 2; this.filters = []; }
    init(_window, title, mode) { this.title = title; this.mode = mode; }
    appendFilter(label, pattern) { this.filters.push({ label, pattern }); }
    async show() {
      pickerCalls.push({ title: this.title, mode: this.mode, defaultString: this.defaultString,
        defaultExtension: this.defaultExtension, filters: clone(this.filters) });
      const next = pickerSelections.shift();
      this.file = next?.path;
      return next?.result ?? this.returnCancel;
    }
  }
  const queueFile = ({ name = '外部 AI 已填表.csv', text = '', bytes, prefix, result = 0 } = {}) => {
    const path = '/fixture/' + files.size + '/' + name;
    files.set(path, { leafName: name, fileSize: bytes ?? Buffer.byteLength(text), text, prefix });
    pickerSelections.push({ path, result });
    return path;
  };
  let preferences = clone(saved), aiConfig = clone(aiSaved);
  const keyStore = new Map([['https://api.example.test/v1/chat/completions', 'fixture-only-key']]);
  let keyProvider = async endpoint => keyStore.get(endpoint) || '';
  let settingsOpened = 0;
  const repo = { projects: () => projects, currentProject: () => projects[0],
    loadProject: async project => {
      loads.push({ projectID: project.id, fields: clone(project.fields) });
      if (fail) throw new Error('模拟读取失败');
      return [project.id === PROJECT_A ? row : rowB];
    },
    saveField: async (project, target, id, value, expected, options = {}) => {
      saves.push({ projectID: project.id, id, value, expected, options: clone(options) });
      return { note: { key: 'NOTEKEY' }, values: { ...target.values, [id]: value }, highlights: { ...target.highlights, [id]: options.highlights || [] } };
    },
    paperSource: async (target, options) => {
      sourceCalls.push({ rowID: target.id, projectID: target.projectID, mode: options.mode, maxChars: options.maxChars });
      return { text: '论文原文片段：实验比较两种条件，结果有待结合原文核对。', label: '模拟提取文本', chars: 30, truncated: false,
        paper: { title: target.title, authors: target.authors, year: target.year, abstract: '模拟公开摘要' } };
    },
    saveFields: async (project, target, changes, expected, options = {}) => {
      batchSaves.push({ projectID: project.id, changes: clone(changes), expected: clone(expected), options: clone(options) });
      for (const id of Object.keys(changes)) if ((target.values[id] || '') !== expected[id]) throw new Error('模拟原子字段冲突');
      return { note: { key: 'AI_NOTEKEY' }, values: { ...target.values, ...changes } };
    },
    importRows: async (project, operations) => {
      importSaves.push({ projectID: project.id, fields: clone(project.fields),
        operations: operations.map(operation => ({ row: operation.row, changes: clone(operation.changes), expected: clone(operation.expected) })) });
      for (const operation of operations) for (const id of Object.keys(operation.changes)) {
        if ((operation.row.values[id] || '') !== operation.expected[id]) throw new Error('模拟整表导入冲突');
      }
      return { records: operations.map((operation, index) => ({ row: operation.row,
        note: { key: 'TBLNOTE' + (index + 1) }, values: { ...operation.row.values, ...operation.changes } })) };
    } };
  let notifier;
  const Z = { Prefs: { get: key => JSON.stringify(key === 'extensions.researchgrid.ai' ? aiConfig : preferences),
    set: (key, value) => { if (key === 'extensions.researchgrid.ai') aiConfig = JSON.parse(value); else preferences = JSON.parse(value); } },
    ProjectLitMatrix: { credentials: { getKey: async endpoint => { keyCalls.push(endpoint); return keyProvider(endpoint); } },
      openSettings() { settingsOpened++; } },
    File: {
      pathToFile(path) { assert.ok(files.has(path), 'the selected file must exist'); return files.get(path); },
      async getBinaryContentsAsync(path, length) { return files.get(path).prefix ?? files.get(path).text.slice(0, length); },
      async getContentsAsync(path, charset, length) { fileReads.push({ path, charset, length }); return files.get(path).text; },
      async putContentsAsync(path, text) { fileWrites.push({ path, text }); },
    },
    Notifier: { registerObserver(observer) { notifier = observer; return 1; }, unregisterObserver() {} }, logError: error => logs.push(error) };
  const timers = new Set();
  const context = vm.createContext({ window, document, Node: window.Node, ChromeUtils: {
    importESModule: url => url.includes('filePicker.mjs') ? { FilePicker } : { Zotero: Z } },
    PLMCore: C, PLMRepository: class { constructor() { return repo; } }, location: { search: '' }, URLSearchParams, URL, AbortController,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); } });
  window.confirm = () => true;
  window.getSelection = () => null;
  window.fetch = async (url, options) => {
    apiCalls.push({ url, options });
    const payload = JSON.parse(options.body);
    const last = payload.messages.at(-1).content;
    const packet = JSON.parse(last.slice(last.indexOf('{')));
    const values = Object.fromEntries(packet.requestedFields.map(field => [field.id, 'AI 草稿：' + field.label]));
    return { ok: true, status: 200, redirected: false,
      text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ fields: values }) } }] }) };
  };
  vm.runInContext(fs.readFileSync('plugin/content/fields.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/ai.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/ai-dialog.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/table-io.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/table-dialog.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/ai-batch.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/highlights.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/display.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/project-picker.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/column-widths.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/mindmap.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('plugin/content/matrix.js', 'utf8'), context);
  await settle();
  const run = code => vm.runInContext(code, context);
  const cell = id => document.querySelector(`td[data-field="${id}"]`);
  const pointerEvent = async (element, type, detail) => {
    assert.ok(element, 'the target control must be present');
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'detail', { value: detail });
    element.dispatchEvent(event);
    // Native DOM retains Event.target after dispatch; LinkeDOM removes it.
    event.target = element;
    await settle();
  };
  const click = element => pointerEvent(element, 'click', 1);
  const dblclick = async element => {
    // Match the browser order so an accidental single-click editor is caught.
    await pointerEvent(element, 'click', 1);
    await pointerEvent(element, 'click', 2);
    await pointerEvent(element, 'dblclick', 2);
  };
  const key = async (element, key, options = {}) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key, ...options });
    element.dispatchEvent(event);
    event.target = element;
    await settle();
    return event;
  };
  const input = async (element, value, type = 'input') => {
    assert.ok(element, 'the input control must be present');
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new window.Event(type, { bubbles: true }));
    await settle();
  };
  return { document, window, context, repo, projects, row, rowB, loads, saves, logs, run, cell, click, dblclick, key, input,
    notify: () => notifier.notify('modify', 'item', [1], {}),
    sourceCalls, apiCalls, keyCalls, batchSaves, importSaves, pickerCalls, fileReads, fileWrites, queueFile,
    setAIConfig: value => { aiConfig = clone(value); },
    aiConfig: () => clone(aiConfig), keyProvider: fn => { keyProvider = fn; }, settingsOpened: () => settingsOpened,
    prefs: () => clone(preferences), cleanup() {
      run('widthManager?.dispose(); mindmapManager?.dispose()');
      for (const timer of timers) clearTimeout(timer);
    } };
}

test('resizing a non-active project column persists its owner and reset affects only the current project', async () => {
  const saved = multiProjectPrefs();
  saved.projects[PROJECT_A].columnWidths = { identity: 390, 'field:findings': 510, 'metadata:year': 180 };
  saved.projects[PROJECT_B].columnWidths = { identity: 250, 'field:remarks': 420, 'field:archived_value': 670 };
  const f = await ui({ saved });
  try {
    await selectBothProjects(f);
    const a = projectGroup(f, PROJECT_A), b = projectGroup(f, PROJECT_B);
    assert.equal(f.run('state.project.id'), PROJECT_A);
    assert.equal(a.querySelector('[data-column-resize="field:findings"]').getAttribute('aria-valuenow'), '510');
    await f.key(b.querySelector('[data-column-resize="field:remarks"]'), 'ArrowRight');
    assert.equal(f.run('state.project.id'), PROJECT_A, 'a width adjustment does not change the active operation project');
    assert.deepEqual(f.prefs().projects[PROJECT_A].columnWidths, saved.projects[PROJECT_A].columnWidths);
    assert.deepEqual(f.prefs().projects[PROJECT_B].columnWidths,
      { identity: 250, 'field:remarks': 430, 'field:archived_value': 670 });
    f.run('render()');
    assert.equal(projectGroup(f, PROJECT_B).querySelector('[data-column-resize="field:remarks"]').getAttribute('aria-valuenow'), '430');
    await f.click(f.document.querySelector('#resetWidths'));
    assert.deepEqual(f.prefs().projects[PROJECT_A].columnWidths, {});
    assert.equal(projectGroup(f, PROJECT_A).querySelector('[data-column-resize="field:findings"]').getAttribute('aria-valuenow'), '290');
    assert.equal(projectGroup(f, PROJECT_B).querySelector('[data-column-resize="field:remarks"]').getAttribute('aria-valuenow'), '430');
    assert.equal(f.prefs().projects[PROJECT_B].columnWidths['field:archived_value'], 670);
    assert.equal(f.saves.length + f.apiCalls.length + f.batchSaves.length + f.importSaves.length, 0);
  } finally { f.cleanup(); }
});

test('column widths follow stable field identities through rename, reorder, hide and reopen', async () => {
  const saved = multiProjectPrefs();
  saved.projects[PROJECT_A].columnWidths = { identity: 390, 'field:findings': 510, 'field:remarks': 440, 'metadata:year': 180 };
  const f = await ui({ saved });
  let reopened;
  try {
    f.run(`savePrefs({ fields: allFields().slice().reverse().map(field => ({ ...field, label: '改名：' + field.label })) }); render()`);
    const handles = [...f.document.querySelectorAll('#grid [data-column-resize]')];
    assert.deepEqual(handles.map(handle => handle.dataset.columnResize), ['identity', 'metadata:year', 'field:remarks', 'field:findings']);
    assert.deepEqual(handles.map(handle => handle.getAttribute('aria-valuenow')), ['390', '180', '440', '510']);
    assert.match(handles.at(-1).getAttribute('aria-label'), /改名：甲项目结论/);
    f.run(`savePrefs({ fields: allFields().map(field => ({ ...field, visible: field.id !== 'findings' })) }); render()`);
    assert.equal(f.document.querySelector('#grid [data-column-resize="field:findings"]'), null);
    assert.equal(f.prefs().projects[PROJECT_A].columnWidths['field:findings'], 510);
    f.run(`savePrefs({ fields: allFields().map(field => ({ ...field, visible: true })) }); render()`);
    reopened = await ui({ saved: f.prefs() });
    assert.equal(reopened.document.querySelector('#grid [data-column-resize="field:findings"]').getAttribute('aria-valuenow'), '510');
    assert.match(reopened.document.querySelector('#grid [data-column-resize="field:findings"]').getAttribute('aria-label'), /改名：甲项目结论/);
    await reopened.key(reopened.document.querySelector('#grid [data-column-resize="field:findings"]'), 'Home');
    assert.equal(reopened.prefs().projects[PROJECT_A].columnWidths['field:findings'], undefined);
    assert.equal(reopened.prefs().projects[PROJECT_A].columnWidths['field:remarks'], 440);
    assert.equal(reopened.document.querySelector('#grid [data-column-resize="field:findings"]').getAttribute('aria-valuenow'), '290');
  } finally { f.cleanup(); reopened?.cleanup(); }
});

test('resizing and restoring widths leave an active text draft intact and persistence failure rolls back width', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('remarks'));
    const draft = f.document.querySelector('#inlineValue');
    await f.input(draft, '尚未保存的表内内容');
    const handle = f.document.querySelector('#grid [data-column-resize="field:remarks"]');
    await f.key(handle, 'ArrowRight', { shiftKey: true });
    assert.equal(handle.getAttribute('aria-valuenow'), '370');
    assert.equal(f.prefs().projects[PROJECT_A].columnWidths['field:remarks'], 370);
    assert.equal(f.document.querySelector('#inlineValue'), draft);
    assert.equal(draft.value, '尚未保存的表内内容');
    await f.click(f.document.querySelector('#resetWidths'));
    assert.equal(f.document.querySelector('#inlineValue'), draft);
    assert.equal(draft.value, '尚未保存的表内内容');
    f.run(`Z.Prefs.set = () => { throw new Error('模拟偏好存储失败'); }`);
    await f.key(f.document.querySelector('#grid [data-column-resize="field:remarks"]'), 'ArrowRight');
    assert.equal(f.document.querySelector('#grid [data-column-resize="field:remarks"]').getAttribute('aria-valuenow'), '320');
    assert.deepEqual(f.prefs().projects[PROJECT_A].columnWidths, {});
    assert.match(f.document.querySelector('#toast').textContent, /模拟偏好存储失败/);
    assert.equal(f.document.querySelector('#inlineValue'), draft);
    assert.equal(f.saves.length, 0);
  } finally { f.cleanup(); }
});

test('view switches protect unsaved text and do not bypass an open settings dialog', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('remarks'));
    const draft = f.document.querySelector('#inlineValue');
    await f.input(draft, '切换视图前未保存的草稿');
    f.window.confirm = () => false;
    await f.click(f.document.querySelector('#viewMindmap'));
    assert.equal(f.run('state.view'), 'table');
    assert.equal(f.document.querySelector('#inlineValue'), draft);
    assert.equal(draft.value, '切换视图前未保存的草稿');
    assert.equal(f.run('mindmapManager.isOpen()'), false);
    assert.equal(f.saves.length, 0);
    f.window.confirm = () => true;
    await f.click(f.document.querySelector('#viewMindmap'));
    assert.equal(f.run('state.view'), 'mindmap');
    assert.equal(f.document.querySelector('#inlineValue'), null);
    assert.equal(f.row.values.remarks, '');
    assert.equal(f.document.querySelector('#matrixView').hidden, true);
    assert.equal(f.document.querySelector('#mindmapView').hidden, false);
    await f.click(f.document.querySelector('#displayOptions'));
    assert.equal(f.run('displayManager.isOpen()'), true);
    await f.click(f.document.querySelector('#viewTable'));
    assert.equal(f.run('state.view'), 'mindmap', 'a view button cannot dismiss another manager');
    assert.equal(f.run('displayManager.isOpen()'), true);
    assert.equal(f.saves.length + f.apiCalls.length, 0);
  } finally { f.cleanup(); }
});

test('a failed reload hides stale mindmap content and exposes the retry state', async () => {
  const f = await ui();
  try {
    f.row.values.findings = '刷新前的项目分析';
    f.run('render()');
    await f.click(f.document.querySelector('#viewMindmap'));
    assert.equal(f.run('mindmapManager.isOpen()'), true);
    f.repo.loadProject = async () => { throw new Error('模拟新一轮读取失败'); };
    await f.run('reload()');
    assert.equal(f.run('state.loadError'), true);
    assert.equal(f.run('mindmapManager.isOpen()'), false);
    assert.equal(f.document.querySelector('#mindmapView').hidden, true);
    assert.equal(f.document.querySelector('#matrixView').hidden, false);
    assert.equal(f.document.querySelector('#grid').hidden, true);
    assert.equal(f.document.querySelector('#projectGroups').hidden, true);
    assert.equal(f.document.querySelector('#empty').hidden, false);
    assert.match(f.document.querySelector('#empty').textContent, /模拟新一轮读取失败/);
    assert.equal(f.apiCalls.length + f.saves.length, 0);
  } finally { f.cleanup(); }
});

test('mindmap follows the active project and current filter without mixing another project analysis', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.values.findings = '仅甲项目的客观结论';
    f.rowB.values.methods_sample = '仅乙项目的实验方法';
    await selectBothProjects(f);
    await f.click(f.document.querySelector('#viewMindmap'));
    const map = f.document.querySelector('#mindmapView');
    const paperID = 'paper:1:PAPERKEY';
    assert.equal(map.querySelector('.rg-mm-project').textContent, '测试项目 A');
    await f.click(map.querySelector(`[data-mm-select="${paperID}"]`));
    assert.match(map.querySelector('.rg-mm-details').textContent, /仅甲项目的客观结论/);
    assert.doesNotMatch(map.textContent, /仅乙项目的实验方法/);
    await f.click(map.querySelector(`[data-mm-toggle="${paperID}"]`));
    assert.ok(map.querySelector(`[data-mm-node="${paperID}:field:findings"]`));
    await f.click(f.document.querySelector(`[data-active-project="${PROJECT_B}"]`));
    assert.equal(map.querySelector('.rg-mm-project').textContent, '测试项目 B');
    await f.click(map.querySelector(`[data-mm-toggle="${paperID}"]`));
    assert.ok(map.querySelector(`[data-mm-node="${paperID}:field:methods_sample"]`));
    assert.equal(map.querySelector(`[data-mm-node="${paperID}:field:findings"]`), null);
    assert.doesNotMatch(map.textContent, /仅甲项目的客观结论/);
    f.document.querySelector('#search').value = '仅甲项目的客观结论';
    f.run('render()');
    assert.equal(f.run('state.shown.length'), 1, 'the other project can still have a matching table row');
    assert.equal(map.querySelectorAll('.rg-mm-paper').length, 0, 'the graph must not fall back to another project matching the filter');
    assert.match(map.querySelector('.rg-mm-count').textContent, /0 篇文献/);
    f.document.querySelector('#search').value = '';
    f.run('render()');
    assert.equal(map.querySelectorAll('.rg-mm-paper').length, 1);
    assert.equal(f.saves.length + f.apiCalls.length + f.importSaves.length, 0);
  } finally { f.cleanup(); }
});

test('select all in mindmap checks only the visible project and keeps other project selections counted as hidden', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    await selectBothProjects(f);
    await f.click(f.document.querySelector('#viewMindmap'));
    await f.click(f.document.querySelector('#selectShown'));
    assert.deepEqual(clone(f.run('selectedRows().map(row => row.projectID)')), [PROJECT_A]);
    await f.click(f.document.querySelector(`[data-active-project="${PROJECT_B}"]`));
    assert.match(f.document.querySelector('#selectionCount').textContent, /已选 1 篇.*筛选外 1 篇/);
    assert.equal(f.document.querySelector('#batchAI').disabled, true);
    await f.click(f.document.querySelector('#selectShown'));
    assert.deepEqual(clone(f.run('selectedRows().map(row => row.projectID)')), [PROJECT_A, PROJECT_B]);
    assert.match(f.document.querySelector('#selectionCount').textContent, /已选 2 篇.*筛选外 1 篇/);
    assert.match(f.document.querySelector('#batchAI').textContent, /测试项目 B（1）/);
    await f.click(f.document.querySelector('#viewTable'));
    assert.equal(f.document.querySelector('#selectionCount').textContent, '已选 2 篇');
    assert.equal(f.saves.length + f.apiCalls.length, 0);
  } finally { f.cleanup(); }
});

test('editing a graph field uses the existing modal and saves only that project owner', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.values.findings = '甲项目保留的原始结论';
    f.rowB.values.methods_sample = '乙项目原始方法';
    await selectBothProjects(f);
    await f.click(f.document.querySelector(`[data-active-project="${PROJECT_B}"]`));
    await f.click(f.document.querySelector('#viewMindmap'));
    const map = f.document.querySelector('#mindmapView'), paperID = 'paper:1:PAPERKEY';
    await f.click(map.querySelector(`[data-mm-toggle="${paperID}"]`));
    await f.dblclick(map.querySelector(`[data-mm-select="${paperID}:field:methods_sample"]`));
    assert.equal(f.document.querySelector('#editDialog').open, true);
    assert.equal(f.run('state.editing.project.id'), PROJECT_B);
    assert.equal(f.document.querySelector('#editHeading').textContent, '乙项目方法');
    assert.equal(f.document.querySelector('#editValue').value, '乙项目原始方法');
    await f.input(f.document.querySelector('#editValue'), '乙项目通过导图更新的方法');
    await f.key(f.document.querySelector('#editValue'), 'Enter', { metaKey: true });
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].projectID, PROJECT_B);
    assert.equal(f.saves[0].id, 'methods_sample');
    assert.equal(f.saves[0].expected, '乙项目原始方法');
    assert.equal(f.rowB.values.methods_sample, '乙项目通过导图更新的方法');
    assert.equal(f.row.values.findings, '甲项目保留的原始结论');
    assert.equal(f.document.querySelector('#editDialog').open, false);
    assert.equal(f.run('state.view'), 'mindmap');
    assert.match(map.textContent, /乙项目通过导图更新的方法/);
    assert.equal(f.apiCalls.length + f.importSaves.length + f.batchSaves.length, 0);
  } finally { f.cleanup(); }
});

test('a field hidden from the table remains editable in the graph without offering an unavailable inline target', async () => {
  const saved = multiProjectPrefs();
  saved.projects[PROJECT_A].fields[0].visible = false;
  const f = await ui({ saved });
  try {
    f.row.values.findings = '隐藏列已有分析';
    f.run('render()');
    assert.equal(f.cell('findings'), null);
    await f.click(f.document.querySelector('#viewMindmap'));
    const map = f.document.querySelector('#mindmapView'), paperID = 'paper:1:PAPERKEY';
    await f.click(map.querySelector(`[data-mm-toggle="${paperID}"]`));
    assert.ok(map.querySelector(`[data-mm-node="${paperID}:field:findings"]`));
    await f.dblclick(map.querySelector(`[data-mm-select="${paperID}:field:findings"]`));
    assert.equal(f.document.querySelector('#editDialog').open, true);
    assert.equal(f.document.querySelector('#editCollapse').hidden, true);
    assert.equal(f.run('state.editing.project.id'), PROJECT_A);
    await f.input(f.document.querySelector('#editValue'), '导图中更新隐藏列分析');
    await f.key(f.document.querySelector('#editValue'), 'Enter', { metaKey: true });
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].projectID, PROJECT_A);
    assert.equal(f.saves[0].id, 'findings');
    assert.equal(f.row.values.findings, '导图中更新隐藏列分析');
    assert.equal(f.cell('findings'), null, 'editing through the map does not change table visibility');
    assert.equal(f.document.querySelector('#editDialog').open, false);
  } finally { f.cleanup(); }
});

test('returning from graph editing to the table preserves the multiline draft and original highlight snapshot', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.values.findings = '原始结论文字';
    f.row.highlights.findings = [{ start: 0, end: 2, color: 'yellow' }];
    await selectBothProjects(f);
    await f.click(f.document.querySelector('#viewMindmap'));
    const map = f.document.querySelector('#mindmapView'), paperID = 'paper:1:PAPERKEY';
    await f.click(map.querySelector(`[data-mm-select="${paperID}"]`));
    await f.click(map.querySelector('[data-mm-edit="findings"]'));
    assert.equal(f.document.querySelector('#editDialog').open, true);
    const draft = '原始结论文字\n从导图编辑的补充';
    await f.input(f.document.querySelector('#editValue'), draft);
    await f.click(f.document.querySelector('#editCollapse'));
    assert.equal(f.run('state.view'), 'table');
    assert.equal(f.document.querySelector('#mindmapView').hidden, true);
    assert.equal(f.document.querySelector('#matrixView').hidden, false);
    assert.equal(f.document.querySelector('#editDialog').open, false);
    assert.equal(f.document.querySelector('#inlineValue').value, draft);
    assert.equal(f.run('state.editing.project.id'), PROJECT_A);
    assert.equal(f.run('state.editing.original'), '原始结论文字');
    assert.deepEqual(clone(f.run('state.editing.originalHighlights')), [{ start: 0, end: 2, color: 'yellow' }]);
    assert.equal(f.saves.length, 0, 'switching from map modal to table is not a save');
    await f.click(f.document.querySelector('#inlineSave'));
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].projectID, PROJECT_A);
    assert.equal(f.row.values.findings, draft);
    assert.equal(f.rowB.values.findings, '');
    assert.deepEqual(f.saves[0].options.expectedHighlights, [{ start: 0, end: 2, color: 'yellow' }]);
  } finally { f.cleanup(); }
});

test('mindmap layout persists independently per project and reopening restores both contexts', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  let reopened;
  try {
    f.row.values.findings = '甲分析';
    f.rowB.values.methods_sample = '乙分析';
    await selectBothProjects(f);
    await f.click(f.document.querySelector('#viewMindmap'));
    const paperID = 'paper:1:PAPERKEY';
    await f.key(f.document.querySelector(`[data-mm-select="${paperID}"]`), 'ArrowRight');
    const layoutA = clone(f.prefs().projects[PROJECT_A].mindmapLayout);
    assert.ok(layoutA.positions[paperID]);
    assert.equal(f.prefs().projects[PROJECT_B].mindmapLayout, undefined);
    await f.click(f.document.querySelector(`[data-active-project="${PROJECT_B}"]`));
    await f.key(f.document.querySelector(`[data-mm-select="${paperID}"]`), 'ArrowRight', { shiftKey: true });
    const layoutB = clone(f.prefs().projects[PROJECT_B].mindmapLayout);
    assert.equal(layoutB.positions[paperID].x - layoutA.positions[paperID].x, 30);
    assert.deepEqual(f.prefs().projects[PROJECT_A].mindmapLayout, layoutA);
    reopened = await ui({ saved: f.prefs() });
    assert.equal(reopened.run('state.view'), 'mindmap');
    assert.equal(reopened.run('state.project.id'), PROJECT_B);
    assert.deepEqual(clone(reopened.run('mindmapManager.layout')), layoutB);
    await reopened.click(reopened.document.querySelector(`[data-active-project="${PROJECT_A}"]`));
    assert.deepEqual(clone(reopened.run('mindmapManager.layout')), layoutA);
    assert.equal(f.saves.length + f.apiCalls.length + f.importSaves.length, 0);
  } finally { f.cleanup(); reopened?.cleanup(); }
});

test('successful project load renders all papers and clears the loading status', async () => {
  const f = await ui();
  try {
    assert.equal(f.document.querySelector('#grid tbody').children.length, 1);
    assert.ok(f.document.querySelector('#status').textContent.includes('1 / 1 篇文献'));
    assert.ok(!f.document.querySelector('#status').textContent.includes('正在读取'));
    assert.equal(f.document.querySelector('#export').disabled, false);
    assert.equal(f.document.querySelector('#grid').hidden, false);
  } finally { f.cleanup(); }
});

test('searching and applying a single project restores that project\'s existing analysis and field preferences', async () => {
  const f = await ui({ saved: { version: 1, projects: {
    [PROJECT_A]: { fields: [{ id: 'custom_project_a', label: '甲项目独有字段', requirement: '仅用于甲项目。', visible: true, archived: false }] },
    [PROJECT_B]: { columns: ['remarks'] },
  } } });
  try {
    f.row.values = { custom_project_a: '甲项目原有分析' };
    f.rowB.values.remarks = '乙项目原有分析';
    f.run('render()');
    assert.equal(f.document.querySelector('#project').localName, 'button');
    assert.equal(f.document.querySelector('#project').textContent, '测试项目 A');
    await f.click(f.document.querySelector('#project'));
    assert.equal(f.document.querySelector('#projectPickerDialog').open, true);
    assert.equal(f.document.querySelector(`[data-project-check="${PROJECT_A}"]`).checked, true);
    await f.input(f.document.querySelector('#rg-project-search'), '测试项目 B');
    assert.equal(f.document.querySelector(`[data-project-check="${PROJECT_A}"]`), null);
    assert.ok(f.document.querySelector(`[data-project-check="${PROJECT_B}"]`));
    assert.ok(f.document.querySelector(`[data-project-selected="${PROJECT_A}"]`), 'search does not discard the current selection');
    await f.click(f.document.querySelector(`[data-project-remove="${PROJECT_A}"]`));
    await f.input(f.document.querySelector(`[data-project-check="${PROJECT_B}"]`), true, 'change');
    assert.equal(f.run('state.project.id'), PROJECT_A, 'checking a result does not switch projects before Apply');
    assert.match(f.cell('custom_project_a').textContent, /甲项目原有分析/);
    await f.click(f.document.querySelector('#rg-project-apply'));
    assert.equal(f.document.querySelector('#projectPickerDialog').open, false);
    assert.equal(f.run('state.project.id'), PROJECT_B);
    assert.equal(f.document.querySelector('#project').textContent, '测试项目 B');
    assert.equal(f.cell('custom_project_a'), null);
    assert.match(f.cell('remarks').textContent, /乙项目原有分析/);
    assert.deepEqual([...f.document.querySelectorAll('td[data-field]')].map(cell => cell.dataset.field), ['remarks']);
    assert.equal(f.loads.at(-1).projectID, PROJECT_B);
    await f.click(f.document.querySelector('#project'));
    await f.click(f.document.querySelector('#rg-project-clear'));
    await f.input(f.document.querySelector('#rg-project-search'), '测试项目 A');
    await f.input(f.document.querySelector(`[data-project-check="${PROJECT_A}"]`), true, 'change');
    await f.click(f.document.querySelector('#rg-project-apply'));
    assert.equal(f.run('state.project.id'), PROJECT_A);
    assert.match(f.cell('custom_project_a').textContent, /甲项目原有分析/);
    assert.equal(f.rowB.values.remarks, '乙项目原有分析');
    assert.equal(f.saves.length + f.batchSaves.length + f.importSaves.length + f.apiCalls.length, 0);
  } finally { f.cleanup(); }
});

test('refusing to discard an inline draft keeps the project picker closed and the draft intact', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('remarks'));
    const editor = f.document.querySelector('#inlineValue');
    editor.value = '切换分类前尚未保存的草稿';
    const loadsBefore = f.loads.length;
    f.window.confirm = () => false;
    await f.click(f.document.querySelector('#project'));
    assert.equal(!!f.document.querySelector('#projectPickerDialog')?.open, false);
    assert.equal(f.document.querySelector('#inlineValue'), editor);
    assert.equal(editor.value, '切换分类前尚未保存的草稿');
    assert.equal(f.run('state.project.id'), PROJECT_A);
    assert.equal(f.loads.length, loadsBefore);
    assert.equal(f.saves.length, 0);
    f.window.confirm = () => true;
    await f.click(f.document.querySelector('#project'));
    assert.equal(f.document.querySelector('#projectPickerDialog').open, true);
    assert.equal(f.document.querySelector('#inlineValue'), null);
    assert.equal(f.row.values.remarks, '', 'opening the picker never saves a discarded draft');
  } finally { f.cleanup(); }
});

test('canceling a changed project selection leaves the current project, analysis and preferences untouched', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '当前项目原有分析';
    f.rowB.values.remarks = '另一项目原有分析';
    f.run('render()');
    const before = f.prefs(), loadsBefore = f.loads.length;
    await f.click(f.document.querySelector('#project'));
    await f.click(f.document.querySelector('#rg-project-clear'));
    await f.input(f.document.querySelector(`[data-project-check="${PROJECT_B}"]`), true, 'change');
    f.window.confirm = () => false;
    await f.click(f.document.querySelector('#rg-project-cancel'));
    assert.equal(f.document.querySelector('#projectPickerDialog').open, true);
    f.window.confirm = () => true;
    await f.click(f.document.querySelector('#rg-project-cancel'));
    assert.equal(f.document.querySelector('#projectPickerDialog').open, false);
    assert.equal(f.run('state.project.id'), PROJECT_A);
    assert.match(f.cell('remarks').textContent, /当前项目原有分析/);
    assert.equal(f.rowB.values.remarks, '另一项目原有分析');
    assert.equal(f.loads.length, loadsBefore);
    assert.deepEqual(f.prefs(), before);
    await f.click(f.document.querySelector('#project'));
    assert.equal(f.document.querySelector(`[data-project-check="${PROJECT_A}"]`).checked, true);
    assert.ok(!f.document.querySelector(`[data-project-check="${PROJECT_B}"]`).checked);
    assert.equal(f.saves.length + f.batchSaves.length + f.importSaves.length, 0);
  } finally { f.cleanup(); }
});

for (const [name, control, dialog] of [
  ['display options', '#displayOptions', '#displayDialog'],
  ['project fields', '#columns', '#fieldManagerDialog'],
  ['single-paper AI', '.ai-summary', '#aiSummaryDialog'],
  ['batch AI', '#batchAI', '#aiBatchDialog'],
  ['table import', '#importTable', '#tableImportDialog'],
  ['template export', '#exportTemplate', '#templateDialog'],
]) test(`the project picker and ${name} dialog are mutually exclusive in both directions`, async () => {
  const otherFirst = await ui();
  try {
    await otherFirst.input(otherFirst.document.querySelector('[data-paper-select]'), true, 'change');
    await otherFirst.click(otherFirst.document.querySelector(control));
    assert.equal(otherFirst.document.querySelector(dialog).open, true);
    const callsBefore = otherFirst.sourceCalls.length;
    await otherFirst.click(otherFirst.document.querySelector('#project'));
    assert.equal(!!otherFirst.document.querySelector('#projectPickerDialog')?.open, false);
    assert.equal(otherFirst.document.querySelector(dialog).open, true);
    assert.equal(otherFirst.sourceCalls.length, callsBefore);
    assert.equal(otherFirst.run('state.project.id'), PROJECT_A);
  } finally { otherFirst.cleanup(); }
  const pickerFirst = await ui();
  try {
    await pickerFirst.input(pickerFirst.document.querySelector('[data-paper-select]'), true, 'change');
    await pickerFirst.click(pickerFirst.document.querySelector('#project'));
    assert.equal(pickerFirst.document.querySelector('#projectPickerDialog').open, true);
    await pickerFirst.click(pickerFirst.document.querySelector(control));
    assert.equal(!!pickerFirst.document.querySelector(dialog)?.open, false);
    assert.equal(pickerFirst.document.querySelector('#projectPickerDialog').open, true);
    assert.equal(pickerFirst.run('state.project.id'), PROJECT_A);
    assert.equal(pickerFirst.sourceCalls.length + pickerFirst.apiCalls.length + pickerFirst.keyCalls.length, 0);
  } finally { pickerFirst.cleanup(); }
});

test('selecting multiple categories displays the same paper in separate project sections with independent fields and highlights', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.values = { findings: '甲项目的结论', remarks: '甲项目备注内容' };
    f.rowB.values = { methods_sample: '乙项目的方法', remarks: '乙项目备注内容' };
    f.row.highlights = { remarks: [{ start: 0, end: 2, color: 'green' }] };
    f.rowB.highlights = { remarks: [{ start: 0, end: 2, color: 'pink' }] };
    f.row.metadata = { year: '2024' };
    f.rowB.metadata = { DOI: '10.1234/project-b' };
    f.run('render()');
    await f.click(f.document.querySelector('#project'));
    await f.input(f.document.querySelector(`[data-project-check="${PROJECT_B}"]`), true, 'change');
    await f.click(f.document.querySelector('#rg-project-apply'));
    assert.equal(f.document.querySelector('#projectPickerDialog').open, false);
    assert.deepEqual(displayedProjects(f), [PROJECT_A, PROJECT_B]);
    assert.equal(f.document.querySelectorAll('#projectGroups table.matrix-table').length, 2);
    assert.deepEqual(clone(f.run('state.rows.map(row => row.projectID)')), [PROJECT_A, PROJECT_B]);
    assert.equal(f.run('state.rows[0].key'), f.run('state.rows[1].key'));
    assert.notEqual(f.run('state.rows[0].contextKey'), f.run('state.rows[1].contextKey'));
    assert.notEqual(projectCell(f, PROJECT_A, 'remarks').dataset.row, projectCell(f, PROJECT_B, 'remarks').dataset.row);
    assert.match(projectGroup(f, PROJECT_A).querySelector('thead').textContent, /甲项目结论/);
    assert.doesNotMatch(projectGroup(f, PROJECT_A).querySelector('thead').textContent, /乙项目方法/);
    assert.match(projectGroup(f, PROJECT_B).querySelector('thead').textContent, /乙项目方法/);
    assert.equal(projectCell(f, PROJECT_A, 'methods_sample'), null);
    assert.equal(projectCell(f, PROJECT_B, 'findings'), null);
    assert.match(projectCell(f, PROJECT_A, 'findings').textContent, /甲项目的结论/);
    assert.match(projectCell(f, PROJECT_B, 'methods_sample').textContent, /乙项目的方法/);
    assert.equal(projectCell(f, PROJECT_A, 'remarks').querySelector('[data-rg-highlight="green"]').textContent, '甲项');
    assert.equal(projectCell(f, PROJECT_B, 'remarks').querySelector('[data-rg-highlight="pink"]').textContent, '乙项');
    assert.equal(projectGroup(f, PROJECT_A).querySelector('[data-metadata="year"] .metadata-text').textContent, '2024');
    assert.equal(projectGroup(f, PROJECT_B).querySelector('[data-metadata="DOI"] .metadata-text').textContent, '10.1234/project-b');
    assert.deepEqual(f.prefs().lastProjectSelection, [PROJECT_A, PROJECT_B]);
    assert.ok(f.document.querySelector(`[data-active-project="${PROJECT_A}"]`));
    assert.ok(f.document.querySelector(`[data-active-project="${PROJECT_B}"]`));
    assert.equal(f.saves.length + f.batchSaves.length + f.importSaves.length + f.apiCalls.length, 0);
  } finally { f.cleanup(); }
});

test('editing and highlighting an inactive project row save only that row\'s owner context', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.values.remarks = '甲项目原有备注';
    f.rowB.values.remarks = '乙项目原有备注';
    f.row.highlights.remarks = [{ start: 0, end: 2, color: 'green' }];
    f.rowB.highlights.remarks = [{ start: 0, end: 2, color: 'pink' }];
    await selectBothProjects(f);
    await f.run(`focusProject('${PROJECT_A}')`);
    await f.dblclick(projectCell(f, PROJECT_B, 'remarks'));
    assert.equal(f.document.querySelector('#inlineValue').value, '乙项目原有备注');
    assert.equal(f.run('state.editing.project.id'), PROJECT_B);
    await f.input(f.document.querySelector('#inlineValue'), '乙项目修改后的备注');
    await f.click(f.document.querySelector('#inlineSave'));
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].projectID, PROJECT_B);
    assert.equal(f.saves[0].expected, '乙项目原有备注');
    assert.match(projectCell(f, PROJECT_B, 'remarks').textContent, /乙项目修改后的备注/);
    assert.match(projectCell(f, PROJECT_A, 'remarks').textContent, /甲项目原有备注/);
    assert.equal(projectCell(f, PROJECT_A, 'remarks').querySelector('[data-rg-highlight="green"]').textContent, '甲项');
    await f.run(`focusProject('${PROJECT_A}')`);
    f.window.getSelection = () => ({ isCollapsed: false, toString: () => '乙项', removeAllRanges() {} });
    f.context.ownerCell = projectCell(f, PROJECT_B, 'remarks').querySelector('.cell-text');
    assert.equal(f.run('highlightManager.capture({element: ownerCell, start: 0, end: 2})'), true);
    await f.click(f.document.querySelector('#rg-highlight-selection-toolbar [data-highlight-color="blue"]'));
    assert.equal(f.saves.length, 2);
    assert.equal(f.saves[1].projectID, PROJECT_B);
    assert.deepEqual(f.saves[1].options.highlights, [{ start: 0, end: 2, color: 'blue' }]);
    assert.equal(projectCell(f, PROJECT_B, 'remarks').querySelector('[data-rg-highlight="blue"]').textContent, '乙项');
    assert.equal(projectCell(f, PROJECT_A, 'remarks').querySelector('[data-rg-highlight="green"]').textContent, '甲项');
    assert.equal(projectCell(f, PROJECT_A, 'remarks').querySelector('[data-rg-highlight="blue"]'), null);
    assert.equal(f.row.values.remarks, '甲项目原有备注');
  } finally { f.cleanup(); }
});

test('single-paper AI takes its clicked row\'s schema and writes only that project even when another project is active', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.values.findings = '甲项目人工结论';
    f.rowB.values.remarks = '乙项目人工备注';
    await selectBothProjects(f);
    await f.run(`focusProject('${PROJECT_A}')`);
    await f.click(projectGroup(f, PROJECT_B).querySelector('.ai-summary'));
    assert.equal(f.run('aiManager.project.id'), PROJECT_B);
    assert.deepEqual(clone(f.run('aiManager.fields.map(field => field.id)')), ['methods_sample', 'remarks']);
    await f.run('aiManager.generate()');
    const user = JSON.parse(f.apiCalls[0].options.body).messages.at(-1).content;
    const packet = JSON.parse(user.slice(user.indexOf('{')));
    assert.equal(packet.project.name, '测试项目 B');
    assert.deepEqual(packet.requestedFields, [{ id: 'methods_sample', label: '乙项目方法', requirement: '只记录乙项目所需研究方法。' }]);
    assert.equal(await f.run('aiManager.apply()'), true);
    assert.equal(f.batchSaves.length, 1);
    assert.equal(f.batchSaves[0].projectID, PROJECT_B);
    assert.deepEqual(f.batchSaves[0].changes, { methods_sample: 'AI 草稿：乙项目方法' });
    assert.match(projectCell(f, PROJECT_B, 'methods_sample').textContent, /AI 草稿：乙项目方法/);
    assert.match(projectCell(f, PROJECT_A, 'findings').textContent, /甲项目人工结论/);
    assert.equal(f.row.values.methods_sample, '');
    assert.equal(f.rowB.values.remarks, '乙项目人工备注');
  } finally { f.cleanup(); }
});

test('batch AI uses only selected papers and fields belonging to the active project', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.values.remarks = '甲项目人工备注';
    f.rowB.values.remarks = '乙项目人工备注';
    await selectBothProjects(f);
    await f.input(projectGroup(f, PROJECT_A).querySelector('[data-paper-select]'), true, 'change');
    await f.input(projectGroup(f, PROJECT_B).querySelector('[data-paper-select]'), true, 'change');
    await f.run(`focusProject('${PROJECT_A}')`);
    assert.match(f.document.querySelector('#batchAI').textContent, /测试项目 A/);
    assert.match(f.document.querySelector('#batchAI').textContent, /1/);
    await f.click(f.document.querySelector('#batchAI'));
    assert.equal(f.run('batchManager.project.id'), PROJECT_A);
    assert.equal(f.run('batchManager.entries.length'), 1);
    assert.equal(f.run('batchManager.entries[0].row.projectID'), PROJECT_A);
    assert.deepEqual(clone(f.run('batchManager.fields.map(field => field.id)')), ['findings', 'remarks']);
    await f.run('batchManager.generate()');
    assert.equal(f.apiCalls.length, 1);
    const user = JSON.parse(f.apiCalls[0].options.body).messages.at(-1).content;
    const packet = JSON.parse(user.slice(user.indexOf('{')));
    assert.equal(packet.project.name, '测试项目 A');
    assert.deepEqual(packet.requestedFields.map(field => field.id), ['findings']);
    assert.equal(await f.run('batchManager.apply()'), true);
    assert.equal(f.importSaves.length, 1);
    assert.equal(f.importSaves[0].projectID, PROJECT_A);
    assert.equal(f.importSaves[0].operations.length, 1);
    assert.equal(f.importSaves[0].operations[0].row.projectID, PROJECT_A);
    assert.equal(f.rowB.values.methods_sample, '');
    assert.equal(f.rowB.values.remarks, '乙项目人工备注');
    f.run('batchManager.close(true)');
    await f.click(f.document.querySelector(`[data-active-project="${PROJECT_B}"]`));
    assert.equal(f.run('state.project.id'), PROJECT_B);
    assert.match(f.document.querySelector('#batchAI').textContent, /测试项目 B/);
    await f.click(f.document.querySelector('#batchAI'));
    assert.equal(f.run('batchManager.project.id'), PROJECT_B);
    assert.equal(f.run('batchManager.entries.length'), 1);
    assert.equal(f.run('batchManager.entries[0].row.projectID'), PROJECT_B);
    assert.deepEqual(clone(f.run('batchManager.fields.map(field => field.id)')), ['methods_sample', 'remarks']);
  } finally { f.cleanup(); }
});

test('CSV, fill-in templates and table import stay within the active project when another section contains the same paper', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.values.findings = '甲项目不可覆盖的结论';
    f.rowB.values.methods_sample = '乙项目原有方法';
    await selectBothProjects(f);
    await f.click(f.document.querySelector(`[data-active-project="${PROJECT_B}"]`));
    f.queueFile({ name: '乙项目已填矩阵.csv' });
    await f.click(f.document.querySelector('#export'));
    const exported = Table.parse(f.fileWrites.at(-1).text);
    assert.equal(exported.records.length, 1);
    assert.equal(exported.records[0].cells[exported.headers.indexOf('项目标识')], PROJECT_B);
    assert.ok(exported.headers.includes('乙项目方法'));
    assert.ok(!exported.headers.includes('甲项目结论'));
    assert.equal(exported.records[0].cells[exported.headers.indexOf('乙项目方法')], '乙项目原有方法');
    assert.ok(!f.fileWrites.at(-1).text.includes('甲项目不可覆盖的结论'));
    await f.click(f.document.querySelector('#exportTemplate'));
    assert.match(f.document.querySelector('#templateContext').textContent, /测试项目 B.*1 篇文献/);
    f.queueFile({ name: '乙项目待填模板.csv' });
    await f.click(f.document.querySelector('#templateSave'));
    const template = Table.parse(f.fileWrites.at(-1).text);
    assert.deepEqual(template.headers.slice(10), ['乙项目方法 [methods_sample]', '乙项目备注 [remarks]']);
    assert.equal(template.records.length, 2);
    assert.equal(template.records[1].cells[2], PROJECT_B);
    await f.click(f.document.querySelector('#importTable'));
    assert.equal(f.run('tableManager.project.id'), PROJECT_B);
    assert.equal(f.run('tableManager.rows.length'), 1);
    assert.equal(f.run('tableManager.rows[0].projectID'), PROJECT_B);
    assert.deepEqual(clone(f.run('tableManager.fields.map(field => field.id)')), ['methods_sample', 'remarks']);
    const text = '项目标识\t文献标识\t乙项目方法 [methods_sample]\n'
      + [PROJECT_A, f.row.itemURL, '不能导入甲项目这一行'].join('\t') + '\n'
      + [PROJECT_B, f.rowB.itemURL, '乙项目外部 AI 方法'].join('\t');
    await f.input(f.document.querySelector('#rg-table-source'), text);
    await f.click(f.document.querySelector('#rg-table-parse'));
    await f.input(f.document.querySelector('#rg-table-overwrite'), true, 'change');
    assert.equal(f.run('tableManager.plan.stats.ready'), 1);
    assert.equal(f.run('tableManager.plan.stats.error'), 1);
    await f.click(f.document.querySelector('#rg-table-apply'));
    assert.equal(f.importSaves.length, 1);
    assert.equal(f.importSaves[0].projectID, PROJECT_B);
    assert.equal(f.importSaves[0].operations.length, 1);
    assert.equal(f.importSaves[0].operations[0].row.projectID, PROJECT_B);
    assert.deepEqual(f.importSaves[0].operations[0].changes, { methods_sample: '乙项目外部 AI 方法' });
    assert.match(projectCell(f, PROJECT_B, 'methods_sample').textContent, /乙项目外部 AI 方法/);
    assert.match(projectCell(f, PROJECT_A, 'findings').textContent, /甲项目不可覆盖的结论/);
  } finally { f.cleanup(); }
});

test('field and display changes apply only to the active section and preserve the other project\'s preferences', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.tags = ['甲项目标签'];
    f.rowB.tags = ['乙项目标签'];
    await selectBothProjects(f);
    const aBefore = clone(f.prefs().projects[PROJECT_A]);
    await f.click(f.document.querySelector(`[data-active-project="${PROJECT_B}"]`));
    await f.click(f.document.querySelector('#columns'));
    assert.deepEqual(clone(f.run('fieldManager.options.getFields().map(field => field.id)')), ['methods_sample', 'remarks']);
    f.context.changedFields = f.run('fieldManager.options.getFields().map(field => ({...field, label: field.id === "methods_sample" ? "乙项目修改后的方法字段" : field.label}))');
    await f.run('fieldManager.options.saveFields(changedFields)');
    f.run('fieldManager.close(true)');
    assert.match(projectGroup(f, PROJECT_B).querySelector('thead').textContent, /乙项目修改后的方法字段/);
    assert.match(projectGroup(f, PROJECT_A).querySelector('thead').textContent, /甲项目结论/);
    await f.input(f.document.querySelector('#showTags'), false, 'change');
    assert.equal(projectGroup(f, PROJECT_B).querySelector('.tags').hidden, true);
    assert.equal(projectGroup(f, PROJECT_A).querySelector('.tags').hidden, false);
    await f.click(f.document.querySelector('#displayOptions'));
    await f.input(f.document.querySelector('[data-metadata-column="abstractNote"]'), true, 'change');
    await f.click(f.document.querySelector('#rg-display-save'));
    assert.deepEqual(f.prefs().projects[PROJECT_B].display, { showTags: false, metadataColumns: ['DOI', 'abstractNote'] });
    assert.deepEqual(f.prefs().projects[PROJECT_A], aBefore);
    assert.deepEqual([...projectGroup(f, PROJECT_A).querySelectorAll('td.metadata-cell')].map(cell => cell.dataset.metadata), ['year']);
    assert.deepEqual([...projectGroup(f, PROJECT_B).querySelectorAll('td.metadata-cell')].map(cell => cell.dataset.metadata), ['DOI', 'abstractNote']);
  } finally { f.cleanup(); }
});

test('multi-project selection accepts native descriptors, survives refresh and reopening, and single-project selection retains its old meaning', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  let saved;
  try {
    await f.run("selectProjects([{libraryID:1,collectionKey:'PROJECTA'}, {libraryID:1,collectionKey:'PROJECTB'}, {libraryID:1,collectionKey:'PROJECTA'}], {fromPicker:true})");
    assert.deepEqual(displayedProjects(f), [PROJECT_A, PROJECT_B]);
    await f.run(`focusProject('${PROJECT_B}')`);
    await f.run('reload()');
    assert.deepEqual(displayedProjects(f), [PROJECT_A, PROJECT_B]);
    assert.equal(f.run('state.project.id'), PROJECT_B);
    await f.click(f.document.querySelector('#project'));
    assert.equal(f.document.querySelector(`[data-project-check="${PROJECT_A}"]`).checked, true);
    assert.equal(f.document.querySelector(`[data-project-check="${PROJECT_B}"]`).checked, true);
    await f.click(f.document.querySelector('#rg-project-cancel'));
    saved = f.prefs();
    assert.deepEqual(saved.lastProjectSelection, [PROJECT_A, PROJECT_B]);
    await f.run(`selectProject('${PROJECT_A}')`);
    assert.equal(f.run('state.project.id'), PROJECT_A);
    assert.deepEqual(clone(f.run('state.rows.map(row => row.projectID)')), [PROJECT_A]);
    assert.match(f.document.querySelector('#grid thead').textContent, /甲项目结论/);
    assert.doesNotMatch(f.document.querySelector('#grid thead').textContent, /乙项目方法/);
    assert.deepEqual(f.prefs().lastProjectSelection, [PROJECT_A]);
  } finally { f.cleanup(); }
  const reopened = await ui({ saved });
  try {
    assert.deepEqual(displayedProjects(reopened), [PROJECT_A, PROJECT_B]);
    assert.equal(reopened.run('state.project.id'), PROJECT_B);
    assert.equal(reopened.document.querySelectorAll('[data-paper-select]').length, 2);
  } finally { reopened.cleanup(); }
});

test('an invalid category in a multi-project request does not silently replace the current selection with its valid subset', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    await selectBothProjects(f);
    const before = f.prefs(), loadsBefore = f.loads.length;
    let rejected = false;
    try { rejected = await f.run(`selectProjects(['${PROJECT_B}', 'user:collection:MISSING0'], {fromPicker:true})`) === false; }
    catch (_) { rejected = true; }
    assert.equal(rejected, true);
    assert.deepEqual(displayedProjects(f), [PROJECT_A, PROJECT_B]);
    assert.equal(f.run('state.project.id'), PROJECT_A);
    assert.deepEqual(f.prefs(), before);
    assert.equal(f.loads.length, loadsBefore);
    assert.equal(f.saves.length + f.batchSaves.length + f.importSaves.length, 0);
  } finally { f.cleanup(); }
});

test('multi-project replacement and active-project changes respect unsaved drafts and modal ownership', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    await selectBothProjects(f);
    await f.run(`focusProject('${PROJECT_A}')`);
    await f.dblclick(projectCell(f, PROJECT_A, 'remarks'));
    const editor = f.document.querySelector('#inlineValue');
    editor.value = '甲项目未保存的草稿';
    f.window.confirm = () => false;
    await f.run(`focusProject('${PROJECT_B}')`);
    assert.equal(f.run('state.project.id'), PROJECT_A);
    await f.run(`selectProjects(['${PROJECT_B}'], {fromPicker:true})`);
    assert.deepEqual(displayedProjects(f), [PROJECT_A, PROJECT_B]);
    assert.equal(f.document.querySelector('#inlineValue'), editor);
    assert.equal(editor.value, '甲项目未保存的草稿');
    f.window.confirm = () => true;
    f.run('closeEditor(true)');
    await f.click(f.document.querySelector('#displayOptions'));
    assert.equal(f.document.querySelector('#displayDialog').open, true);
    await f.run(`focusProject('${PROJECT_B}')`);
    await f.run(`selectProjects(['${PROJECT_B}'], {fromPicker:true})`);
    assert.deepEqual(displayedProjects(f), [PROJECT_A, PROJECT_B]);
    assert.equal(f.run('state.project.id'), PROJECT_A);
    assert.equal(f.document.querySelector('#displayDialog').open, true);
    f.run('displayManager.close(true)');
    await f.click(projectGroup(f, PROJECT_B).querySelector('.ai-summary'));
    assert.equal(f.run('aiManager.project.id'), PROJECT_B);
    await f.run(`focusProject('${PROJECT_B}')`);
    await f.run(`selectProject('${PROJECT_B}')`);
    assert.equal(f.run('state.project.id'), PROJECT_A);
    assert.deepEqual(displayedProjects(f), [PROJECT_A, PROJECT_B]);
    assert.equal(f.run('aiManager.isOpen()'), true);
    assert.equal(f.saves.length + f.batchSaves.length + f.importSaves.length + f.apiCalls.length, 0);
  } finally { f.cleanup(); }
});

test('tags are shown by default and hiding them keeps tag search and CSV values intact', async () => {
  const f = await ui();
  try {
    f.row.tags = ['远程监控', '只通过标签匹配'];
    f.run('render()');
    assert.equal(f.document.querySelector('#showTags').checked, true);
    assert.match(f.document.querySelector('td.identity').textContent, /远程监控/);
    assert.equal(f.document.querySelector('td.identity .tags').hidden, false);
    await f.input(f.document.querySelector('#showTags'), false, 'change');
    assert.equal(f.prefs().projects[PROJECT_A].display.showTags, false);
    assert.equal(f.document.querySelector('td.identity .tags').hidden, true);
    assert.deepEqual(f.row.tags, ['远程监控', '只通过标签匹配']);
    f.document.querySelector('#search').value = '只通过标签匹配';
    f.run('render()');
    assert.equal(f.run('state.shown.length'), 1, 'tag visibility must not change search matching');
    const path = f.queueFile({ name: '隐藏标签的矩阵.csv' });
    await f.click(f.document.querySelector('#export'));
    assert.equal(f.fileWrites.at(-1).path, path);
    const table = Table.parse(f.fileWrites.at(-1).text);
    assert.equal(table.records[0].cells[table.headers.indexOf('标签')], '远程监控; 只通过标签匹配');
    assert.equal(table.headers.some(header => header.includes('[zotero:')), false, 'the default CSV keeps its existing columns');
    assert.equal(f.saves.length + f.batchSaves.length + f.importSaves.length, 0);
  } finally { f.cleanup(); }
});

test('tag visibility is saved independently for each project and survives reopening', async () => {
  const f = await ui();
  let saved;
  try {
    f.row.tags = ['项目甲标签'];
    f.rowB.tags = ['项目乙标签'];
    f.run('render()');
    await f.input(f.document.querySelector('#showTags'), false, 'change');
    await f.run(`selectProject('${PROJECT_B}')`);
    assert.equal(f.document.querySelector('#showTags').checked, true);
    assert.match(f.document.querySelector('td.identity').textContent, /项目乙标签/);
    assert.equal(f.document.querySelector('td.identity .tags').hidden, false);
    await f.run(`selectProject('${PROJECT_A}')`);
    assert.equal(f.document.querySelector('#showTags').checked, false);
    assert.equal(f.document.querySelector('td.identity .tags').hidden, true);
    assert.equal(f.prefs().projects[PROJECT_B].display.showTags, true);
    saved = f.prefs();
  } finally { f.cleanup(); }
  const reopened = await ui({ saved });
  try {
    assert.equal(reopened.document.querySelector('#showTags').checked, false);
    await reopened.run(`selectProject('${PROJECT_B}')`);
    assert.equal(reopened.document.querySelector('#showTags').checked, true);
  } finally { reopened.cleanup(); }
});

test('a failed tag preference write restores the checkbox and leaves the displayed tags unchanged', async () => {
  const f = await ui();
  try {
    f.row.tags = ['继续显示的标签'];
    f.run('render()');
    const before = f.prefs();
    f.run("Z.Prefs.set = () => { throw new Error('模拟显示设置写入失败'); }");
    await f.input(f.document.querySelector('#showTags'), false, 'change');
    assert.deepEqual(f.prefs(), before);
    assert.equal(f.run('prefs().display.showTags'), true);
    assert.equal(f.document.querySelector('#showTags').checked, true);
    assert.match(f.document.querySelector('td.identity').textContent, /继续显示的标签/);
    assert.equal(f.document.querySelector('td.identity .tags').hidden, false);
    assert.ok(f.logs.some(error => /模拟显示设置写入失败/.test(error.message)));
    assert.equal(f.saves.length + f.batchSaves.length + f.importSaves.length, 0);
  } finally { f.cleanup(); }
});

test('display options save selected metadata in the chosen order without changing analysis fields', async () => {
  const f = await ui({ saved: { version: 1, projects: { [PROJECT_A]: {
    display: { showTags: true, metadataColumns: ['year', 'title'] },
  } } } });
  try {
    f.row.metadata = { year: '2024', title: '元数据标题', DOI: '10.1234/example' };
    f.run('render()');
    const fieldsBefore = clone(f.run('allFields()'));
    const before = f.prefs();
    await f.click(f.document.querySelector('#displayOptions'));
    assert.equal(f.document.querySelector('#displayDialog').open, true);
    assert.equal(f.document.querySelector('[data-metadata-column="year"]').checked, true);
    assert.equal(f.document.querySelector('[data-metadata-column="title"]').checked, true);
    await f.input(f.document.querySelector('[data-metadata-column="DOI"]'), true, 'change');
    await f.click(f.document.querySelector('[data-display-move="up"][data-display-column="DOI"]'));
    await f.click(f.document.querySelector('[data-display-move="up"][data-display-column="DOI"]'));
    await f.input(f.document.querySelector('#rg-display-tags'), false, 'change');
    assert.deepEqual(f.prefs(), before, 'display changes remain a draft until Save');
    assert.equal(f.document.querySelector('td.metadata-cell[data-metadata="DOI"]'), null);
    await f.click(f.document.querySelector('#rg-display-save'));
    assert.equal(f.document.querySelector('#displayDialog').open, false);
    assert.deepEqual(f.prefs().projects[PROJECT_A].display, { showTags: false, metadataColumns: ['DOI', 'year', 'title'] });
    assert.deepEqual(clone(f.run('allFields()')), fieldsBefore);
    assert.equal(f.document.querySelector('#showTags').checked, false);
    const cells = [...f.document.querySelector('#grid tbody tr').children];
    assert.equal(cells[0].classList.contains('identity'), true);
    assert.deepEqual(cells.slice(1, 4).map(cell => cell.dataset.metadata), ['DOI', 'year', 'title']);
    assert.equal(cells[4].hasAttribute('data-field'), true, 'analysis columns follow the read-only metadata columns');
    assert.deepEqual(cells.slice(1, 4).map(cell => cell.textContent), ['10.1234/example', '2024', '元数据标题']);
    await f.run(`selectProject('${PROJECT_B}')`);
    assert.equal(f.document.querySelector('td.metadata-cell'), null);
    assert.equal(f.document.querySelector('#showTags').checked, true);
    await f.run(`selectProject('${PROJECT_A}')`);
    assert.deepEqual([...f.document.querySelectorAll('td.metadata-cell')].map(cell => cell.dataset.metadata), ['DOI', 'year', 'title']);
    assert.equal(f.saves.length + f.batchSaves.length + f.importSaves.length, 0);
  } finally { f.cleanup(); }
});

test('a failed display dialog save preserves its draft without exposing unsaved columns', async () => {
  const f = await ui();
  try {
    await f.click(f.document.querySelector('#displayOptions'));
    await f.input(f.document.querySelector('[data-metadata-column="DOI"]'), true, 'change');
    const before = f.prefs();
    f.context.originalPrefSet = f.run('Z.Prefs.set');
    f.run("Z.Prefs.set = () => { throw new Error('模拟显示列写入失败'); }");
    await f.click(f.document.querySelector('#rg-display-save'));
    assert.equal(f.document.querySelector('#displayDialog').open, true);
    assert.equal(f.document.querySelector('[data-metadata-column="DOI"]').checked, true);
    assert.deepEqual(f.prefs(), before);
    assert.equal(f.document.querySelector('td.metadata-cell'), null);
    f.run('Z.Prefs.set = originalPrefSet');
    await f.click(f.document.querySelector('#rg-display-save'));
    assert.equal(f.document.querySelector('#displayDialog').open, false);
    assert.deepEqual(f.prefs().projects[PROJECT_A].display.metadataColumns, ['DOI']);
    assert.equal(f.document.querySelector('td.metadata-cell[data-metadata="DOI"]').textContent, '—');
  } finally { f.cleanup(); }
});

test('metadata cells render missing values and unsafe text safely and cannot become editable AI fields', async () => {
  const f = await ui({ saved: { version: 1, projects: { [PROJECT_A]: {
    display: { showTags: true, metadataColumns: ['title', 'DOI', 'creators'] },
    fields: [{ id: 'custom_design', label: '研究设计', requirement: '仅填写原文研究设计。', visible: true, archived: false }],
  } } } });
  try {
    const unsafe = '<img src=x onerror="window.metadataInjected=true"><script>window.metadataInjected=true</script>';
    f.row.metadata = { title: unsafe, creators: '张三；李四' };
    f.run('render()');
    const titleCell = f.document.querySelector('td.metadata-cell[data-metadata="title"]');
    assert.equal(titleCell.textContent, unsafe);
    assert.equal(titleCell.querySelector('img,script'), null);
    assert.equal(f.window.metadataInjected, undefined);
    assert.equal(f.document.querySelector('td.metadata-cell[data-metadata="DOI"]').textContent, '—');
    assert.equal(f.document.querySelector('td.metadata-cell[data-metadata="creators"]').textContent, '张三；李四');
    await f.dblclick(titleCell);
    assert.equal(f.run('state.editing'), null);
    assert.equal(f.document.querySelector('#inlineValue'), null);
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), false);
    assert.equal(f.saves.length, 0);
    await f.click(f.document.querySelector('.ai-summary'));
    assert.deepEqual(clone(f.run('aiManager.fields.map(field => field.id)')), ['custom_design']);
    assert.equal(f.document.querySelector('[data-ai-field="title"], [data-ai-field="DOI"], [data-ai-field="creators"]'), null);
    await f.run('aiManager.generate()');
    const payload = JSON.parse(f.apiCalls[0].options.body);
    const content = payload.messages.at(-1).content;
    const packet = JSON.parse(content.slice(content.indexOf('{')));
    assert.deepEqual(packet.requestedFields.map(field => field.id), ['custom_design']);
    assert.equal(f.batchSaves.length, 0, 'generating a draft does not write metadata or analyses');
  } finally { f.cleanup(); }
});

test('filled CSV includes the selected read-only metadata while the fill-in template keeps its original schema', async () => {
  const f = await ui({ saved: { version: 1, projects: { [PROJECT_A]: {
    display: { showTags: false, metadataColumns: ['DOI', 'year', 'title'] },
  } } } });
  try {
    f.row.metadata = { DOI: '10.1234/read-only', year: '2024', title: '元数据标题,含逗号' };
    f.row.values.findings = '已有分析';
    f.run('render()');
    f.queueFile({ name: '包含元数据.csv' });
    await f.click(f.document.querySelector('#export'));
    const csv = Table.parse(f.fileWrites.at(-1).text);
    const metadataIndexes = csv.headers.map((header, index) => ({ id: header.match(/\[zotero:([^\]]+)\]$/)?.[1], index })).filter(column => column.id);
    assert.deepEqual(metadataIndexes.map(column => column.id), ['DOI', 'year', 'title']);
    assert.ok(metadataIndexes.every(column => csv.headers[column.index].startsWith('Zotero · ')));
    assert.deepEqual(metadataIndexes.map(column => csv.records[0].cells[column.index]), ['10.1234/read-only', '2024', '元数据标题,含逗号']);
    assert.equal(csv.records[0].cells[csv.headers.indexOf('核心结论')], '已有分析');
    await f.click(f.document.querySelector('#exportTemplate'));
    f.queueFile({ name: '仍然只填分析的模板.csv' });
    await f.click(f.document.querySelector('#templateSave'));
    const template = Table.parse(f.fileWrites.at(-1).text);
    assert.equal(template.headers.some(header => header.includes('[zotero:')), false);
    assert.deepEqual(template.headers.slice(10), clone(f.run('activeFields().map(field => `${field.label} [${field.id}]`)')));
    assert.ok(template.records[1].cells.slice(10).every(value => value === ''));
    assert.equal(f.apiCalls.length + f.saves.length + f.batchSaves.length + f.importSaves.length, 0);
  } finally { f.cleanup(); }
});

test('read error leaves a clear retry state and disables export', async () => {
  const f = await ui({ fail: true });
  try {
    assert.equal(f.document.querySelector('#status').textContent, '加载失败');
    assert.ok(f.document.querySelector('#empty').textContent.includes('模拟读取失败'));
    assert.equal(f.document.querySelector('#export').disabled, true);
  } finally { f.cleanup(); }
});

test('double-clicking a cell starts direct table editing without covering the other columns', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('remarks'));
    assert.ok(f.cell('remarks').querySelector('#inlineValue'), f.logs.map(error => error.stack).join('\n'));
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), false);
    assert.ok(f.cell('findings').textContent.includes('双击'));
    f.document.querySelector('#inlineValue').value = '项目备注';
    await f.click(f.document.querySelector('#inlineSave'));
    assert.equal(f.row.values.remarks, '项目备注');
    assert.equal(f.document.querySelector('#inlineValue'), null);
    assert.ok(f.cell('remarks').textContent.includes('项目备注'));
    assert.ok(f.document.querySelector('#saveStatus').textContent.includes('已保存'));
    assert.equal(f.saves.length, 1);
  } finally { f.cleanup(); }
});

test('single-clicking empty or filled cells leaves the matrix in reading mode', async () => {
  const f = await ui();
  try {
    await f.click(f.cell('remarks'));
    assert.equal(f.document.querySelector('#inlineValue'), null);
    assert.equal(f.run('state.editing'), null);
    f.row.values.remarks = '可直接阅读和选择的文字。';
    f.run('render()');
    await f.click(f.cell('remarks').querySelector('.cell-text'));
    assert.equal(f.document.querySelector('#inlineValue'), null);
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), false);
    assert.equal(f.run('state.editing'), null);
    assert.equal(f.saves.length, 0);
  } finally { f.cleanup(); }
});

test('double-clicking selected text edits the cell even when a reading selection is active', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '双击这个词进入编辑。';
    f.run('render()');
    f.window.getSelection = () => ({ isCollapsed: false, toString: () => '这个词', removeAllRanges() {} });
    assert.equal(f.run(`highlightManager.capture({element:document.querySelector('td[data-field="remarks"] .cell-text'), start:2,end:5})`), true);
    assert.equal(f.run('highlightManager.isOpen()'), true);
    await f.dblclick(f.cell('remarks').querySelector('.cell-text'));
    assert.equal(f.document.querySelector('#inlineValue').value, '双击这个词进入编辑。');
    assert.equal(f.run('highlightManager.isOpen()'), false, 'an editing cell must not retain a reading toolbar');
    assert.equal(f.saves.length, 0);
  } finally { f.cleanup(); }
});

test('expanding and returning to the table preserves the same unsaved multiline draft', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('remarks'));
    const draft = '第一行：还没有保存\n第二行：包含逗号、引号“内容”\n' + '长文本。'.repeat(80);
    f.document.querySelector('#inlineValue').value = draft;
    await f.click(f.document.querySelector('#inlineExpand'));
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), true);
    assert.equal(f.document.querySelector('#editValue').value, draft);
    assert.equal(f.saves.length, 0);
    f.document.querySelector('#editValue').value += '\n弹窗补充';
    await f.click(f.document.querySelector('#editCollapse'));
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), false);
    assert.equal(f.document.querySelector('#inlineValue').value, draft + '\n弹窗补充');
    assert.equal(f.saves.length, 0);
    await f.run('saveEditor()');
    assert.equal(f.row.values.remarks, draft + '\n弹窗补充');
    assert.equal(f.saves[0].expected, '');
  } finally { f.cleanup(); }
});

test('the explicit long-text control opens a modal and can save without first creating an inline editor', async () => {
  const f = await ui();
  try {
    await f.click(f.cell('remarks').querySelector('.expand-cell'));
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), true);
    assert.equal(f.document.querySelector('#inlineValue'), null);
    f.document.querySelector('#editValue').value = '从弹窗直接填写';
    await f.run('saveEditor()');
    assert.equal(f.row.values.remarks, '从弹窗直接填写');
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), false);
  } finally { f.cleanup(); }
});

test('returning from the popup does not lose a draft when a deferred search hides its row', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('remarks'));
    f.document.querySelector('#inlineValue').value = '筛选变化也不能丢失的草稿';
    f.document.querySelector('#search').value = 'no-matching-paper';
    f.run('render()');
    await f.click(f.document.querySelector('#inlineExpand'));
    await f.click(f.document.querySelector('#editCollapse'));
    const editor = f.document.querySelector('#inlineValue') ||
      (f.document.querySelector('#editDialog').hasAttribute('open') && f.document.querySelector('#editValue'));
    assert.ok(editor, 'an unsaved draft must stay in an editable control');
    assert.equal(editor.value, '筛选变化也不能丢失的草稿');
    assert.equal(f.saves.length, 0);
  } finally { f.cleanup(); }
});

test('a save conflict keeps the inline draft and prevents switching to another cell', async () => {
  const f = await ui();
  try {
    f.repo.saveField = async () => { throw new Error('冲突：别处已修改'); };
    await f.dblclick(f.cell('remarks'));
    const input = f.document.querySelector('#inlineValue');
    input.value = '不能丢失的草稿';
    await f.dblclick(f.cell('findings'));
    assert.equal(f.document.querySelector('#inlineValue'), input);
    assert.equal(input.value, '不能丢失的草稿');
    assert.ok(f.document.querySelector('#inlineError').textContent.includes('冲突'));
    assert.equal(f.row.values.remarks, '');
    assert.equal(f.cell('findings').querySelector('textarea'), null);
  } finally { f.cleanup(); }
});

test('a modal save failure also keeps text available for recovery', async () => {
  const f = await ui();
  try {
    f.repo.saveField = async () => { throw new Error('模拟保存失败'); };
    await f.run("openEditor(state.rows[0], C.fieldByID('remarks'), 'modal')");
    f.document.querySelector('#editValue').value = '弹窗草稿';
    assert.equal(await f.run('saveEditor()'), false);
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), true);
    assert.equal(f.document.querySelector('#editValue').value, '弹窗草稿');
    assert.ok(f.document.querySelector('#editError').textContent.includes('模拟保存失败'));
    assert.equal(f.row.values.remarks, '');
  } finally { f.cleanup(); }
});

test('render requests do not replace an active draft and refusing discard keeps the project unchanged', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('remarks'));
    const input = f.document.querySelector('#inlineValue');
    input.value = '仍在编辑';
    f.run('render()');
    assert.equal(f.document.querySelector('#inlineValue'), input);
    f.window.confirm = () => false;
    await f.run(`selectProject('${PROJECT_B}')`);
    assert.equal(f.run('state.project.id'), PROJECT_A);
    assert.equal(f.document.querySelector('#inlineValue').value, '仍在编辑');
    assert.equal(f.loads.length, 1);
  } finally { f.cleanup(); }
});

test('inline keyboard handling leaves IME composition and Shift+Enter unsaved, then Enter commits', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('remarks'));
    const input = f.document.querySelector('#inlineValue');
    input.value = '输入法组合中的中文';
    await f.key(input, 'Enter', { isComposing: true });
    assert.equal(f.saves.length, 0);
    assert.equal(f.document.querySelector('#inlineValue'), input);
    await f.key(input, 'Enter', { shiftKey: true });
    assert.equal(f.saves.length, 0);
    await f.key(input, 'Enter');
    assert.equal(f.saves.length, 1);
    assert.equal(f.row.values.remarks, '输入法组合中的中文');
    assert.equal(f.document.querySelector('#inlineValue'), null);
  } finally { f.cleanup(); }
});

test('Tab commits a cell before editing the next visible field', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('task_evidence'));
    const input = f.document.querySelector('#inlineValue');
    input.value = '任务描述';
    await f.key(input, 'Tab');
    assert.equal(f.row.values.task_evidence, '任务描述');
    assert.ok(f.cell('outcomes').querySelector('#inlineValue'));
    assert.equal(f.saves.length, 1);
  } finally { f.cleanup(); }
});

test('canceling an inline draft does not save it or reopen the editor through cell bubbling', async () => {
  const f = await ui();
  try {
    await f.dblclick(f.cell('remarks'));
    f.document.querySelector('#inlineValue').value = '不保存的草稿';
    await f.click(f.document.querySelector('#inlineCancel'));
    assert.equal(f.document.querySelector('#inlineValue'), null);
    assert.equal(f.run('state.editing'), null);
    assert.equal(f.row.values.remarks, '');
    assert.equal(f.saves.length, 0);
  } finally { f.cleanup(); }
});

test('project field preferences migrate legacy columns and remain isolated when switching projects', async () => {
  const f = await ui({ saved: { version: 1, projects: { [PROJECT_A]: { columns: ['remarks', 'findings'] } } } });
  try {
    assert.deepEqual([...f.document.querySelectorAll('td[data-field]')].map(td => td.getAttribute('data-field')), ['findings', 'remarks']);
    assert.equal(f.loads[0].fields.find(field => field.id === 'remarks').visible, true);
    assert.equal(f.loads[0].fields.find(field => field.id === 'outcomes').visible, false);
    f.run('showColumns()');
    await settle();
    f.context.nextFields = [
      { id: 'custom_project_goal', label: '项目目标', requirement: '注明与项目目标的关系及原文页码。', visible: true, archived: false, aliases: [] },
      ...f.run('allFields()').map(field => ({ ...field, archived: true, visible: false })),
    ];
    await f.run('fieldManager.options.saveFields(nextFields)');
    f.run('fieldManager.close(true)');
    assert.ok(f.cell('custom_project_goal'));
    assert.ok(f.document.querySelector('#grid thead').textContent.includes('注明与项目目标的关系'));
    assert.equal(f.loads.at(-1).fields[0].id, 'custom_project_goal');
    await f.run(`selectProject('${PROJECT_B}')`);
    assert.equal(f.cell('custom_project_goal'), null);
    assert.ok(f.cell('outcomes'));
    assert.equal(f.prefs().projects[PROJECT_B].fields.some(field => field.id === 'custom_project_goal'), false);
    await f.run(`selectProject('${PROJECT_A}')`);
    assert.ok(f.cell('custom_project_goal'));
    assert.equal(f.cell('outcomes'), null);
    assert.equal(f.prefs().projects[PROJECT_A].fields[0].requirement, '注明与项目目标的关系及原文页码。');
  } finally { f.cleanup(); }
});

test('failed preference persistence leaves project field definitions and visible columns unchanged', async () => {
  const f = await ui();
  try {
    const fieldsBefore = clone(f.run('allFields()'));
    const projectFieldsBefore = clone(f.run('state.project.fields'));
    const preferencesBefore = f.prefs();
    const columnsBefore = [...f.document.querySelectorAll('td[data-field]')].map(td => td.getAttribute('data-field'));
    f.context.changedFields = fieldsBefore.map(field => field.id === 'remarks'
      ? { ...field, label: '尚未成功保存的名称', requirement: '尚未成功保存的填写要求' } : field);
    f.context.originalPrefSet = f.run('Z.Prefs.set');
    f.run("Z.Prefs.set = () => { throw new Error('模拟偏好写入失败'); }");
    assert.throws(() => f.run('savePrefs({ fields: changedFields })'), /模拟偏好写入失败/);
    assert.deepEqual(clone(f.run('allFields()')), fieldsBefore);
    assert.deepEqual(clone(f.run('state.project.fields')), projectFieldsBefore);
    assert.deepEqual(f.prefs(), preferencesBefore);
    f.run('render()');
    assert.deepEqual([...f.document.querySelectorAll('td[data-field]')].map(td => td.getAttribute('data-field')), columnsBefore);
    assert.ok(!f.document.querySelector('#grid thead').textContent.includes('尚未成功保存的名称'));
    f.run('Z.Prefs.set = originalPrefSet; savePrefs({ fields: changedFields }); render();');
    assert.equal(f.prefs().projects[PROJECT_A].fields.find(field => field.id === 'remarks').label, '尚未成功保存的名称');
    assert.ok(f.document.querySelector('#grid thead').textContent.includes('尚未成功保存的名称'));
  } finally { f.cleanup(); }
});

test('failed template persistence does not expose an unsaved template to other projects', async () => {
  const f = await ui();
  try {
    await f.run('showColumns()');
    const preferencesBefore = f.prefs();
    const templatesBefore = clone(f.run('fieldManager.options.getTemplates()'));
    f.context.changedTemplates = [{ id: 'template_unsaved', name: '尚未成功保存的模板', fields: clone(f.run('allFields()')) }];
    f.context.originalPrefSet = f.run('Z.Prefs.set');
    f.run("Z.Prefs.set = () => { throw new Error('模拟模板写入失败'); }");
    await assert.rejects(f.run('fieldManager.options.saveTemplates(changedTemplates)'), /模拟模板写入失败/);
    assert.deepEqual(clone(f.run('fieldManager.options.getTemplates()')), templatesBefore);
    assert.deepEqual(f.prefs(), preferencesBefore);
    f.run('Z.Prefs.set = originalPrefSet; fieldManager.close(true)');
    await f.run(`selectProject('${PROJECT_B}')`);
    assert.deepEqual(clone(f.run('fieldManager.options.getTemplates()')), templatesBefore);
  } finally { f.cleanup(); }
});


test('main AI action prepares current project fields and local paper text without sending a request', async () => {
  const f = await ui({ saved: { version: 1, projects: { [PROJECT_A]: { fields: [
    { id: 'custom_project_method', label: '本项目方法', requirement: '仅记录研究设计与样本', visible: true, archived: false },
    { id: 'remarks', label: '我的备注', requirement: '个人想法', visible: true, archived: false },
  ] } } } });
  try {
    f.row.values.remarks = 'PRIVATE_REMARK_DO_NOT_SEND';
    f.row.annotations.push({ text: 'PRIVATE_ANNOTATION_DO_NOT_SEND', comment: 'PRIVATE_COMMENT_DO_NOT_SEND' });
    await f.click(f.document.querySelector('.ai-summary'));
    assert.equal(f.run('aiManager.isOpen()'), true);
    assert.equal(f.apiCalls.length, 0);
    assert.equal(f.keyCalls.length, 0);
    assert.equal(f.batchSaves.length, 0);
    assert.equal(f.sourceCalls.length, 1);
    assert.equal(f.document.querySelector('[data-ai-field="custom_project_method"]').checked, true);
    assert.ok(!f.document.querySelector('[data-ai-field="remarks"]').checked);
    assert.equal(f.document.querySelector('#rg-ai-endpoint').textContent, 'https://api.example.test/v1');
    await f.run('aiManager.generate()');
    assert.equal(f.apiCalls.length, 1);
    assert.deepEqual(f.keyCalls, ['https://api.example.test/v1/chat/completions']);
    assert.equal(f.apiCalls[0].url, 'https://api.example.test/v1/chat/completions');
    assert.equal(f.apiCalls[0].options.headers.Authorization, 'Bearer fixture-only-key');
    const body = f.apiCalls[0].options.body;
    const payload = JSON.parse(body);
    const packetText = payload.messages.at(-1).content;
    const packet = JSON.parse(packetText.slice(packetText.indexOf('{')));
    assert.equal(packet.project.name, '测试项目 A');
    assert.deepEqual(packet.requestedFields, [{ id: 'custom_project_method', label: '本项目方法', requirement: '仅记录研究设计与样本' }]);
    assert.equal(packet.paper.title, f.row.title);
    assert.equal(packet.paper.abstract, '模拟公开摘要');
    assert.ok(packet.source.text.includes('论文原文片段'));
    assert.ok(!body.includes('PRIVATE_REMARK_DO_NOT_SEND'));
    assert.ok(!body.includes('PRIVATE_ANNOTATION_DO_NOT_SEND'));
    assert.ok(!body.includes('PRIVATE_COMMENT_DO_NOT_SEND'));
    assert.equal(f.batchSaves.length, 0);
    assert.equal(f.row.values.custom_project_method, undefined);
  } finally { f.cleanup(); }
});

test('changing API destination after preview blocks generation before reading any key or sending paper text', async () => {
  const f = await ui();
  try {
    await f.click(f.document.querySelector('.ai-summary'));
    f.setAIConfig({ ...f.aiConfig(), baseURL: 'https://different.example.test/v1' });
    await f.run('aiManager.generate()');
    assert.equal(f.keyCalls.length, 0);
    assert.equal(f.apiCalls.length, 0);
    assert.equal(f.batchSaves.length, 0);
    assert.ok(f.document.querySelector('#rg-ai-error').textContent.includes('刷新 API 设置'));
  } finally { f.cleanup(); }
});

test('AI drafts update main table values only after explicit aggregate save, preserving unselected human content', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '人工备注保留';
    await f.run('showAI(state.rows[0])');
    await f.run('aiManager.generate()');
    assert.equal(f.apiCalls.length, 1);
    assert.equal(f.batchSaves.length, 0);
    assert.equal(f.row.values.findings, '');
    assert.equal(f.row.values.remarks, '人工备注保留');
    const chosen = f.run('[...aiManager.applySelected]');
    assert.ok(chosen.includes('findings'));
    assert.ok(!chosen.includes('remarks'));
    assert.equal(await f.run('aiManager.apply()'), true);
    assert.equal(f.batchSaves.length, 1, 'all checked fields use one aggregate repository operation');
    assert.equal(f.batchSaves[0].projectID, PROJECT_A);
    assert.equal(f.batchSaves[0].expected.findings, '');
    assert.deepEqual(f.batchSaves[0].options.expectedHighlights.findings, []);
    assert.equal(f.batchSaves[0].changes.remarks, undefined);
    assert.equal(f.row.values.findings, 'AI 草稿：核心结论');
    assert.equal(f.row.values.remarks, '人工备注保留');
    assert.equal(f.row.noteKey, 'AI_NOTEKEY');
    assert.equal(f.row.noteURL, 'zotero://select/library/items/AI_NOTEKEY');
    assert.ok(f.cell('findings').textContent.includes('AI 草稿：核心结论'));
    assert.ok(f.document.querySelector('#saveStatus').textContent.includes('AI 草稿已写入'));
  } finally { f.cleanup(); }
});

test('API config changed during endpoint-bound key lookup never sends the retrieved key', async () => {
  const f = await ui();
  try {
    await f.run('showAI(state.rows[0])');
    let resolveKey;
    f.keyProvider(() => new Promise(resolve => { resolveKey = resolve; }));
    const request = f.run('aiManager.generate()');
    await settle();
    assert.deepEqual(f.keyCalls, ['https://api.example.test/v1/chat/completions']);
    f.setAIConfig({ ...f.aiConfig(), baseURL: 'https://changed.example.test/v1' });
    resolveKey('should-never-be-sent');
    await request;
    assert.equal(f.apiCalls.length, 0);
    assert.ok(f.document.querySelector('#rg-ai-error').textContent.includes('API 设置已变化'));
    assert.equal(f.row.values.findings, '');
  } finally { f.cleanup(); }
});

test('template export uses the filtered papers and every active project field without existing analyses', async () => {
  const fields = [
    { id: 'custom_design', label: '本项目研究设计', requirement: '说明研究设计、样本与原文页码。', visible: true, archived: false },
    { id: 'custom_context', label: '本项目场景', requirement: '仅填写论文明确研究的应用场景。', visible: false, archived: false },
    { id: 'remarks', label: '我的备注', requirement: '填写与本项目有关的个人想法。', visible: true, archived: false },
    { id: 'retired_field', label: '已移出字段', requirement: '不应导出的旧字段。', visible: false, archived: true },
  ];
  const f = await ui({ saved: { version: 1, projects: { [PROJECT_A]: { fields } } } });
  try {
    f.row.values = { custom_design: 'PRIVATE_EXISTING_ANALYSIS', custom_context: 'PRIVATE_HIDDEN_ANALYSIS',
      remarks: 'PRIVATE_HUMAN_REMARK', retired_field: 'PRIVATE_ARCHIVED_ANALYSIS' };
    f.context.excludedRow = { ...f.row, id: 2, key: 'OTHERKEY', title: '不在本次筛选中的论文',
      itemURL: 'zotero://select/library/items/OTHERKEY', values: { ...f.row.values } };
    f.run('state.rows.push(excludedRow)');
    await f.input(f.document.querySelector('#search'), f.row.title);
    f.run('render()');
    assert.equal(f.run('state.shown.length'), 1);
    assert.equal(f.cell('custom_context'), null, 'hidden fields need not be displayed to be exported');

    for (const format of ['csv', 'tsv']) {
      await f.click(f.document.querySelector('#exportTemplate'));
      assert.equal(f.document.querySelector('#templateDialog').open, true);
      assert.match(f.document.querySelector('#templateContext').textContent, /1 篇文献.*3 个字段/);
      assert.match(f.document.querySelector('#templateInstructions').value, /论文原文或 PDF/);
      assert.equal(f.pickerCalls.length, f.fileWrites.length, 'opening export does not prompt or save automatically');
      await f.input(f.document.querySelector('#templateFormat'), format, 'change');
      const path = f.queueFile({ name: '待填模板.' + format });
      await f.click(f.document.querySelector('#templateSave'));
      assert.equal(f.document.querySelector('#templateDialog').open, false);
      const exported = f.fileWrites.at(-1);
      assert.equal(exported.path, path);
      assert.ok(exported.text.startsWith('\ufeff'));
      assert.ok(!exported.text.includes('PRIVATE_'));
      assert.ok(!exported.text.includes('不在本次筛选中的论文'));
      const table = Table.parse(exported.text);
      assert.equal(table.delimiter, format === 'tsv' ? '\t' : ',');
      assert.deepEqual(table.headers.slice(10), ['本项目研究设计 [custom_design]', '本项目场景 [custom_context]', '我的备注 [remarks]']);
      assert.deepEqual(table.records[0].cells.slice(10), fields.filter(field => !field.archived).map(field => field.requirement));
      assert.equal(table.records[0].cells[0], '填写要求');
      assert.equal(table.records.length, 2);
      const paper = table.records[1].cells;
      assert.equal(paper[0], '文献');
      assert.equal(paper[2], PROJECT_A);
      assert.equal(paper[3], f.row.itemURL);
      assert.equal(paper[4], f.row.key);
      assert.deepEqual(paper.slice(10), ['', '', '']);
      assert.equal(f.pickerCalls.at(-1).defaultExtension, format);
      assert.match(f.pickerCalls.at(-1).defaultString, new RegExp('待填模板\\.' + format + '$'));
    }
    assert.equal(f.saves.length + f.batchSaves.length + f.importSaves.length, 0);
    assert.equal(f.apiCalls.length + f.keyCalls.length, 0);
    assert.equal(f.row.values.remarks, 'PRIVATE_HUMAN_REMARK');
  } finally { f.cleanup(); }
});

test('file import previews all current-project papers and updates the matrix only after aggregate commit', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '人工备注保留';
    const other = { ...f.row, id: 2, key: 'SECOND01', title: '筛选外的同项目论文', citekey: 'Second2026',
      itemURL: 'zotero://select/library/items/SECOND01', values: { ...C.blankValues(), remarks: '第二篇人工备注' } };
    f.context.other = other;
    f.run('state.rows.push(other)');
    f.document.querySelector('#search').value = f.row.title;
    f.run('render()');
    const text = [
      '项目标识\t文献标识\t标题\t核心结论 [findings]\t我的备注 [remarks]',
      [PROJECT_A, f.row.itemURL, f.row.title, '外部 AI 结论一', '不应覆盖人工备注'].join('\t'),
      [PROJECT_A, other.itemURL, other.title, '外部 AI 结论二', ''].join('\t'),
    ].join('\r\n');
    const path = f.queueFile({ name: '外部AI结果.tsv', text });
    await f.click(f.document.querySelector('#importTable'));
    assert.equal(f.run('tableManager.isOpen()'), true);
    assert.equal(f.pickerCalls.length, 0);
    assert.equal(f.importSaves.length, 0);
    await f.click(f.document.querySelector('#rg-table-file'));
    assert.equal(f.fileReads.length, 1);
    assert.equal(f.fileReads[0].path, path);
    assert.equal(f.fileReads[0].charset, 'utf-8');
    assert.equal(f.document.querySelector('#rg-table-source').value, text);
    assert.equal(f.run('tableManager.plan'), null);
    assert.equal(f.importSaves.length, 0);
    await f.click(f.document.querySelector('#rg-table-parse'));
    assert.equal(f.run('tableManager.plan.stats.ready'), 2, 'import uses the project, including papers hidden by the current search');
    assert.match(f.document.querySelector('#rg-table-preview').textContent, /外部 AI 结论一/);
    assert.match(f.document.querySelector('#rg-table-preview').textContent, /外部 AI 结论二/);
    assert.equal(f.importSaves.length, 0);
    assert.equal(f.row.values.findings, '');
    assert.equal(other.values.findings, '');
    assert.equal(f.document.querySelector('#rg-table-apply').disabled, false);

    let finishCommit;
    const originalImport = f.repo.importRows;
    f.repo.importRows = async (...args) => {
      const result = await originalImport(...args);
      await new Promise(resolve => { finishCommit = resolve; });
      return result;
    };
    await f.click(f.document.querySelector('#rg-table-apply'));
    assert.equal(f.importSaves.length, 1, 'all selected papers use a single repository transaction');
    assert.equal(f.importSaves[0].projectID, PROJECT_A);
    assert.deepEqual(clone(f.importSaves[0].operations.map(operation => ({ id: operation.row.id, changes: operation.changes, expected: operation.expected }))), [
      { id: 1, changes: { findings: '外部 AI 结论一' }, expected: { findings: '' } },
      { id: 2, changes: { findings: '外部 AI 结论二' }, expected: { findings: '' } },
    ]);
    assert.ok(f.importSaves[0].fields.some(field => field.id === 'remarks'));
    assert.equal(f.run('state.saving'), true);
    assert.equal(f.document.querySelector('#rg-table-apply').disabled, true);
    assert.equal(f.row.values.findings, '', 'the visible table stays unchanged while the database commit is pending');
    assert.equal(other.values.findings, '');
    assert.equal(f.row.noteKey, undefined);
    finishCommit();
    await settle();
    assert.equal(f.run('state.saving'), false);
    assert.equal(f.row.values.findings, '外部 AI 结论一');
    assert.equal(other.values.findings, '外部 AI 结论二');
    assert.equal(f.row.values.remarks, '人工备注保留');
    assert.equal(other.values.remarks, '第二篇人工备注');
    assert.equal(f.rowB.values.findings, '', 'the same paper in another project keeps its own analysis');
    assert.equal(f.row.noteKey, 'TBLNOTE1');
    assert.equal(f.row.noteURL, 'zotero://select/library/items/TBLNOTE1');
    assert.ok(f.cell('findings').textContent.includes('外部 AI 结论一'));
    assert.match(f.document.querySelector('#saveStatus').textContent, /已导入所选表格内容/);
    assert.match(f.document.querySelector('#rg-table-status').textContent, /已导入 2 篇文献/);
    assert.equal(f.document.querySelector('#rg-table-apply').disabled, true);
    assert.equal(await f.run('tableManager.apply()'), false);
    assert.equal(f.importSaves.length, 1);
    assert.equal(f.apiCalls.length + f.keyCalls.length + f.saves.length + f.batchSaves.length, 0);
  } finally { f.cleanup(); }
});

test('failed import keeps the file, mappings, selection and preview for retry without changing table values', async () => {
  const f = await ui();
  try {
    f.row.values.findings = '已有人工分析';
    f.row.values.remarks = '原有个人备注';
    f.run('render()');
    const text = '标题,外部AI回答\r\n未批注文献,"新的结论，含逗号\n和第二行"\r\n';
    f.queueFile({ name: '自定义列名.csv', text });
    await f.click(f.document.querySelector('#importTable'));
    await f.click(f.document.querySelector('#rg-table-file'));
    await f.click(f.document.querySelector('#rg-table-parse'));
    assert.equal(f.run('tableManager.plan.stats.ready'), 0);
    await f.input(f.document.querySelector('[data-table-column="1"]'), 'field:findings', 'change');
    await f.input(f.document.querySelector('#rg-table-overwrite'), true, 'change');
    assert.equal(f.run('tableManager.plan.stats.ready'), 1);
    assert.match(f.document.querySelector('#rg-table-preview').textContent, /已有人工分析/);
    assert.equal(f.importSaves.length, 0);
    const mappingsBefore = clone(f.run('tableManager.mappings'));
    const selectionBefore = clone(f.run('[...tableManager.selected]'));
    const planBefore = clone(f.run('tableManager.plan.rows.map(({ line, changes, expected, status }) => ({ line, changes, expected, status }))'));
    const originalImport = f.repo.importRows;
    f.repo.importRows = async (...args) => { await originalImport(...args); throw new Error('模拟事务失败：第二篇文献已被修改'); };
    await f.click(f.document.querySelector('#rg-table-apply'));
    assert.equal(f.importSaves.length, 1);
    assert.equal(f.run('state.saving'), false);
    assert.equal(f.run('tableManager.isOpen()'), true);
    assert.equal(f.run('tableManager.applied'), false);
    assert.equal(f.document.querySelector('#rg-table-source').value, text);
    assert.equal(f.document.querySelector('#rg-table-file-name').textContent, '自定义列名.csv');
    assert.deepEqual(clone(f.run('tableManager.mappings')), mappingsBefore);
    assert.deepEqual(clone(f.run('[...tableManager.selected]')), selectionBefore);
    assert.deepEqual(clone(f.run('tableManager.plan.rows.map(({ line, changes, expected, status }) => ({ line, changes, expected, status }))')), planBefore);
    assert.equal(f.document.querySelector('#rg-table-overwrite').checked, true);
    assert.equal(f.document.querySelector('#rg-table-apply').disabled, false);
    assert.match(f.document.querySelector('#rg-table-error').textContent, /模拟事务失败/);
    assert.match(f.document.querySelector('#rg-table-status').textContent, /本次未写入/);
    assert.equal(f.row.values.findings, '已有人工分析');
    assert.equal(f.row.values.remarks, '原有个人备注');
    assert.ok(f.cell('findings').textContent.includes('已有人工分析'));
    assert.equal(f.row.noteKey, undefined);
    assert.equal(f.row.noteURL, undefined);
    f.repo.importRows = originalImport;
    await f.click(f.document.querySelector('#rg-table-apply'));
    assert.equal(f.importSaves.length, 2);
    assert.equal(f.row.values.findings, '新的结论，含逗号\n和第二行');
    assert.equal(f.row.values.remarks, '原有个人备注');
    assert.equal(f.document.querySelector('#rg-table-apply').disabled, true);
    assert.equal(f.apiCalls.length + f.keyCalls.length + f.saves.length + f.batchSaves.length, 0);
  } finally { f.cleanup(); }
});


test('per-generation summary detail reaches the prompt while preserving the saved default and API destination checks', async () => {
  const f = await ui();
  try {
    await f.run('showAI(state.rows[0])');
    assert.equal(f.run('aiManager.summaryDetail'), 'brief');
    await f.click(f.document.querySelector('[data-ai-detail="comprehensive"]'));
    assert.equal(f.apiCalls.length, 0);
    await f.run('aiManager.generate()');
    assert.equal(f.apiCalls.length, 1, 'changing the detail must not trigger a stale API configuration error');
    const payload = JSON.parse(f.apiCalls[0].options.body);
    assert.ok(payload.messages[0].content.includes('全面'));
    const user = payload.messages.at(-1).content;
    const packet = JSON.parse(user.slice(user.indexOf('{')));
    assert.equal(packet.summaryDetail.id, 'comprehensive');
    assert.ok(!f.aiConfig().summaryDetail || f.aiConfig().summaryDetail === 'brief');
    assert.equal(f.batchSaves.length, 0);
    f.setAIConfig({ ...f.aiConfig(), model: 'changed-model' });
    await f.run('aiManager.generate()');
    assert.equal(f.apiCalls.length, 1, 'actual provider/model changes must still block dispatch');
    assert.ok(f.document.querySelector('#rg-ai-error').textContent.includes('API 设置已变化'));
  } finally { f.cleanup(); }
});


test('paper checkboxes retain selected papers across filters and reset for another project', async () => {
  const f = await ui();
  try {
    f.run('state.rows.push({...state.rows[0], id:2, key:"PAPER002", title:"第二篇文献", values:C.blankValues(), highlights:{}}); render()');
    await f.click(f.document.querySelector('#selectShown'));
    assert.equal(f.run('selectedRows().length'), 2);
    assert.equal(f.document.querySelectorAll('[data-paper-select]').length, 2);
    assert.ok([...f.document.querySelectorAll('[data-paper-select]')].every(box => box.checked));
    f.document.querySelector('#search').value = '第二篇';
    f.run('render()');
    assert.equal(f.document.querySelectorAll('[data-paper-select]').length, 1);
    assert.ok(f.document.querySelector('#selectionCount').textContent.includes('已选 2 篇'));
    assert.ok(f.document.querySelector('#selectionCount').textContent.includes('筛选外 1 篇'));
    await f.run('selectProject(state.projects[1].id)');
    assert.equal(f.run('selectedRows().length'), 0);
    assert.equal(f.document.querySelector('#batchAI').disabled, true);
  } finally { f.cleanup(); }
});

test('selected papers generate independent batch requests and apply once after explicit aggregate confirmation', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '人工备注，不发送或覆盖';
    f.run('state.rows.push({...state.rows[0], id:2, key:"PAPER002", title:"第二篇文献", values:C.blankValues(), highlights:{}}); render(); selectShown()');
    await f.click(f.document.querySelector('#batchAI'));
    assert.equal(f.run('batchManager.isOpen()'), true);
    assert.equal(f.sourceCalls.length, 2);
    assert.equal(f.apiCalls.length, 0);
    assert.equal(f.importSaves.length, 0);
    await f.run('batchManager.generate()');
    assert.equal(f.apiCalls.length, 2);
    const packets = f.apiCalls.map(call => {
      const user = JSON.parse(call.options.body).messages.at(-1).content;
      return JSON.parse(user.slice(user.indexOf('{')));
    });
    assert.deepEqual(packets.map(packet => packet.paper.title), ['未批注文献', '第二篇文献']);
    assert.ok(!packets[0].requestedFields.some(field => field.id === 'remarks'));
    assert.ok(packets[1].requestedFields.some(field => field.id === 'remarks'));
    assert.ok(!f.apiCalls.some(call => call.options.body.includes('人工备注，不发送或覆盖')));
    assert.equal(f.importSaves.length, 0);
    assert.equal(await f.run('batchManager.apply()'), true);
    assert.equal(f.importSaves.length, 1);
    assert.equal(f.importSaves[0].operations.length, 2);
    assert.equal(f.row.values.remarks, '人工备注，不发送或覆盖');
    assert.equal(f.row.values.findings, 'AI 草稿：核心结论');
    assert.equal(f.run('state.rows[1].values.findings'), 'AI 草稿：核心结论');
  } finally { f.cleanup(); }
});

test('reading selections save exact highlights immediately without any editor or preview step', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '关键结果。第二句。';
    f.run('render()');
    f.window.getSelection = () => ({ isCollapsed:false, toString:()=>'关键结果', removeAllRanges() {} });
    await f.click(f.cell('remarks'));
    assert.equal(f.document.querySelector('#inlineValue'), null, 'drag-selected text must remain available for highlighting');
    assert.equal(f.run(`highlightManager.capture({element:document.querySelector('td[data-field="remarks"] .cell-text'), start:0,end:4})`), true);
    assert.equal(f.saves.length, 0, 'selecting text alone must not save');
    assert.equal(f.document.querySelector('#inlineHighlightPreview'), null);
    assert.equal(f.document.querySelector('#editHighlightPreview'), null);
    await f.click(f.document.querySelector('#rg-highlight-selection-toolbar [data-highlight-color="yellow"]'));
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].value, '关键结果。第二句。');
    assert.equal(f.saves[0].expected, '关键结果。第二句。');
    assert.deepEqual(f.saves[0].options.highlights, [{ start:0, end:4, color:'yellow' }]);
    assert.deepEqual(f.saves[0].options.expectedHighlights, []);
    assert.equal(f.cell('remarks').querySelector('[data-rg-highlight="yellow"]').textContent, '关键结果');
    assert.equal(f.row.values.remarks, '关键结果。第二句。');
    assert.equal(f.run('highlightManager.isOpen()'), false);
    assert.equal(f.document.querySelector('#inlineValue'), null);
    assert.equal(f.document.querySelector('#inlineSave'), null);
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), false);
  } finally { f.cleanup(); }
});

test('existing highlights survive textarea edits and a popup roundtrip without editor palettes or previews', async () => {
  const f = await ui();
  try {
    const original = '需要标记的句子。';
    const originalHighlights = [{ start:0, end:4, color:'pink' }];
    f.row.values.remarks = original;
    f.row.highlights.remarks = clone(originalHighlights);
    f.run('render()');
    assert.equal(f.cell('remarks').querySelector('[data-rg-highlight="pink"]').textContent, '需要标记');
    await f.dblclick(f.cell('remarks'));
    const input = f.document.querySelector('#inlineValue');
    assert.equal(input.localName, 'textarea');
    assert.equal(input.value, original);
    assert.equal(f.cell('remarks').querySelector('[data-highlight-color]'), null);
    assert.equal(f.document.querySelector('#inlineHighlightPreview'), null);
    await f.input(input, original + '\n表内补充');
    assert.deepEqual(clone(f.run('state.editing.highlights')), originalHighlights);
    assert.equal(f.saves.length, 0);
    await f.click(f.document.querySelector('#inlineExpand'));
    assert.equal(f.document.querySelector('#editValue').localName, 'textarea');
    assert.equal(f.document.querySelector('#editValue').value, original + '\n表内补充');
    assert.equal(f.document.querySelector('#editDialog [data-highlight-color]'), null);
    assert.equal(f.document.querySelector('#editHighlightPreview'), null);
    assert.equal(f.document.querySelector('#editHighlightTools'), null);
    await f.input(f.document.querySelector('#editValue'), '前言：' + original + '\n表内补充');
    assert.deepEqual(clone(f.run('state.editing.highlights')), [{ start:3, end:7, color:'pink' }]);
    const changed = '前言：' + original + '\n表内补充\n弹窗补充';
    await f.input(f.document.querySelector('#editValue'), changed);
    await f.click(f.document.querySelector('#editCollapse'));
    assert.equal(f.document.querySelector('#inlineValue').value, changed);
    assert.equal(f.cell('remarks').querySelector('[data-highlight-color]'), null);
    assert.equal(f.document.querySelector('#inlineHighlightPreview'), null);
    assert.deepEqual(clone(f.run('state.editing.originalHighlights')), originalHighlights);
    assert.deepEqual(clone(f.run('state.editing.highlights')), [{ start:3, end:7, color:'pink' }]);
    f.window.confirm = () => false;
    await f.click(f.document.querySelector('#inlineCancel'));
    assert.ok(f.document.querySelector('#inlineValue'), 'discarding the edited text still requires confirmation');
    await f.click(f.document.querySelector('#inlineSave'));
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].value, changed);
    assert.equal(f.saves[0].expected, original);
    assert.deepEqual(f.saves[0].options.highlights, [{ start:3, end:7, color:'pink' }]);
    assert.deepEqual(f.saves[0].options.expectedHighlights, originalHighlights);
    assert.equal(f.row.values.remarks, changed);
    assert.equal(f.cell('remarks').querySelector('[data-rg-highlight="pink"]').textContent, '需要标记');
  } finally { f.cleanup(); }
});

// A real browser clamps scroll offsets when the last table rows disappear.
// Model that behavior, which LinkeDOM's plain scrollTop properties omit.
function readingOffsets(f, top = 1400, left = 800) {
  const results = f.document.querySelector('#results');
  let y = top, x = left;
  const hasRows = () => f.document.querySelectorAll('.matrix-table tbody tr').length > 0;
  Object.defineProperties(results, {
    scrollTop: { configurable: true, get() { if (!hasRows()) y = 0; return y; }, set(value) { y = hasRows() ? value : 0; } },
    scrollLeft: { configurable: true, get() { if (!hasRows()) x = 0; return x; }, set(value) { x = hasRows() ? value : 0; } },
  });
  return results;
}

test('highlighting and clearing update only their cell and preserve outer and inner reading offsets', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '关键结果。第二句。';
    f.row.values.findings = '另一列的分析';
    f.run('render()');
    const results = readingOffsets(f);
    const text = f.cell('remarks').querySelector('.cell-text'), other = f.cell('findings');
    text.scrollTop = 130; text.scrollLeft = 25;
    other.querySelector('.cell-text').scrollTop = 72;
    for (const color of ['yellow', null]) {
      assert.equal(f.run(`highlightManager.capture({element:document.querySelector('td[data-field="remarks"] .cell-text'),start:0,end:4})`), true);
      await f.run(`highlightManager.apply(${JSON.stringify(color)})`);
      assert.equal(f.cell('remarks').querySelector('.cell-text'), text, 'keep the original scrollable text container');
      assert.equal(f.cell('findings'), other, 'do not replace unrelated columns or focus targets');
      assert.equal(results.scrollTop, 1400);
      assert.equal(results.scrollLeft, 800);
      assert.equal(text.scrollTop, 130);
      assert.equal(text.scrollLeft, 25);
      assert.equal(other.querySelector('.cell-text').scrollTop, 72);
    }
    assert.equal(text.querySelector('[data-rg-highlight]'), null);
    assert.equal(f.saves.length, 2);
    assert.equal(f.loads.length, 1, 'a local highlight must not force an immediate project load');
  } finally { f.cleanup(); }
});

test('the delayed Zotero notification after a highlight preserves page and cell reading positions', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '关键结果。第二句。';
    f.run('render()');
    const results = readingOffsets(f, 1800, 960), text = f.cell('remarks').querySelector('.cell-text');
    text.scrollTop = 95;
    const saveField = f.repo.saveField;
    f.repo.saveField = async (...args) => { f.notify(); return saveField(...args); };
    assert.equal(f.run(`highlightManager.capture({element:document.querySelector('td[data-field="remarks"] .cell-text'),start:0,end:4})`), true);
    assert.equal(await f.run('highlightManager.apply("green")'), true);
    assert.equal(f.cell('remarks').querySelector('.cell-text'), text);
    await new Promise(resolve => setTimeout(resolve, 720));
    await settle();
    assert.equal(f.loads.length, 2, 'keep real Zotero notifications instead of dropping external changes');
    assert.equal(results.scrollTop, 1800, 'never collapse the table between notification and refreshed data');
    assert.equal(results.scrollLeft, 960);
    assert.equal(f.cell('remarks').querySelector('.cell-text').scrollTop, 95);
    assert.equal(f.cell('remarks').querySelector('[data-rg-highlight="green"]').textContent, '关键结果');
    assert.equal(f.run('state.pendingReload'), false);
  } finally { f.cleanup(); }
});

test('background refresh keeps rows visible and preserves the latest reading position while data arrives', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '长分析内容';
    f.run('render()');
    const results = readingOffsets(f, 2000, 900), cell = f.cell('remarks');
    let finish;
    f.repo.loadProject = () => new Promise(resolve => { finish = resolve; });
    const pending = f.run('reload()');
    assert.equal(f.run('state.loading'), true);
    assert.equal(f.cell('remarks'), cell);
    assert.equal(f.document.querySelector('#grid').hidden, false);
    assert.equal(await f.run('openEditor(state.rows[0], activeFields().find(f=>f.id==="remarks"))'), false,
      'do not open a draft that could be replaced by the incoming refresh');
    results.scrollTop = 1630; results.scrollLeft = 1100;
    cell.querySelector('.cell-text').scrollTop = 120;
    f.row.values.remarks = '外部更新后的分析';
    finish([f.row]); await pending;
    assert.equal(results.scrollTop, 1630, 'use the latest position, not the position before the network/database wait');
    assert.equal(results.scrollLeft, 1100);
    assert.equal(f.cell('remarks').querySelector('.cell-text').scrollTop, 120);
    assert.match(f.cell('remarks').textContent, /外部更新后的分析/);
    assert.equal(f.run('state.loading'), false);
  } finally { f.cleanup(); }
});

test('a changed project selection still clears the previous project during loading', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '甲项目分析不能显示在乙项目下';
    f.run('render()');
    let finish;
    f.repo.loadProject = () => new Promise(resolve => { finish = resolve; });
    const pending = f.run(`selectProject('${PROJECT_B}')`);
    assert.equal(f.run('state.loading'), true);
    assert.equal(f.document.querySelector('#grid tbody').children.length, 0);
    assert.equal(f.document.querySelector('#grid').hidden, true);
    assert.equal(f.document.querySelector('#results').textContent.includes('甲项目分析不能显示在乙项目下'), false);
    finish([f.rowB]); await pending;
    assert.equal(f.run('state.project.id'), PROJECT_B);
  } finally { f.cleanup(); }
});

test('highlight patches preserve separate reading containers for the same paper in two projects', async () => {
  const f = await ui({ saved: multiProjectPrefs() });
  try {
    f.row.values.remarks = '甲项目独立备注'; f.rowB.values.remarks = '乙项目独立备注';
    await selectBothProjects(f);
    const a = projectCell(f, PROJECT_A, 'remarks'), b = projectCell(f, PROJECT_B, 'remarks');
    const aText = a.querySelector('.cell-text'), bText = b.querySelector('.cell-text');
    aText.scrollTop = 77; bText.scrollTop = 123;
    const results = readingOffsets(f, 3400, 1020);
    assert.equal(f.run(`highlightManager.capture({element:document.querySelector('[data-project-group="${PROJECT_B}"] td[data-field="remarks"] .cell-text'),start:0,end:3})`), true);
    assert.equal(await f.run('highlightManager.apply("pink")'), true);
    assert.equal(projectCell(f, PROJECT_A, 'remarks'), a);
    assert.equal(projectCell(f, PROJECT_B, 'remarks'), b);
    assert.equal(aText.querySelector('[data-rg-highlight]'), null);
    assert.equal(bText.querySelector('[data-rg-highlight="pink"]').textContent, '乙项目');
    assert.equal(aText.scrollTop, 77); assert.equal(bText.scrollTop, 123);
    assert.equal(results.scrollTop, 3400); assert.equal(results.scrollLeft, 1020);
    assert.equal(f.saves[0].projectID, PROJECT_B);
  } finally { f.cleanup(); }
});
