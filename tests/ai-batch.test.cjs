const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { Manager, MAX_PAPERS } = require('../plugin/content/ai-batch.js');
const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function fixture(count = 2) {
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
  let project = { id: 'project-A', name: '项目 A', libraryID: 1, recursive: true };
  let fields = [
    { id: 'findings', label: '核心结论', requirement: '只记录作者报告的事实', visible: true },
    { id: 'outcomes', label: '结果指标', requirement: '记录指标与数值', visible: false },
    { id: 'remarks', label: '我的备注', requirement: '个人备注', visible: true },
    { id: 'archived', label: '已归档', archived: true },
  ];
  const rows = Array.from({ length: count }, (_, index) => ({
    id: index + 1, key: 'PAPER00' + index, libraryID: 1, title: '测试论文 ' + (index + 1), authors: '作者', year: '2026', editable: true,
    values: { findings: index === 1 ? '人工结论' : '', outcomes: '', remarks: 'PRIVATE_REMARK_' + index },
    highlights: { findings: index === 1 ? [{ start: 0, end: 2, color: 'yellow' }] : [], outcomes: [], remarks: [] },
  }));
  const config = { baseURL: 'https://api.example.test/v1', model: 'fixture-model', maxChars: 60000, timeoutSeconds: 120, maxTokens: 0, summaryDetail: 'brief' };
  let configProvider = async () => config;
  let sourceProvider = async row => ({ text: 'SOURCE_' + row.key + '\n<IMG src=x onerror=untrusted()>', label: '模拟 PDF 提取文本', chars: 100,
    truncated: row.id === 1, warning: row.id === 1 ? '本次仅提供部分原文' : '', paper: { title: row.title, authors: row.authors, year: row.year } });
  let generator = async args => Object.fromEntries(args.fields.map(field => [field.id, args.paper.title + ' · ' + field.label]));
  const sources = [], generated = [], writes = [], notices = [];
  let save = async (p, operations) => {
    for (const operation of operations) for (const [id, expected] of Object.entries(operation.expected)) {
      assert.equal(operation.row.values[id], expected, 'original values must still match');
      assert.deepEqual(operation.row.highlights?.[id] || [], operation.expectedHighlights[id], 'format snapshot must still match');
    }
    return { records: operations.map(operation => {
      Object.assign(operation.row.values, operation.changes);
      for (const id of Object.keys(operation.changes)) operation.row.highlights[id] = [];
      return { row: operation.row, values: copy(operation.row.values), highlights: copy(operation.row.highlights), note: { key: 'NOTE' + operation.row.id } };
    }) };
  };
  const manager = new Manager({ document, getProject: () => project, getFields: () => fields,
    getConfig: () => configProvider(),
    getSource: async (...args) => { sources.push(args); return sourceProvider(...args); },
    generate: async args => { generated.push(args); return generator(args); },
    save: async (p, operations) => { writes.push({ project: p, operations }); return save(p, operations); },
    beforeOpen: () => true, openSettings() {}, notify: value => notices.push(value) });
  const click = async selector => {
    const element = document.querySelector(selector); assert.ok(element, selector);
    element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); await settle();
  };
  const input = (selector, value, eventType = 'input') => {
    const element = document.querySelector(selector); assert.ok(element, selector);
    if (typeof value === 'boolean') element.checked = value; else element.value = value;
    element.dispatchEvent(new window.Event(eventType, { bubbles: true, cancelable: true }));
  };
  return { manager, document, window, rows, config, fields: () => fields, sources, generated, writes, notices, click, input,
    project: value => { project = value; }, setFields: value => { fields = value; },
    configProvider: value => { configProvider = value; }, sourceProvider: value => { sourceProvider = value; },
    generator: value => { generator = value; }, save: value => { save = value; } };
}

