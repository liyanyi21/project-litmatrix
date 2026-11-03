const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('linkedom');

const content = name => fs.readFileSync(path.join(__dirname, '../plugin', name), 'utf8');
const plugin = { rootURI: 'jar:file:///research-grid.xpi!/', id: 'project-litmatrix@liyanyi.local', version: '0.1.2' };

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
  assert.deepEqual([...pane.scripts], [plugin.rootURI + 'content/preferences.js']);
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
  const Zotero = { ProjectLitMatrix: { version: plugin.version, open() { opens++; } }, logError: e => errors.push(e) };
  // Native inline handlers run in the shared preferences window. Zotero 8+
  // loads a plugin's script into a separate sandbox, exposed by getScope().
  // Zotero 7 instead loads that script directly into the shared window.
  const sharedWindow = { document, Zotero, Zotero_Preferences: {} };
  sharedWindow.window = sharedWindow;
  const windowContext = vm.createContext(sharedWindow);
  const context = legacy ? windowContext : vm.createContext({ document, Zotero });
  if (!legacy) sharedWindow.Zotero_Preferences.getScope = id => {
    assert.equal(id, 'research-grid-preferences');
    return context;
  };
  vm.runInContext(content('content/preferences.js'), context);
  return { document, Zotero, context, windowContext, errors, opens: () => opens };
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
