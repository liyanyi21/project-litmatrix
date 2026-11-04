/* Based on LitMatrix 1.1.0 by bapungiri. Modified 2026-11-02. AGPL-3.0-or-later. */
/* global Zotero, Services, Components, APP_SHUTDOWN */
"use strict";

const PLM_WINDOW = "zotero:projectlitmatrix";
const PLM_STATE = "__projectLitMatrix";
var chromeHandle = null;
var preferencePaneID = null;

function install() {}
function uninstall() {}

async function startup({ rootURI, id, version }) {
  await Zotero.initializationPromise;
  Services.obs.notifyObservers(null, "startupcache-invalidate");
  Services.obs.notifyObservers(null, "chrome-flush-caches");
  const manager = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = manager.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "projectlitmatrix", rootURI + "content/"],
  ]);
  const credentialScope = {};
  Services.scriptloader.loadSubScript(rootURI + "content/credentials.js", credentialScope);
  Zotero.ProjectLitMatrix = { open: openMatrix, openFields: win => openMatrix(win, { fields: true }), version,
    credentials: credentialScope.RGCredentials.create({ Services, Components }),
    openSettings: () => Zotero.Utilities.Internal.openPreferences("research-grid-preferences") };
  preferencePaneID = await Zotero.PreferencePanes.register({
    pluginID: id,
    id: "research-grid-preferences",
    label: "研矩",
    src: rootURI + "content/preferences.xhtml",
    scripts: [rootURI + "content/ai.js", rootURI + "content/preferences.js"],
  });
  for (const win of Zotero.getMainWindows()) addToWindow(win);
}

function onMainWindowLoad({ window }) { addToWindow(window); }
function onMainWindowUnload({ window }) { removeFromWindow(window); }

function addToWindow(win) {
  if (!win.ZoteroPane || win[PLM_STATE]) return;
  const state = { elements: [] };
  win[PLM_STATE] = state;
  for (const [menuID, suffix, label] of [
    ["menu_ToolsPopup", "tools", "研矩 · ResearchGrid"],
    ["zotero-collectionmenu", "collection", "打开研矩"],
  ]) {
    const menu = win.document.getElementById(menuID);
    if (!menu) continue;
    const sep = win.document.createXULElement("menuseparator");
    const item = win.document.createXULElement("menuitem");
    item.id = `projectlitmatrix-${suffix}`;
    item.setAttribute("label", label);
    item.addEventListener("command", () => openMatrix(win, suffix === "tools" ? { restore: true } : {}));
    menu.append(sep, item);
    state.elements.push(sep, item);
  }
}

function removeFromWindow(win) {
  for (const el of win[PLM_STATE]?.elements || []) el.remove();
  delete win[PLM_STATE];
}

function selectedProject(win) {
  try {
    const pane = win.ZoteroPane;
    const selected = pane.getSelectedCollections?.();
    const col = selected ? (selected.length === 1 ? selected[0] : null) : pane.getSelectedCollection();
    return col ? { libraryID: col.libraryID, collectionKey: col.key } : null;
  } catch (_) { return null; }
}

function selectedProjects(win) {
  try {
    const pane = win?.ZoteroPane;
    const selected = pane?.getSelectedCollections?.();
    const collections = selected || [pane?.getSelectedCollection?.()].filter(Boolean);
    const seen = new Set(), targets = [];
    if (!Array.isArray(collections)) return targets;
    for (const col of collections) {
      if (!Number.isInteger(col?.libraryID) || !col.key || typeof col.key !== "string") continue;
      const identity = JSON.stringify([col.libraryID, col.key]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      targets.push({ libraryID: col.libraryID, collectionKey: col.key });
    }
    return targets;
  } catch (_) { return []; }
}

function openMatrix(win, options = {}) {
  win = win || Zotero.getMainWindow();
  if (win?.ZoteroPane) Zotero.ProjectLitMatrix.hostWindow = win;
  const selected = selectedProjects(win);
  const targets = options.restore && selected.length <= 1 ? [] : selected;
  const target = targets.length === 1 ? targets[0] : null;
  const existing = Services.wm.getMostRecentWindow(PLM_WINDOW);
  if (existing) {
    existing.focus();
    const ui = existing.ProjectLitMatrixUI;
    if (ui && (!targets.length || (targets.length === 1 ? typeof ui.selectProject === "function" : typeof ui.selectProjects === "function"))) {
      Promise.resolve().then(() => targets.length > 1 ? ui.selectProjects(targets) : target ? ui.selectProject(target) : null)
        .then(() => { if (options.fields) existing.ProjectLitMatrixUI.showFields(); })
        .catch(error => Zotero.logError(error));
    } else {
      if (targets.length) {
        existing.__plmRequestedProjects = targets;
        if (target) existing.__plmRequestedProject = target;
        else delete existing.__plmRequestedProject;
      }
      if (options.fields) existing.__plmOpenFields = true;
    }
    return existing;
  }
  const query = targets.length > 1 ? `?projects=${encodeURIComponent(JSON.stringify(targets))}`
    : target ? `?library=${target.libraryID}&collection=${encodeURIComponent(target.collectionKey)}` : "";
  const matrix = win.openDialog("chrome://projectlitmatrix/content/matrix.html" + query,
    "project-litmatrix-window", "chrome,resizable,centerscreen,dialog=no,width=1440,height=900");
  if (targets.length) matrix.__plmRequestedProjects = targets;
  if (target) matrix.__plmRequestedProject = target;
  if (options.fields) matrix.__plmOpenFields = true;
  return matrix;
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  if (preferencePaneID) {
    Zotero.PreferencePanes.unregister(preferencePaneID);
    preferencePaneID = null;
  }
  Services.wm.getMostRecentWindow(PLM_WINDOW)?.close();
  for (const win of Zotero.getMainWindows()) removeFromWindow(win);
  delete Zotero.ProjectLitMatrix;
  chromeHandle?.destruct();
  chromeHandle = null;
  Services.obs.notifyObservers(null, "chrome-flush-caches");
}
