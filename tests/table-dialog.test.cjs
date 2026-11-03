const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { Manager } = require('../plugin/content/table-dialog.js');

const clone = value => JSON.parse(JSON.stringify(value));
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const csv = (records, headers = ['标题', '核心结论', '项目备注']) => [headers, ...records]
  .map(record => record.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(',')).join('\r\n');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture() {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const element = create(tag);
    if (tag === 'dialog') {
      element.showModal = () => { element.open = true; element.setAttribute('open', ''); };
      element.close = () => { element.open = false; element.removeAttribute('open'); };
    }
    if (tag === 'select') Object.defineProperty(element, 'value', { value: '', writable: true });
    return element;
  };
  window.confirm = () => true;
  let project = { id: 'user:collection:PROJECTA', name: '测试项目 A', library: { libraryType: 'user', libraryID: 1 } };
  let fields = [
    { id: 'findings', label: '核心结论', requirement: '结论与页码', visible: true },
    { id: 'remarks', label: '项目备注', aliases: ['我的备注'], requirement: '项目相关说明', visible: false },
  ];
  let rows = [
    { id: 1, key: 'PAPER001', libraryID: 1, title: '测试论文一', citekey: 'PaperOne', editable: true,
      itemURL: 'zotero://select/library/items/PAPER001', values: { findings: '', remarks: '人工备注' } },
    { id: 2, key: 'PAPER002', libraryID: 1, title: '测试论文二', citekey: 'PaperTwo', editable: true,
      itemURL: 'zotero://select/library/items/PAPER002', values: { findings: '已有结论', remarks: '已有备注' } },
  ];
  let file = async () => null, allow = true;
  const reads = [], writes = [], notifications = [];
  let save = async (p, operations) => {
    for (const operation of operations) Object.assign(operation.row.values, operation.changes);
    return { records: operations.map(operation => ({ row: operation.row, values: clone(operation.row.values) })) };
  };
  const manager = new Manager({ document, getProject: () => project, getFields: () => fields, getRows: () => rows,
    readFile: async () => { reads.push(true); return file(); },
    beforeOpen: () => allow,
    save: async (p, operations) => { writes.push({ project: clone(p), operations: operations.map(o => ({ rowID: o.row.id, changes: clone(o.changes), expected: clone(o.expected) })) }); return save(p, operations); },
    notify: message => notifications.push(message) });
  const click = async selector => {
    const element = document.querySelector(selector);
    assert.ok(element, selector);
    element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await settle();
  };
  const input = (selector, value, type = 'input') => {
    const element = document.querySelector(selector);
    assert.ok(element, selector);
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new window.Event(type, { bubbles: true }));
  };
  const paste = text => input('#rg-table-source', text);
  return { manager, document, window, reads, writes, notifications, click, input, paste,
    rows: () => rows, setRows: value => { rows = value; }, fields: () => fields,
    setFields: value => { fields = value; }, setProject: value => { project = value; },
    setFile: value => { file = value; }, setSave: value => { save = value; }, allow: value => { allow = value; } };
}

test('opening import is a local empty preview and never selects a file or writes by itself', async () => {
  const f = fixture();
  await f.manager.open();
  assert.equal(f.manager.isOpen(), true);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.manager.dirty(), false);
  assert.equal(f.document.querySelector('#rg-table-apply').disabled, true);
  assert.equal(f.document.querySelector('#rg-table-parse').disabled, true);
  assert.equal(f.document.querySelector('#rg-table-clear-blanks').disabled, true);
  assert.match(f.document.querySelector('#tableImportDialog').textContent, /已有文献/);
  const blocked = fixture(); blocked.allow(false);
  await blocked.manager.open();
  assert.equal(blocked.manager.isOpen(), false);
});

test('parsing defaults to filling empty fields, protects existing analysis, and requires explicit apply', async () => {
  const f = fixture(); await f.manager.open();
  f.paste(csv([['测试论文一', 'AI 新结论', 'AI 备注'], ['测试论文二', '待覆盖结论', '']]));
  await f.click('#rg-table-parse');
  assert.equal(f.manager.plan.stats.ready, 1);
  assert.equal(f.manager.plan.stats.skip, 1);
  assert.deepEqual(f.manager.selectedRows()[0].changes, { findings: 'AI 新结论' });
  assert.equal(f.rows()[0].values.findings, '');
  assert.equal(f.writes.length, 0);
  assert.match(f.document.querySelector('#rg-table-preview').textContent, /人工|保留|保护/);
  assert.equal(f.document.querySelector('[data-table-row="1"]').disabled, true, 'skip selection must stay disabled after syncControls');
  await f.click('#rg-table-apply');
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].operations, [{ rowID: 1, changes: { findings: 'AI 新结论' }, expected: { findings: '' } }]);
  assert.equal(f.rows()[0].values.remarks, '人工备注');
  assert.equal(f.rows()[1].values.findings, '已有结论');
  assert.equal(f.manager.dirty(), false);
  assert.equal(f.document.querySelector('#rg-table-apply').disabled, true);
  await f.manager.apply();
  assert.equal(f.writes.length, 1, 'successful preview cannot be applied twice');
});

