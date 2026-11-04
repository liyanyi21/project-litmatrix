const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { Manager, normalize, MIN_WIDTH, MAX_WIDTH } = require('../plugin/content/column-widths.js');
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const copy = value => JSON.parse(JSON.stringify(value));
const defs = [ { id: 'identity', label: '文献与原文', width: 320 },
  { id: 'metadata:year', label: '年份', width: 180 }, { id: 'field:findings', label: '主要发现', width: 290 } ];
function fixture() {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  const writes = [], notices = [];
  let save = () => undefined;
  const manager = new Manager({ document, notify: text => notices.push(text) });
  const table = () => {
    const element = document.createElement('table'); element.className = 'matrix-table';
    element.innerHTML = '<colgroup><col><col><col></colgroup><thead><tr><th>文献</th><th>年份</th><th>发现</th></tr></thead><tbody><tr><td>标题</td><td>2026</td><td><textarea id="draft">未保存的文字</textarea></td></tr></tbody>';
    document.body.append(element); return element;
  };
  const attach = (element, projectID = 'A', widths = {}, columns = defs) => manager.attach(element,
    { projectID, columns, widths, onChange: (next, context) => { writes.push({ next: copy(next), context: copy(context) }); return save(next, context); } });
  const dispatch = (node, type, attrs = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, attrs); node.dispatchEvent(event); return event;
  };
  const grip = (element, index) => element.querySelectorAll('[data-column-resize]')[index];
  const widths = element => [...element.querySelectorAll('col')].map(col => col.style.width);
  const drag = async (element, index, start, end) => {
    dispatch(grip(element, index), 'pointerdown', { button: 0, pointerId: 1, clientX: start });
    dispatch(document, 'pointermove', { pointerId: 1, clientX: end });
    dispatch(document, 'pointerup', { pointerId: 1, clientX: end }); await settle();
  };
  return { window, document, manager, writes, notices, table, attach, dispatch, grip, widths, drag, save: fn => { save = fn; } };
}

test('stored widths accept only stable column IDs and finite numbers within safe limits', () => {
  for (const bad of [null, undefined, [], 42, 'bad', false]) assert.deepEqual(normalize(bad), {});
  const value = { identity: 20, 'field:findings': 99999, 'metadata:year': 170.6, 'field:archived': 245,
    title: 200, __proto__: 250, 'field:': 250, 'field:bad key': 250, 'field:bad': Infinity, 'field:str': '300' };
  assert.deepEqual(normalize(value), { identity: 180, 'field:findings': MAX_WIDTH, 'metadata:year': 171, 'field:archived': 245 });
  assert.equal(MIN_WIDTH, 100);
});

test('attach applies project widths, retains hidden overrides and adds accessible grips without changing cells', () => {
  const f = fixture(), table = f.table(), draft = table.querySelector('#draft');
  const input = { 'identity': 400, 'field:archived': 500, 'metadata:year': 100 };
  assert.equal(f.attach(table, 'A', input), true);
  assert.deepEqual(f.widths(table), ['400px', '100px', '290px']);
  assert.equal(table.style.width, '790px'); assert.equal(table.style.minWidth, '790px');
  assert.equal(table.querySelector('#draft'), draft); assert.equal(draft.value, '未保存的文字');
  assert.equal(f.writes.length, 0);
  const handle = f.grip(table, 0);
  assert.equal(handle.getAttribute('role'), 'separator'); assert.equal(handle.getAttribute('aria-orientation'), 'vertical');
  assert.equal(handle.getAttribute('tabindex'), '0'); assert.equal(handle.getAttribute('aria-valuenow'), '400');
  assert.equal(handle.getAttribute('aria-label'), '调整列宽：文献与原文');
  assert.equal(handle.getAttribute('aria-valuemin'), '180');
  assert.deepEqual(input, { identity: 400, 'field:archived': 500, 'metadata:year': 100 });
});

test('drag updates only the requested column live and saves one owner-scoped override on pointerup', async () => {
  const f = fixture(), table = f.table(); f.attach(table, 'A', { 'field:archived': 555 });
  const draft = table.querySelector('#draft'), handle = f.grip(table, 2);
  const down = f.dispatch(handle, 'pointerdown', { button: 0, pointerId: 9, clientX: 200 });
  assert.equal(down.defaultPrevented, true);
  f.dispatch(f.document, 'pointermove', { pointerId: 9, clientX: 270 });
  assert.deepEqual(f.widths(table), ['320px', '180px', '360px']);
  assert.equal(f.writes.length, 0); assert.equal(f.document.documentElement.classList.contains('rg-column-resizing'), true);
  f.dispatch(f.document, 'pointerup', { pointerId: 9, clientX: 285 }); await settle();
  assert.deepEqual(f.widths(table), ['320px', '180px', '375px']);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0], { next: { 'field:archived': 555, 'field:findings': 375 },
    context: { projectID: 'A', columnID: 'field:findings', width: 375, reset: false } });
  assert.equal(f.document.documentElement.classList.contains('rg-column-resizing'), false);
  assert.equal(table.querySelector('#draft'), draft);
});

