const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { Manager, normalizeLayout, buildGraph, nodeID } = require('../plugin/content/mindmap.js');
const copy = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const fields = [{ id: 'findings', label: '主要发现', requirement: '只列原文事实' }, { id: 'remarks', label: '我的备注' },
  { id: 'hidden', label: '隐藏分析', visible: false }, { id: 'archived', label: '旧字段', archived: true }];
const sample = (patch = {}) => ({ id: 10, key: 'PAPERKEY', libraryID: 1, projectID: 'A', title: '远程监督研究', authors: 'Lee 等', year: '2025',
  attachmentID: 20, editable: true, values: { findings: '原型测试包含 20 名参与者。\n任务完成率为 90%。', remarks: '', hidden: '隐藏列仍属于当前项目。', archived: '归档数据' }, ...patch });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture({ rows = [sample()], layout, fieldList = fields } = {}) {
  const { window, document } = parseHTML('<!doctype html><html><body><div id="view"></div></body></html>');
  let active = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => active });
  const create = document.createElement.bind(document);
  document.createElement = tag => { const element = create(tag); element.focus = () => { active = element; }; return element; };
  let project = { id: 'A', name: '项目甲', libraryID: 1 }, currentRows = rows, currentFields = fieldList;
  const layouts = layout === undefined ? {} : { A: copy(layout) }, writes = [], notices = [], edits = [], opened = [], located = [];
  let save = async (owner, value) => { layouts[owner.id] = copy(value); };
  const manager = new Manager({ document, container: document.querySelector('#view'), getProject: () => project,
    getRows: () => currentRows, getFields: () => currentFields, getLayout: owner => layouts[owner.id],
    saveLayout: (owner, value) => { writes.push({ owner: { ...owner }, value: copy(value) }); return save(owner, value); },
    onEdit: (row, field) => edits.push({ row, field }), onOpenPaper: row => opened.push(row), onLocate: row => located.push(row), notify: message => notices.push(message) });
  const query = selector => document.querySelector(selector);
  const find = (attribute, id) => [...document.querySelectorAll(`[${attribute}]`)].find(node => node.getAttribute(attribute) === id);
  const event = (node, name, props = {}) => {
    const item = new window.Event(name, { bubbles: true, cancelable: true });
    Object.assign(item, props); node.dispatchEvent(item); return item;
  };
  const click = async selector => { const node = typeof selector === 'string' ? query(selector) : selector; assert.ok(node, String(selector)); event(node, 'click'); await settle(); };
  const key = async (id, value, shiftKey = false) => { event(find('data-mm-select', id), 'keydown', { key: value, shiftKey }); await settle(); };
  return { window, document, manager, query, find, event, click, key, layouts, writes, notices, edits, opened, located,
    setProject: value => { project = value; }, setRows: value => { currentRows = value; }, setFields: value => { currentFields = value; },
    save: value => { save = value; }, currentProject: () => project };
}

test('graph derives project-owned facts with stable library/item/field identities and preserves hidden active fields', () => {
  const a = sample(), b = sample({ id: 11, libraryID: 2, title: '第二库同 key' }), other = sample({ projectID: 'B' });
  const graph = buildGraph({ id: 'A', name: '项目' }, [a, a, b, other], fields);
  assert.equal(graph.nodes.filter(node => node.kind === 'paper').length, 2);
  assert.equal(graph.nodes.filter(node => node.kind === 'field').length, 4);
  assert.deepEqual(graph.byID.get(nodeID(a)).children.map(id => graph.byID.get(id).field.id), ['findings', 'hidden']);
  assert.equal(graph.byID.get(`${nodeID(a)}:field:findings`).value, a.values.findings);
  assert.notEqual(nodeID(a), nodeID(b));
  assert.equal(graph.byID.get('project').children.length, 2);
  assert.equal(a.values.remarks, '', 'deriving a graph must never fill or mutate notes');
});

