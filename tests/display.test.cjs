const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { COLUMNS, normalize, Manager } = require('../plugin/content/display.js');
const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture(initial = {}) {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag);
    if (tag === 'dialog') {
      node.showModal = () => { node.open = true; node.setAttribute('open', ''); };
      node.close = () => { node.open = false; node.removeAttribute('open'); };
    }
    return node;
  };
  let project = { id: 'project-A', name: '项目 A' }, display = copy(initial);
  const writes = [], notices = [], confirmations = [];
  let beforeOpen = () => true, save = async value => { display = copy(value); };
  window.confirm = message => { confirmations.push(message); return true; };
  const manager = new Manager({ document, getProject: () => project, getDisplay: () => display,
    beforeOpen: () => beforeOpen(),
    save: async value => { writes.push(copy(value)); return save(value); },
    notify: message => notices.push(message) });
  const click = async selector => {
    const node = document.querySelector(selector); assert.ok(node, selector);
    node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); await settle();
  };
  const check = (selector, value) => {
    const node = document.querySelector(selector); assert.ok(node, selector);
    node.checked = value;
    node.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  return { window, document, manager, writes, notices, confirmations, click, check,
    currentDisplay: () => copy(display),
    project: value => { project = value; }, display: value => { display = value; },
    beforeOpen: value => { beforeOpen = value; }, save: value => { save = value; } };
}

test('metadata catalog has the requested order, stable identifiers and immutable reasonable widths', () => {
  assert.deepEqual(COLUMNS.map(column => column.id), ['title', 'creators', 'year', 'date', 'publicationTitle', 'itemType', 'DOI', 'url', 'abstractNote',
    'volume', 'issue', 'pages', 'publisher', 'place', 'language', 'ISBN', 'ISSN', 'accessDate', 'dateAdded', 'dateModified', 'extra', 'citationKey']);
  assert.equal(COLUMNS.find(column => column.id === 'title').width, 320);
  assert.equal(COLUMNS.find(column => column.id === 'abstractNote').width, 360);
  assert.equal(COLUMNS.find(column => column.id === 'creators').width, 240);
  assert.equal(COLUMNS.find(column => column.id === 'DOI').width, 260);
  assert.ok(COLUMNS.every(column => column.label && Number.isInteger(column.width) && column.width >= 180));
  assert.ok(Object.isFrozen(COLUMNS));
  assert.ok(COLUMNS.every(Object.isFrozen));
});

test('normalization defaults to tags on and no extra columns, filters unknowns and preserves valid unique order', () => {
  for (const input of [undefined, null, false, '', 4, [], {}, { metadataColumns: 'title' }]) {
    assert.deepEqual(normalize(input), { showTags: true, metadataColumns: [] });
  }
  const input = { showTags: false, metadataColumns: ['DOI', 'title', 'bad', 'DOI', null, 4, {}, 'citationKey', 'constructor', 'YEAR', 'year'] };
  const result = normalize(input);
  assert.deepEqual(result, { showTags: false, metadataColumns: ['DOI', 'title', 'citationKey', 'year'] });
  result.metadataColumns.push('url');
  assert.equal(input.metadataColumns.includes('url'), false, 'normalization owns its array');
  assert.equal(normalize({ showTags: 0 }).showTags, true, 'only literal false hides tags');
});

test('opening renders safe project text, persisted selections and read-only guidance without a write', async () => {
  const f = fixture({ showTags: false, metadataColumns: ['DOI', 'title'] });
  f.project({ id: 'project-A', name: '<IMG src=x onerror=untrusted()> 项目' });
  assert.equal(await f.manager.open(), true);
  assert.equal(f.manager.isOpen(), true);
  assert.equal(f.document.querySelectorAll('[data-metadata-column]').length, COLUMNS.length);
  assert.equal(!!f.document.querySelector('#rg-display-tags').checked, false);
  assert.equal(!!f.document.querySelector('[data-metadata-column="DOI"]').checked, true);
  assert.equal(!!f.document.querySelector('[data-metadata-column="year"]').checked, false);
  assert.deepEqual([...f.document.querySelectorAll('[data-display-selected]')].map(node => node.dataset.displaySelected), ['DOI', 'title']);
  assert.equal(f.document.querySelector('#displayDialog IMG'), null);
  assert.ok(f.document.querySelector('.rg-display-project').textContent.includes('<IMG'));
  assert.match(f.document.querySelector('#displayDialog').textContent, /请在 Zotero 条目信息中编辑/);
  assert.match(f.document.querySelector('#displayDialog').textContent, /不参与 AI 总结或手填分析/);
  assert.equal(f.manager.dirty(), false);
  assert.equal(f.writes.length, 0);
});

