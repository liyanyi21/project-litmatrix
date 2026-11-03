const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const F = require('../plugin/content/fields.js');

function fixture() {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const el = create(tag);
    if (tag === 'dialog') {
      el.showModal = () => { el.open = true; el.setAttribute('open', ''); };
      el.close = () => { el.open = false; el.removeAttribute('open'); };
    }
    if (tag === 'select') Object.defineProperty(el, 'value', { writable: true, value: '' });
    return el;
  };
  window.confirm = () => true;
  let project = { id: 'project-A', name: '项目 A' };
  let fields = F.defaults();
  let templates = [];
  let saves = 0;
  let rejectSave = false;
  const manager = new F.Manager({ document, getProject: () => project, getFields: () => fields,
    getTemplates: () => templates, beforeOpen: () => true, notify() {},
    saveFields: async next => { if (rejectSave) throw new Error('模拟保存失败'); fields = structuredClone(next); saves++; },
    saveTemplates: async next => { templates = structuredClone(next); } });
  return { manager, document, window, fields: () => fields, templates: () => templates, saves: () => saves,
    project(value) { project = value; }, reject(value) { rejectSave = value; } };
}

test('default and built-in templates are independent copies; invalid or reserved labels fail', () => {
  const a = F.defaults(), b = F.defaults();
  a[0].requirement = '只改当前副本';
  assert.notEqual(a[0].requirement, b[0].requirement);
  const builtins = F.builtins();
  assert.deepEqual(builtins.map(t => t.name), ['通用文献分析', '实证研究', '理论与综述']);
  builtins[0].fields[0].label = '改名';
  assert.notEqual(F.builtins()[0].fields[0].label, '改名');
  assert.throws(() => F.normalize([{ id: 'custom_abc', label: '核心结论', visible: true }]), /原有字段名称/);
  assert.throws(() => F.normalize([{ id: 'custom_a', label: 'A', visible: true }, { id: 'custom_a', label: 'B', visible: true }]), /标识重复/);
  assert.throws(() => F.normalize([{ id: 'custom_a', label: 'A', aliases: ['旧名'], visible: true }, { id: 'custom_b', label: '旧名', visible: true }]), /历史名称/);
});

test('applying template reuses IDs by label and archives excluded definitions without mutating the source', () => {
  const existing = [...F.defaults(), { id: 'custom_original', label: '项目独有', requirement: '原要求', visible: true, archived: false }];
  const template = [{ id: 'custom_template', label: '项目独有', requirement: '模板要求', visible: true },
    { id: 'findings', label: '主要发现', requirement: '新要求', visible: true }];
  const applied = F.applyTemplate(existing, template);
  assert.equal(applied[0].id, 'custom_original');
  assert.equal(applied[0].requirement, '模板要求');
  assert.equal(applied.find(f => f.id === 'remarks').archived, true);
  assert.ok(applied.find(f => f.id === 'findings').aliases.includes('核心结论'));
  applied[0].requirement = '局部修改';
  assert.equal(template[0].requirement, '模板要求');
  assert.equal(existing.find(f => f.id === 'remarks').archived, false);
});

test('project fields stay draft until save, rename retains identity and aliases; cancel never writes', async () => {
  const f = fixture();
  await f.manager.open();
  const id = f.manager.draft[0].id;
  f.manager.draft[0].label = '本项目证据';
  f.manager.draft[0].requirement = '关注哪些证据？';
  assert.equal(f.fields()[0].label, '任务与证据类型');
  assert.equal(f.saves(), 0);
  await f.manager.save();
  assert.equal(f.fields()[0].id, id);
  assert.equal(f.fields()[0].label, '本项目证据');
  assert.ok(f.fields()[0].aliases.includes('任务与证据类型'));
  assert.equal(f.manager.dialog.open, false);
  await f.manager.open();
  f.manager.draft[0].label = '不要保存';
  f.window.confirm = () => false;
  assert.equal(f.manager.close(), false);
  assert.equal(f.manager.dialog.open, true);
  f.window.confirm = () => true;
  assert.equal(f.manager.close(), true);
  assert.equal(f.fields()[0].label, '本项目证据');
  assert.equal(f.saves(), 1);
});

test('save failure preserves draft and refuses saving into a project changed behind the dialog', async () => {
  const f = fixture();
  await f.manager.open();
  f.manager.draft[0].requirement = '不能丢失';
  f.reject(true);
  await f.manager.save();
  assert.equal(f.manager.dialog.open, true);
  assert.equal(f.manager.draft[0].requirement, '不能丢失');
  assert.ok(f.document.querySelector('#rg-fields-error').textContent.includes('模拟保存失败'));
  assert.equal(f.saves(), 0);
  f.reject(false);
  f.project({ id: 'project-B', name: '项目 B' });
  await f.manager.save();
  assert.ok(f.document.querySelector('#rg-fields-error').textContent.includes('当前项目已经变化'));
  assert.equal(f.saves(), 0);
});

test('saving and applying a reusable template copies requirements without modifying projects', async () => {
  const f = fixture();
  await f.manager.open();
  f.manager.draft[0].requirement = '通用要求';
  f.manager.templateName.value = '我的通用分析';
  await f.manager.saveTemplate();
  assert.equal(f.templates().length, 1);
  assert.equal(f.saves(), 0);
  f.manager.draft[0].requirement = '项目中的局部变化';
  assert.equal(f.templates()[0].fields[0].requirement, '通用要求');
  f.manager.templateSelect.value = `custom:${f.templates()[0].id}`;
  f.manager.loadTemplate();
  assert.equal(f.manager.draft[0].requirement, '通用要求');
  f.manager.draft[0].requirement = '应用后再改';
  assert.equal(f.templates()[0].fields[0].requirement, '通用要求');
  assert.equal(f.fields()[0].requirement, F.defaults()[0].requirement);
  assert.equal(f.saves(), 0);
});
