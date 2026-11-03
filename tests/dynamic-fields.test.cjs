const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DOMParser } = require('linkedom');
const C = require('../plugin/content/core.js');

const custom = { id: 'custom_11111111', label: '研究问题', requirement: '说明本文解决什么问题', visible: true };
const remarks = { ...C.fieldByID('remarks') };
const parse = (html, fields) => C.parseNote(html, DOMParser, fields);
const row = values => ({ title: '普通论文', authors: '张', year: '2026', tags: [], annotations: [], values });

test('custom field IDs survive project-specific label and requirement changes', () => {
  const fields = [custom, remarks];
  const html = C.createNote('项目 A', { [custom.id]: '旧值', remarks: '备注' }, fields);
  const renamed = [{ ...custom, label: '本项目的问题', requirement: '新的填写要求' }, remarks];
  assert.equal(parse(html, renamed).values[custom.id], '旧值');
  const updated = C.updateNote(html, custom.id, '新值\n第二行', DOMParser, renamed);
  assert.equal(parse(updated, renamed).values[custom.id], '新值\n第二行');
  assert.equal(parse(updated, renamed).values.remarks, '备注');
  assert.ok(updated.includes('>本项目的问题</h2>'));
});

test('renamed built-in fields recover old notes even when custom attributes were stripped', () => {
  const html = C.createNote('旧项目', { findings: '历史结论', remarks: '保留' }).replace(/ data-plm-field="[^"]+"/g, '');
  const fields = [{ ...C.fieldByID('findings'), label: '对本项目的发现' }, remarks];
  assert.equal(parse(html, fields).values.findings, '历史结论');
  const updated = C.updateNote(html, 'findings', '更新后结论', DOMParser, fields);
  assert.equal(parse(updated, fields).values.findings, '更新后结论');
  assert.equal(parse(updated, fields).values.remarks, '保留');
});

test('custom label history recovers renamed headings after note editor strips attributes', () => {
  const html = C.createNote('项目', { [custom.id]: '历史问题' }, [custom]).replace(/ data-plm-field="[^"]+"/g, '');
  const fields = [{ ...custom, label: '项目研究问题', aliases: [custom.label] }];
  assert.equal(parse(html, fields).values[custom.id], '历史问题');
  const updated = C.updateNote(html, custom.id, '新问题', DOMParser, fields);
  assert.equal(parse(updated, fields).values[custom.id], '新问题');
  assert.ok(updated.includes('>项目研究问题</h2>'));
});

test('legacy label recovery never reassigns built-in content to a custom field with the same label', () => {
  const fields = [{ ...custom, label: '核心结论' }, { ...C.fieldByID('findings'), label: '项目发现' }];
  const old = '<div><h2>核心结论</h2><p>来自旧版的结论</p></div>';
  const values = parse(old, fields).values;
  assert.equal(values.findings, '来自旧版的结论');
  assert.equal(values[custom.id], '');
  const explicit = `<div><h2 data-plm-field="${custom.id}">核心结论</h2><p>真正的自定义值</p></div>`;
  assert.equal(parse(explicit, fields).values[custom.id], '真正的自定义值');
});

test('ambiguous custom label aliases reject writes instead of guessing a field', () => {
  const fields = [custom, { id: 'custom_22222222', label: '另一个问题', aliases: [custom.label] }];
  const html = '<div><h2>研究问题</h2><p>不应被错写</p></div>';
  assert.throws(() => C.updateNote(html, custom.id, '新内容', DOMParser, fields), /无法唯一识别/);
});

test('archived and unknown note sections survive edits while active search and CSV ignore them', () => {
  const archived = { ...custom, archived: true };
  const html = C.createNote('项目', { [custom.id]: '仅归档字段包含的词', remarks: '活动备注' }, [custom, remarks])
    .replace('</div>', '<h2 data-plm-field="custom_unknown">其他设备字段</h2><p><a href="https://example.com">未知内容</a></p></div>');
  const updated = C.updateNote(html, 'remarks', '新备注', DOMParser, [archived, remarks]);
  const values = parse(updated, [archived, remarks]).values;
  assert.equal(values[custom.id], '仅归档字段包含的词');
  assert.equal(values.custom_unknown, '未知内容');
  assert.ok(updated.includes('<a href="https://example.com">'));
  assert.equal(C.filterRows([row(values)], '仅归档', 'all', [archived, remarks]).length, 0);
  assert.equal(C.filterRows([row({ [custom.id]: '有值', remarks: '' })], '', 'empty', [archived, remarks]).length, 1);
  const csv = C.toCSV([row(values)], '项目', 'key', [archived, remarks]);
  assert.ok(!csv.includes('仅归档字段包含的词'));
  assert.ok(!csv.includes('未知内容'));
  assert.ok(!csv.includes('研究问题'));
  assert.ok(csv.includes('新备注'));
  assert.throws(() => C.updateNote(html, custom.id, '不允许编辑', DOMParser, [archived, remarks]), /已移除/);
  assert.ok(!C.createNote('新笔记', {}, [archived, remarks]).includes(custom.id));
});

test('custom CSV follows project field order including hidden fields and escapes formulas', () => {
  const fields = [{ ...custom, label: '=危险列名', visible: false }, remarks];
  const csv = C.toCSV([row({ [custom.id]: '@公式', remarks: '普通备注' })], '项目', 'key', fields);
  const header = csv.split('\r\n')[0];
  assert.ok(header.indexOf('危险列名') < header.indexOf('我的备注'));
  assert.ok(csv.includes('"\'=危险列名"'));
  assert.ok(csv.includes('"\'@公式"'));
  assert.ok(csv.includes('普通备注'));
});

test('custom note labels and IDs are escaped and unknown magic IDs do not change object prototypes', () => {
  const fields = [{ id: 'custom_"<&', label: '<script>危险名称</script>', visible: true }];
  const html = C.createNote('<项目>', { [fields[0].id]: '<img src=x>' }, fields);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.equal(parse(html, fields).values[fields[0].id], '<img src=x>');
  const values = parse('<div><h2 data-plm-field="__proto__">未知字段</h2><p>仅为文本</p></div>', []).values;
  assert.equal(Object.getPrototypeOf(values), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(values, '__proto__').value, '仅为文本');
});
