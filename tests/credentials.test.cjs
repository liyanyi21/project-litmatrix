const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../plugin/content/credentials.js');

const ORIGIN = 'https://researchgrid.invalid';
const REALM = 'ResearchGrid API · ';
const USERNAME = 'ResearchGrid API Key';
const A = 'https://provider-a.example/v1/chat/completions';
const B = 'https://provider-b.example/v1/chat/completions';
function record(endpoint, password, extra = {}) {
  return { origin: ORIGIN, hostname: ORIGIN, httpRealm: REALM + endpoint, username: USERNAME, password, ...extra };
}
function fixture({ legacy = false, initial = [] } = {}) {
  const records = initial.map(login => ({ ...login }));
  const calls = [];
  const state = { failReplace: false };
  function lookup(origin, realm) {
    calls.push({ action: 'search', origin, realm });
    // Include any entries returned by the platform, so the plugin must perform
    // its own namespace and username filtering before using a password.
    return records.slice();
  }
  function add(login) { calls.push({ action: 'add', login }); records.push({ ...login }); }
  function modify(old, login) {
    calls.push({ action: 'modify', old, login });
    if (state.failReplace) throw new Error('synthetic credential replacement failure');
    records[records.indexOf(old)] = { ...login };
  }
  function remove(login) { calls.push({ action: 'remove', login }); records.splice(records.indexOf(login), 1); }
  const manager = legacy ? {
    findLogins(origin, action, realm) { assert.equal(action, null); return lookup(origin, realm); },
    addLogin: add, modifyLogin: modify, removeLogin: remove,
  } : {
    async searchLoginsAsync({ origin, httpRealm }) { return lookup(origin, httpRealm); },
    async addLoginAsync(login) { add(login); },
    async modifyLoginAsync(old, login) { modify(old, login); },
    async removeLoginAsync(login) { remove(login); },
    findLogins() { throw new Error('removed modern API must never be called'); },
    removeLogin() { throw new Error('removed modern API must never be called'); },
    addLogin() { throw new Error('removed modern API must never be called'); },
    modifyLogin() { throw new Error('removed modern API must never be called'); },
  };
  const credentials = create({ Services: { logins: manager }, Components: {
    interfaces: { nsILoginInfo: {} },
    classes: { '@mozilla.org/login-manager/loginInfo;1': { createInstance() {
      return { init(origin, formAction, httpRealm, username, password, usernameField, passwordField) {
        assert.equal(formAction, null);
        assert.equal(usernameField, ''); assert.equal(passwordField, '');
        Object.assign(this, { origin, hostname: origin, httpRealm, username, password });
      } };
    } } },
  } });
  return { credentials, records, calls, state };
}

for (const legacy of [false, true]) {
  test(`credential storage uses ${legacy ? 'Zotero 7 legacy' : 'modern async'} APIs and binds keys to endpoints`, async () => {
    const f = fixture({ legacy });
    await f.credentials.setKey(A, 'synthetic-key-a');
    await f.credentials.setKey(B, 'synthetic-key-b');
    assert.equal(await f.credentials.getKey(A), 'synthetic-key-a');
    assert.equal(await f.credentials.getKey(B), 'synthetic-key-b');
    await f.credentials.setKey(A, 'synthetic-key-a-replaced');
    assert.equal(await f.credentials.getKey(A), 'synthetic-key-a-replaced');
    assert.equal(await f.credentials.getKey(B), 'synthetic-key-b');
    assert.equal(f.records.length, 2);
    const searches = f.calls.filter(call => call.action === 'search');
    assert.ok(searches.length > 0);
    assert.ok(searches.every(call => call.origin === ORIGIN && [REALM + A, REALM + B].includes(call.realm)));
  });
}

test('unrelated plugins and usernames cannot supply or lose credentials through ResearchGrid', async () => {
  const foreign = record(A, 'foreign-plugin-key', { origin: 'https://other-plugin.invalid', hostname: 'https://other-plugin.invalid' });
  const otherUser = record(A, 'other-username-key', { username: 'other plugin user' });
  const otherEndpoint = record(B, 'synthetic-key-b');
  const f = fixture({ initial: [foreign, otherUser, otherEndpoint] });
  assert.equal(await f.credentials.getKey(A), '');
  await f.credentials.setKey(A, 'synthetic-key-a');
  assert.equal(await f.credentials.getKey(A), 'synthetic-key-a');
  await f.credentials.clearKey(A);
  assert.equal(await f.credentials.getKey(A), '');
  assert.equal(await f.credentials.getKey(B), 'synthetic-key-b');
  assert.equal(f.records.length, 3);
  assert.ok(f.records.some(login => login.password === 'foreign-plugin-key'));
  assert.ok(f.records.some(login => login.password === 'other-username-key'));
});

test('failed key replacement leaves the previous credential available', async () => {
  const f = fixture({ initial: [record(A, 'synthetic-old-key')] });
  f.state.failReplace = true;
  await assert.rejects(f.credentials.setKey(A, 'synthetic-new-key'), /synthetic credential replacement failure/);
  assert.equal(await f.credentials.getKey(A), 'synthetic-old-key');
  assert.equal(f.records.length, 1);
  assert.equal(f.calls.filter(call => call.action === 'remove').length, 0);
});

test('clearing a target endpoint removes its duplicates while retaining other endpoints', async () => {
  const f = fixture({ initial: [record(A, 'synthetic-a-1'), record(A, 'synthetic-a-2'), record(B, 'synthetic-b')] });
  await f.credentials.clearKey(A);
  assert.equal(await f.credentials.getKey(A), '');
  assert.equal(await f.credentials.getKey(B), 'synthetic-b');
  assert.equal(f.records.length, 1);
});

test('invalid credential destinations are rejected before consulting platform storage', async () => {
  const f = fixture();
  await assert.rejects(f.credentials.getKey('not-a-url'));
  await assert.rejects(f.credentials.setKey(A + '?key=synthetic', 'synthetic-key'));
  await assert.rejects(f.credentials.clearKey(A + '#fragment'));
  await assert.rejects(f.credentials.setKey(A, ''));
  assert.equal(f.calls.length, 0);
});

test('bootstrap object-scope export does not depend on globalThis being the script target', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const target = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync('plugin/content/credentials.js', 'utf8'), target);
  assert.equal(typeof target.RGCredentials.create, 'function');
  assert.equal(target.globalThis.RGCredentials, undefined);
});
