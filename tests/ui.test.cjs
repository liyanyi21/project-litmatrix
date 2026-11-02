const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const C = require('../plugin/content/core.js');

async function ui({ fail = false } = {}) {
  const { window, document } = parseHTML(fs.readFileSync('plugin/content/matrix.html', 'utf8'));
  // LinkeDOM doesn't implement the select value setter or native dialog API.
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', { writable: true, value: '' });
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
  }
  const project = { id: 'user:collection:PROJECTA', libraryID: 1, collectionKey: 'PROJECTA', name: '测试项目', label: '文献库 / 测试项目', library: { editable: true } };
  const paper = { isAttachment: () => false };
  const row = { id: 1, key: 'PAPERKEY', title: '未批注文献', authors: '张', year: '2026', citekey: 'Zhang2026', tags: [], annotations: [],
    values: C.blankValues(), editable: true, paper, itemURL: 'zotero://select/library/items/PAPERKEY', pdfURL: '', attachmentID: null };
  const repo = { projects: () => [project], currentProject: () => project,
    loadProject: async () => { if (fail) throw new Error('模拟读取失败'); return [row]; },
    saveField: async (p, r, id, value) => ({ note: { key: 'NOTEKEY' }, values: { ...r.values, [id]: value } }) };
  const Z = { Prefs: { get: () => '{}', set() {} }, Notifier: { registerObserver() { return 1; }, unregisterObserver() {} }, logError() {} };
  const timers = new Set();
  const context = vm.createContext({ window, document, Node: window.Node, ChromeUtils: { importESModule: () => ({ Zotero: Z }) },
    PLMCore: C, PLMRepository: class { constructor() { return repo; } }, location: { search: '' }, URLSearchParams,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); } });
  window.confirm = () => true;
  vm.runInContext(fs.readFileSync('plugin/content/matrix.js', 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return { document, window, context, repo, row, cleanup() { for (const timer of timers) clearTimeout(timer); } };
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
test('editor saves selected field and closes only after successful persistence', async () => {
  const f = await ui();
  try {
    vm.runInContext("openEditor(state.rows[0], C.fieldByID('remarks'))", f.context);
    f.document.querySelector('#editValue').value = '项目备注';
    await vm.runInContext('saveEditor()', f.context);
    assert.equal(f.row.values.remarks, '项目备注');
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), false);
    assert.ok(f.document.querySelector('#saveStatus').textContent.includes('已保存'));
  } finally { f.cleanup(); }
});
test('save errors keep editor text available for recovery', async () => {
  const f = await ui();
  try {
    f.repo.saveField = async () => { throw new Error('冲突：别处已修改'); };
    vm.runInContext("openEditor(state.rows[0], C.fieldByID('remarks'))", f.context);
    f.document.querySelector('#editValue').value = '不能丢失的草稿';
    await vm.runInContext('saveEditor()', f.context);
    assert.equal(f.document.querySelector('#editDialog').hasAttribute('open'), true);
    assert.equal(f.document.querySelector('#editValue').value, '不能丢失的草稿');
    assert.ok(f.document.querySelector('#editError').textContent.includes('冲突'));
    assert.equal(f.row.values.remarks, '');
  } finally { f.cleanup(); }
});
