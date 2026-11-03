const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const C = require('../plugin/content/core.js');

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
  const row = { id: 1, key: 'PAPERKEY', title: '未批注文献', authors: '张', year: '2026', citekey: 'Zhang2026', tags: [], annotations: [],
    values: C.blankValues(), editable: true, paper, itemURL: 'zotero://select/library/items/PAPERKEY', pdfURL: '', attachmentID: null };
  const rowB = { ...row, values: C.blankValues() };
  const loads = [], saves = [], logs = [], sourceCalls = [], apiCalls = [], keyCalls = [], batchSaves = [];
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
    saveField: async (project, target, id, value, expected) => {
      saves.push({ projectID: project.id, id, value, expected });
      return { note: { key: 'NOTEKEY' }, values: { ...target.values, [id]: value } };
    },
    paperSource: async (target, options) => {
      sourceCalls.push({ rowID: target.id, mode: options.mode, maxChars: options.maxChars });
      return { text: '论文原文片段：实验比较两种条件，结果有待结合原文核对。', label: '模拟提取文本', chars: 30, truncated: false,
        paper: { title: target.title, authors: target.authors, year: target.year, abstract: '模拟公开摘要' } };
    },
    saveFields: async (project, target, changes, expected) => {
      batchSaves.push({ projectID: project.id, changes: clone(changes), expected: clone(expected) });
      for (const id of Object.keys(changes)) if ((target.values[id] || '') !== expected[id]) throw new Error('模拟原子字段冲突');
      return { note: { key: 'AI_NOTEKEY' }, values: { ...target.values, ...changes } };
    } };
  const Z = { Prefs: { get: key => JSON.stringify(key === 'extensions.researchgrid.ai' ? aiConfig : preferences),
    set: (key, value) => { if (key === 'extensions.researchgrid.ai') aiConfig = JSON.parse(value); else preferences = JSON.parse(value); } },
    ProjectLitMatrix: { credentials: { getKey: async endpoint => { keyCalls.push(endpoint); return keyProvider(endpoint); } },
      openSettings() { settingsOpened++; } },
    Notifier: { registerObserver() { return 1; }, unregisterObserver() {} }, logError: error => logs.push(error) };
  const timers = new Set();
  const context = vm.createContext({ window, document, Node: window.Node, ChromeUtils: { importESModule: () => ({ Zotero: Z }) },
    PLMCore: C, PLMRepository: class { constructor() { return repo; } }, location: { search: '' }, URLSearchParams, URL, AbortController,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); } });
  window.confirm = () => true;
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
  return { document, window, context, repo, projects, row, rowB, loads, saves, logs, run, cell, click, key,
    sourceCalls, apiCalls, keyCalls, batchSaves, setAIConfig: value => { aiConfig = clone(value); },
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
