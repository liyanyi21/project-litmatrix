const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('linkedom');

const content = name => fs.readFileSync(path.join(__dirname, '../plugin', name), 'utf8');
const plugin = { rootURI: 'jar:file:///research-grid.xpi!/', id: 'project-litmatrix@liyanyi.local', version: '0.3.0' };

function lifecycle() {
  const panes = new Map();
  const registrations = [];
  const unregistered = [];
  let chromeDestroyed = 0;
  let matrixClosed = 0;
  const Zotero = {
    initializationPromise: Promise.resolve(),
    getMainWindows: () => [],
    PreferencePanes: {
      async register(options) {
        assert.ok(!panes.has(options.id), 'a second copy of the settings pane must not be registered');
        const returnedID = `registered-${options.id}`;
        panes.set(options.id, returnedID);
        registrations.push(options);
        return returnedID;
      },
      unregister(id) {
        unregistered.push(id);
        for (const [key, value] of panes) if (value === id) panes.delete(key);
      },
    },
  };
  const context = vm.createContext({
    Zotero, APP_SHUTDOWN: 2,
    Services: {
      scriptloader: { loadSubScript(url, scope) {
        assert.equal(url, plugin.rootURI + 'content/credentials.js');
        vm.runInNewContext(content('content/credentials.js'), scope);
      } },
      logins: {},
      obs: { notifyObservers() {} },
      io: { newURI: value => value },
      wm: { getMostRecentWindow: () => ({ close() { matrixClosed++; } }) },
    },
    Components: {
      classes: {
        '@mozilla.org/addons/addon-manager-startup;1': {
          getService: () => ({ registerChrome: () => ({ destruct() { chromeDestroyed++; } }) }),
        },
      },
      interfaces: { amIAddonManagerStartup: {} },
    },
  });
  vm.runInContext(content('bootstrap.js'), context);
  return { context, Zotero, panes, registrations, unregistered,
    destroyed: () => chromeDestroyed, closed: () => matrixClosed };
}

test('native settings pane is removed on disable and can be registered again on enable', async () => {
  const f = lifecycle();
  await f.context.startup(plugin);
  assert.equal(f.panes.size, 1);
  const pane = f.registrations[0];
  assert.equal(pane.pluginID, plugin.id);
  assert.equal(pane.src, plugin.rootURI + 'content/preferences.xhtml');
  assert.deepEqual([...pane.scripts], [plugin.rootURI + 'content/ai.js', plugin.rootURI + 'content/preferences.js']);
  assert.equal(typeof f.Zotero.ProjectLitMatrix.credentials.getKey, 'function');
  assert.equal(typeof f.Zotero.ProjectLitMatrix.openSettings, 'function');
  assert.equal(f.Zotero.ProjectLitMatrix.version, plugin.version);
  assert.equal(typeof f.Zotero.ProjectLitMatrix.open, 'function');

  f.context.shutdown({}, 1);
  assert.deepEqual(f.unregistered, [`registered-${pane.id}`]);
  assert.equal(f.panes.size, 0);
  assert.equal(f.Zotero.ProjectLitMatrix, undefined);
  assert.equal(f.destroyed(), 1);
  assert.equal(f.closed(), 1);

  await f.context.startup(plugin);
  assert.equal(f.panes.size, 1);
  f.context.shutdown({}, 1);
  assert.equal(f.panes.size, 0);
});

test('application shutdown leaves native settings cleanup to Zotero', async () => {
  const f = lifecycle();
  await f.context.startup(plugin);
  f.context.shutdown({}, 2);
  assert.equal(f.unregistered.length, 0);
  assert.equal(f.destroyed(), 0);
  assert.equal(f.closed(), 0);
});