test('opening a batch prepares local sources, discloses per-paper coverage and preserves immutable original snapshots without API calls', async () => {
  const f = fixture();
  await f.manager.open(f.rows);
  assert.equal(f.manager.isOpen(), true);
  assert.equal(f.sources.length, 2);
  assert.equal(f.generated.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.manager.summaryDetail, 'brief');
  assert.equal(f.manager.overwriteExisting, false);
  assert.deepEqual(f.manager.eligibleFields(f.manager.entries[0]).map(field => field.id), ['findings', 'outcomes']);
  assert.deepEqual(f.manager.eligibleFields(f.manager.entries[1]).map(field => field.id), ['outcomes']);
  assert.ok(f.document.querySelector('[data-batch-field="outcomes"]').checked, 'hidden active fields remain available');
  assert.equal(f.document.querySelector('[data-batch-field="archived"]'), null);
  assert.ok(f.document.querySelector('[data-batch-coverage="0"]').textContent.includes('已截断'));
  assert.ok(f.document.querySelector('#aiBatchDialog').textContent.includes('每篇文献分别调用一次'));
  assert.equal(f.document.querySelector('#aiBatchDialog IMG'), null, 'source text is inert');
  f.rows[1].values.findings = '其他窗口修改';
  f.rows[1].highlights.findings[0].end = 3;
  assert.equal(f.manager.entries[1].expected.findings, '人工结论');
  assert.equal(f.manager.entries[1].expectedHighlights.findings[0].end, 2);
});

test('batch generation is sequential and gives each request only that paper and its eligible fields', async () => {
  const f = fixture(), first = deferred();
  await f.manager.open(f.rows);
  let active = 0, maxActive = 0;
  f.generator(async args => {
    active++; maxActive = Math.max(active, maxActive);
    if (args.paper.title.endsWith('1')) await first.promise;
    active--;
    return Object.fromEntries(args.fields.map(field => [field.id, '事实 ' + args.paper.title]));
  });
  const running = f.manager.generate(); await settle();
  assert.equal(f.generated.length, 1);
  assert.equal(f.manager.busy, true);
  assert.equal(f.document.querySelector('[data-batch-detail="comprehensive"]').disabled, true);
  assert.equal(f.manager.setSummaryDetail('comprehensive'), false);
  first.resolve(); assert.equal(await running, true);
  assert.equal(maxActive, 1);
  assert.equal(f.generated.length, 2);
  assert.deepEqual(f.generated[0].fields.map(field => field.id), ['findings', 'outcomes']);
  assert.deepEqual(f.generated[1].fields.map(field => field.id), ['outcomes']);
  assert.ok(!JSON.stringify(f.generated).includes('PRIVATE_REMARK_'));
  assert.ok(!f.generated[0].source.text.includes(f.rows[1].key));
  assert.equal(f.writes.length, 0);
  assert.equal(f.rows[0].values.findings, '');
  assert.equal(f.manager.entries[0].origin.summaryDetail, 'brief');
});

test('selected draft fields from multiple papers use one atomic save with preview-time text and formatting expectations', async () => {
  const f = fixture(); await f.manager.open(f.rows);
  f.manager.overwriteExisting = true;
  f.manager.selected = new Set(['findings', 'outcomes']);
  await f.manager.generate();
  f.manager.entries[0].applySelected.delete('outcomes');
  f.input('[data-batch-draft="0:findings"]', '人工核对后的事实');
  assert.equal(await f.manager.apply(), true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].operations.length, 2);
  const operations = f.writes[0].operations;
  assert.deepEqual(operations[0].changes, { findings: '人工核对后的事实' });
  assert.deepEqual(operations[1].expectedHighlights.findings, [{ start: 0, end: 2, color: 'yellow' }]);
  assert.equal(operations[1].expected.findings, '人工结论');
  assert.equal(f.rows[0].values.findings, '人工核对后的事实');
  assert.equal(f.rows[0].values.outcomes, '');
  assert.equal(f.rows[0].values.remarks, 'PRIVATE_REMARK_0');
  assert.ok(f.manager.entries[0].drafts.has('outcomes'), 'unselected drafts remain editable');
  assert.equal(f.manager.entries[1].drafts.size, 0);
});

test('source failure blocks only that paper and explicit retry reads and generates only its failed work', async () => {
  const f = fixture(); let failSecond = true;
  f.sourceProvider(async row => {
    if (row.id === 2 && failSecond) throw new Error('模拟读取失败');
    return { text: '原文 ' + row.key, label: '模拟 PDF', paper: { title: row.title } };
  });
  await f.manager.open(f.rows);
  assert.equal(f.manager.entries[1].sourceState, 'error');
  await f.manager.generate();
  assert.equal(f.generated.length, 1);
  failSecond = false;
  assert.equal(await f.manager.retryFailed(), true);
  assert.equal(f.sources.length, 3);
  assert.equal(f.sources[2][0].id, 2);
  assert.equal(f.generated.length, 2);
  assert.equal(f.generated[1].paper.title, f.rows[1].title);
  assert.equal(f.manager.entries[0].generateState, 'success');
});