test('layout normalization rejects malformed, unbounded and foreign-version data without prototype pollution', () => {
  const dirty = JSON.parse('{"version":1,"positions":{"__proto__":{"x":1,"y":2},"good":{"x":999999,"y":-999999},"bad":{"x":"5","y":0}},"collapsed":["project","project",2],"viewport":{"x":"12","y":3,"scale":99}}');
  const value = normalizeLayout(dirty);
  assert.equal(value.positions.good.x, 100000); assert.equal(value.positions.good.y, -100000);
  assert.equal(value.positions.bad, undefined);
  assert.equal(Object.getPrototypeOf(value.positions), Object.prototype);
  assert.equal({}.x, undefined);
  assert.deepEqual(value.collapsed, ['project']);
  assert.deepEqual(value.viewport, { x: 0, y: 3, scale: 2.5 });
  assert.deepEqual(normalizeLayout({ version: 2, positions: dirty.positions }).positions, {});
  assert.deepEqual(normalizeLayout(null).viewport, { x: 0, y: 0, scale: 1 });
  dirty.positions.good.x = 5; assert.equal(value.positions.good.x, 100000);
});

test('opening is local/read-only, starts with paper branches folded, and renders hostile text safely', () => {
  const f = fixture({ rows: [sample({ title: '<img src=x onerror=bad()>', values: { findings: '<script>evil()</script>\n事实' } })] });
  assert.equal(f.manager.show(), true);
  assert.equal(f.manager.isOpen(), true);
  assert.equal(f.query('#view').hidden, false);
  assert.equal(f.query('img'), null); assert.equal(f.query('script'), null);
  assert.equal(f.query('svg path').getAttribute('d').includes('NaN'), false);
  assert.equal(f.document.querySelectorAll('[data-mm-node]').length, 2);
  assert.match(f.query('.rg-mm-node.rg-mm-paper').textContent, /<img/);
  assert.match(f.query('.rg-mm-count').textContent, /1 篇文献 · 1 项已填分析/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.edits.length, 0); assert.equal(f.opened.length, 0);
});

test('first view remains readable with many papers and 100% centers the selected node without changing its positions', async () => {
  const rows = Array.from({ length: 11 }, (_, index) => sample({ id: index + 1, key: `PAPER${index}`, title: `文献 ${index + 1}` }));
  const f = fixture({ rows }); f.manager.show();
  assert.equal(f.manager.layout.viewport.scale, .85, 'first view must not shrink all eleven titles to fit the full project');
  const root = f.manager.positions().project, viewport = f.manager.layout.viewport;
  assert.ok(Math.abs(root.y * viewport.scale + viewport.y + 82 * viewport.scale / 2 - 240) < 1e-8, 'project root is centered vertically near the middle papers');
  assert.equal(f.writes.length, 0);
  const id = nodeID(rows[7]); f.manager.select(id);
  const before = f.manager.positions()[id];
  await f.click('[aria-label="实际大小（100%）"]');
  assert.equal(f.layouts.A.viewport.scale, 1);
  assert.equal(before.x + 272 / 2 + f.layouts.A.viewport.x, 400);
  assert.equal(before.y + 102 / 2 + f.layouts.A.viewport.y, 240);
  assert.deepEqual(f.layouts.A.positions, {}, 'resetting zoom does not rearrange nodes');
  assert.equal(f.writes.length, 1);
});

test('saved viewport is restored exactly and expanding one branch preserves its screen anchor and scale', async () => {
  const rows = Array.from({ length: 11 }, (_, index) => sample({ id: index + 1, key: `PAPER${index}` }));
  const saved = { version: 1, positions: {}, collapsed: rows.map(nodeID), viewport: { x: 101.25, y: -222.5, scale: .73 } };
  const f = fixture({ rows, layout: saved }); f.manager.show();
  assert.deepEqual(f.manager.layout.viewport, saved.viewport);
  const id = nodeID(rows[4]), before = f.manager.positions()[id];
  const anchor = { x: before.x * saved.viewport.scale + saved.viewport.x, y: before.y * saved.viewport.scale + saved.viewport.y };
  await f.click(f.find('data-mm-toggle', id));
  const after = f.manager.positions()[id], viewport = f.layouts.A.viewport;
  assert.equal(viewport.scale, .73);
  assert.ok(Math.abs(after.x * viewport.scale + viewport.x - anchor.x) < 1e-8);
  assert.ok(Math.abs(after.y * viewport.scale + viewport.y - anchor.y) < 1e-8);
  f.manager.hide(); f.manager.show(); assert.deepEqual(f.manager.layout.viewport, viewport);
});

