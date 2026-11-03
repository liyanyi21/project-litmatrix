const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DOMParser } = require('linkedom');
const C = require('../plugin/content/core.js');
const Repository = require('../plugin/content/repository.js');

function fixture() {
  const items = new Map();
  let nextID = 10;
  const library = { libraryType: 'user', libraryID: 1, name: '我的文献库', editable: true };
  class Item {
    constructor(type = 'journalArticle') { this.type = type; this.id = nextID++; this.key = `ITEM${this.id}`; this.libraryID = 1; this.parentID = null; this.tags = []; this.html = ''; this.deleted = false; this.notes = []; this.attachments = []; }
    isRegularItem() { return this.type === 'journalArticle'; }
    isAttachment() { return this.type === 'attachment'; }
    isEditable() { return library.editable; }
    getNotes() { return this.notes.filter(id => !items.get(id).deleted); }
    getAttachments() { return this.attachments; }
    getTags() { return this.tags.map(tag => ({ tag })); }
    addTag(tag) { this.tags.push(tag); }
    getNote() { return this.html; }
    setNote(html) { this.html = html; }
    getField(name) { return { title: this.title || '未批注文献', date: '2026', citationKey: 'Example2026' }[name] || ''; }
    getDisplayTitle() { return this.getField('title'); }
    getCreators() { return [{ firstName: '三', lastName: '张', creatorType: 'author' }]; }
    async save() { items.set(this.id, this); if (this.parentID) { const p = items.get(this.parentID); if (!p.notes.includes(this.id)) p.notes.push(this.id); } return this.id; }
  }
  const parent = new Item(); items.set(parent.id, parent);
  const makeCol = (id, key, name, parentID = null, itemIDs = []) => ({ id, key, name, parentID, libraryID: 1, async loadDataType() {}, getChildItems() { return itemIDs; } });
  const a = makeCol(1, 'PROJECTA', '远程监控', null, [parent.id]);
  const b = makeCol(2, 'PROJECTB', '驾驶疲劳', null, [parent.id]);
  const sub = makeCol(3, 'PROJECTC', '子分类', 1, [parent.id]);
  const Z = {
    Libraries: { getAll: () => [library], get: () => library },
    Collections: { getByLibrary: () => [a, b, sub], getByParent: id => id === 1 ? [sub] : [] },
    Items: { getAsync: async ids => Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids), loadDataTypes: async () => {} },
    Item, DB: { executeTransaction: async fn => fn() },
    getMainWindow: () => ({ ZoteroPane: { getSelectedCollection: () => a } }),
    CreatorTypes: { getID: () => 1 },
  };
  const repo = new Repository(Z, C, DOMParser);
  const [projectA, projectB] = repo.projects();
  const row = { id: parent.id, key: parent.key, libraryID: 1, editable: true };
  return { repo, Z, Item, parent, row, items, library, projectA, projectB, a };
}

