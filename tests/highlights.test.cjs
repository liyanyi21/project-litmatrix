const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const C = require('../plugin/content/core.js');
const H = require('../plugin/content/highlights.js');
const copy = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function document() { return parseHTML('<!doctype html><html><body><table id="grid"><tbody><tr><td id="target"></td></tr></tbody></table></body></html>'); }
function fixture() {
  const { document: doc, window } = document();
  const original = '首😀句。\n第二句，结果明确。';
  const field = { id: 'findings', label: '核心结论', requirement: '记录事实' };
  let fields = [field], project = { id: 'project-A', name: '项目 A' };
  const row = { id: 1, key: 'PAPER001', libraryID: 1, editable: true, values: { findings: original }, highlights: { findings: [] } };
  let rows = [row];
  const cell = doc.createElement('div');
  cell.className = 'cell-text'; cell.setAttribute('data-row', '1'); cell.setAttribute('data-field', 'findings');
  cell.append(H.render(doc, original, [])); doc.querySelector('#target').append(cell);
  const saved = [], notices = [];
  let save = async (...args) => { saved.push(args); row.highlights.findings = copy(args[5].highlights); };
  let beforeSave = async () => true, cleared = 0;
  const manager = new H.Manager({ document: doc, getProject: () => project, getFields: () => fields, getRows: () => rows,
    getSelection: () => ({ removeAllRanges() { cleared++; } }),
    beforeSave: () => beforeSave(), save: (...args) => save(...args), notify: message => notices.push(message) });
  const capture = (start = 0, end = 4) => manager.capture({ element: cell, start, end });
  return { doc, window, manager, row, cell, field, original, capture, saved, notices,
    project: value => { project = value; }, fields: value => { fields = value; }, rows: value => { rows = value; },
    save: fn => { save = fn; }, beforeSave: fn => { beforeSave = fn; }, cleared: () => cleared };
}
function fakeSelection(startNode, startOffset, endNode, endOffset) {
  const range = { startContainer: startNode, startOffset, endContainer: endNode, endOffset, collapsed: false,
    cloneRange() {
      return { selectNodeContents(node) { this.root = node; }, setEnd(node, offset) { this.endNode = node; this.offset = offset; },
        toString() {
          let text = '', done = false;
          const visit = node => {
            if (done) return;
            if (node === this.endNode) { text += node.textContent.slice(0, this.offset); done = true; return; }
            if (node.nodeType === 3) text += node.textContent;
            else for (const child of node.childNodes) visit(child);
          };
          visit(this.root); return text;
        } };
    } };
  return { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
}

test('highlight rendering preserves plain multiline Unicode and never interprets source HTML or styles', () => {
  const { document: doc } = document();
  const text = '<img src=x onerror=alert(1)>\n首😀句';
  const host = doc.createElement('div');
  host.append(H.render(doc, text, [{ start: 0, end: 4, color: 'yellow' }, { start: text.length - 4, end: text.length, color: 'pink' }]));
  assert.equal(host.textContent, text);
  assert.equal(host.querySelector('img,script'), null);
  assert.equal(host.querySelectorAll('.rg-text-highlight').length, 2);
  assert.equal(host.querySelector('[data-rg-highlight="yellow"]').textContent, '<img');
  assert.ok(host.querySelector('[data-rg-highlight="pink"]').getAttribute('style').includes(C.HIGHLIGHT_COLORS.pink));
  assert.throws(() => H.render(doc, 'abc', [{ start: 0, end: 1, color: 'url(javascript:evil)' }]));
});

test('palette mouse down preserves the text selection before a color command', () => {
  const f = fixture();
  f.capture();
  const event = new f.window.Event('mousedown', { bubbles: true, cancelable: true });
  f.manager.root.querySelector('[data-highlight-color="green"]').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.saved.length, 0);
});

test('native selection offsets use UTF-16 text across nested spans and reject cross-cell or multiple ranges', () => {
  const { document: doc } = document();
  const a = doc.createElement('div'); a.className = 'cell-text'; a.setAttribute('data-row', '1'); a.setAttribute('data-field', 'findings');
  a.append(H.render(doc, '首😀句\n第二句', [{ start: 0, end: 4, color: 'green' }]));
  doc.body.append(a);
  const first = a.querySelector('span').firstChild, last = a.lastChild;
  const selected = H.readSelection(fakeSelection(first, 1, last, 3));
  assert.equal(selected.element, a); assert.equal(selected.start, 1); assert.equal(selected.end, 7);
  assert.equal(a.textContent.slice(selected.start, selected.end), '😀句\n第二');
  const b = a.cloneNode(true); b.setAttribute('data-row', '2'); doc.body.append(b);
  assert.equal(H.readSelection(fakeSelection(first, 0, b.lastChild, 1)), null);
  assert.equal(H.readSelection({ ...fakeSelection(first, 0, last, 1), rangeCount: 2 }), null);
  assert.equal(H.readSelection({ ...fakeSelection(first, 0, last, 1), isCollapsed: true }), null);
});

