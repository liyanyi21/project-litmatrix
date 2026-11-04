const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { Manager } = require('../plugin/content/project-picker.js');
const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function projects() {
  const entry = (id, name, path, parentKey, libraryID = 1, collectionKey = id) => ({
    id, libraryID, collectionKey, name, path, parentKey,
    label: `${libraryID === 1 ? '我的文献库' : '团队文献库'} / ${path}`, library: { name: libraryID === 1 ? '我的文献库' : '团队文献库' },
  });
  const fallback = entry('I', 'Fallback', 'Root / Fallback', null); delete fallback.parentKey;
  return [entry('A', 'Root', 'Root', null), entry('B', 'Methods', 'Root / Methods', 'A'),
    entry('C', 'Remote', 'Root / Methods / Remote', 'B'), entry('D', 'Findings', 'Root / Findings', 'A'),
    entry('E', 'Other', 'Other', null), entry('F', 'Root', 'Root', null, 2, 'A'),
    entry('G', 'Remote', 'Root / Remote', 'A', 2), entry('H', 'Derived', 'Root / Derived', 'E'), fallback,
    entry('J', 'Missing parent', 'Root / Missing parent', 'NO_SUCH_KEY')];
}
function fixture({ selected = [], rows = projects() } = {}) {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  let active = null;
  Object.defineProperty(document, 'activeElement', { get: () => active });
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag);
    node.focus = () => { active = node; };
    if (tag === 'dialog') {
      node.showModal = () => { node.open = true; node.setAttribute('open', ''); };
      node.close = () => { node.open = false; node.removeAttribute('open'); };
    }
    return node;
  };
  let currentProjects = copy(rows), currentSelected = copy(selected), beforeOpen = () => true;
  let apply = async ids => { currentSelected = copy(ids); };
  const writes = [], notices = [], confirmations = [];
  window.confirm = message => { confirmations.push(message); return true; };
  const manager = new Manager({ document, getProjects: () => currentProjects, getSelected: () => currentSelected,
    beforeOpen: () => beforeOpen(), apply: async ids => { writes.push(copy(ids)); return apply(ids); }, notify: message => notices.push(message) });
  const query = selector => document.querySelector(selector);
  const click = async selector => {
    const node = typeof selector === 'string' ? query(selector) : selector; assert.ok(node, String(selector));
    node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); await settle();
  };
  const check = (id, value) => {
    const node = [...document.querySelectorAll('[data-project-check]')].find(item => item.getAttribute('data-project-check') === id);
    assert.ok(node, id); node.checked = value;
    node.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const search = value => {
    const node = query('#rg-project-search'); node.value = value;
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return { manager, document, window, query, click, check, search, writes, notices, confirmations,
    selected: () => copy(currentSelected), currentProjects: () => currentProjects,
    setProjects: value => { currentProjects = value; }, setSelected: value => { currentSelected = value; },
    beforeOpen: value => { beforeOpen = value; }, apply: value => { apply = value; } };
}

test('tree uses same-library parent keys, explicit roots and missing-parent roots, with path fallback only when no parentKey exists', async () => {
  const f = fixture(); await f.manager.open();
  assert.equal(f.manager.tree.nodes.get('B').parent.id, 'A');
  assert.equal(f.manager.tree.nodes.get('G').parent.id, 'F', 'same key in another library must never steal the parent');
  assert.equal(f.manager.tree.nodes.get('H').parent.id, 'E', 'accurate parent key overrides a misleading textual path');
  assert.equal(f.manager.tree.nodes.get('I').parent.id, 'A');
  assert.equal(f.manager.tree.nodes.get('J').parent, null);
  assert.equal(f.manager.tree.nodes.get('A').parent, null);
  assert.equal(f.manager.tree.groups.length, 2);
  assert.equal(f.query('[data-project-check="B"]'), null, 'unselected branches start collapsed');
  assert.ok(f.query('[data-project-check="A"]'));
  assert.equal(f.writes.length, 0);
});

test('initial selected paths expand their ancestors and nodes show concise names rather than repeated long labels', async () => {
  const f = fixture({ selected: ['C'] }); await f.manager.open();
  assert.equal(f.query('[data-project-toggle="A"]').getAttribute('aria-expanded'), 'true');
  assert.equal(f.query('[data-project-toggle="B"]').getAttribute('aria-expanded'), 'true');
  assert.equal(f.query('[data-project-check="C"]').checked, true);
  assert.equal(f.query('[data-project-node="C"] .rg-project-name').textContent, 'Remote');
  assert.equal(f.query('[data-project-node="C"] .rg-project-name').getAttribute('title'), '我的文献库 / Root / Methods / Remote');
  assert.ok(f.query('#rg-project-selected').textContent.includes('Root / Methods / Remote'));
  assert.equal(f.manager.dirty(), false);
  assert.equal(f.document.activeElement, f.query('#rg-project-search'));
  await f.click('[data-project-toggle="A"]');
  assert.equal(f.query('[data-project-check="C"]'), null);
  assert.deepEqual([...f.manager.selected], ['C'], 'collapsing never clears selection');
});

test('library labels prefer the repository libraryName and fall back to the library object', async () => {
  const rows = projects();
  rows.filter(project => project.libraryID === 1).forEach(project => { project.libraryName = '本机文献库'; });
  const f = fixture({ rows, selected: ['A', 'F'] }); await f.manager.open();
  assert.equal(f.manager.tree.groups[0].name, '本机文献库');
  assert.equal(f.manager.tree.groups[1].name, '团队文献库');
  assert.match(f.query('[data-project-selected="A"] small').textContent, /^本机文献库/);
});

test('search preserves ancestor context, supports full paths and selects only genuine matches across libraries', async () => {
  const f = fixture(); await f.manager.open(); f.search('rEmOtE');
  for (const id of ['A', 'B', 'C', 'F', 'G']) assert.ok(f.query(`[data-project-check="${id}"]`), id);
  for (const id of ['D', 'E', 'H', 'I', 'J']) assert.equal(f.query(`[data-project-check="${id}"]`), null, id);
  assert.equal(f.query('#rg-project-results-count').textContent, '找到 2 个分类');
  await f.click('#rg-project-select-results');
  assert.deepEqual([...f.manager.selected], ['C', 'G'], 'ancestor-only context must not be checked');
  f.search('Root / Methods');
  assert.deepEqual(f.manager.matches().map(node => node.id), ['B', 'C']);
  await f.click('#rg-project-select-results');
  assert.deepEqual([...f.manager.selected], ['C', 'G', 'B']);
  assert.equal(f.writes.length, 0);
});

test('search branches can be collapsed while matched counts and selection survive query changes', async () => {
  const f = fixture(); await f.manager.open(); f.search('Remote');
  f.check('C', true); await f.click('[data-project-toggle="A"]');
  assert.equal(f.query('[data-project-check="C"]'), null);
  assert.equal(f.query('#rg-project-results-count').textContent, '找到 2 个分类');
  f.search('Findings');
  assert.ok(f.query('[data-project-check="D"]'));
  assert.deepEqual([...f.manager.selected], ['C']);
  f.check('D', true);
  assert.equal(f.query('#rg-project-selected-title').textContent, '已选择（2）');
  f.search('no-matching-name');
  assert.match(f.query('#rg-project-tree-scroll').textContent, /没有匹配/);
  assert.equal(f.query('#rg-project-select-results').disabled, true);
  assert.deepEqual([...f.manager.selected], ['C', 'D']);
  await f.click('[data-project-remove="C"]');
  assert.deepEqual([...f.manager.selected], ['D']);
  f.search('Remote');
  assert.ok(f.query('[data-project-check="C"]'), 'new query resets only search collapse state');
});

test('checking a parent selects only that category and clearing keeps search and persisted selection untouched', async () => {
  const f = fixture(); await f.manager.open(); f.check('A', true);
  assert.deepEqual([...f.manager.selected], ['A']);
  await f.click('[data-project-toggle="A"]');
  assert.equal(!!f.query('[data-project-check="B"]').checked, false);
  assert.equal(!!f.query('[data-project-check="D"]').checked, false);
  f.search('Remote'); await f.click('#rg-project-clear');
  assert.deepEqual([...f.manager.selected], []);
  assert.equal(f.query('#rg-project-search').value, 'Remote');
  assert.equal(f.query('#rg-project-clear').disabled, true);
  assert.deepEqual(f.selected(), []);
  assert.match(f.query('#projectPickerDialog').textContent, /勾选父分类不会自动勾选子分类/);
});

test('checkbox rerenders preserve scroll and keyboard focus without replacing the search input', async () => {
  const f = fixture({ selected: ['C'] }); await f.manager.open();
  const search = f.query('#rg-project-search'), checkbox = f.query('[data-project-check="C"]');
  f.query('#rg-project-tree-scroll').scrollTop = 175;
  checkbox.focus(); f.check('C', false);
  assert.equal(f.query('#rg-project-tree-scroll').scrollTop, 175);
  assert.equal(f.document.activeElement, f.query('[data-project-check="C"]'));
  assert.equal(f.query('#rg-project-search'), search);
  search.focus(); f.search('Remote');
  assert.equal(f.document.activeElement, search);
  assert.equal(f.query('#rg-project-tree-scroll').scrollTop, 0);
});

test('cancel and native Escape protect draft changes, while searching and folding alone are not dirty', async () => {
  const f = fixture(); await f.manager.open(); f.search('Remote'); await f.click('[data-project-toggle="A"]');
  assert.equal(f.manager.dirty(), false);
  f.search('Root'); f.check('A', true); f.window.confirm = () => false;
  await f.click('#rg-project-cancel');
  assert.equal(f.manager.isOpen(), true);
  const event = new f.window.Event('cancel', { cancelable: true });
  f.manager.dialog.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.manager.isOpen(), true);
  assert.equal(f.manager.close(true), true);
  await f.manager.open();
  assert.equal(f.query('#rg-project-search').value, '');
  assert.deepEqual([...f.manager.selected], []);
  assert.equal(f.manager.dirty(), false);
  assert.equal(f.writes.length, 0);
});

