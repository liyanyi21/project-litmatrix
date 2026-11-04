const { test } = require('node:test');
const assert = require('node:assert/strict');
const IO = require('../plugin/content/table-io.js');
const C = require('../plugin/content/core.js');
const project = { id: 'user:collection:PROJECTA', name: '项目 A', library: { libraryType: 'user' } };
const fields = [
  { id: 'findings', label: '项目发现', aliases: ['核心结论'], requirement: '说明核心证据，不编造数值。', visible: true },
  { id: 'custom_task', label: '任务要求', requirement: '记录场景、条件和原文页码。', visible: false },
  { id: 'remarks', label: '我的备注', visible: true },
  { id: 'old_field', label: '已归档列', archived: true },
];
const rows = [
  { id: 1, key: 'PAPER001', itemURL: 'zotero://select/library/items/PAPER001', title: 'A synthetic study', authors: '张', year: '2026', citekey: 'Zhang2026', values: { findings: '', custom_task: '', remarks: '人工备注' }, editable: true },
  { id: 2, key: 'PAPER002', itemURL: 'zotero://select/library/items/PAPER002', title: 'Another synthetic study', citekey: 'Li2026', values: { findings: '', custom_task: '', remarks: '' }, editable: true },
];
const clone = value => JSON.parse(JSON.stringify(value));
const table = text => IO.parse(text);
const plan = (text, options = {}) => IO.buildPlan(table(text), { project, fields, rows: clone(rows), ...options });
const csv = values => values.map(record => record.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(',')).join('\r\n');

test('blank template exports project/item identities, instructions and hidden active fields without filled values', () => {
  const result = IO.exportTemplate(rows, project, fields);
  assert.equal(result.charCodeAt(0), 0xFEFF);
  assert.ok(result.endsWith('\r\n'));
  assert.ok(result.includes('任务要求 [custom_task]'));
  assert.ok(!result.includes('已归档列'));
  assert.ok(!result.includes('人工备注'));
  const parsed = IO.parse(result);
  assert.equal(parsed.records.length, 3);
  assert.equal(parsed.records[0].cells[0], '填写要求');
  assert.equal(parsed.records[0].cells[10], fields[0].requirement);
  assert.equal(parsed.records[1].cells[3], rows[0].itemURL);
  assert.equal(parsed.records[1].cells[4], rows[0].key);
  assert.deepEqual(parsed.records[1].cells.slice(10), ['', '', '']);
  const resultPlan = IO.buildPlan(parsed, { project, fields, rows });
  assert.equal(resultPlan.stats.ready, 0);
  assert.equal(resultPlan.stats.error, 0);
  assert.equal(resultPlan.stats.skip, 3);
});

test('template cells roundtrip comma, quotes, multiline and spreadsheet formula protections', () => {
  const value = IO.exportTemplate([{ ...rows[0], title: '=HYPERLINK("x")' }], { ...project, name: '+项目' }, [
    { id: 'custom_csv', label: '=危险名称', requirement: '含逗号,和“中文”\n第二行 "quoted"' },
  ]);
  const parsed = IO.parse(value);
  assert.equal(parsed.headers[10], "'=危险名称 [custom_csv]");
  assert.equal(parsed.records[0].cells[1], "'+项目");
  assert.equal(parsed.records[0].cells[10], '含逗号,和“中文”\n第二行 "quoted"');
  assert.equal(parsed.records[1].cells[6], '\'=HYPERLINK("x")');
  assert.equal(IO.inferMappings(parsed.headers, [{ id: 'custom_csv', label: '=危险名称' }])[10], 'field:custom_csv');
});