test('clicking a color immediately saves the displayed selection with a stable format snapshot', async () => {
  const f = fixture();
  assert.equal(f.capture(), true);
  assert.equal(f.manager.isOpen(), true); assert.equal(f.saved.length, 0);
  assert.match(f.manager.status.textContent, /点颜色立即高亮并自动保存/);
  assert.equal(f.manager.root.querySelector('[data-highlight-save]'), null);
  f.manager.root.querySelector('[data-highlight-color="yellow"]').dispatchEvent(new f.window.Event('click', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(f.saved.length, 1);
  const [project, row, fieldID, text, expected, options] = f.saved[0];
  assert.equal(project.id, 'project-A'); assert.equal(row, f.row); assert.equal(fieldID, 'findings');
  assert.equal(text, f.original); assert.equal(expected, f.original);
  assert.deepEqual(options, { highlights: [{ start: 0, end: 4, color: 'yellow' }], expectedHighlights: [] });
  assert.equal(f.manager.isOpen(), false); assert.equal(f.cleared(), 1);
  assert.equal(f.row.values.findings, f.original); assert.equal(f.notices.length, 1);
});

test('removing a portion of a saved highlight preserves the two unaffected ranges', async () => {
  const f = fixture();
  f.row.highlights.findings = [{ start: 0, end: 5, color: 'green' }];
  f.cell.replaceChildren(H.render(f.doc, f.original, f.row.highlights.findings));
  assert.equal(f.capture(1, 3), true);
  assert.equal(await f.manager.apply(null), true);
  assert.deepEqual(f.saved[0][5].highlights, [{ start: 0, end: 1, color: 'green' }, { start: 3, end: 5, color: 'green' }]);
  assert.deepEqual(f.saved[0][5].expectedHighlights, [{ start: 0, end: 5, color: 'green' }]);
});

test('a persistence error keeps the selected phrase and toolbar available for retry without changing user data', async () => {
  const f = fixture();
  f.row.highlights.findings = [{ start: 0, end: 4, color: 'green' }];
  f.cell.replaceChildren(H.render(f.doc, f.original, f.row.highlights.findings));
  const originalHTML = f.cell.innerHTML;
  f.save(async () => { throw new Error('模拟高亮冲突'); }); f.capture();
  f.manager.root.querySelector('[data-highlight-color="pink"]').dispatchEvent(new f.window.Event('click', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(f.manager.isOpen(), true); assert.equal(f.manager.snapshot.text, f.original);
  assert.ok(f.manager.status.textContent.includes('模拟高亮冲突'));
  assert.deepEqual(f.row.highlights.findings, [{ start: 0, end: 4, color: 'green' }]);
  assert.equal(f.cell.innerHTML, originalHTML, 'failed immediate saves leave the original displayed color intact');
  assert.equal(f.manager.busy, false);
  let recovered;
  f.save(async (...args) => { recovered = args; });
  assert.equal(await f.manager.apply('pink'), true);
  assert.deepEqual(recovered[5].expectedHighlights, [{ start: 0, end: 4, color: 'green' }]);
});

test('project, schema, text, mark, and detached cell changes prevent stale highlight writes', async () => {
  for (const mutate of [
    f => f.project({ id: 'project-B' }),
    f => f.fields([{ ...f.field, requirement: '更改后的要求' }]),
    f => { f.row.values.findings = '另一窗口已更新'; },
    f => { f.row.highlights.findings = [{ start: 0, end: 1, color: 'blue' }]; },
    f => { f.cell.remove(); },
    f => f.rows([{ ...f.row, key: 'OTHERKEY' }]),
  ]) {
    const f = fixture(); f.capture(); mutate(f);
    assert.equal(await f.manager.apply('yellow'), false); assert.equal(f.saved.length, 0);
    assert.ok(f.manager.status.textContent.includes('变化'));
  }
});

test('busy lock begins before asynchronous editor approval and blocks duplicate or changing selections', async () => {
  const f = fixture(), gate = deferred();
  f.beforeSave(() => gate.promise); f.capture();
  const pending = f.manager.apply('blue');
  assert.equal(f.manager.busy, true);
  assert.equal(f.capture(4, 5), false); assert.equal(f.manager.clear(), false);
  assert.equal(await f.manager.apply('pink'), false); assert.equal(f.saved.length, 0);
  assert.ok([...f.manager.root.querySelectorAll('button')].every(button => button.disabled));
  gate.resolve(true); assert.equal(await pending, true); assert.equal(f.saved.length, 1);
});

test('readonly rows, editor contents, invalid positions and canceled approval never write', async () => {
  const f = fixture(); f.row.editable = false; assert.equal(f.capture(), false);
  f.row.editable = true; f.cell.parentElement.classList.add('editing-cell'); assert.equal(f.capture(), false);
  f.cell.parentElement.classList.remove('editing-cell'); assert.equal(f.capture(-1, 3), false);
  assert.equal(f.capture(1, 99), false); assert.equal(f.capture(3, 1), false);
  f.beforeSave(async () => false); f.capture(); assert.equal(await f.manager.apply('yellow'), false);
  assert.equal(f.manager.busy, false); assert.equal(f.saved.length, 0); assert.equal(f.manager.isOpen(), true);
});

test('selection listeners can clear a collapsed selection and disposal removes controls', () => {
  const f = fixture(); f.capture(); assert.equal(f.manager.isOpen(), true);
  assert.equal(f.manager.captureSelection({ isCollapsed: true, rangeCount: 0 }), false);
  assert.equal(f.manager.isOpen(), false);
  f.capture(); f.manager.dispose();
  assert.equal(f.doc.querySelector('#rg-highlight-selection-toolbar'), null);
  assert.equal(f.capture(), false);
  assert.equal(f.manager.snapshot, null);
});

test('notification failures cannot turn a committed highlight save into a reported failure', async () => {
  const f = fixture(); f.manager.options.notify = () => { throw new Error('display failed'); };
  f.capture(); assert.equal(await f.manager.apply('green'), true); assert.equal(f.saved.length, 1);
  assert.equal(f.manager.isOpen(), false);
});
