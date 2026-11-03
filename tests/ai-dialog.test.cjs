const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { Manager } = require('../plugin/content/ai-dialog.js');

const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
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
  let project = { id: 'project-A', name: '项目 A' };
  let fields = [
    { id: 'findings', label: '核心结论', requirement: '记录结论和原文页码', visible: true },
    { id: 'outcomes', label: '结果指标', requirement: '记录指标定义', visible: false },
    { id: 'remarks', label: '项目备注', requirement: '记录与项目的关系', visible: true },
  ];
  const row = { id: 1, key: 'PAPER1', title: '测试论文', authors: '作者', year: '2026', editable: true,
    values: { findings: '', outcomes: '', remarks: '人工填写的原有备注' } };
  const config = { baseURL: 'https://api.example.test/v1', model: 'test-model', maxChars: 48000 };
  const source = { text: '<script>untrusted paper text</script>\n论文片段', label: '提取的 PDF 文本', chars: 50,
    truncated: true, warning: '仅提供了论文的一部分', paper: { title: row.title, authors: row.authors, year: row.year } };
  const generated = [], writes = [], sources = [];
  let generate = async () => ({ findings: '结论草稿', outcomes: '指标草稿' });
  let save = async (p, target, changes, expected) => {
    Object.assign(target.values, changes);
    return { values: copy(target.values), note: { key: 'NOTE1' } };
  };
  let configProvider = async () => config;
  let sourceProvider = async () => source;
  let settings = 0;
  const manager = new Manager({ document, getProject: () => project, getFields: () => fields,
    getConfig: () => configProvider(),
    getSource: async (...args) => { sources.push(args); return sourceProvider(...args); },
    generate: async args => { generated.push(args); return generate(args); },
    save: async (...args) => { writes.push(copy(args)); return save(...args); },
    beforeOpen: () => true, notify() {}, openSettings: () => { settings++; } });
  const click = async selector => {
    const element = document.querySelector(selector);
    assert.ok(element, selector);
    element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await settle();
  };
  const setDraft = (id, text) => {
    const element = document.querySelector(`[data-ai-draft="${id}"]`);
    element.value = text;
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return { manager, window, document, row, config, source, generated, writes, sources, click, setDraft,
    fields: () => fields, project: value => { project = value; }, setFields: value => { fields = value; },
    generate: value => { generate = value; }, save: value => { save = value; },
    configProvider: value => { configProvider = value; }, sourceProvider: value => { sourceProvider = value; }, settings: () => settings };
}

test('opening AI preview only prepares local text and defaults to empty fields, with explicit destination disclosure', async () => {
  const f = fixture();
  await f.manager.open(f.row);
  assert.equal(f.manager.isOpen(), true);
  assert.equal(f.generated.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0][1].mode, 'indexed');
  assert.equal(f.document.querySelector('[data-ai-field="findings"]').checked, true);
  assert.equal(f.document.querySelector('[data-ai-field="outcomes"]').checked, true, 'hidden fields can also be summarized');
  assert.ok(!f.document.querySelector('[data-ai-field="remarks"]').checked);
  assert.equal(f.document.querySelector('#rg-ai-endpoint').textContent, f.config.baseURL);
  assert.equal(f.document.querySelector('#rg-ai-model').textContent, 'test-model');
  assert.ok(f.document.querySelector('#aiSummaryDialog').textContent.includes('项目名称'));
  assert.ok(f.document.querySelector('#aiSummaryDialog').textContent.includes('不发送批注'));
  assert.ok(f.document.querySelector('#rg-ai-source-coverage').textContent.includes('截断'));
  assert.equal(f.document.querySelector('#rg-ai-source-preview').textContent, f.source.text);
  assert.equal(f.document.querySelector('#rg-ai-source-preview script'), null);
  assert.equal(f.document.querySelector('#rg-ai-generate').disabled, false);
});

test('generating creates editable drafts without writing; apply sends only explicitly selected values and opening originals', async () => {
  const f = fixture();
  await f.manager.open(f.row);
  await f.click('#rg-ai-generate');
  assert.equal(f.generated.length, 1);
  assert.deepEqual(f.generated[0].fields.map(field => field.id), ['findings', 'outcomes']);
  assert.equal(f.generated[0].fields[0].requirement, '记录结论和原文页码');
  assert.equal(f.generated[0].project.name, '项目 A');
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.row.values, { findings: '', outcomes: '', remarks: '人工填写的原有备注' });
  assert.equal(f.manager.dirty(), true);
  f.setDraft('findings', '人工核对后的结论');
  f.manager.applySelected.delete('outcomes');
  await f.manager.apply();
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0][2], { findings: '人工核对后的结论' });
  assert.deepEqual(f.writes[0][3], { findings: '' });
  assert.equal(f.row.values.remarks, '人工填写的原有备注');
  assert.equal(f.row.values.outcomes, '');
  assert.equal(f.manager.drafts.get('outcomes'), '指标草稿');
  assert.equal(f.manager.selected.has('findings'), false, 'saved values are no longer default generation targets');
  assert.equal(f.manager.isOpen(), true);
});