test('parser supports BOM CSV/TSV, multiline quoted text, code fences and actual source line numbers', () => {
  const parsed = IO.parse('\uFEFF"标题"\t"项目发现 [findings]"\r\n"A synthetic study"\t"第一行\r\n第二行,含\t制表符和""引号"""\r\n');
  assert.equal(parsed.delimiter, '\t');
  assert.equal(parsed.records[0].line, 2);
  assert.equal(parsed.records[0].cells[1], '第一行\n第二行,含\t制表符和"引号"');
  const fenced = IO.parse('```csv\n标题,findings\nA synthetic study,结果\n```');
  assert.equal(fenced.records[0].line, 3);
  assert.equal(fenced.records[0].cells[1], '结果');
  const quotedHeader = IO.parse('"title, with comma"\tfindings\nA\tx');
  assert.equal(quotedHeader.delimiter, '\t');
});

test('parser rejects malformed quotes, ragged rows and ambiguous or blank headers without guessing', () => {
  for (const [input, pattern] of [
    ['标题,findings\nA,"unfinished', /没有结束/],
    ['标题,findings\nA,"value"bad', /多余字符/],
    ['标题,findings\nA,b"ad', /引号/],
    ['标题,findings\nA,b,c', /3 列.*2 列/],
    ['标题,findings\nA', /1 列.*2 列/],
    ['标题, 标题 \nA,B', /重复/],
    [',findings\nA,B', /表头为空/],
    ['a,b\nA,\u0000', /UTF-8/],
    ['', /表格为空/],
  ]) assert.throws(() => IO.parse(input), pattern);
});

test('parser enforces file, cell, column and row limits', () => {
  assert.throws(() => IO.parse('x'.repeat(IO.LIMITS.bytes + 1)), /10 MB/);
  assert.throws(() => IO.parse('标题,findings\nA,' + 'x'.repeat(IO.LIMITS.cellChars + 1)), /单元格超过/);
  assert.throws(() => IO.parse(Array.from({ length: IO.LIMITS.columns + 1 }, (_, i) => 'c' + i).join(',')), /列数超过/);
  assert.throws(() => IO.parse('title,findings\n' + 'A,x\n'.repeat(IO.LIMITS.records + 1)), /超过.*行/);
});

test('filled template imports by stable IDs despite paper or field label changes', () => {
  const parsed = IO.parse(IO.exportTemplate(rows, project, fields));
  parsed.headers[10] = '旧字段名称 [findings]';
  parsed.records[1].cells[6] = 'Old title before rename';
  parsed.records[1].cells[10] = '初步结论\n需要原文核实。';
  const current = [{ ...rows[0], title: 'New title after rename' }, rows[1]];
  const result = IO.buildPlan(parsed, { project, fields, rows: current });
  const ready = result.rows.find(row => row.status === 'ready');
  assert.equal(result.stats.ready, 1);
  assert.equal(ready.target, current[0]);
  assert.equal(ready.matchBy, 'itemURL');
  assert.deepEqual(ready.changes, { findings: '初步结论\n需要原文核实。' });
  assert.deepEqual(ready.expected, { findings: '' });
  assert.match(ready.message, /标题.*不同/);
});

test('existing CSV export imports field aliases and identities without changing metadata', () => {
  const exported = C.toCSV([{ ...rows[0], values: { findings: '由外部工具填写', remarks: '尝试覆盖', custom_task: '' }, tags: [], annotations: [] }], project.name, project.id,
    [{ ...fields[0], label: '核心结论' }, fields[2]]);
  const result = plan(exported);
  assert.equal(result.stats.ready, 1);
  assert.equal(result.rows[0].target.key, rows[0].key);
  assert.equal(result.rows[0].matchBy, 'itemURL');
  assert.deepEqual(result.rows[0].changes, { findings: '由外部工具填写' });
  assert.deepEqual(result.rows[0].protectedFields, ['remarks']);
});