test('a provider failure preserves completed and edited drafts and only failed papers are retried explicitly', async () => {
  const f = fixture(); await f.manager.open(f.rows);
  let failSecond = true;
  f.generator(async args => {
    if (args.paper.title === f.rows[1].title && failSecond) throw new Error('模拟额度错误，需检查设置');
    return Object.fromEntries(args.fields.map(field => [field.id, '草稿 ' + field.id]));
  });
  assert.equal(await f.manager.generate(), false);
  assert.equal(f.generated.length, 2);
  f.input('[data-batch-draft="0:findings"]', '编辑后保留');
  failSecond = false;
  assert.equal(await f.manager.retryFailed(), true);
  assert.equal(f.generated.length, 3);
  assert.equal(f.generated[2].paper.title, f.rows[1].title);
  assert.equal(f.manager.entries[0].drafts.get('findings'), '编辑后保留');
  assert.equal(f.writes.length, 0);
});

test('cancelling a queue keeps completed drafts, ignores late replies and resumes only unfinished papers', async () => {
  const f = fixture(3), second = deferred(); await f.manager.open(f.rows);
  let calls = 0;
  f.generator(async args => {
    calls++;
    if (calls === 2) return second.promise;
    return Object.fromEntries(args.fields.map(field => [field.id, '草稿 ' + field.id]));
  });
  const running = f.manager.generate(); await settle();
  assert.equal(f.generated.length, 2);
  f.manager.cancelRequest();
  assert.equal(f.generated[1].signal.aborted, true);
  assert.equal(f.manager.entries[0].drafts.get('findings'), '草稿 findings');
  second.resolve({ outcomes: '晚到结果' }); await running;
  assert.equal(f.generated.length, 2, 'third paper must not be dispatched after cancellation');
  assert.equal(f.manager.entries[1].drafts.size, 0);
  assert.equal(f.manager.entries[2].generateState, 'idle');
  assert.equal(await f.manager.generate(), true);
  assert.deepEqual(f.generated.map(args => args.paper.title), [f.rows[0].title, f.rows[1].title, f.rows[1].title, f.rows[2].title]);
});

test('detail, source and field changes make no API calls or draft loss and regenerated fields retain separate origins', async () => {
  const f = fixture(); await f.manager.open(f.rows); await f.manager.generate();
  f.input('[data-batch-draft="0:outcomes"]', '原先人工编辑指标');
  const count = f.generated.length;
  f.manager.setSummaryDetail('comprehensive');
  f.input('[data-batch-field="outcomes"]', false, 'change');
  await f.manager.prepareSources('abstract');
  assert.equal(f.generated.length, count);
  assert.equal(f.manager.entries[0].drafts.get('outcomes'), '原先人工编辑指标');
  assert.equal(f.manager.entries[0].origins.get('outcomes').summaryDetail, 'brief');
  f.window.confirm = () => false;
  assert.equal(await f.manager.generate(false, true), false);
  assert.equal(f.generated.length, count);
  f.window.confirm = () => true;
  await f.manager.generate(false, true);
  assert.equal(f.manager.entries[0].origins.get('findings').summaryDetail, 'comprehensive');
  assert.equal(f.manager.entries[0].origins.get('outcomes').summaryDetail, 'brief');
  assert.equal(f.manager.entries[0].drafts.get('outcomes'), '原先人工编辑指标');
});

test('a conflicting atomic save preserves every edited draft, selection and original expectation for retry', async () => {
  const f = fixture(); await f.manager.open(f.rows); await f.manager.generate();
  f.input('[data-batch-draft="0:findings"]', '不能丢失的事实');
  f.save(async () => { throw new Error('格式或内容已在其他窗口修改'); });
  assert.equal(await f.manager.apply(), false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.manager.entries[0].expected.findings, '');
  assert.equal(f.manager.entries[0].drafts.get('findings'), '不能丢失的事实');
  assert.ok(f.manager.entries[0].applySelected.has('findings'));
  assert.equal(f.rows[0].values.findings, '');
  assert.ok(f.document.querySelector('#rg-batch-error').textContent.includes('其他窗口'));
});