test('drag clamps identity and ordinary columns and ignores another pointer', async () => {
  const f = fixture(), table = f.table(); f.attach(table);
  f.dispatch(f.grip(table, 0), 'pointerdown', { button: 0, pointerId: 3, clientX: 400 });
  f.dispatch(f.document, 'pointermove', { pointerId: 8, clientX: -1000 });
  assert.equal(f.widths(table)[0], '320px');
  f.dispatch(f.document, 'pointerup', { pointerId: 8, clientX: -1000 }); assert.equal(f.writes.length, 0);
  f.dispatch(f.document, 'pointermove', { pointerId: 3, clientX: -1000 }); assert.equal(f.widths(table)[0], '180px');
  f.dispatch(f.document, 'pointerup', { pointerId: 3, clientX: -1000 }); await settle();
  assert.equal(f.writes[0].next.identity, 180);
  await f.drag(table, 1, 0, 100000); assert.equal(f.widths(table)[1], '1200px');
  await f.drag(table, 2, 10000, 0); assert.equal(f.widths(table)[2], '100px');
});

test('cancel and Escape restore the saved width and never persist a partial drag', async () => {
  const f = fixture(), table = f.table(); f.attach(table, 'A', { 'field:findings': 340 });
  for (const cancel of ['pointercancel', 'Escape', 'lostpointercapture', 'blur']) {
    const grip = f.grip(table, 2);
    f.dispatch(grip, 'pointerdown', { button: 0, pointerId: 4, clientX: 100 });
    f.dispatch(f.document, 'pointermove', { pointerId: 4, clientX: 200 });
    assert.equal(f.widths(table)[2], '440px');
    if (cancel === 'Escape') f.dispatch(f.document, 'keydown', { key: 'Escape' });
    else if (cancel === 'lostpointercapture') f.dispatch(grip, cancel);
    else if (cancel === 'blur') f.dispatch(f.window, cancel);
    else f.dispatch(f.document, cancel, { pointerId: 4 });
    assert.equal(f.widths(table)[2], '340px', cancel);
    assert.equal(f.manager.gesture, null, cancel);
  }
  await settle(); assert.equal(f.writes.length, 0);
});

test('right click, invalid coordinates and an unchanged grip click do not save or start resize', async () => {
  const f = fixture(), table = f.table(); f.attach(table);
  f.dispatch(f.grip(table, 2), 'pointerdown', { button: 2, clientX: 100 }); assert.equal(f.manager.gesture, null);
  f.dispatch(f.grip(table, 2), 'pointerdown', { button: 0, clientX: NaN }); assert.equal(f.manager.gesture, null);
  await f.drag(table, 2, 100, 100); assert.equal(f.writes.length, 0);
});

test('keyboard arrows resize with a larger Shift step and Home resets only that stable column', async () => {
  const f = fixture(), table = f.table(); f.attach(table, 'A', { 'field:hidden': 410, identity: 370 });
  const handle = f.grip(table, 0);
  f.dispatch(handle, 'keydown', { key: 'ArrowLeft' }); await settle();
  assert.equal(f.widths(table)[0], '360px');
  f.dispatch(handle, 'keydown', { key: 'ArrowRight', shiftKey: true }); await settle();
  assert.equal(f.widths(table)[0], '410px');
  f.dispatch(handle, 'keydown', { key: 'Home' }); await settle();
  assert.equal(f.widths(table)[0], '320px');
  assert.deepEqual(f.writes[2].next, { 'field:hidden': 410 });
  assert.equal(f.writes[2].context.reset, true);
  f.dispatch(handle, 'keydown', { key: 'Home' }); await settle(); assert.equal(f.writes.length, 3);
});

test('double click resets the targeted column and reset restores the complete project layout', async () => {
  const f = fixture(), table = f.table(); f.attach(table, 'A', { identity: 410, 'field:findings': 600, 'field:hidden': 500 });
  f.dispatch(f.grip(table, 2), 'dblclick'); await settle();
  assert.deepEqual(f.widths(table), ['410px', '180px', '290px']);
  assert.deepEqual(f.writes[0].next, { identity: 410, 'field:hidden': 500 });
  assert.equal(await f.manager.reset(table), true);
  assert.deepEqual(f.widths(table), ['320px', '180px', '290px']);
  assert.deepEqual(f.writes[1].next, {}); assert.equal(f.writes[1].context.columnID, null);
});

