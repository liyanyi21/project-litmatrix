/* Based on LitMatrix 1.1.0 by bapungiri. Modified 2026-11-02. AGPL-3.0-or-later. */
/* global Zotero, Services, Components, APP_SHUTDOWN */
"use strict";

const PLM_WINDOW = "zotero:projectlitmatrix";
const PLM_STATE = "__projectLitMatrix";
var chromeHandle = null;

function install() {}
function uninstall() {}

async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  Services.obs.notifyObservers(null, "startupcache-invalidate");
  Services.obs.notifyObservers(null, "chrome-flush-caches");
  const manager = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = manager.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "projectlitmatrix", rootURI + "content/"],
  ]);
  Zotero.ProjectLitMatrix = { open: openMatrix };
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
    item.addEventListener("command", () => openMatrix(win));
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

function openMatrix(win) {
  win = win || Zotero.getMainWindow();
  if (win?.ZoteroPane) Zotero.ProjectLitMatrix.hostWindow = win;
  const target = selectedProject(win);
  const existing = Services.wm.getMostRecentWindow(PLM_WINDOW);
  if (existing) {
    existing.focus();
    if (target) {
      if (existing.ProjectLitMatrixUI) existing.ProjectLitMatrixUI.selectProject(target);
      else existing.__plmRequestedProject = target;
    }
    return;
  }
  const query = target ? `?library=${target.libraryID}&collection=${encodeURIComponent(target.collectionKey)}` : "";
  win.openDialog("chrome://projectlitmatrix/content/matrix.html" + query,
    "project-litmatrix-window", "chrome,resizable,centerscreen,dialog=no,width=1440,height=900");
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  Services.wm.getMostRecentWindow(PLM_WINDOW)?.close();
  for (const win of Zotero.getMainWindows()) removeFromWindow(win);
  delete Zotero.ProjectLitMatrix;
  chromeHandle?.destruct();
  chromeHandle = null;
  Services.obs.notifyObservers(null, "chrome-flush-caches");
}