test('default import ignores blanks and protects human content; overwrite and clearing require explicit choices', () => {
  const input = csv([['文献Key', 'findings', 'remarks'], ['PAPER001', '初步总结', '新备注'], ['PAPER002', '', '']]);
  const result = plan(input);
  assert.deepEqual(result.rows[0].changes, { findings: '初步总结' });
  assert.deepEqual(result.rows[0].expected, { findings: '' });
  assert.equal(result.rows[1].status, 'skip');
  const overwrite = plan(input, { overwrite: true });
  assert.deepEqual(overwrite.rows[0].changes, { findings: '初步总结', remarks: '新备注' });
  const blank = csv([['文献Key', 'remarks'], ['PAPER001', '']]);
  assert.equal(plan(blank, { overwrite: true }).stats.ready, 0);
  assert.equal(plan(blank, { clearBlanks: true }).stats.ready, 0);
  const cleared = plan(blank, { overwrite: true, clearBlanks: true });
  assert.deepEqual(cleared.rows[0].changes, { remarks: '' });
  assert.deepEqual(cleared.rows[0].expected, { remarks: '人工备注' });
});

test('untrusted imported text stays literal; formulas and HTML are not executed or rewritten', () => {
  const content = '=HYPERLINK("https://example.test")\n<script>plain text</script>\n"quoted", tab\t结束';
  const result = plan(csv([['文献Key', 'findings'], ['PAPER001', content]]));
  assert.equal(result.rows[0].changes.findings, content);
});

test('explicit bad, foreign or conflicting identifiers never fall back to matching titles', () => {
  const tests = [
    [['文献标识', '标题', 'findings'], ['zotero://select/library/items/NOTFOUND', rows[0].title, 'x']],
    [['文献标识', '标题', 'findings'], ['zotero://select/groups/99/items/PAPER001', rows[0].title, 'x']],
    [['文献标识', '标题', 'findings'], ['https://example.test/paper', rows[0].title, 'x']],
    [['文献Key', '标题', 'findings'], ['UNKNOWN1', rows[0].title, 'x']],
    [['引用键', '标题', 'findings'], ['Nonexistent2026', rows[0].title, 'x']],
    [['文献链接', '文献Key', 'findings'], [rows[0].itemURL, rows[1].key, 'x']],
    [['项目标识', '文献Key', 'findings'], ['user:collection:OTHERPROJECT', rows[0].key, 'x']],
    [['文献标识', '文献链接', 'findings'], [rows[0].itemURL, rows[1].itemURL, 'x']],
  ];
  for (const records of tests) {
    const result = plan(csv(records));
    assert.equal(result.stats.ready, 0);
    assert.equal(result.stats.error, 1);
    assert.deepEqual(result.rows[0].changes, {});
  }
});

test('unique exact titles and citation keys are supported, while ambiguous matches are rejected', () => {
  const titles = plan('Title,项目发现\n  A   synthetic study  ,初步总结');
  assert.equal(titles.rows[0].matchBy, 'title');
  assert.equal(titles.stats.ready, 1);
  assert.ok(titles.warnings.some(warning => warning.includes('唯一标题')));
  const keys = plan('Citation Key,findings\nLi2026,第二篇');
  assert.equal(keys.rows[0].matchBy, 'citekey');
  assert.equal(keys.rows[0].target.key, 'PAPER002');
  const duplicate = clone(rows); duplicate[1].title = rows[0].title;
  assert.equal(plan('标题,findings\nA synthetic study,x', { rows: duplicate }).stats.error, 1);
  duplicate[1].citekey = duplicate[0].citekey;
  assert.equal(plan('引用键,findings\nZhang2026,x', { rows: duplicate }).stats.error, 1);
  assert.equal(plan('标题,findings\nA synthetic study!,x').stats.error, 1, 'no fuzzy punctuation matching');
});

test('duplicate target rows are all blocked even when one row has no changes', () => {
  const result = plan('文献Key,findings\nPAPER001,新结论\nPAPER001,');
  assert.equal(result.stats.ready, 0);
  assert.equal(result.stats.error, 2);
  assert.ok(result.rows.every(row => row.message.includes('多行')));
});