test('checkbox edits and reorder controls change only the draft until saving', async () => {
  const f = fixture(); await f.manager.open();
  f.check('#rg-display-tags', false);
  f.check('[data-metadata-column="year"]', true);
  f.check('[data-metadata-column="title"]', true);
  f.check('[data-metadata-column="DOI"]', true);
  assert.deepEqual(f.manager.draft, { showTags: false, metadataColumns: ['year', 'title', 'DOI'] });
  await f.click('[data-display-column="DOI"][data-display-move="up"]');
  assert.deepEqual(f.manager.draft.metadataColumns, ['year', 'DOI', 'title']);
  await f.click('[data-display-column="year"][data-display-move="down"]');
  assert.deepEqual(f.manager.draft.metadataColumns, ['DOI', 'year', 'title']);
  assert.equal(f.document.querySelector('[data-display-column="DOI"][data-display-move="up"]').disabled, true);
  assert.equal(f.document.querySelector('[data-display-column="title"][data-display-move="down"]').disabled, true);
  f.check('[data-metadata-column="year"]', false);
  assert.deepEqual(f.manager.draft.metadataColumns, ['DOI', 'title']);
  assert.equal(f.manager.dirty(), true);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.currentDisplay(), {});
  assert.equal(f.manager.moveColumn('DOI', -1), false);
  assert.equal(f.manager.moveColumn('unknown', 1), false);
  assert.equal(f.manager.toggleColumn('constructor', true), false);
  assert.equal(await f.manager.save(), true);
  assert.deepEqual(f.currentDisplay(), { showTags: false, metadataColumns: ['DOI', 'title'] });
  assert.equal(f.writes.length, 1);
  assert.equal(f.manager.isOpen(), false);
  assert.equal(f.manager.dirty(), false);
});

test('cancel confirmation can retain the draft, while accepted discard reopens from persisted display', async () => {
  const f = fixture({ showTags: false, metadataColumns: ['title'] }); await f.manager.open();
  f.check('[data-metadata-column="year"]', true);
  f.window.confirm = message => { f.confirmations.push(message); return false; };
  await f.click('#rg-display-cancel');
  assert.equal(f.manager.isOpen(), true);
  assert.deepEqual(f.manager.draft.metadataColumns, ['title', 'year']);
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.manager.close(true), true);
  assert.equal(f.manager.isOpen(), false);
  await f.manager.open();
  assert.deepEqual(f.manager.draft, { showTags: false, metadataColumns: ['title'] });
  assert.equal(f.manager.dirty(), false);
});

test('native Escape cancel also protects a dirty draft and closing a clean draft needs no confirmation', async () => {
  const f = fixture(); await f.manager.open();
  f.check('#rg-display-tags', false);
  f.window.confirm = () => false;
  const event = new f.window.Event('cancel', { cancelable: true });
  f.manager.dialog.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.manager.isOpen(), true);
  f.check('#rg-display-tags', true);
  assert.equal(f.manager.dirty(), false);
  assert.equal(f.manager.close(), true);
  assert.equal(f.manager.isOpen(), false);
});

test('beforeOpen authorization, no project and repeated async opening cannot create duplicate dialogs', async () => {
  const f = fixture(), pending = deferred();
  f.beforeOpen(() => false);
  assert.equal(await f.manager.open(), false);
  assert.equal(f.document.querySelector('#displayDialog'), null);
  f.beforeOpen(() => true); f.project(null);
  assert.equal(await f.manager.open(), false);
  assert.equal(f.document.querySelector('#displayDialog'), null);
  assert.match(f.notices.at(-1), /选择一个研究项目/);
  f.project({ id: 'project-A', name: '项目 A' }); f.beforeOpen(() => pending.promise);
  const opening = f.manager.open();
  assert.equal(await f.manager.open(), false);
  pending.resolve(true); assert.equal(await opening, true);
  assert.equal(await f.manager.open(), false);
  assert.equal(f.document.querySelectorAll('#displayDialog').length, 1);
});

