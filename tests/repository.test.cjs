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