test('two projects using the same field retain independent widths and owner callbacks', async () => {
  const f = fixture(), a = f.table(), b = f.table();
  f.attach(a, 'project-A', { 'field:findings': 390 }); f.attach(b, 'project-B', { 'field:findings': 520 });
  await f.drag(a, 2, 10, 50);
  assert.equal(f.widths(a)[2], '430px'); assert.equal(f.widths(b)[2], '520px');
  assert.equal(f.writes[0].context.projectID, 'project-A');
  f.dispatch(f.grip(b, 2), 'keydown', { key: 'ArrowRight' }); await settle();
  assert.equal(f.writes[1].context.projectID, 'project-B'); assert.equal(f.widths(a)[2], '430px');
  f.manager.detach(a);
  f.attach(a, 'project-A', f.writes[0].next);
  assert.equal(f.widths(a)[2], '430px');
});

test('reordering or hiding fields applies saved widths by stable ID rather than position', () => {
  const f = fixture(), table = f.table();
  const reordered = [defs[0], { id: 'field:custom_1', label: '自定义', width: 300 }, defs[2]];
  f.attach(table, 'A', { 'field:custom_1': 610, 'metadata:year': 120, 'field:findings': 450 }, reordered);
  assert.deepEqual(f.widths(table), ['320px', '610px', '450px']);
  f.attach(table, 'A', { 'field:custom_1': 610, 'metadata:year': 120, 'field:findings': 450 });
  assert.deepEqual(f.widths(table), ['320px', '120px', '450px']);
});

test('failed asynchronous persistence rolls widths back and ignores controls until completion', async () => {
  const f = fixture(), table = f.table(); f.attach(table, 'A', { 'field:findings': 330 });
  let reject;
  f.save(() => new Promise((_, fail) => { reject = fail; }));
  f.dispatch(f.grip(table, 2), 'keydown', { key: 'ArrowRight' });
  assert.equal(f.widths(table)[2], '340px');
  assert.equal(f.grip(table, 2).getAttribute('aria-disabled'), 'true');
  f.dispatch(f.grip(table, 2), 'keydown', { key: 'ArrowRight' });
  f.dispatch(f.grip(table, 2), 'pointerdown', { button: 0, clientX: 100 });
  assert.equal(f.manager.gesture, null); assert.equal(f.writes.length, 1);
  reject(new Error('存储不可用')); await settle();
  assert.equal(f.widths(table)[2], '330px'); assert.deepEqual(f.notices, ['存储不可用']);
  assert.equal(f.grip(table, 2).hasAttribute('aria-disabled'), false);
});

test('a detached pending save failure cannot overwrite a replacement project table', async () => {
  const f = fixture(), table = f.table(); f.attach(table, 'A', { identity: 400 });
  let reject;
  f.save(() => new Promise((_, fail) => { reject = fail; }));
  f.dispatch(f.grip(table, 0), 'keydown', { key: 'ArrowRight' });
  f.attach(table, 'B', { identity: 700 });
  reject(new Error('旧项目保存失败')); await settle();
  assert.equal(f.widths(table)[0], '700px'); assert.equal(table.querySelectorAll('[data-column-resize]').length, 3);
});

test('reattach and dispose cancel gestures, remove listeners and retain ordinary table content', async () => {
  const f = fixture(), table = f.table(); f.attach(table);
  const oldHandle = f.grip(table, 2), draft = table.querySelector('#draft');
  f.dispatch(oldHandle, 'pointerdown', { button: 0, pointerId: 1, clientX: 100 });
  f.dispatch(f.document, 'pointermove', { pointerId: 1, clientX: 200 });
  f.attach(table, 'B', { 'field:findings': 600 });
  f.dispatch(f.document, 'pointerup', { pointerId: 1, clientX: 300 });
  f.dispatch(oldHandle, 'keydown', { key: 'ArrowRight' }); await settle();
  assert.equal(f.writes.length, 0); assert.equal(f.widths(table)[2], '600px');
  assert.equal(f.manager.tables.size, 1); assert.equal(table.querySelectorAll('[data-column-resize]').length, 3);
  f.manager.dispose(); assert.equal(f.manager.tables.size, 0);
  assert.equal(table.querySelectorAll('[data-column-resize]').length, 0);
  assert.equal(table.querySelector('#draft'), draft);
});

test('malformed attach data fails without half-built handles and custom minima remain bounded', () => {
  const f = fixture(), table = f.table();
  assert.equal(f.manager.attach(table, { columns: defs }), false);
  assert.equal(f.attach(table, 'A', {}, [defs[0]]), false);
  assert.equal(table.querySelectorAll('[data-column-resize]').length, 0);
  assert.equal(f.attach(table, 'A', { identity: 400 }, [{ ...defs[0], min: 8000 }, defs[1], defs[2]]), true);
  assert.equal(f.widths(table)[0], '1200px'); assert.equal(f.grip(table, 0).getAttribute('aria-valuemin'), '1200');
});
