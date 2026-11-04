const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const C = require('../plugin/content/core.js');
const Table = require('../plugin/content/table-io.js');

const PROJECT_A = 'user:collection:PROJECTA';
const PROJECT_B = 'user:collection:PROJECTB';
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
  const rowB = { ...row, values: C.blankValues() };
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
      sourceCalls.push({ rowID: target.id, mode: options.mode, maxChars: options.maxChars });
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
    Notifier: { registerObserver() { return 1; }, unregisterObserver() {} }, logError: error => logs.push(error) };
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
  vm.runInContext(fs.readFileSync('plugin/content/matrix.js', 'utf8'), context);
  await settle();
  const run = code => vm.runInContext(code, context);
  const cell = id => document.querySelector(`td[data-field="${id}"]`);
  const click = async element => {
    assert.ok(element, 'the target control must be present');
    const event = new window.Event('click', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    // Native DOM retains Event.target after dispatch; LinkeDOM removes it.
    event.target = element;
    await settle();
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
  return { document, window, context, repo, projects, row, rowB, loads, saves, logs, run, cell, click, key, input,
    sourceCalls, apiCalls, keyCalls, batchSaves, importSaves, pickerCalls, fileReads, fileWrites, queueFile,
    setAIConfig: value => { aiConfig = clone(value); },
    aiConfig: () => clone(aiConfig), keyProvider: fn => { keyProvider = fn; }, settingsOpened: () => settingsOpened,
    prefs: () => clone(preferences), cleanup() { for (const timer of timers) clearTimeout(timer); } };
}

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

test('read error leaves a clear retry state and disables export', async () => {
  const f = await ui({ fail: true });
  try {
    assert.equal(f.document.querySelector('#status').textContent, '加载失败');
    assert.ok(f.document.querySelector('#empty').textContent.includes('模拟读取失败'));
    assert.equal(f.document.querySelector('#export').disabled, true);
  } finally { f.cleanup(); }
});

test('clicking a cell starts direct table editing without covering the other columns', async () => {
  const f = await ui();
  try {
    await f.click(f.cell('remarks'));
    assert.ok(f.cell('remarks').querySelector('#inlineValue'), f.logs.map(error => error.stack).join('\n'));
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), false);
    assert.ok(f.cell('findings').textContent.includes('点击直接填写'));
    f.document.querySelector('#inlineValue').value = '项目备注';
    await f.click(f.document.querySelector('#inlineSave'));
    assert.equal(f.row.values.remarks, '项目备注');
    assert.equal(f.document.querySelector('#inlineValue'), null);
    assert.ok(f.cell('remarks').textContent.includes('项目备注'));
    assert.ok(f.document.querySelector('#saveStatus').textContent.includes('已保存'));
    assert.equal(f.saves.length, 1);
  } finally { f.cleanup(); }
});

test('expanding and returning to the table preserves the same unsaved multiline draft', async () => {
  const f = await ui();
  try {
    await f.click(f.cell('remarks'));
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
    await f.click(f.cell('remarks'));
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
    await f.click(f.cell('remarks'));
    const input = f.document.querySelector('#inlineValue');
    input.value = '不能丢失的草稿';
    await f.click(f.cell('findings'));
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
    await f.click(f.cell('remarks'));
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
    await f.click(f.cell('remarks'));
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
    await f.click(f.cell('task_evidence'));
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
    await f.click(f.cell('remarks'));
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

test('reading selections highlight exact text without opening the editor and save formatting-only changes', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '关键结果。第二句。';
    f.run('render()');
    f.window.getSelection = () => ({ isCollapsed:false, toString:()=>'关键结果', removeAllRanges() {} });
    await f.click(f.cell('remarks'));
    assert.equal(f.document.querySelector('#inlineValue'), null, 'drag-selected text must remain available for highlighting');
    assert.equal(f.run(`highlightManager.capture({element:document.querySelector('td[data-field="remarks"] .cell-text'), start:0,end:4})`), true);
    await f.click(f.document.querySelector('#rg-highlight-selection-toolbar [data-highlight-color="yellow"]'));
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].value, '关键结果。第二句。');
    assert.equal(f.saves[0].expected, '关键结果。第二句。');
    assert.deepEqual(f.saves[0].options.highlights, [{ start:0, end:4, color:'yellow' }]);
    assert.equal(f.cell('remarks').querySelector('[data-rg-highlight="yellow"]').textContent, '关键结果');
    assert.equal(f.row.values.remarks, '关键结果。第二句。');
  } finally { f.cleanup(); }
});

test('editor colors survive popup roundtrip and formatting-only drafts require save or discard', async () => {
  const f = await ui();
  try {
    f.row.values.remarks = '需要标记的句子。';
    f.run('render()');
    await f.click(f.cell('remarks'));
    const input = f.document.querySelector('#inlineValue');
    input.selectionStart = 0; input.selectionEnd = 4;
    await f.click(f.cell('remarks').querySelector('[data-highlight-color="pink"]'));
    assert.ok(f.document.querySelector('#inlineHighlightPreview [data-rg-highlight="pink"]'));
    assert.equal(f.saves.length, 0);
    await f.click(f.document.querySelector('#inlineExpand'));
    assert.equal(f.document.querySelector('#editHighlightPreview [data-rg-highlight="pink"]').textContent, '需要标记');
    await f.click(f.document.querySelector('#editCollapse'));
    assert.equal(f.document.querySelector('#inlineHighlightPreview [data-rg-highlight="pink"]').textContent, '需要标记');
    f.window.confirm = () => false;
    await f.click(f.document.querySelector('#inlineCancel'));
    assert.ok(f.document.querySelector('#inlineValue'), 'canceling a formatting draft must request discard confirmation');
    await f.click(f.document.querySelector('#inlineSave'));
    assert.equal(f.saves.length, 1);
    assert.deepEqual(f.saves[0].options.highlights, [{ start:0, end:4, color:'pink' }]);
    assert.deepEqual(f.saves[0].options.expectedHighlights, []);
    assert.equal(f.cell('remarks').querySelector('[data-rg-highlight="pink"]').textContent, '需要标记');
  } finally { f.cleanup(); }
});
