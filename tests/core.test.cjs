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

test('highlights round-trip Chinese, UTF16 emoji, whitespace and repeated blank lines while values stay plain', () => {
  const text = '  前😀后\n\n\n第二段 & <证据>  ';
  const start = text.indexOf('😀'), end = text.indexOf(' &');
  const ranges = [{ start, end, color: 'yellow' }];
  const html = C.createNote('项目', { findings: text }, C.FIELDS, { findings: ranges });
  const result = parse(html);
  assert.equal(result.values.findings, text.trim());
  assert.deepEqual(result.highlights.findings, [{ start: start - 2, end: end - 2, color: 'yellow' }]);
  assert.ok(html.includes('background-color: #ffd400'));
  assert.ok(html.includes('&lt;证据&gt;'));
  assert.ok(!html.includes('<证据>'));
  assert.deepEqual(ranges, [{ start, end, color: 'yellow' }], 'serialization never mutates ranges');
  const mixed = '甲\r\n😀\r乙';
  const mixedResult = parse(C.createNote('项目', { findings: mixed }, C.FIELDS, {
    findings: [{ start: 3, end: 5, color: 'green' }],
  }));
  assert.equal(mixedResult.values.findings, mixed);
  assert.deepEqual(mixedResult.highlights.findings, [{ start: 3, end: 5, color: 'green' }]);
});

test('Zotero style-only highlights and nested marks survive stripped custom attributes', () => {
  const html = '<div><h2 data-plm-field="findings">核心结论</h2><p>甲<span style="background-color: rgb(255, 212, 0);">乙<span style="background-color:#7dd3fc">丙</span>丁</span><mark>戊</mark></p></div>';
  const result = parse(html);
  assert.equal(result.values.findings, '甲乙丙丁戊');
  assert.deepEqual(result.highlights.findings, [
    { start: 1, end: 2, color: 'yellow' }, { start: 2, end: 3, color: 'blue' },
    { start: 3, end: 5, color: 'yellow' },
  ]);
  const rewritten = C.updateNote(html, 'findings', '甲乙丙丁戊', DOMParser);
  assert.deepEqual(parse(rewritten).highlights.findings, result.highlights.findings);
});

test('unsafe external formatting is ignored and all user text is escaped when creating highlight HTML', () => {
  const hostile = '<img src=x onerror=alert(1)> & "quote"';
  const html = C.valueHTML(hostile, [{ start: 0, end: hostile.length, color: 'pink' }]);
  assert.ok(!html.includes('<img'));
  const result = parse('<div><h2 data-plm-field="findings">核心结论</h2>' + html + '</div>');
  assert.equal(result.values.findings, hostile);
  assert.deepEqual(result.highlights.findings, [{ start: 0, end: hostile.length, color: 'pink' }]);
  const unsafe = parse('<div><h2 data-plm-field="remarks">我的备注</h2><p><span data-rg-highlight="constructor" style="background-color: url(javascript:alert(1))">仍可读取</span></p></div>');
  assert.equal(unsafe.values.remarks, '仍可读取');
  assert.deepEqual(unsafe.highlights.remarks, []);
});

test('highlight overlays and removal split only the selected text and merge adjacent equal colors', () => {
  const original = [{ start: 0, end: 8, color: 'yellow' }];
  const colored = C.applyHighlight('abcdefgh', original, 2, 6, 'blue');
  assert.deepEqual(colored, [{ start: 0, end: 2, color: 'yellow' }, { start: 2, end: 6, color: 'blue' }, { start: 6, end: 8, color: 'yellow' }]);
  assert.deepEqual(C.applyHighlight('abcdefgh', colored, 3, 7, null), [{ start: 0, end: 2, color: 'yellow' }, { start: 2, end: 3, color: 'blue' }, { start: 7, end: 8, color: 'yellow' }]);
  assert.deepEqual(C.applyHighlight('abcdefgh', colored, 2, 6, 'yellow'), original);
  assert.deepEqual(original, [{ start: 0, end: 8, color: 'yellow' }]);
});