test('one paper saves independent notes in two projects; switching back restores values', async () => {
  const f = fixture();
  await f.repo.saveField(f.projectA, f.row, 'remarks', '项目 A 的备注', '');
  await f.repo.saveField(f.projectB, f.row, 'remarks', '项目 B 的备注', '');
  const a = await f.repo.noteFor(f.parent, f.projectA);
  const b = await f.repo.noteFor(f.parent, f.projectB);
  assert.equal(a.values.remarks, '项目 A 的备注');
  assert.equal(b.values.remarks, '项目 B 的备注');
  assert.notEqual(a.note.id, b.note.id);
  assert.equal(f.parent.notes.length, 2);
});
test('normal LitMatrix notes with the same title are never selected or overwritten', async () => {
  const f = fixture();
  const old = new f.Item('note'); old.parentID = f.parent.id;
  old.setNote(C.createNote(f.projectA.name, { remarks: '原插件内容' })); await old.save();
  await f.repo.saveField(f.projectA, f.row, 'remarks', '独立项目内容', '');
  assert.equal(C.parseNote(old.getNote(), DOMParser).values.remarks, '原插件内容');
  assert.equal(f.parent.notes.length, 2);
});
test('editing a second field preserves first field, and clearing a field persists', async () => {
  const f = fixture();
  await f.repo.saveField(f.projectA, f.row, 'findings', '结论 A', '');
  await f.repo.saveField(f.projectA, f.row, 'remarks', '备注 B', '');
  await f.repo.saveField(f.projectA, f.row, 'findings', '', '结论 A');
  const saved = await f.repo.noteFor(f.parent, f.projectA);
  assert.equal(saved.values.findings, '');
  assert.equal(saved.values.remarks, '备注 B');
  assert.equal(f.parent.notes.length, 1);
});
test('concurrent modification to the same field rejects stale save', async () => {
  const f = fixture();
  await f.repo.saveField(f.projectA, f.row, 'remarks', '别处刚写的内容', '');
  await assert.rejects(f.repo.saveField(f.projectA, f.row, 'remarks', '旧窗口内容', ''), /其他窗口/);
  assert.equal((await f.repo.noteFor(f.parent, f.projectA)).values.remarks, '别处刚写的内容');
});
test('duplicate project notes block ambiguous writes', async () => {
  const f = fixture();
  await f.repo.saveField(f.projectA, f.row, 'remarks', '原内容', '');
  const duplicate = new f.Item('note'); duplicate.parentID = f.parent.id;
  duplicate.addTag(C.noteTag(f.projectA.id)); duplicate.setNote(C.createNote('复制')); await duplicate.save();
  await assert.rejects(f.repo.saveField(f.projectA, f.row, 'remarks', '新内容', '原内容'), /多份/);
});
test('read-only library and deleted paper cannot be written', async () => {
  const f = fixture(); f.library.editable = false;
  await assert.rejects(f.repo.saveField(f.projectA, f.row, 'remarks', 'x', ''), /不能编辑/);
  f.library.editable = true; f.parent.deleted = true;
  await assert.rejects(f.repo.saveField(f.projectA, f.row, 'remarks', 'x', ''), /已删除/);
  assert.equal(f.parent.notes.length, 0);
});
test('collection rename changes display, not project note identity', async () => {
  const f = fixture();
  await f.repo.saveField(f.projectA, f.row, 'remarks', '保留', '');
  f.a.name = '分类新名称';
  const renamed = f.repo.projects()[0];
  assert.equal(renamed.id, f.projectA.id);
  assert.equal(renamed.name, '分类新名称');
  assert.equal((await f.repo.noteFor(f.parent, renamed)).values.remarks, '保留');
});
test('all collection papers appear without annotations, with recursive deduplication', async () => {
  const f = fixture();
  const rows = await f.repo.loadProject(f.projectA, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].annotations.length, 0);
  assert.equal(rows[0].title, '未批注文献');
  assert.equal(rows[0].editable, true);
});
test('unchanged empty edit never creates an empty note', async () => {
  const f = fixture();
  await f.repo.saveField(f.projectA, f.row, 'remarks', '', '');
  assert.equal(f.parent.notes.length, 0);
});
test('current project and nested collection paths use selected Zotero collection', () => {
  const f = fixture();
  assert.equal(f.repo.currentProject().id, f.projectA.id);
  assert.equal(f.repo.projects()[2].path, '远程监控 / 子分类');
});
test('current collection uses the host window and plural selection API on Zotero 11', () => {
  const f = fixture();
  f.Z.getMainWindow = () => ({ /* most recent auxiliary window */ });
  f.Z.ProjectLitMatrix = { hostWindow: { closed: false, ZoteroPane: {
    getSelectedCollection() { throw new Error('single-selection compatibility guard'); },
    getSelectedCollections: () => [f.a],
  } } };
  assert.equal(f.repo.currentProject().id, f.projectA.id);
  f.Z.ProjectLitMatrix.hostWindow.ZoteroPane.getSelectedCollections = () => [f.a, f.a];
  assert.equal(f.repo.currentProject(), null);
});