test('project and field schema changes block stale generating or writing while preserving prepared drafts', async () => {
  const f = fixture(); await f.manager.open(f.rows); await f.manager.generate();
  f.project({ id: 'project-B', name: '项目 B' });
  assert.equal(await f.manager.apply(), false);
  assert.equal(f.writes.length, 0);
  assert.ok(f.manager.dirty());
  f.project({ id: 'project-A', name: '项目 A' });
  f.setFields(f.fields().map(field => field.id === 'findings' ? { ...field, requirement: '改变要求' } : field));
  assert.equal(await f.manager.generate(false, true), false);
  assert.equal(f.generated.length, 2);
  assert.ok(f.document.querySelector('#rg-batch-error').textContent.includes('填写要求'));
});

test('provider settings changed between papers stop the remaining queue without mixing destinations', async () => {
  const f = fixture(); await f.manager.open(f.rows);
  f.generator(async args => {
    f.configProvider(async () => ({ ...f.config, baseURL: 'https://changed.example.test/v1' }));
    return Object.fromEntries(args.fields.map(field => [field.id, '已有草稿']));
  });
  assert.equal(await f.manager.generate(), false);
  assert.equal(f.generated.length, 1);
  assert.ok(f.manager.entries[0].drafts.size > 0);
  assert.equal(f.manager.entries[1].drafts.size, 0);
  assert.ok(f.document.querySelector('#rg-batch-error').textContent.includes('API 设置已变化'));
});

test('closing during preparation rejects late old results after opening a different selection', async () => {
  const f = fixture(), pending = deferred();
  let first = true;
  f.sourceProvider(async row => {
    if (first) { first = false; return pending.promise; }
    return { text: '新论文内容', label: '新来源', paper: { title: row.title } };
  });
  const opening = f.manager.open([f.rows[0]]); await settle();
  assert.equal(f.manager.loading, true);
  assert.equal(f.manager.close(), true);
  await f.manager.open([f.rows[1]]);
  pending.resolve({ text: '旧论文晚到内容', label: '旧来源' }); await opening;
  assert.equal(f.manager.entries.length, 1);
  assert.equal(f.manager.entries[0].row, f.rows[1]);
  assert.equal(f.manager.entries[0].source.text, '新论文内容');
  assert.equal(f.generated.length, 0);
});

test('late pre-dispatch configuration lookup cannot send an old selection after close and reopen', async () => {
  const f = fixture(), pending = deferred(); await f.manager.open([f.rows[0]]);
  f.configProvider(() => pending.promise);
  const running = f.manager.generate(); await settle();
  assert.equal(f.generated.length, 0);
  f.manager.close();
  f.configProvider(async () => f.config);
  await f.manager.open([f.rows[1]]);
  pending.resolve(f.config); await running;
  assert.equal(f.generated.length, 0);
  assert.equal(f.manager.entries[0].row, f.rows[1]);
});

test('read-only papers can create previews but cannot be selected or saved as writes', async () => {
  const f = fixture(); f.rows.forEach(row => { row.editable = false; });
  await f.manager.open(f.rows); await f.manager.generate();
  assert.equal(f.generated.length, 2);
  assert.equal(f.manager.selectedOperations().length, 0);
  assert.equal(f.document.querySelector('[data-batch-apply="0:findings"]').disabled, true);
  assert.equal(await f.manager.apply(), false);
  assert.equal(f.writes.length, 0);
});

test('discard confirmation preserves drafts and close is blocked while saving', async () => {
  const f = fixture(); await f.manager.open(f.rows); await f.manager.generate();
  f.window.confirm = () => false;
  assert.equal(f.manager.close(), false);
  assert.equal(f.manager.isOpen(), true);
  const pending = deferred(); f.save(() => pending.promise);
  const saving = f.manager.apply(); await settle();
  assert.equal(f.manager.saving, true);
  assert.equal(f.manager.close(true), false);
  pending.resolve({ records: [] }); await saving;
  assert.equal(f.manager.saving, false);
  assert.equal(f.manager.close(), true);
});