test('expanding a paper reveals nonempty fields, details retain full text, empty fields are editable from paper details', async () => {
  const row = sample({ values: { findings: '事实 '.repeat(300), remarks: '' } }), f = fixture({ rows: [row] }); f.manager.show();
  await f.click(f.find('data-mm-toggle', nodeID(row)));
  assert.ok(f.find('data-mm-node', `${nodeID(row)}:field:findings`));
  assert.equal(f.find('data-mm-node', `${nodeID(row)}:field:remarks`), undefined);
  assert.equal(f.writes.length, 1);
  assert.equal(f.layouts.A.collapsed.includes(nodeID(row)), false);
  await f.click(f.find('data-mm-select', `${nodeID(row)}:field:findings`));
  assert.equal(f.query('.rg-mm-fulltext').textContent, row.values.findings);
  assert.match(f.query('.rg-mm-requirement').textContent, /只列原文事实/);
  await f.click(f.find('data-mm-edit', 'findings'));
  assert.equal(f.edits.at(-1).row, row); assert.equal(f.edits.at(-1).field.id, 'findings');
  await f.click(f.find('data-mm-select', nodeID(row)));
  await f.click(f.find('data-mm-edit', 'remarks'));
  assert.equal(f.edits.at(-1).field.id, 'remarks');
  assert.equal(row.values.remarks, '', 'the map delegates edits, never writes text itself');
});

test('source/location actions route to the selected paper; readonly fields cannot invoke edit', async () => {
  const row = sample({ editable: false }), f = fixture({ rows: [row] }); f.manager.show();
  await f.click(f.find('data-mm-select', nodeID(row)));
  await f.click(f.find('data-mm-open', nodeID(row))); await f.click(f.find('data-mm-locate', nodeID(row)));
  assert.equal(f.opened[0], row); assert.equal(f.located[0], row);
  assert.equal(f.find('data-mm-edit', 'findings').disabled, true);
  await f.click(f.find('data-mm-edit', 'findings'));
  assert.equal(f.edits.length, 0);
  f.setProject({ id: 'B', name: '已切换项目' });
  await f.click(f.find('data-mm-open', nodeID(row)));
  assert.equal(f.opened.length, 1, 'a stale project view cannot open or edit a different context');
});

test('keyboard node movement moves the complete branch including hidden descendants, and persists once per action', async () => {
  const row = sample(), f = fixture(); f.manager.show();
  const before = f.manager.positions(), paperID = nodeID(row), fieldID = `${paperID}:field:findings`;
  await f.key(paperID, 'ArrowRight');
  assert.equal(f.layouts.A.positions[paperID].x, before[paperID].x + 10);
  assert.equal(f.layouts.A.positions[fieldID].x, before[fieldID].x + 10);
  assert.equal(f.layouts.A.positions.project, undefined);
  await f.key(paperID, 'ArrowDown', true);
  assert.equal(f.layouts.A.positions[paperID].y, before[paperID].y + 40);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].owner.id, 'A');
  assert.equal(f.manager.busy, false); assert.equal(f.manager.dirty(), false);
});

test('pointer drag accounts for zoom and commits subtree positions only after pointerup', async () => {
  const row = sample(), paperID = nodeID(row), f = fixture({ layout: { version: 1, viewport: { x: 0, y: 0, scale: .5 } } }); f.manager.show();
  const before = f.manager.positions();
  f.event(f.find('data-mm-select', paperID), 'pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 100 });
  f.event(f.document, 'pointermove', { pointerId: 1, clientX: 80, clientY: 120 });
  assert.equal(f.manager.layout.positions[paperID].x, before[paperID].x + 60);
  assert.equal(f.manager.layout.positions[`${paperID}:field:findings`].y, before[`${paperID}:field:findings`].y + 40);
  assert.equal(f.writes.length, 0); assert.equal(f.manager.dirty(), true);
  f.event(f.document, 'pointerup', { pointerId: 1, clientX: 80, clientY: 120 }); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.layouts.A.positions[paperID].x, before[paperID].x + 60);
  assert.equal(f.manager.dirty(), false);
});