function preferences({ legacy = false } = {}) {
  const document = new DOMParser().parseFromString(content('content/preferences.xhtml'), 'text/xml');
  let opens = 0;
  const errors = [];
  const keys = new Map();
  const keyCalls = [];
  const savedPrefs = new Map();
  const state = { failPublicWrite: false };
  const credentials = {
    async getKey(endpoint) { keyCalls.push(['get', endpoint]); return keys.get(endpoint) || ''; },
    async setKey(endpoint, key) { keyCalls.push(['set', endpoint, key]); keys.set(endpoint, key); },
    async clearKey(endpoint) { keyCalls.push(['clear', endpoint]); keys.delete(endpoint); },
  };
  const Zotero = {
    ProjectLitMatrix: { version: plugin.version, open() { opens++; }, credentials },
    Prefs: {
      get(key) { return savedPrefs.get(key); },
      set(key, value) { if (state.failPublicWrite) throw new Error('synthetic pref write failure'); savedPrefs.set(key, value); },
    },
    logError: e => errors.push(e),
  };
  // Native inline handlers run in the shared preferences window. Zotero 8+
  // loads a plugin's script into a separate sandbox, exposed by getScope().
  // Zotero 7 instead loads that script directly into the shared window.
  const sharedWindow = { document, Zotero, Zotero_Preferences: {}, URL, AbortController,
    setTimeout, clearTimeout, addEventListener() {},
    fetch() { throw new Error('tests must explicitly supply a synthetic transport'); } };
  sharedWindow.window = sharedWindow;
  const windowContext = vm.createContext(sharedWindow);
  const context = legacy ? windowContext : vm.createContext({ document, Zotero, window: sharedWindow,
    URL, AbortController, setTimeout, clearTimeout });
  if (!legacy) sharedWindow.Zotero_Preferences.getScope = id => {
    assert.equal(id, 'research-grid-preferences');
    return context;
  };
  vm.runInContext(content('content/ai.js'), context);
  vm.runInContext(content('content/preferences.js'), context);
  const controller = context.ResearchGridPreferences;
  function setInput(config = {}) {
    const values = { 'rg-ai-url': 'https://provider-a.example/v1', 'rg-ai-model': 'synthetic-model',
      'rg-ai-max-chars': '60000', 'rg-ai-timeout': '120', 'rg-ai-max-tokens': '0', 'rg-ai-key': '', ...config };
    for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
  }
  return { document, Zotero, context, windowContext, window: sharedWindow, controller, keys, keyCalls, savedPrefs, state,
    setInput, errors, opens: () => opens, status: () => document.getElementById('rg-ai-status').textContent };
}

for (const legacy of [false, true]) {
  test(`settings handlers reach the ${legacy ? 'Zotero 7 window' : 'Zotero 8+ sandbox'} controller`, () => {
    const f = preferences({ legacy });
    if (!legacy) assert.equal(f.windowContext.ResearchGridPreferences, undefined);
    const load = f.document.getElementById('research-grid-preferences-content').getAttribute('onload');
    vm.runInContext(load, f.windowContext);
    vm.runInContext(load, f.windowContext);
    assert.equal(f.document.getElementById('research-grid-version').textContent, `v${plugin.version}`);
    assert.equal(f.opens(), 0);
    const command = f.document.getElementById('research-grid-open-matrix').getAttribute('oncommand');
    vm.runInContext(command, f.windowContext);
    assert.equal(f.opens(), 1);
    assert.equal(f.errors.length, 0);
  });
}

test('failed settings launch shows an error and a successful retry clears it', () => {
  const f = preferences();
  const failure = new Error('matrix unavailable');
  f.Zotero.ProjectLitMatrix.open = () => { throw failure; };
  f.context.ResearchGridPreferences.openMatrix();
  const error = f.document.getElementById('research-grid-preferences-error');
  assert.ok(error.textContent.length > 0);
  assert.deepEqual(f.errors, [failure]);
  f.Zotero.ProjectLitMatrix.open = () => {};
  f.context.ResearchGridPreferences.openMatrix();
  assert.equal(error.textContent, '');
});


test('settings store an API key separately from public preferences and clear the typed field', async () => {
  const f = preferences();
  f.setInput({ 'rg-ai-key': 'synthetic-private-key' });
  await f.controller.saveAIConfig();
  const endpoint = 'https://provider-a.example/v1/chat/completions';
  assert.equal(f.keys.get(endpoint), 'synthetic-private-key');
  assert.equal(f.document.getElementById('rg-ai-key').value, '');
  const publicJSON = [...f.savedPrefs.values()].join('\n');
  assert.ok(!publicJSON.includes('synthetic-private-key'));
  assert.ok(!publicJSON.includes('apiKey'));
  assert.ok(f.status().includes('已保存 AI 设置'));
  assert.equal(JSON.parse(f.savedPrefs.get(f.context.RGAI.CONFIG_PREF)).model, 'synthetic-model');
});