test('malformed ranges, inherited color names, oversized collections and split surrogate pairs cannot be saved', () => {
  for (const ranges of [null, [{ start: -1, end: 1, color: 'yellow' }], [{ start: 0, end: 4, color: 'yellow' }],
    [{ start: 1.5, end: 2, color: 'yellow' }], [{ start: 0, end: 1, color: 'constructor' }],
    [{ start: 0, end: 1, color: 'background:url(x)' }], [{ start: 0, end: 0, color: 'yellow' }]]) {
    assert.throws(() => C.normalizeHighlights('abc', ranges), /高亮/);
  }
  assert.throws(() => C.normalizeHighlights('😀甲', [{ start: 1, end: 3, color: 'yellow' }]), /高亮/);
  assert.throws(() => C.applyHighlight('😀甲', [], 0, 1, 'green'), /选中/);
  assert.throws(() => C.normalizeHighlights('abc', Array.from({ length: 2001 }, () => ({ start: 0, end: 1, color: 'yellow' }))), /过多/);
});

test('plain-text edits rebase unaffected highlights and drop formatting only from replaced characters', () => {
  const old = 'before MID after';
  const ranges = [{ start: 0, end: 6, color: 'blue' }, { start: 7, end: 10, color: 'yellow' }, { start: 11, end: 16, color: 'green' }];
  assert.deepEqual(C.rebaseHighlights(old, 'before NEWLONG after', ranges), [
    { start: 0, end: 6, color: 'blue' }, { start: 15, end: 20, color: 'green' },
  ]);
  assert.deepEqual(C.rebaseHighlights('甲😀乙', '新甲😀乙', [{ start: 1, end: 3, color: 'pink' }]), [{ start: 2, end: 4, color: 'pink' }]);
  assert.deepEqual(C.rebaseHighlights('甲😀乙', '甲乙', [{ start: 1, end: 3, color: 'pink' }]), []);
  assert.equal(ranges[2].start, 11);
});

test('updating text preserves unrelated sections and highlights, while explicit empty formatting removes a mark', () => {
  const html = C.createNote('项目', { findings: 'before MID after', remarks: '备注内容' }, C.FIELDS,
    { findings: [{ start: 11, end: 16, color: 'green' }], remarks: [{ start: 0, end: 2, color: 'pink' }] })
    .replace('</div>', '<h2>额外资料</h2><p><a href="zotero://select/library/items/ABCDEFGH">保留</a></p></div>');
  const updated = C.updateNote(html, 'findings', 'before NEWLONG after', DOMParser);
  const result = parse(updated);
  assert.deepEqual(result.highlights.findings, [{ start: 15, end: 20, color: 'green' }]);
  assert.deepEqual(result.highlights.remarks, [{ start: 0, end: 2, color: 'pink' }]);
  assert.ok(updated.includes('zotero://select/library/items/ABCDEFGH'));
  const cleared = parse(C.updateNote(updated, 'remarks', '备注内容', DOMParser, C.FIELDS, []));
  assert.equal(cleared.values.remarks, '备注内容');
  assert.deepEqual(cleared.highlights.remarks, []);
  assert.deepEqual(cleared.highlights.findings, result.highlights.findings);
});

test('highlighted note values keep CSV as portable plain text rather than HTML markup or offsets', () => {
  const parsed = parse(C.createNote('项目', { findings: '关键证据\n第二行' }, C.FIELDS, { findings: [{ start: 0, end: 4, color: 'yellow' }] }));
  const csv = C.toCSV([{ values: parsed.values, highlights: parsed.highlights, tags: [], annotations: [] }], '项目', '项目标识');
  assert.ok(csv.includes('关键证据\n第二行'));
  assert.ok(!csv.includes('background-color'));
  assert.ok(!csv.includes('data-rg-highlight'));
});