test('existing content is included only after selection and is shown locally before explicit overwrite', async () => {
  const f = fixture();
  await f.manager.open(f.row);
  f.manager.selected = new Set(['remarks']);
  f.generate(async () => ({ remarks: 'AI 建议备注' }));
  await f.manager.generate();
  assert.ok(f.document.querySelector('.rg-ai-original').textContent.includes('人工填写的原有备注'));
  assert.equal(f.writes.length, 0);
  await f.manager.apply();
  assert.deepEqual(f.writes[0][3], { remarks: '人工填写的原有备注' });
  assert.equal(f.row.values.remarks, 'AI 建议备注');
  assert.equal(f.manager.dirty(), false);
});

test('save conflicts preserve editable drafts and existing values; user can retry', async () => {
  const f = fixture();
  await f.manager.open(f.row); await f.manager.generate();
  f.setDraft('findings', '不能丢失的修改');
  f.save(async () => { throw new Error('字段已经被其他窗口修改'); });
  assert.equal(await f.manager.apply(), false);
  assert.equal(f.row.values.findings, '');
  assert.equal(f.manager.drafts.get('findings'), '不能丢失的修改');
  assert.equal(f.document.querySelector('[data-ai-draft="findings"]').value, '不能丢失的修改');
  assert.ok(f.document.querySelector('#rg-ai-error').textContent.includes('其他窗口'));
  assert.ok(f.document.querySelector('#rg-ai-status').textContent.includes('尚未写入'));
  assert.equal(f.manager.busy, false);
  assert.equal(f.manager.isOpen(), true);
  f.save(async (project, row, changes) => ({ values: { ...row.values, ...changes } }));
  assert.equal(await f.manager.apply(), true);
  assert.equal(f.manager.dirty(), false);
});

test('cancel ignores a late generation response and never modifies the paper', async () => {
  const f = fixture(), pending = deferred();
  await f.manager.open(f.row);
  f.generate(() => pending.promise);
  const request = f.manager.generate(); await settle();
  assert.equal(f.manager.generating, true);
  const signal = f.generated[0].signal;
  f.manager.cancelRequest();
  assert.equal(signal.aborted, true);
  assert.equal(f.manager.busy, false);
  pending.resolve({ findings: '不应出现的晚到结果', outcomes: '晚到结果' }); await request;
  assert.equal(f.manager.drafts.size, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.row.values.findings, '');
  assert.ok(f.document.querySelector('#rg-ai-status').textContent.includes('已取消'));
});

test('closing and reopening for a different paper rejects late results from the previous request', async () => {
  const f = fixture(), pending = deferred();
  await f.manager.open(f.row);
  f.generate(() => pending.promise);
  const request = f.manager.generate(); await settle();
  f.manager.close(true);
  const next = { ...f.row, id: 2, key: 'PAPER2', title: '另一篇论文' };
  await f.manager.open(next);
  pending.resolve({ findings: '旧论文结果', outcomes: '旧论文指标' }); await request;
  assert.equal(f.manager.row.title, '另一篇论文');
  assert.equal(f.manager.drafts.size, 0);
  assert.equal(f.manager.isOpen(), true);
});

test('project or field requirement changes prevent generation and applying stale drafts', async () => {
  const f = fixture();
  await f.manager.open(f.row);
  f.fields()[0].requirement = '后台改了要求';
  await f.manager.generate();
  assert.equal(f.generated.length, 0);
  assert.ok(f.document.querySelector('#rg-ai-error').textContent.includes('填写要求'));
  f.fields()[0].requirement = '记录结论和原文页码';
  await f.manager.generate();
  f.project({ id: 'project-B', name: '另一个项目' });
  assert.equal(await f.manager.apply(), false);
  assert.equal(f.writes.length, 0);
  assert.ok(f.document.querySelector('#rg-ai-error').textContent.includes('项目已变化'));
  assert.equal(f.manager.dirty(), true);
});

test('failed generation preserves previous drafts and closing them requires discard confirmation', async () => {
  const f = fixture();
  await f.manager.open(f.row); await f.manager.generate();
  f.setDraft('findings', '仍需保留的草稿');
  f.generate(async () => { throw new Error('API 暂时不可用'); });
  await f.manager.generate();
  assert.equal(f.manager.drafts.get('findings'), '仍需保留的草稿');
  assert.ok(f.document.querySelector('#rg-ai-error').textContent.includes('API 暂时不可用'));
  f.window.confirm = () => false;
  assert.equal(f.manager.close(), false);
  assert.equal(f.manager.isOpen(), true);
  f.window.confirm = () => true;
  assert.equal(f.manager.close(), true);
  assert.equal(f.writes.length, 0);
});