test('save failures retain tag choices, column order and draft, and a deliberate retry can succeed', async () => {
  const f = fixture({ metadataColumns: ['title', 'year'] }); await f.manager.open();
  f.check('#rg-display-tags', false);
  await f.click('[data-display-column="year"][data-display-move="up"]');
  f.save(async () => { throw new Error('模拟偏好写入失败 <unsafe>'); });
  assert.equal(await f.manager.save(), false);
  assert.equal(f.manager.isOpen(), true);
  assert.equal(f.manager.busy, false);
  assert.deepEqual(f.manager.draft, { showTags: false, metadataColumns: ['year', 'title'] });
  assert.equal(f.manager.dirty(), true);
  assert.equal(f.document.querySelector('#rg-display-save').disabled, false);
  assert.equal(f.document.querySelector('[data-display-column="year"][data-display-move="up"]').disabled, true);
  assert.match(f.document.querySelector('#rg-display-error').textContent, /模拟偏好写入失败 <unsafe>/);
  assert.equal(f.document.querySelector('#rg-display-error unsafe'), null);
  assert.deepEqual(f.currentDisplay(), { metadataColumns: ['title', 'year'] });
  f.save(async value => f.display(copy(value)));
  await f.click('#rg-display-save');
  assert.equal(f.manager.isOpen(), false);
  assert.deepEqual(f.currentDisplay(), { showTags: false, metadataColumns: ['year', 'title'] });
  assert.equal(f.writes.length, 2);
});

test('changed project or concurrent display preferences are rejected before writing and leave the draft intact', async () => {
  const f = fixture(); await f.manager.open(); f.check('[data-metadata-column="title"]', true);
  f.project({ id: 'project-B', name: '项目 B' });
  assert.equal(await f.manager.save(), false);
  assert.match(f.document.querySelector('#rg-display-error').textContent, /当前项目已变化/);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.manager.draft.metadataColumns, ['title']);
  f.project({ id: 'project-A', name: '项目 A' }); f.display({ metadataColumns: ['DOI'] });
  assert.equal(await f.manager.save(), false);
  assert.match(f.document.querySelector('#rg-display-error').textContent, /已在别处更新/);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.manager.draft.metadataColumns, ['title']);
  assert.equal(f.manager.isOpen(), true);
});

test('pending save locks all controls, forbids duplicate saves or closing, and sends a separate draft snapshot', async () => {
  const f = fixture({ metadataColumns: ['title', 'year'] }), pending = deferred();
  await f.manager.open(); f.check('#rg-display-tags', false);
  let received;
  f.save(async value => { received = value; await pending.promise; f.display(copy(value)); });
  const saving = f.manager.save();
  assert.equal(f.manager.busy, true);
  assert.equal(f.document.querySelector('#displayDialog').getAttribute('aria-busy'), 'true');
  assert.ok([...f.document.querySelectorAll('#displayDialog button,#displayDialog input')].every(node => node.disabled));
  assert.notEqual(received, f.manager.draft);
  assert.notEqual(received.metadataColumns, f.manager.draft.metadataColumns);
  assert.equal(f.manager.moveColumn('year', -1), false);
  assert.equal(f.manager.toggleColumn('DOI', true), false);
  f.check('[data-metadata-column="DOI"]', true);
  f.check('#rg-display-tags', true);
  assert.deepEqual(f.manager.draft, { showTags: false, metadataColumns: ['title', 'year'] });
  assert.equal(await f.manager.save(), false);
  assert.equal(f.manager.close(true), false);
  assert.equal(f.writes.length, 1);
  pending.resolve(); assert.equal(await saving, true);
  assert.equal(f.manager.busy, false);
  assert.equal(f.manager.isOpen(), false);
  assert.deepEqual(f.currentDisplay(), { showTags: false, metadataColumns: ['title', 'year'] });
});

test('a notification failure after successful save does not reopen the dialog or report a failed commit', async () => {
  const f = fixture(); await f.manager.open();
  f.check('[data-metadata-column="abstractNote"]', true);
  f.manager.options.notify = () => { throw new Error('模拟提示失败'); };
  assert.equal(await f.manager.save(), true);
  assert.equal(f.manager.isOpen(), false);
  assert.equal(f.manager.dirty(), false);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.currentDisplay(), { showTags: true, metadataColumns: ['abstractNote'] });
});
