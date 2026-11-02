/* Project LitMatrix. Zotero adapter inspired by LitMatrix 1.1.0. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  class Repository {
    constructor(Zotero, Core = root.PLMCore, Parser = root.DOMParser) {
      this.Z = Zotero;
      this.C = Core;
      this.Parser = Parser;
    }
    projects() {
      const result = [];
      for (const lib of this.Z.Libraries.getAll()) {
        if (!["user", "group"].includes(lib.libraryType)) continue;
        const collections = this.Z.Collections.getByLibrary(lib.libraryID, true);
        const byID = new Map(collections.map(c => [c.id, c]));
        for (const col of collections) {
          const path = [col.name];
          const seen = new Set([col.id]);
          for (let parent = byID.get(col.parentID); parent && !seen.has(parent.id); parent = byID.get(parent.parentID)) {
            seen.add(parent.id);
            path.unshift(parent.name);
          }
          result.push({ id: this.C.projectID(lib, col.key), libraryID: lib.libraryID,
            collectionKey: col.key, name: col.name, path: path.join(" / "),
            label: `${lib.name} / ${path.join(" / ")}`, library: lib, collection: col });
        }
      }
      return result;
    }
    mainWindow() {
      const host = this.Z.ProjectLitMatrix?.hostWindow;
      if (host && !host.closed && host.ZoteroPane) return host;
      const recent = this.Z.getMainWindow();
      if (recent?.ZoteroPane) return recent;
      return this.Z.getMainWindows?.().find(win => win.ZoteroPane && !win.closed) || null;
    }
    currentProject() {
      const pane = this.mainWindow()?.ZoteroPane;
      let collection;
      try {
        const selected = pane?.getSelectedCollections?.();
        collection = selected ? (selected.length === 1 ? selected[0] : null) : pane?.getSelectedCollection();
      } catch (_) { /* multiple selection */ }
      if (!collection) return null;
      return this.projects().find(p => p.libraryID === collection.libraryID && p.collectionKey === collection.key) || null;
    }
    async itemsFor(project, recursive) {
      const cols = [project.collection];
      if (recursive) cols.push(...this.Z.Collections.getByParent(project.collection.id, true));
      const ids = new Set();
      for (const col of cols) {
        if (col.loadDataType) await col.loadDataType("childItems");
        for (const id of col.getChildItems(true)) ids.add(id);
      }
      const all = ids.size ? await this.Z.Items.getAsync([...ids]) : [];
      return all.filter(it => it && !it.deleted && !it.parentID && (it.isRegularItem() || it.isAttachment()));
    }
    async noteFor(paper, project) {
      if (!paper.isRegularItem()) return { note: null, values: this.C.blankValues() };
      await this.Z.Items.loadDataTypes([paper], ["childItems"]);
      const notes = await this.Z.Items.getAsync(paper.getNotes());
      await this.Z.Items.loadDataTypes(notes.filter(Boolean), ["note", "tags"]);
      const marker = this.C.noteTag(project.id);
      const matches = notes.filter(n => n && !n.deleted && n.parentID === paper.id &&
        n.libraryID === project.libraryID && n.getTags().some(t => t.tag === marker));
      if (matches.length > 1) throw new Error("此文献有多份同项目笔记，请在 Zotero 中合并后再编辑。");
      const note = matches[0] || null;
      return { note, values: note ? this.C.parseNote(note.getNote(), this.Parser).values : this.C.blankValues() };
    }
    info(paper, library) {
      const field = name => { try { return paper.getField(name) || ""; } catch (_) { return ""; } };
      const creators = paper.isRegularItem() ? paper.getCreators().filter(c => {
        if (c.creatorType) return c.creatorType === "author";
        if (typeof c.creatorTypeID === "number") return c.creatorTypeID === this.Z.CreatorTypes?.getID("author");
        return true;
      }) : [];
      const names = (creators.length ? creators : paper.isRegularItem() ? paper.getCreators() : [])
        .map(c => c.lastName || c.name || "").filter(Boolean);
      const authors = names.length > 2 ? `${names[0]} 等` : names.join("、");
      let citekey = field("citationKey");
      try { citekey ||= this.Z.BetterBibTeX?.KeyManager?.get(paper.id)?.citationKey || ""; } catch (_) {}
      citekey ||= (field("extra").match(/^Citation Key:\s*(\S+)/im) || [])[1] || paper.key;
      const year = (field("date").match(/\b(?:1|2)\d{3}\b/) || [])[0] || "";
      return { id: paper.id, key: paper.key, libraryID: paper.libraryID,
        title: (paper.getDisplayTitle ? paper.getDisplayTitle() : field("title")) || "未命名文献",
        authors, year, citekey, tags: paper.getTags().map(t => t.tag),
        itemURL: this.C.itemLink(library, paper.key),
        editable: !!library.editable && paper.isRegularItem(), paper };
    }
    async loadProject(project, recursive = true) {
      const papers = await this.itemsFor(project, recursive);
      await this.Z.Items.loadDataTypes(papers, ["creators", "itemData", "tags", "childItems"]);
      const rows = [];
      for (const paper of papers) {
        const row = { ...this.info(paper, project.library), values: this.C.blankValues(), annotations: [],
          noteKey: null, noteURL: "", noteError: "", pdfURL: "", attachmentID: null };
        const attachments = paper.isAttachment() ? [paper] : await this.Z.Items.getAsync(paper.getAttachments());
        const live = attachments.filter(a => a && !a.deleted);
        await this.Z.Items.loadDataTypes(live, ["childItems"]);
        const pdf = live.find(a => a.attachmentContentType === "application/pdf");
        const best = pdf || live.find(a => ["application/epub+zip", "text/html"].includes(a.attachmentContentType));
        if (best) {
          row.attachmentID = best.id;
          row.pdfURL = this.C.pdfLink(project.library, best.key);
        }
        for (const att of live) {
          if (!att.isFileAttachment()) continue;
          const anns = att.getAnnotations().filter(a => !a.deleted);
          await this.Z.Items.loadDataTypes(anns, ["annotation", "annotationDeferred"]);
          for (const a of anns) row.annotations.push({ key: a.key, attachmentID: att.id,
            text: a.annotationText || "", comment: this.htmlText(a.annotationComment || ""),
            page: a.annotationPageLabel || "", color: a.annotationColor || "#999999",
            sortIndex: a.annotationSortIndex || "", url: this.C.pdfLink(project.library, att.key, a.key) });
        }
        row.annotations.sort((a, b) => a.attachmentID - b.attachmentID || a.sortIndex.localeCompare(b.sortIndex));
        try {
          const record = await this.noteFor(paper, project);
          row.values = record.values;
          row.noteKey = record.note?.key || null;
          row.noteURL = row.noteKey ? this.C.itemLink(project.library, row.noteKey) : "";
        } catch (e) { row.noteError = e.message; row.editable = false; }
        rows.push(row);
      }
      return rows;
    }
    htmlText(html) {
      const doc = new this.Parser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
      return [...doc.body.childNodes].map(this.C.plainNode).join("").trim();
    }
    async saveField(project, row, fieldID, value, expected) {
      if (!this.C.fieldByID(fieldID)) throw new Error("未知分析字段。");
      if (!row.editable || !this.Z.Libraries.get(project.libraryID)?.editable) throw new Error("此文献不能编辑项目笔记。");
      let saved;
      // Resolve notes again inside the transaction: don't write a stale UI snapshot.
      await this.Z.DB.executeTransaction(async () => {
        const paper = await this.Z.Items.getAsync(row.id);
        if (!paper || paper.deleted || paper.libraryID !== project.libraryID || paper.key !== row.key) {
          throw new Error("文献已删除或发生变化，请刷新后重试。");
        }
        if (paper.isEditable && !paper.isEditable()) throw new Error("此文献当前不可编辑。");
        const fresh = await this.noteFor(paper, project);
        if (fresh.values[fieldID] !== expected) throw new Error("这个字段已在其他窗口或设备中修改。请保留输入，关闭编辑框并刷新后核对。");
        if (value.trim() === expected.trim()) { saved = fresh; return; }
        let note = fresh.note;
        if (!note) {
          note = new this.Z.Item("note");
          note.libraryID = project.libraryID;
          note.parentID = paper.id;
          note.addTag(this.C.noteTag(project.id));
          note.setNote(this.C.createNote(project.name, { [fieldID]: value }));
        } else {
          note.setNote(this.C.updateNote(note.getNote(), fieldID, value, this.Parser));
        }
        await note.save();
        saved = { note, values: this.C.parseNote(note.getNote(), this.Parser).values };
      });
      return saved;
    }
    async openPaper(row) {
      if (row.attachmentID) await this.Z.Reader.open(row.attachmentID);
      else await this.selectItem(row.id);
      this.mainWindow()?.focus();
    }
    async openAnnotation(annotation) {
      await this.Z.Reader.open(annotation.attachmentID, { annotationID: annotation.key });
      this.mainWindow()?.focus();
    }
    async selectItem(id) {
      const win = this.mainWindow();
      if (!win) throw new Error("请先打开 Zotero 主窗口。");
      win.Zotero_Tabs?.select("zotero-pane");
      await win.ZoteroPane.selectItem(id);
      win.focus();
    }
  }
  root.PLMRepository = Repository;
  if (typeof module !== "undefined" && module.exports) module.exports = Repository;
})(globalThis);