test('overwrite and clearing blank cells are separate explicit choices shown in the preview', async () => {
  const f = fixture(); await f.manager.open();
  f.paste(csv([['测试论文二', '新结论', '']])); f.manager.parse();
  assert.equal(f.manager.plan.stats.ready, 0);
  f.input('#rg-table-overwrite', true, 'change');
  assert.deepEqual(f.manager.plan.rows[0].changes, { findings: '新结论' });
  assert.deepEqual(f.manager.plan.rows[0].expected, { findings: '已有结论' });
  assert.equal(f.document.querySelector('#rg-table-clear-blanks').disabled, false);
  f.input('#rg-table-clear-blanks', true, 'change');
  assert.deepEqual(f.manager.plan.rows[0].changes, { findings: '新结论', remarks: '' });
  assert.match(f.document.querySelector('#rg-table-preview').textContent, /将清空/);
  assert.match(f.document.querySelector('#rg-table-preview').textContent, /已有备注/);
  f.input('#rg-table-overwrite', false, 'change');
  assert.equal(f.manager.clearBlanks, false);
  assert.equal(f.document.querySelector('#rg-table-clear-blanks').disabled, true);
  assert.equal(f.manager.plan.stats.ready, 0);
});

test('unrecognized columns can be mapped manually and duplicate field mappings remain editable errors', async () => {
  const f = fixture(); await f.manager.open();
  f.paste(csv([['测试论文一', '外部 AI 结果', '另一个结果']], ['标题', 'AI总结', '辅助结论'])); f.manager.parse();
  assert.equal(f.manager.plan.stats.ready, 0);
  assert.match(f.document.querySelector('#rg-table-preview').textContent, /未映射/);
  f.input('[data-table-column="1"]', 'field:findings', 'change');
  assert.equal(f.manager.plan.stats.ready, 1);
  f.input('[data-table-column="2"]', 'field:findings', 'change');
  assert.equal(f.manager.plan, null);
  assert.match(f.document.querySelector('#rg-table-error').textContent, /多列/);
  assert.ok(f.document.querySelector('[data-table-column="2"]'));
  f.input('[data-table-column="2"]', 'ignore', 'change');
  assert.equal(f.manager.plan.stats.ready, 1);
});

test('a failed import retains preview-time originals even if current row values changed while awaiting save', async () => {
  const f = fixture(); await f.manager.open();
  f.paste(csv([['测试论文一', '待导入内容', '']])); f.manager.parse();
  const pending = deferred(); f.setSave(() => pending.promise);
  const applying = f.manager.apply();
  assert.equal(f.manager.saving, true);
  assert.equal(f.manager.close(), false, 'saving cannot close the dialog');
  f.rows()[0].values.findings = '另一个窗口的内容';
  pending.reject(new Error('字段原值冲突')); await applying;
  assert.equal(f.writes[0].operations[0].expected.findings, '');
  assert.equal(f.manager.plan.rows[0].expected.findings, '');
  assert.equal(f.manager.selectedRows().length, 1);
  assert.match(f.document.querySelector('#rg-table-source').value, /待导入内容/);
  assert.match(f.document.querySelector('#rg-table-error').textContent, /原值冲突/);
  assert.equal(f.rows()[0].values.findings, '另一个窗口的内容');
  assert.equal(f.document.querySelector('#rg-table-apply').disabled, false);
});

test('changing project or field schema blocks applying a stale preview without writing', async () => {
  const f = fixture(); await f.manager.open();
  f.paste(csv([['测试论文一', '待导入', '']])); f.manager.parse();
  f.setProject({ id: 'user:collection:PROJECTB', name: '项目 B' });
  assert.equal(await f.manager.apply(), false);
  assert.match(f.document.querySelector('#rg-table-error').textContent, /项目已变化/);
  assert.equal(f.writes.length, 0);
  f.setProject({ id: 'user:collection:PROJECTA', name: '项目 A' });
  f.setFields(f.fields().map(field => ({ ...field, requirement: '新的要求' })));
  assert.equal(await f.manager.apply(), false);
  assert.match(f.document.querySelector('#rg-table-error').textContent, /项目字段已变化/);
  assert.equal(f.writes.length, 0);
});