test('application revalidates missing categories and keeps checks, search and removals available for recovery', async () => {
  const f = fixture({ selected: ['C'] }); await f.manager.open(); f.search('Remote');
  f.setProjects(f.currentProjects().filter(project => project.id !== 'C'));
  assert.equal(await f.manager.apply(), false);
  assert.match(f.query('#rg-project-error').textContent, /所选分类已不存在/);
  assert.equal(f.manager.isOpen(), true);
  assert.equal(f.query('#rg-project-search').value, 'Remote');
  assert.deepEqual([...f.manager.selected], ['C']);
  assert.equal(f.writes.length, 0);
  await f.click('[data-project-remove="C"]');
  f.check('G', true);
  assert.equal(await f.manager.apply(), true);
  assert.deepEqual(f.writes, [['G']]);
  assert.deepEqual(f.selected(), ['G']);
  assert.equal(f.manager.isOpen(), false);
});

test('an initially missing selected category remains visible for explicit removal instead of silently dropping it', async () => {
  const f = fixture({ selected: ['REMOVED', 'REMOVED', 'A'] }); await f.manager.open();
  assert.deepEqual([...f.manager.selected], ['REMOVED', 'A']);
  assert.match(f.query('[data-project-selected="REMOVED"]').textContent, /分类已移除/);
  assert.equal(f.manager.dirty(), false);
  assert.equal(await f.manager.apply(), false);
  await f.click('[data-project-remove="REMOVED"]');
  assert.deepEqual([...f.manager.selected], ['A']);
  assert.equal(await f.manager.apply(), true);
  assert.deepEqual(f.selected(), ['A']);
});