test('custom fields save independently by project and survive label changes', async () => {
  const f = fixture();
  const field = { id: 'custom_project_question', label: '研究问题', requirement: '当前项目需要回答什么', visible: true };
  f.projectA.fields = [field];
  f.projectB.fields = [{ ...field, label: '另一个项目的问题' }];
  await f.repo.saveField(f.projectA, f.row, field.id, '项目 A 的问题', '');
  await f.repo.saveField(f.projectB, f.row, field.id, '项目 B 的问题', '');
  f.projectA.fields = [{ ...field, label: '重新命名的问题' }];
  assert.equal((await f.repo.noteFor(f.parent, f.projectA)).values[field.id], '项目 A 的问题');
  assert.equal((await f.repo.loadProject(f.projectB))[0].values[field.id], '项目 B 的问题');
  await f.repo.saveField(f.projectA, f.row, field.id, '项目 A 更新', '项目 A 的问题');
  assert.equal((await f.repo.noteFor(f.parent, f.projectA)).values[field.id], '项目 A 更新');
  assert.equal((await f.repo.noteFor(f.parent, f.projectB)).values[field.id], '项目 B 的问题');
  assert.equal(f.parent.notes.length, 2);
});
test('archived fields cannot be saved and retain note data when other custom fields change', async () => {
  const f = fixture();
  const field = { id: 'custom_archived', label: '待归档字段', visible: true };
  const other = { id: 'custom_current', label: '当前字段', visible: true };
  f.projectA.fields = [field, other];
  await f.repo.saveField(f.projectA, f.row, field.id, '历史内容', '');
  f.projectA.fields = [{ ...field, archived: true }, other];
  await assert.rejects(f.repo.saveField(f.projectA, f.row, field.id, '不能覆盖', '历史内容'), /已移除/);
  await f.repo.saveField(f.projectA, f.row, other.id, '新字段内容', '');
  const values = (await f.repo.noteFor(f.parent, f.projectA)).values;
  assert.equal(values[field.id], '历史内容');
  assert.equal(values[other.id], '新字段内容');
});
test('custom field stale saves reject conflicts without overwriting another edit', async () => {
  const f = fixture();
  const field = { id: 'custom_conflict', label: '项目字段', visible: true };
  f.projectA.fields = [field];
  await f.repo.saveField(f.projectA, f.row, field.id, '新窗口已保存', '');
  await assert.rejects(f.repo.saveField(f.projectA, f.row, field.id, '旧窗口草稿', ''), /其他窗口/);
  assert.equal((await f.repo.noteFor(f.parent, f.projectA)).values[field.id], '新窗口已保存');
});

test('an AI batch creates exactly one project note and saves every selected field once', async () => {
  const f = fixture();
  let saves = 0;
  const save = f.Item.prototype.save;
  f.Item.prototype.save = async function () { saves++; return save.call(this); };
  const result = await f.repo.saveFields(f.projectA, f.row,
    { findings: 'AI 结论草稿', remarks: '用户确认的备注草稿' }, { findings: '', remarks: '' });
  assert.equal(saves, 1);
  assert.equal(f.parent.notes.length, 1);
  assert.equal(result.values.findings, 'AI 结论草稿');
  assert.equal(result.values.remarks, '用户确认的备注草稿');
  assert.equal(result.values.methods_sample, '');
  assert.ok(result.note.getTags().some(t => t.tag === C.noteTag(f.projectA.id)));
});

test('one stale field rejects the whole AI batch before changing an earlier valid field', async () => {
  const f = fixture();
  await f.repo.saveFields(f.projectA, f.row, { findings: '原结论', remarks: '原备注' }, { findings: '', remarks: '' });
  const original = await f.repo.noteFor(f.parent, f.projectA);
  const expected = { ...original.values };
  await f.repo.saveField(f.projectA, f.row, 'findings', '其他窗口的新结论', '原结论');
  const untouchedHTML = original.note.getNote();
  let writes = 0;
  const setNote = original.note.setNote.bind(original.note);
  original.note.setNote = html => { writes++; setNote(html); };
  await assert.rejects(f.repo.saveFields(f.projectA, f.row,
    { remarks: '不应写入的备注', findings: '过期 AI 结论' }, expected), /其他窗口/);
  assert.equal(writes, 0, 'all selected conflicts must be checked before note mutation');
  assert.equal(original.note.getNote(), untouchedHTML);
  assert.equal(f.parent.notes.length, 1);
});

test('a caller cannot bypass an AI batch conflict by mutating the expected snapshot during a transaction wait', async () => {
  const f = fixture();
  await f.repo.saveField(f.projectA, f.row, 'remarks', '服务器的新值', '');
  const expected = { remarks: '过期的原值' };
  f.Z.DB.executeTransaction = async callback => { expected.remarks = '服务器的新值'; return callback(); };
  await assert.rejects(f.repo.saveFields(f.projectA, f.row, { remarks: '不应覆盖' }, expected), /其他窗口/);
  assert.equal((await f.repo.noteFor(f.parent, f.projectA)).values.remarks, '服务器的新值');
});

test('AI batch validation rejects archived fields and incomplete expected values without any write', async () => {
  const f = fixture();
  f.projectA.fields = C.FIELDS.map(field => ({ ...field, archived: field.id === 'findings' }));
  let transactions = 0;
  f.Z.DB.executeTransaction = async callback => { transactions++; return callback(); };
  await assert.rejects(f.repo.saveFields(f.projectA, f.row, { remarks: '有效草稿', findings: '已归档' }, { remarks: '', findings: '' }), /已移除/);
  await assert.rejects(f.repo.saveFields(f.projectA, f.row, { remarks: '缺少原值' }, {}), /原值/);
  await assert.rejects(f.repo.saveFields(f.projectA, f.row, {}, {}), /选择/);
  assert.equal(transactions, 0);
  assert.equal(f.parent.notes.length, 0);
});