test('editing pasted text invalidates the old preview and prevents writing stale parsed data', async () => {
  const f = fixture(); await f.manager.open();
  f.paste(csv([['测试论文一', '第一份内容', '']])); f.manager.parse();
  assert.equal(f.manager.selectedRows().length, 1);
  f.paste(csv([['测试论文一', '第二份内容', '']]));
  assert.equal(f.manager.plan, null);
  assert.equal(f.document.querySelector('#rg-table-apply').disabled, true);
  assert.equal(await f.manager.apply(), false);
  assert.equal(f.writes.length, 0);
  f.manager.parse();
  assert.equal(f.manager.plan.rows[0].changes.findings, '第二份内容');
});

test('closing or reopening ignores a late file read and cancellation keeps the previous text', async () => {
  const f = fixture(); await f.manager.open();
  const read = deferred(); f.setFile(() => read.promise);
  const pending = f.manager.chooseFile();
  assert.equal(f.manager.busy, true);
  f.manager.close(true); await f.manager.open();
  read.resolve({ name: 'old.csv', text: csv([['测试论文一', '过期文件', '']]) }); await pending;
  assert.equal(f.manager.text, '');
  assert.equal(f.manager.fileName, '');
  f.paste(csv([['测试论文一', '保留输入', '']]));
  f.setFile(async () => null); await f.manager.chooseFile();
  assert.match(f.manager.text, /保留输入/);
  assert.match(f.document.querySelector('#rg-table-status').textContent, /已取消/);
});

test('file selection reads content locally and explicit parse controls preparation', async () => {
  const f = fixture(); await f.manager.open();
  f.setFile(async () => ({ name: '外部结果.tsv', text: '标题\t核心结论\n测试论文一\t外部摘要' }));
  await f.manager.chooseFile();
  assert.equal(f.reads.length, 1);
  assert.equal(f.manager.plan, null);
  assert.equal(f.writes.length, 0);
  assert.match(f.document.querySelector('#rg-table-file-name').textContent, /外部结果/);
  f.manager.parse();
  assert.equal(f.manager.table.delimiter, '\t');
  assert.equal(f.manager.plan.rows[0].changes.findings, '外部摘要');
});

test('row selection spans all pages, and pagination boundary controls remain disabled', async () => {
  const f = fixture();
  const rows = Array.from({ length: 51 }, (_, index) => ({ id: index + 1, key: 'P' + String(index).padStart(7, '0'), libraryID: 1,
    title: `论文 ${index + 1}`, editable: true, values: { findings: '', remarks: '' } }));
  f.setRows(rows); await f.manager.open();
  f.paste(csv(rows.map(row => [row.title, '新内容', '']))); f.manager.parse();
  assert.equal(f.manager.selectedRows().length, 51);
  assert.equal(f.document.querySelectorAll('.rg-table-row').length, 50);
  assert.equal(f.document.querySelector('#rg-table-prev').disabled, true);
  assert.equal(f.document.querySelector('#rg-table-next').disabled, false);
  await f.click('#rg-table-select-none');
  assert.equal(f.manager.selectedRows().length, 0);
  await f.click('#rg-table-next');
  assert.equal(f.document.querySelectorAll('.rg-table-row').length, 1);
  assert.equal(f.document.querySelector('#rg-table-next').disabled, true);
  f.input('[data-table-row="50"]', true, 'change');
  assert.equal(f.manager.selectedRows().length, 1);
  await f.click('#rg-table-prev');
  assert.match(f.document.querySelector('#rg-table-selected-count').textContent, /已选 1 篇/);
  await f.manager.apply();
  assert.deepEqual(f.writes[0].operations.map(operation => operation.rowID), [51]);
});

test('invalid rows remain disabled and imported HTML or formulas are only visible text', async () => {
  const f = fixture(); await f.manager.open();
  const untrusted = '<img src=x onerror="not-executed">\n=SUM(A1:A2)';
  f.paste(csv([['测试论文一', untrusted, ''], ['不存在的论文', '不导入', '']])); f.manager.parse();
  assert.equal(f.manager.plan.stats.error, 1);
  assert.equal(f.document.querySelector('[data-table-row="1"]').disabled, true);
  assert.equal(f.document.querySelector('#rg-table-preview img'), null);
  assert.ok(f.document.querySelector('#rg-table-preview').textContent.includes(untrusted));
  await f.manager.apply();
  assert.equal(f.writes[0].operations.length, 1);
  assert.equal(f.rows()[0].values.findings, untrusted);
});

test('canceling unsaved input asks for confirmation and never invokes persistence', async () => {
  const f = fixture(); await f.manager.open();
  f.paste(csv([['测试论文一', '草稿', '']])); f.manager.parse();
  f.window.confirm = () => false;
  assert.equal(f.manager.close(), false);
  assert.equal(f.manager.isOpen(), true);
  f.window.confirm = () => true;
  assert.equal(f.manager.close(), true);
  assert.equal(f.writes.length, 0);
});