test('switching API endpoint with a blank key never copies or clears the old endpoint secret', async () => {
  const f = preferences();
  const a = 'https://provider-a.example/v1/chat/completions';
  const b = 'https://provider-b.example/v1/chat/completions';
  f.keys.set(a, 'synthetic-a-key');
  f.setInput({ 'rg-ai-url': 'https://provider-b.example/v1', 'rg-ai-key': '' });
  await f.controller.saveAIConfig();
  assert.equal(f.keys.get(a), 'synthetic-a-key');
  assert.equal(f.keys.has(b), false);
  assert.equal(f.keyCalls.filter(call => call[0] === 'set' || call[0] === 'clear').length, 0);
  assert.ok(f.document.getElementById('rg-ai-key-status').textContent.includes('尚未保存'));
  assert.equal(JSON.parse(f.savedPrefs.get(f.context.RGAI.CONFIG_PREF)).baseURL, 'https://provider-b.example/v1');
});

test('public preference write failure rolls a changed key back to its previous value', async () => {
  const f = preferences();
  const endpoint = 'https://provider-a.example/v1/chat/completions';
  f.keys.set(endpoint, 'synthetic-old-key');
  f.setInput({ 'rg-ai-key': 'synthetic-new-key' });
  f.state.failPublicWrite = true;
  await f.controller.saveAIConfig();
  assert.equal(f.keys.get(endpoint), 'synthetic-old-key');
  assert.equal(f.savedPrefs.size, 0);
  assert.ok(f.status().includes('保存 AI 设置失败'));
  assert.equal(f.controller.aiBusy, false);
  assert.equal(f.document.getElementById('rg-ai-save').disabled, false);
});

test('public preference write failure removes a newly created key without touching other endpoints', async () => {
  const f = preferences();
  const endpoint = 'https://provider-a.example/v1/chat/completions';
  f.keys.set('https://other.example/v1/chat/completions', 'synthetic-other-key');
  f.setInput({ 'rg-ai-key': 'synthetic-new-key' });
  f.state.failPublicWrite = true;
  await f.controller.saveAIConfig();
  assert.equal(f.keys.has(endpoint), false);
  assert.equal(f.keys.get('https://other.example/v1/chat/completions'), 'synthetic-other-key');
});

test('clearing the current endpoint key retains other service keys', async () => {
  const f = preferences();
  const a = 'https://provider-a.example/v1/chat/completions';
  const b = 'https://provider-b.example/v1/chat/completions';
  f.keys.set(a, 'synthetic-a-key'); f.keys.set(b, 'synthetic-b-key');
  f.setInput();
  await f.controller.clearAIKey();
  assert.equal(f.keys.has(a), false);
  assert.equal(f.keys.get(b), 'synthetic-b-key');
  assert.ok(f.status().includes('已清除'));
});

test('connection test sends only a synthetic test sentence and does not persist typed inputs', async () => {
  const f = preferences();
  f.setInput({ 'rg-ai-key': 'synthetic-unsaved-key' });
  let request;
  f.window.fetch = async (endpoint, options) => {
    request = { endpoint, options, body: JSON.parse(options.body) };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }) };
  };
  await f.controller.testAI();
  assert.equal(request.endpoint, 'https://provider-a.example/v1/chat/completions');
  assert.deepEqual(request.body.messages, [
    { role: 'system', content: 'This is a connection test. Reply briefly with OK.' },
    { role: 'user', content: 'Reply OK.' },
  ]);
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-unsaved-key');
  assert.equal(f.savedPrefs.size, 0); assert.equal(f.keys.size, 0);
  assert.ok(f.status().includes('连接成功'));
  assert.equal(f.controller.aiBusy, false);
  assert.equal(f.document.getElementById('rg-ai-key').value, 'synthetic-unsaved-key');
});

test('connection test can be canceled without persisting inputs or exposing transport errors', async () => {
  const f = preferences();
  f.setInput({ 'rg-ai-key': 'synthetic-unsaved-key' });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.window.fetch = (endpoint, options) => new Promise((resolve, reject) => {
    started();
    options.signal.addEventListener('abort', () => reject(new Error('synthetic transport failure includes sensitive material')), { once: true });
  });
  const running = f.controller.testAI();
  await ready;
  assert.equal(f.controller.aiBusy, true);
  f.controller.cancelAITest();
  await running;
  assert.ok(f.status().includes('已取消'));
  assert.ok(!f.status().includes('sensitive material'));
  assert.equal(f.savedPrefs.size, 0); assert.equal(f.keys.size, 0);
  assert.equal(f.controller.aiBusy, false);
  assert.equal(f.document.getElementById('rg-ai-save').disabled, false);
});