test('AI batches update only selected fields and retain newer unselected notes', async () => {
  const f = fixture();
  const old = C.blankValues();
  await f.repo.saveField(f.projectA, f.row, 'findings', '未选字段的新结论', '');
  await f.repo.saveFields(f.projectA, f.row, { remarks: '仅选备注' }, old);
  const result = await f.repo.noteFor(f.parent, f.projectA);
  assert.equal(result.values.remarks, '仅选备注');
  assert.equal(result.values.findings, '未选字段的新结论');
  assert.equal(f.parent.notes.length, 1);
});

function sourceFixture({ abstract = '<p>摘要证据。</p>', indexed = 'INDEXED ARTICLE TEXT', partial = false, exists = true } = {}) {
  const f = fixture();
  const originalGetField = f.parent.getField.bind(f.parent);
  f.parent.getField = name => name === 'abstractNote' ? abstract : originalGetField(name);
  const attachment = new f.Item('attachment');
  attachment.parentID = f.parent.id;
  attachment.attachmentContentType = 'application/pdf';
  f.items.set(attachment.id, attachment);
  f.parent.attachments.push(attachment.id);
  Object.assign(f.row, { title: 'Synthetic source paper', authors: 'Test Author', year: '2026', attachmentID: attachment.id,
    annotations: [{ text: 'PRIVATE_ANNOTATION_SENTINEL', comment: 'PRIVATE_COMMENT_SENTINEL' }],
    values: { remarks: 'PRIVATE_PROJECT_REMARK_SENTINEL' } });
  const cache = { path: '/synthetic-zotero-cache/source.txt', exists: () => exists, fileSize: indexed.length };
  const reads = [], extracts = [];
  f.Z.FullText = { INDEX_STATE_PARTIAL: 2,
    getItemCacheFile(item) { assert.equal(item.id, attachment.id); return cache; },
    getIndexedState: async () => partial ? 2 : 1,
  };
  f.Z.File = { getContentsAsync: async (...args) => { reads.push(args); return indexed; } };
  f.Z.PDFWorker = { getFullText: async (...args) => { extracts.push(args); return { text: 'EXTRACTED PDF TEXT' }; } };
  return { ...f, attachment, cache, reads, extracts };
}

function assertNoPrivateNotes(result) {
  const serialized = JSON.stringify(result);
  for (const marker of ['PRIVATE_ANNOTATION_SENTINEL', 'PRIVATE_COMMENT_SENTINEL', 'PRIVATE_PROJECT_REMARK_SENTINEL']) {
    assert.ok(!serialized.includes(marker), 'paper source must not include personal notes or annotations');
  }
}

test('AI source uses the selected paper indexed cache with bounded reads and excludes notes and annotations', async () => {
  const f = sourceFixture();
  const result = await f.repo.paperSource(f.row);
  assert.equal(result.text, 'INDEXED ARTICLE TEXT');
  assert.match(result.label, /已索引/);
  assert.equal(result.chars, result.text.length);
  assert.equal(result.truncated, false);
  assert.deepEqual(f.reads, [[f.cache.path, 'utf-8', 2000000]]);
  assert.equal(f.extracts.length, 0);
  assertNoPrivateNotes(result);
});

test('partial PDF indexes are replaced with locally extracted text before preparing an AI source', async () => {
  const f = sourceFixture({ partial: true, indexed: 'PARTIAL EXCERPT ONLY' });
  const result = await f.repo.paperSource(f.row);
  assert.equal(result.text, 'EXTRACTED PDF TEXT');
  assert.equal(result.label, '本地 PDF 提取文本');
  assert.equal(result.warning, '');
  assert.deepEqual(f.extracts, [[f.attachment.id, null]]);
  assertNoPrivateNotes(result);
});

test('a missing PDF cache can be extracted locally while an unreadable cache also falls back to extraction', async () => {
  const missing = sourceFixture({ exists: false });
  const first = await missing.repo.paperSource(missing.row);
  assert.equal(first.text, 'EXTRACTED PDF TEXT');
  assert.equal(missing.reads.length, 0);
  const unreadable = sourceFixture();
  unreadable.Z.File.getContentsAsync = async () => { throw new Error('synthetic cache vanished'); };
  const second = await unreadable.repo.paperSource(unreadable.row);
  assert.equal(second.text, 'EXTRACTED PDF TEXT');
  assert.equal(unreadable.extracts.length, 1);
});