test('missing configuration and duplicate or excessive selections remain closable without requests', async () => {
  const f = fixture();
  assert.equal(await f.manager.open([f.rows[0], f.rows[0]]), false);
  assert.equal(f.manager.isOpen(), false);
  assert.ok(f.notices.at(-1).includes('重复'));
  assert.equal(await f.manager.open(Array.from({ length: MAX_PAPERS + 1 }, (_, index) => ({ id: index + 1, key: 'K' + index }))), false);
  f.configProvider(async () => ({ baseURL: '', model: '' }));
  await f.manager.open(f.rows);
  assert.equal(f.document.querySelector('#rg-batch-generate').disabled, true);
  assert.equal(await f.manager.generate(), false);
  assert.equal(f.generated.length, 0);
  assert.equal(f.manager.close(), true);
});

test('pagination retains draft selections across all pages and malicious returned markup is inert', async () => {
  const f = fixture(11); await f.manager.open(f.rows);
  f.manager.selected = new Set(['outcomes']);
  f.generator(async () => ({ outcomes: '<img src=x onerror="execute()"><script>never()</script>' }));
  await f.manager.generate();
  assert.equal(f.manager.selectedOperations().length, 11);
  assert.equal(f.document.querySelector('#aiBatchDialog img'), null);
  assert.equal(f.document.querySelector('#aiBatchDialog script'), null);
  f.input('[data-batch-apply="0:outcomes"]', false, 'change');
  await f.click('#rg-batch-next');
  assert.equal(f.document.querySelector('[data-batch-paper="10"]').getAttribute('data-batch-paper'), '10');
  assert.equal(f.manager.selectedOperations().length, 10);
  await f.click('#rg-batch-prev');
  assert.ok(!f.document.querySelector('[data-batch-apply="0:outcomes"]').checked);
});


test('late initial config from a closed selection cannot overwrite a newer batch destination', async () => {
  const f = fixture(), pending = deferred();
  f.configProvider(() => pending.promise);
  const opening = f.manager.open([f.rows[0]]); await settle();
  f.manager.close();
  const newer = { ...f.config, baseURL: 'https://new-destination.example.test/v1', model: 'new-model' };
  f.configProvider(async () => newer);
  await f.manager.open([f.rows[1]]);
  pending.resolve(f.config); await opening;
  assert.equal(f.manager.config.baseURL, newer.baseURL);
  assert.equal(f.manager.config.model, newer.model);
  assert.equal(f.document.querySelector('#rg-batch-endpoint').textContent, newer.baseURL);
  assert.equal(f.manager.entries[0].row, f.rows[1]);
  assert.equal(f.generated.length, 0);
});


test('cancelling local preparation makes both the active and waiting papers resumable without repeating completed work', async () => {
  const f = fixture(3), pending = deferred();
  let cancelledRead = true;
  f.sourceProvider(async row => {
    if (row.id === 2 && cancelledRead) return pending.promise;
    return { text: '论文原文 ' + row.key, label: '模拟 PDF', paper: { title: row.title } };
  });
  const opening = f.manager.open(f.rows); await settle();
  assert.deepEqual(f.manager.entries.map(entry => entry.sourceState), ['ready', 'loading', 'waiting']);
  assert.equal(f.manager.cancelRequest(), true);
  assert.deepEqual(f.manager.entries.map(entry => entry.sourceState), ['ready', 'error', 'error']);
  assert.ok(f.document.querySelector('#rg-batch-status').textContent.includes('继续未完成'));
  assert.equal(f.document.querySelector('#rg-batch-retry').disabled, false);
  pending.resolve({ text: '应忽略的取消后晚到文本', label: '旧来源' }); await opening;
  cancelledRead = false;
  assert.equal(await f.manager.retryFailed(), true);
  assert.deepEqual(f.sources.map(([row]) => row.id), [1, 2, 2, 3], 'previously ready paper is not reread; waiting paper is now prepared');
  assert.deepEqual(f.generated.map(args => args.paper.title), f.rows.map(row => row.title));
  assert.deepEqual(f.manager.entries.map(entry => entry.generateState), ['success', 'success', 'success']);
  assert.equal(f.writes.length, 0);
});