test('application failure or a declined callback retains draft and query and allows retry without extra side effects', async () => {
  const f = fixture(); await f.manager.open(); f.search('Remote'); f.check('C', true); f.check('G', true);
  f.apply(async () => { throw new Error('模拟切换失败 <unsafe>'); });
  assert.equal(await f.manager.apply(), false);
  assert.equal(f.manager.busy, false);
  assert.equal(f.manager.isOpen(), true);
  assert.equal(f.query('#rg-project-search').value, 'Remote');
  assert.deepEqual([...f.manager.selected], ['C', 'G']);
  assert.match(f.query('#rg-project-error').textContent, /模拟切换失败 <unsafe>/);
  assert.equal(f.query('#rg-project-error unsafe'), null);
  assert.equal(f.query('#rg-project-apply').disabled, false);
  f.apply(async () => false);
  assert.equal(await f.manager.apply(), false);
  assert.equal(f.manager.isOpen(), true);
  f.apply(async ids => f.setSelected(copy(ids)));
  await f.click('#rg-project-apply');
  assert.deepEqual(f.selected(), ['C', 'G']);
  assert.equal(f.manager.isOpen(), false);
  assert.equal(f.manager.dirty(), false);
  assert.equal(f.writes.length, 3);
});

test('pending application locks all controls, rejects duplicate actions and passes an independent IDs snapshot', async () => {
  const f = fixture(), pending = deferred(); await f.manager.open(); f.check('A', true);
  let received;
  f.apply(async ids => { received = ids; await pending.promise; f.setSelected(copy(ids)); });
  const applying = f.manager.apply();
  assert.equal(f.manager.busy, true);
  assert.equal(f.query('#projectPickerDialog').getAttribute('aria-busy'), 'true');
  assert.ok([...f.document.querySelectorAll('#projectPickerDialog button,#projectPickerDialog input')].every(node => node.disabled));
  assert.equal(f.manager.clear(), false);
  assert.equal(f.manager.select('E', true), false);
  assert.equal(f.manager.toggleExpanded('A'), false);
  assert.equal(f.manager.selectMatches(), false);
  f.search('Other');
  assert.equal(f.manager.query, '');
  assert.equal(await f.manager.apply(), false);
  assert.equal(f.manager.close(true), false);
  assert.equal(f.writes.length, 1);
  received.push('E');
  assert.deepEqual([...f.manager.selected], ['A'], 'consumer mutation cannot change the picker draft');
  pending.resolve(); assert.equal(await applying, true);
  assert.equal(f.manager.busy, false);
  assert.equal(f.manager.isOpen(), false);
  assert.equal(f.manager.dirty(), false);
});