test('failed PDF extraction keeps partial indexed evidence or explicitly falls back to an available abstract', async () => {
  const partial = sourceFixture({ partial: true });
  partial.Z.PDFWorker.getFullText = async () => { throw new Error('synthetic extraction failure'); };
  const indexed = await partial.repo.paperSource(partial.row);
  assert.equal(indexed.text, 'INDEXED ARTICLE TEXT');
  assert.match(indexed.warning, /未完成/);
  const missing = sourceFixture({ exists: false });
  missing.Z.PDFWorker.getFullText = async () => { throw new Error('synthetic extraction failure'); };
  const abstract = await missing.repo.paperSource(missing.row);
  assert.equal(abstract.text, '摘要证据。');
  assert.match(abstract.label, /仅摘要/);
  assert.match(abstract.warning, /不能代表通读全文/);
  assertNoPrivateNotes(abstract);
});

test('abstract-only mode never reads a PDF, does not duplicate the abstract and fails when evidence is unavailable', async () => {
  const f = sourceFixture();
  Object.defineProperty(f.Z, 'FullText', { get() { throw new Error('abstract mode must not inspect full text'); } });
  const result = await f.repo.paperSource(f.row, { mode: 'abstract' });
  assert.equal(result.text, '摘要证据。');
  assert.equal(result.paper.abstract, '');
  assert.equal(result.label, '仅摘要');
  assertNoPrivateNotes(result);
  const empty = sourceFixture({ abstract: '', exists: false });
  empty.Z.PDFWorker.getFullText = async () => ({ text: '' });
  await assert.rejects(empty.repo.paperSource(empty.row), /没有可用/);
  await assert.rejects(empty.repo.paperSource(empty.row, { mode: 'abstract' }), /没有可用/);
  assert.equal(empty.parent.notes.length, 0);
});

test('AI source rejects stale rows and never reads an attachment belonging to another paper', async () => {
  const f = sourceFixture();
  await assert.rejects(f.repo.paperSource({ ...f.row, key: 'OTHERKEY' }), /文献已变化/);
  await assert.rejects(f.repo.paperSource({ ...f.row, libraryID: 99 }), /文献已变化/);
  assert.equal(f.reads.length, 0);
  f.attachment.parentID = 999;
  const result = await f.repo.paperSource(f.row);
  assert.match(result.label, /仅摘要/);
  assert.equal(f.reads.length, 0);
  assert.equal(f.extracts.length, 0);
});

test('cancellation before or during source extraction stops without a usable source or note writes', async () => {
  const before = sourceFixture();
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(before.repo.paperSource(before.row, { signal: stopped.signal }), /已取消/);
  assert.equal(before.reads.length, 0);
  const during = sourceFixture({ exists: false });
  let resolveText, entered;
  const didEnter = new Promise(resolve => { entered = resolve; });
  during.Z.PDFWorker.getFullText = async () => { entered(); return new Promise(resolve => { resolveText = resolve; }); };
  const controller = new AbortController();
  const pending = during.repo.paperSource(during.row, { signal: controller.signal });
  await didEnter;
  controller.abort(); resolveText({ text: 'late PDF text must be ignored' });
  await assert.rejects(pending, /已取消/);
  assert.equal(during.parent.notes.length, 0);
});

test('source truncation preserves both ends within the exact maxChars cap and reports partial evidence', async () => {
  for (const limit of [1000, 300000]) {
    const f = sourceFixture({ abstract: 'A'.repeat(10000), indexed: 'BEGIN|' + 'middle '.repeat(50000) + '|END' });
    f.cache.fileSize = 3000000;
    const result = await f.repo.paperSource(f.row, { maxChars: limit });
    assert.equal(result.truncated, true);
    assert.equal(result.chars, limit);
    assert.equal(result.text.length, limit);
    assert.ok(result.text.startsWith('BEGIN|'));
    assert.ok(result.text.endsWith('|END'));
    assert.match(result.text, /中间部分因长度限制省略/);
    assert.match(result.warning, /开头与结尾摘录/);
    assert.match(result.warning, /2 MB/);
    assert.equal(result.paper.abstract.length, 6000);
    assertNoPrivateNotes(result);
  }
});