test('pointer jitter, foreign pointers, Escape and cancellation do not persist accidental movement', async () => {
  const paperID = nodeID(sample()), f = fixture(); f.manager.show(); const initial = copy(f.manager.layout);
  const start = () => f.event(f.find('data-mm-select', paperID), 'pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 100 });
  start(); f.event(f.document, 'pointermove', { pointerId: 1, clientX: 52, clientY: 101 }); f.event(f.document, 'pointerup', { pointerId: 1 });
  assert.equal(f.writes.length, 0); assert.deepEqual(f.manager.layout, initial);
  start(); f.event(f.document, 'pointermove', { pointerId: 2, clientX: 100, clientY: 100 });
  assert.equal(f.manager.dirty(), false);
  f.event(f.document, 'pointermove', { pointerId: 1, clientX: 100, clientY: 100 });
  f.event(f.document, 'keydown', { key: 'Escape' });
  assert.deepEqual(f.manager.layout, initial); assert.equal(f.manager.gesture, null);
  start(); f.event(f.document, 'pointermove', { pointerId: 1, clientX: 100, clientY: 150 }); f.event(f.document, 'pointercancel', { pointerId: 1 });
  await settle(); assert.equal(f.writes.length, 0); assert.deepEqual(f.manager.layout, initial);
});

test('blank-canvas panning and zoom are persisted without changing node positions, and fit remains finite', async () => {
  const f = fixture(); f.manager.show(); const before = copy(f.manager.layout);
  f.event(f.manager.canvas, 'pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 100 });
  f.event(f.document, 'pointermove', { pointerId: 1, clientX: 90, clientY: 130 });
  f.event(f.document, 'pointerup', { pointerId: 1 }); await settle();
  assert.equal(f.layouts.A.viewport.x, before.viewport.x + 40); assert.equal(f.layouts.A.viewport.y, before.viewport.y + 30);
  assert.deepEqual(f.layouts.A.positions, {});
  const scale = f.layouts.A.viewport.scale;
  await f.click('[aria-label="放大思维导图"]'); assert.equal(f.layouts.A.viewport.scale, scale * 1.25);
  f.manager.fit(); await settle(); assert.ok(Number.isFinite(f.layouts.A.viewport.x)); assert.ok(Number.isFinite(f.layouts.A.viewport.scale));
  assert.equal(f.writes.length, 3);
});

test('two projects sharing the same paper retain independent positions, collapse and viewport across reopening', async () => {
  const row = sample(), paperID = nodeID(row), f = fixture(); f.manager.show();
  await f.key(paperID, 'ArrowRight', true); const savedA = copy(f.layouts.A);
  f.setProject({ id: 'B', name: '项目乙' }); f.setRows([sample({ projectID: 'B' })]); f.manager.update();
  assert.deepEqual(f.manager.layout.positions, {}); await f.key(paperID, 'ArrowLeft');
  assert.notEqual(f.layouts.B.positions[paperID].x, savedA.positions[paperID].x);
  f.setProject({ id: 'A', name: '项目甲' }); f.setRows([row]); f.manager.update();
  assert.deepEqual(f.manager.layout, savedA);
  f.manager.hide(); f.manager.show(); assert.deepEqual(f.manager.layout, savedA);
  assert.equal(f.writes.length, 2);
});

test('filtering temporarily hidden papers does not discard their stored positions or collapsed state', async () => {
  const second = sample({ id: 11, key: 'SECOND', title: '第二篇文献' }), f = fixture({ rows: [sample(), second] }); f.manager.show();
  await f.key(nodeID(second), 'ArrowRight', true);
  const savedSecond = copy(f.layouts.A.positions[nodeID(second)]);
  f.setRows([sample()]); f.manager.update(); await f.key(nodeID(sample()), 'ArrowDown');
  assert.deepEqual(f.layouts.A.positions[nodeID(second)], savedSecond);
  assert.ok(f.layouts.A.collapsed.includes(nodeID(second)));
  f.setRows([sample(), second]); f.manager.update();
  assert.deepEqual(f.manager.positions()[nodeID(second)], savedSecond);
});

test('failed persistence restores positions and readonly controls and reports the error without writing paper content', async () => {
  const row = sample({ editable: false }), f = fixture({ rows: [row] }); f.manager.show(); f.manager.select(nodeID(row));
  const before = copy(f.manager.layout); f.save(async () => { throw new Error('磁盘不可写'); });
  await f.key(nodeID(row), 'ArrowRight');
  assert.deepEqual(f.manager.layout, before);
  assert.equal(f.manager.busy, false);
  assert.equal(f.find('data-mm-edit', 'findings').disabled, true);
  assert.match(f.query('.rg-mm-status').textContent, /保存失败/);
  assert.equal(f.notices.at(-1), '磁盘不可写'); assert.equal(f.edits.length, 0);
});

test('pending persistence locks layout actions, captures owner and safely refreshes a newly selected project after completion', async () => {
  const pending = deferred(), f = fixture(); f.manager.show(); f.save(() => pending.promise);
  f.event(f.find('data-mm-select', nodeID(sample())), 'keydown', { key: 'ArrowRight' });
  assert.equal(f.manager.busy, true); assert.equal(f.manager.hide(), false);
  assert.equal(f.manager.zoom(1.25), false); assert.equal(f.manager.collapseAll(false), false);
  f.setProject({ id: 'B', name: '项目乙' }); f.setRows([sample({ projectID: 'B' })]);
  assert.equal(f.manager.update(), false);
  assert.equal(f.writes[0].owner.id, 'A');
  pending.resolve(); await settle();
  assert.equal(f.manager.project.id, 'B'); assert.deepEqual(f.manager.layout.positions, {}); assert.equal(f.manager.busy, false);
});

test('project switches or hiding cancel an unfinished gesture and never leak its positions to another project', async () => {
  const f = fixture(); f.manager.show();
  const start = () => f.event(f.find('data-mm-select', nodeID(sample())), 'pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 100 });
  start(); f.event(f.document, 'pointermove', { pointerId: 1, clientX: 100, clientY: 150 });
  assert.equal(f.manager.hide(), true); assert.equal(f.manager.dirty(), false); assert.equal(f.writes.length, 0);
  f.manager.show(); start(); f.event(f.document, 'pointermove', { pointerId: 1, clientX: 100, clientY: 150 });
  f.setProject({ id: 'B', name: '项目乙' }); f.setRows([sample({ projectID: 'B' })]); f.manager.update();
  f.event(f.document, 'pointerup', { pointerId: 1 }); await settle();
  assert.equal(f.writes.length, 0); assert.deepEqual(f.manager.layout.positions, {});
});

test('native capture remains on the stable canvas through node redraws, and lost capture or app blur cancels without saving', () => {
  const f = fixture(); f.manager.show(); const initial = copy(f.manager.layout), captured = [];
  f.manager.canvas.setPointerCapture = id => captured.push(id);
  const paperID = nodeID(sample());
  let focused = 0;
  f.find('data-mm-select', paperID).focus = () => { focused++; };
  const start = () => f.event(f.find('data-mm-select', paperID), 'pointerdown', { button: 0, pointerId: 5, clientX: 50, clientY: 100 });
  start(); assert.equal(focused, 1); assert.equal(f.manager.gesture.capture, f.manager.canvas);
  assert.deepEqual(captured, [], 'plain presses must retain native click/doubleclick targets');
  f.event(f.document, 'pointermove', { pointerId: 5, clientX: 51, clientY: 101 });
  assert.deepEqual(captured, [], 'pointer jitter is not a drag');
  f.event(f.document, 'pointermove', { pointerId: 5, clientX: 80, clientY: 120 });
  assert.deepEqual(captured, [5]);
  f.event(f.document, 'pointermove', { pointerId: 5, clientX: 85, clientY: 125 });
  assert.deepEqual(captured, [5], 'capture is acquired only once per gesture');
  assert.equal(f.manager.gesture.capture, f.manager.canvas);
  f.event(f.manager.canvas, 'lostpointercapture', { pointerId: 5 });
  assert.deepEqual(f.manager.layout, initial); assert.equal(f.manager.gesture, null);
  start(); f.event(f.document, 'pointermove', { pointerId: 5, clientX: 80, clientY: 120 });
  f.event(f.window, 'blur');
  assert.deepEqual(f.manager.layout, initial); assert.equal(f.manager.gesture, null);
  assert.equal(f.writes.length, 0); assert.deepEqual(captured, [5, 5]);
});

test('saving a keyboard move restores node focus so consecutive arrow presses continue moving the selected branch', async () => {
  const f = fixture(); f.manager.show(); const paperID = nodeID(sample()), start = f.manager.positions()[paperID].x;
  f.find('data-mm-select', paperID).focus();
  f.event(f.document.activeElement, 'keydown', { key: 'ArrowRight' }); await settle();
  assert.equal(f.document.activeElement, f.find('data-mm-select', paperID));
  assert.equal(f.document.activeElement.disabled, false);
  f.event(f.document.activeElement, 'keydown', { key: 'ArrowRight' }); await settle();
  assert.equal(f.layouts.A.positions[paperID].x, start + 20); assert.equal(f.writes.length, 2);
  assert.equal(f.document.activeElement, f.find('data-mm-select', paperID));
});

test('an accessibility click focuses the selected node so subsequent arrow keys move its branch instead of panning', async () => {
  const f = fixture(); f.manager.show(); const paperID = nodeID(sample()), before = f.manager.positions()[paperID].x;
  f.manager.canvas.focus();
  const viewport = copy(f.manager.layout.viewport);
  await f.click(f.find('data-mm-select', paperID));
  assert.equal(f.document.activeElement, f.find('data-mm-select', paperID));
  assert.equal(f.writes.length, 0);
  f.event(f.document.activeElement, 'keydown', { key: 'ArrowRight' }); await settle();
  assert.equal(f.layouts.A.positions[paperID].x, before + 10);
  assert.deepEqual(f.layouts.A.viewport, viewport, 'node arrows must not be interpreted as canvas pan');
  assert.equal(f.document.activeElement, f.find('data-mm-select', paperID));
});

test('automatic layout clears manual positions but retains collapse state; collapse all and expand all are reversible', async () => {
  const f = fixture(); f.manager.show(); await f.key(nodeID(sample()), 'ArrowRight');
  f.manager.resetPositions(); await settle(); assert.deepEqual(f.layouts.A.positions, {});
  assert.ok(f.layouts.A.collapsed.includes(nodeID(sample())));
  f.manager.collapseAll(false); await settle(); assert.equal(f.document.querySelectorAll('[data-mm-node]').length, 4);
  f.manager.collapseAll(true); await settle(); assert.equal(f.document.querySelectorAll('[data-mm-node]').length, 2);
});

test('empty filtered projects and missing project are handled locally; disposal removes listeners', async () => {
  const f = fixture({ rows: [] }); f.manager.show();
  assert.equal(f.document.querySelectorAll('[data-mm-node]').length, 1);
  assert.match(f.query('.rg-mm-details').textContent, /当前筛选没有文献/);
  assert.ok(Number.isFinite(f.manager.layout.viewport.scale));
  f.manager.dispose(); assert.equal(f.manager.isOpen(), false); assert.equal(f.query('#view').hidden, true);
  assert.equal(f.manager.show(), false);
  f.event(f.document, 'pointermove', { pointerId: 1, clientX: 100, clientY: 100 }); assert.equal(f.writes.length, 0);
  const missing = fixture(); missing.setProject(null); assert.equal(missing.manager.show(), false);
  assert.match(missing.notices[0], /请先选择/); assert.equal(missing.query('#view').hidden, true);
});