test('beforeOpen refusal and repeated asynchronous opens cannot create duplicate dialogs', async () => {
  const f = fixture(), pending = deferred(); f.beforeOpen(() => false);
  assert.equal(await f.manager.open(), false);
  assert.equal(f.query('#projectPickerDialog'), null);
  f.beforeOpen(() => pending.promise);
  const opening = f.manager.open();
  assert.equal(await f.manager.open(), false);
  pending.resolve(true); assert.equal(await opening, true);
  assert.equal(await f.manager.open(), false);
  assert.equal(f.document.querySelectorAll('#projectPickerDialog').length, 1);
});

test('empty libraries and empty selection are displayed clearly and final empty-selection policy stays with the caller', async () => {
  const f = fixture({ rows: [] }); await f.manager.open();
  assert.match(f.query('#rg-project-tree-scroll').textContent, /先在 Zotero 中创建分类/);
  assert.equal(f.query('#rg-project-select-results').disabled, true);
  assert.equal(f.query('#rg-project-clear').disabled, true);
  assert.equal(await f.manager.apply(), true);
  assert.deepEqual(f.writes, [[]]);
});

test('cyclic, ambiguous and cross-library paths remain reachable and unsafe names never become markup', async () => {
  const rows = projects();
  rows.push({ id: 'X', libraryID: 3, collectionKey: 'X', parentKey: 'Y', name: '<IMG src=x onerror=bad()>', path: 'X', library: { name: '<svg onload=bad()>' } },
    { id: 'Y', libraryID: 3, collectionKey: 'Y', parentKey: 'X', name: 'Y', path: 'Y', library: { name: '<svg onload=bad()>' } },
    { id: 'A2', libraryID: 1, collectionKey: 'A2', parentKey: null, name: 'Root', path: 'Root', library: { name: '我的文献库' } });
  const f = fixture({ rows }); await f.manager.open(); f.search(''); await f.click('#rg-project-select-results');
  assert.equal(f.manager.tree.nodes.get('I').parent, null, 'ambiguous textual parents are not guessed');
  f.search('onerror');
  assert.ok(f.query('[data-project-check="X"]'));
  assert.equal(f.query('#projectPickerDialog IMG'), null);
  assert.equal(f.query('#projectPickerDialog svg'), null);
  assert.match(f.query('#rg-project-tree-scroll').textContent, /<IMG/);
  assert.equal(await f.manager.apply(), true);
  assert.equal(f.selected().length, rows.length);
});

test('notification failure after application does not reopen the dialog or report a failed selection', async () => {
  const f = fixture(); await f.manager.open(); f.check('E', true);
  f.manager.options.notify = () => { throw new Error('模拟提示失败'); };
  assert.equal(await f.manager.apply(), true);
  assert.equal(f.manager.isOpen(), false);
  assert.equal(f.manager.dirty(), false);
  assert.deepEqual(f.selected(), ['E']);
});