test('unknown and archived columns are ignored, manual mapping works, and duplicate field mappings fail', () => {
  const parsed = table('标题,外部AI结论,已归档列 [old_field]\nA synthetic study,外部文本,历史字段');
  const ignored = IO.buildPlan(parsed, { project, fields, rows });
  assert.equal(ignored.stats.ready, 0);
  assert.ok(ignored.warnings.some(warning => warning.includes('未映射')));
  const mappings = ['meta:title', 'field:findings', 'ignore'];
  const mapped = IO.buildPlan(parsed, { project, fields, rows, mappings });
  assert.deepEqual(mapped.rows[0].changes, { findings: '外部文本' });
  assert.throws(() => IO.buildPlan(parsed, { project, fields, rows, mappings: ['meta:title', 'field:old_field', 'ignore'] }), /不可用|已移出/);
  assert.throws(() => IO.buildPlan(parsed, { project, fields, rows, mappings: ['meta:title', 'field:findings', 'field:findings'] }), /多列/);
  assert.throws(() => IO.buildPlan(parsed, { project, fields, rows, mappings: ['meta:unknown', 'ignore', 'ignore'] }), /映射无效/);
});

test('requirements records never become literature writes, and readonly notes never become ready', () => {
  const result = plan('记录类型,文献Key,findings\n填写要求,PAPER001,只作填写说明\n文献,PAPER002,正常内容', { rows: rows.map(row => ({ ...row, editable: false })) });
  assert.equal(result.rows[0].status, 'skip');
  assert.equal(result.rows[0].target, null);
  assert.equal(result.rows[1].status, 'error');
  assert.deepEqual(result.rows[1].changes, {});
  assert.equal(plan('记录类型,文献Key,findings\n不明记录,PAPER001,不导入').stats.error, 1);
});

test('group templates retain group scope and cannot match the same key in a personal library', () => {
  const group = { id: 'group:42:collection:GROUPKEY', name: '群组项目', library: { libraryType: 'group', groupID: 42 } };
  const groupRows = [{ ...rows[0], itemURL: 'zotero://select/groups/42/items/PAPER001' }];
  const parsed = IO.parse(IO.exportTemplate(groupRows, group, fields, { delimiter: '\t' }));
  parsed.records[1].cells[10] = '群组总结';
  const valid = IO.buildPlan(parsed, { project: group, fields, rows: groupRows });
  assert.equal(valid.stats.ready, 1);
  const personal = IO.buildPlan(parsed, { project, fields, rows });
  assert.equal(personal.stats.ready, 0);
  assert.equal(personal.stats.error, 1);
});

test('planning is pure and snapshots old strings without mutating table, project schema or target values', () => {
  const current = clone(rows), source = table('文献Key,findings\nPAPER001,原样写入');
  const before = JSON.stringify({ current, source, project, fields });
  const result = IO.buildPlan(source, { project, fields, rows: current });
  assert.equal(JSON.stringify({ current, source, project, fields }), before);
  current[0].values.findings = '后来修改';
  assert.equal(result.rows[0].expected.findings, '');
});

test('table plans capture independent formatting snapshots only for selected text changes', () => {
  const current = clone(rows);
  current[0].values.findings = '旧结论';
  current[0].highlights = { findings: [{ start: 0, end: 1, color: 'yellow' }], remarks: [{ start: 0, end: 2, color: 'pink' }] };
  const result = IO.buildPlan(table('文献Key,findings,remarks\nPAPER001,新结论,人工备注'), {
    project, fields, rows: current, overwrite: true,
  });
  assert.deepEqual(result.rows[0].expectedHighlights, { findings: [{ start: 0, end: 1, color: 'yellow' }] });
  current[0].highlights.findings[0].color = 'green';
  assert.equal(result.rows[0].expectedHighlights.findings[0].color, 'yellow');
  assert.equal(result.rows[0].highlights, undefined, 'the importer supplies no replacement formatting');
});