test('missing API configuration remains a closable settings screen without network calls', async () => {
  const f = fixture();
  f.configProvider(async () => { throw new Error('请填写 API 地址和模型'); });
  await f.manager.open(f.row);
  assert.equal(f.document.querySelector('#rg-ai-generate').disabled, true);
  assert.ok(f.document.querySelector('#aiSummaryDialog').textContent.includes('请填写 API 地址'));
  assert.equal(f.generated.length, 0);
  await f.click('#rg-ai-settings');
  assert.equal(f.settings(), 1);
  assert.equal(f.manager.close(), true);
});

test('missing returned fields are not selected to apply and switching source mode makes no API request', async () => {
  const f = fixture();
  await f.manager.open(f.row);
  await f.manager.loadSource('abstract');
  assert.equal(f.sources[1][1].mode, 'abstract');
  assert.equal(f.generated.length, 0);
  f.generate(async () => ({ findings: '只有结论' }));
  await f.manager.generate();
  assert.equal(f.manager.drafts.get('outcomes'), '');
  assert.equal(f.manager.applySelected.has('outcomes'), false);
  assert.ok(f.document.querySelector('#aiSummaryDialog').textContent.includes('没有返回此字段'));
  await f.manager.apply();
  assert.deepEqual(f.writes[0][2], { findings: '只有结论' });
});


test('late configuration from a closed preview cannot change the destination of a newly opened paper', async () => {
  const f = fixture(), oldConfig = deferred();
  let first = true;
  f.configProvider(() => first ? (first = false, oldConfig.promise) : Promise.resolve({ ...f.config, baseURL: 'https://new.example.test/v1' }));
  const oldOpen = f.manager.open(f.row); await settle();
  f.manager.close(true);
  await f.manager.open({ ...f.row, id: 2, title: '第二篇论文' });
  oldConfig.resolve({ ...f.config, baseURL: 'https://old.example.test/v1' }); await oldOpen;
  assert.equal(f.manager.config.baseURL, 'https://new.example.test/v1');
  assert.equal(f.document.querySelector('#rg-ai-endpoint').textContent, 'https://new.example.test/v1');
});


test('refreshing configuration after setup enables generation without closing the preview or sending a request', async () => {
  const f = fixture();
  let configured = false;
  f.configProvider(async () => configured ? { ...f.config, baseURL: 'https://configured.example.test/v1', maxChars: 12000 } : { baseURL: '', model: '', maxChars: 48000 });
  await f.manager.open(f.row);
  assert.equal(f.document.querySelector('#rg-ai-generate').disabled, true);
  configured = true;
  await f.click('#rg-ai-refresh-config');
  assert.equal(f.document.querySelector('#rg-ai-endpoint').textContent, 'https://configured.example.test/v1');
  assert.equal(f.document.querySelector('#rg-ai-generate').disabled, false);
  assert.equal(f.sources.at(-1)[1].maxChars, 12000);
  assert.equal(f.generated.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.manager.isOpen(), true);
});

test('refreshing API settings preserves editable drafts and shows their original provider', async () => {
  const f = fixture();
  await f.manager.open(f.row); await f.manager.generate();
  f.setDraft('findings', '刷新设置时保留的修改');
  f.configProvider(async () => ({ ...f.config, baseURL: 'https://new.example.test/v1', model: 'different-model' }));
  await f.manager.refreshConfig();
  assert.equal(f.manager.drafts.get('findings'), '刷新设置时保留的修改');
  assert.equal(f.document.querySelector('[data-ai-draft="findings"]').value, '刷新设置时保留的修改');
  assert.equal(f.document.querySelector('#rg-ai-endpoint').textContent, 'https://new.example.test/v1');
  assert.ok(f.document.querySelector('.rg-ai-draft-origin').textContent.includes('https://api.example.test/v1'));
  assert.ok(f.document.querySelector('.rg-ai-draft-origin').textContent.includes('test-model'));
  assert.equal(f.generated.length, 1);
  assert.equal(f.writes.length, 0);
});

test('late refresh from a closed dialog cannot update a newly opened destination', async () => {
  const f = fixture(), pending = deferred();
  await f.manager.open(f.row);
  f.configProvider(() => pending.promise);
  const refresh = f.manager.refreshConfig(); await settle();
  assert.equal(f.document.querySelector('#rg-ai-refresh-config').disabled, true);
  assert.equal(f.document.querySelector('#rg-ai-settings').disabled, true);
  f.manager.close(true);
  f.configProvider(async () => ({ ...f.config, baseURL: 'https://current.example.test/v1' }));
  await f.manager.open({ ...f.row, id: 3 });
  pending.resolve({ ...f.config, baseURL: 'https://stale.example.test/v1' }); await refresh;
  assert.equal(f.manager.config.baseURL, 'https://current.example.test/v1');
  assert.equal(f.document.querySelector('#rg-ai-endpoint').textContent, 'https://current.example.test/v1');
});
