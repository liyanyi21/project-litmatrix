const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DOMParser } = require('linkedom');
const C = require('../plugin/content/core.js');
const parse = html => C.parseNote(html, DOMParser);
const user = { libraryType: 'user', libraryID: 1 };
const group = { libraryType: 'group', libraryID: 2, groupID: 200 };

test('project identity survives local numeric ID changes and separates groups and collections', () => {
  assert.equal(C.projectID(user, 'ABCDEFGH'), C.projectID({ ...user, libraryID: 9 }, 'ABCDEFGH'));
  assert.notEqual(C.projectID(user, 'ABCDEFGH'), C.projectID(group, 'ABCDEFGH'));
  assert.notEqual(C.projectID(user, 'ABCDEFGH'), C.projectID(user, 'XYZABCDE'));
  assert.throws(() => C.projectID(user, ''), /选择/);
});
test('Chinese multiline values round-trip without executing HTML', () => {
  const text = '第一段，包含 "引号"\n第二行\n\n第三段 <script>alert(1)</script> & = 不执行';
  const html = C.createNote('远程驾驶 <项目>', { findings: text });
  assert.equal(parse(html).values.findings, text);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;项目&gt;'));
});
test('editing one field preserves every other field and unknown rich sections', () => {
  const html = C.createNote('项目 A', { remarks: '原备注', findings: '原结论' })
    .replace('</div>', '<h2>额外资料</h2><p><a href="zotero://open-pdf/library/items/ABCDEFGH">原文</a></p></div>');
  const result = C.updateNote(html, 'findings', '新结论\n含换行', DOMParser);
  assert.equal(parse(result).values.findings, '新结论\n含换行');
  assert.equal(parse(result).values.remarks, '原备注');
  assert.ok(result.includes('zotero://open-pdf/library/items/ABCDEFGH'));
  assert.ok(result.includes('额外资料'));
});
test('fixed field identity survives display heading renaming', () => {
  const html = C.createNote('项目 A', { findings: '结果' }).replace('>核心结论</h2>', '>新的显示名称</h2>');
  assert.equal(parse(html).values.findings, '结果');
});
test('standard headings remain readable if a note editor removes custom attributes', () => {
  const html = C.createNote('项目 A', { findings: '可恢复' }).replace(/ data-plm-field="[^"]+"/g, '');
  assert.equal(parse(html).values.findings, '可恢复');
});
test('missing sections are appended; duplicate sections block writes', () => {
  const html = '<div data-schema-version="9"><h1>项目笔记</h1><p>保留的前言</p></div>';
  const updated = C.updateNote(html, 'remarks', '备注', DOMParser);
  assert.equal(parse(updated).values.remarks, '备注');
  assert.ok(updated.includes('保留的前言'));
  assert.throws(() => parse(C.createNote('A').replace('</div>', '<h2 data-plm-field="findings">冲突</h2></div>')), /重复/);
});
test('paper-level search matches terms across separate annotations and analysis fields', () => {
  const row = { title: '远程驾驶', authors: '张', year: '2026', tags: [], values: { findings: '接管效果' },
    annotations: [{ text: 'driving simulator', comment: '' }, { text: 'takeover performance', comment: '' }] };
  assert.equal(C.filterRows([row], 'simulator takeover 接管').length, 1);
  assert.equal(C.filterRows([row], '不存在').length, 0);
  assert.equal(C.filterRows([row], '', 'filled').length, 1);
  assert.equal(C.filterRows([row], '', 'empty').length, 0);
});
test('zero-annotation papers and empty projects remain valid', () => {
  const row = { title: '尚未阅读', tags: [], values: C.blankValues(), annotations: [] };
  assert.equal(C.filterRows([row], '', 'empty').length, 1);
  assert.equal(C.filterRows([], '').length, 0);
});
test('CSV exports all Chinese fields with BOM, multiline/quote escaping and links', () => {
  const row = { authors: 'A', year: '2026', title: '题目,"测试"', citekey: 'A2026', tags: ['一', '二'],
    values: { ...C.blankValues(), findings: '第一行\n第二行', methods_sample: '隐藏字段也导出' }, annotations: [],
    itemURL: C.itemLink(user, 'ABCDEFGH'), pdfURL: C.pdfLink(user, 'PDFABCDE'), noteURL: C.itemLink(user, 'NOTEABCD') };
  const csv = C.toCSV([row], '项目', 'user:collection:ABCDEFGH');
  assert.ok(csv.startsWith('\uFEFF"项目"'));
  assert.ok(csv.includes('"题目,""测试"""'));
  assert.ok(csv.includes('"第一行\n第二行"'));
  assert.ok(csv.includes('隐藏字段也导出'));
  assert.ok(csv.includes('zotero://open-pdf/library/items/PDFABCDE'));
  assert.ok(csv.endsWith('\r\n'));
});
test('CSV neutralizes formulas in all externally supplied cells', () => {
  const row = { authors: '+bad', title: '=HYPERLINK("https://example.com")', tags: [], annotations: [],
    values: { ...C.blankValues(), remarks: ' \t@SUM(1)' } };
  const csv = C.toCSV([row], '-项目', 'key');
  assert.ok(csv.includes('"\'=HYPERLINK('));
  assert.ok(csv.includes('"\'+bad"'));
  assert.ok(csv.includes('"\'-项目"'));
  assert.ok(csv.includes('"\' \t@SUM(1)"'));
});
test('deep links distinguish user/group libraries and annotation targets', () => {
  assert.equal(C.itemLink(group, 'ABCDEFGH'), 'zotero://select/groups/200/items/ABCDEFGH');
  assert.equal(C.pdfLink(group, 'PDFABCDE', 'ANNABCDE'), 'zotero://open-pdf/groups/200/items/PDFABCDE?annotation=ANNABCDE');
  assert.equal(C.pdfLink(user, ''), '');
});
