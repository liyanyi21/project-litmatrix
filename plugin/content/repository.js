/* ResearchGrid. Zotero adapter inspired by LitMatrix 1.1.0. AGPL-3.0-or-later. */
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
      const fields = project.fields || this.C.FIELDS;
      if (!paper.isRegularItem()) return { note: null, values: this.C.blankValues(fields), highlights: Object.fromEntries(fields.map(field => [field.id, []])) };
      await this.Z.Items.loadDataTypes([paper], ["childItems"]);
      const notes = await this.Z.Items.getAsync(paper.getNotes());
      await this.Z.Items.loadDataTypes(notes.filter(Boolean), ["note", "tags"]);
      const marker = this.C.noteTag(project.id);
      const matches = notes.filter(n => n && !n.deleted && n.parentID === paper.id &&
        n.libraryID === project.libraryID && n.getTags().some(t => t.tag === marker));
      if (matches.length > 1) throw new Error("此文献有多份同项目笔记，请在 Zotero 中合并后再编辑。");
      const note = matches[0] || null;
      const parsed = note ? this.C.parseNote(note.getNote(), this.Parser, fields) : null;
      return { note, values: parsed?.values || this.C.blankValues(fields),
        highlights: parsed?.highlights || Object.fromEntries(fields.map(field => [field.id, []])) };
    }
    info(paper, library) {
      const field = name => { try { return paper.getField(name) || ""; } catch (_) { return ""; } };
      const creators = paper.isRegularItem() ? paper.getCreators().filter(c => {
        if (c.creatorType) return c.creatorType === "author";
        if (typeof c.creatorTypeID === "number") return c.creatorTypeID === this.Z.CreatorTypes?.getID("author");
        return true;
      }) : [];
      const displayCreators = creators.length ? creators : paper.isRegularItem() ? paper.getCreators() : [];
      const names = displayCreators
        .map(c => c.lastName || c.name || "").filter(Boolean);
      const authors = names.length > 2 ? `${names[0]} 等` : names.join("、");
      let citekey = field("citationKey");
      try { citekey ||= this.Z.BetterBibTeX?.KeyManager?.get(paper.id)?.citationKey || ""; } catch (_) {}
      citekey ||= (field("extra").match(/^Citation Key:\s*(\S+)/im) || [])[1] || paper.key;
      const year = (field("date").match(/\b(?:1|2)\d{3}\b/) || [])[0] || "";
      const textField = name => {
        try { const value = paper.getField(name); return value == null || value === false ? "" : String(value); }
        catch (_) { return ""; }
      };
      const metadata = Object.fromEntries(["title", "date", "DOI", "url", "abstractNote", "volume", "issue", "pages",
        "publisher", "place", "language", "ISBN", "ISSN", "accessDate", "dateAdded", "dateModified", "extra", "citationKey"]
        .map(name => [name, textField(name)]));
      metadata.creators = displayCreators.map(creator => {
        if (creator.name) return String(creator.name);
        if (creator.fieldMode === 1) return String(creator.lastName || creator.firstName || "");
        return [creator.firstName, creator.lastName].filter(Boolean).map(String).join(" ");
      }).filter(Boolean).join("、");
      metadata.year = year;
      metadata.citationKey = String(citekey ?? "");
      metadata.publicationTitle = ["publicationTitle", "proceedingsTitle", "bookTitle", "websiteTitle"]
        .map(textField).find(value => value.trim()) || "";
      metadata.itemType = "";
      for (const getType of [() => this.Z.ItemTypes?.getLocalizedString?.(paper.itemTypeID),
        () => this.Z.ItemTypes?.getName?.(paper.itemTypeID), () => paper.itemType]) {
        try { const value = getType(); if (value) { metadata.itemType = String(value); break; } }
        catch (_) { /* Item type helpers vary between Zotero versions. */ }
      }
      return { id: paper.id, key: paper.key, libraryID: paper.libraryID,
        title: (paper.getDisplayTitle ? paper.getDisplayTitle() : field("title")) || "未命名文献",
        authors, year, citekey, tags: paper.getTags().map(t => t.tag), metadata,
        itemURL: this.C.itemLink(library, paper.key),
        editable: !!library.editable && paper.isRegularItem(), paper };
    }
    async loadProject(project, recursive = true) {
      project = { ...project, fields: project.fields || this.C.FIELDS };
      const papers = await this.itemsFor(project, recursive);
      await this.Z.Items.loadDataTypes(papers, ["creators", "itemData", "tags", "childItems"]);
      const rows = [];
      for (const paper of papers) {
        const row = { ...this.info(paper, project.library), values: this.C.blankValues(project.fields), highlights: {}, annotations: [],
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
          row.highlights = record.highlights;
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
    async saveField(project, row, fieldID, value, expected, options = {}) {
      return this.saveFields(project, row, { [fieldID]: value }, { [fieldID]: expected }, {
        highlights: options.highlights === undefined ? undefined : { [fieldID]: options.highlights },
        expectedHighlights: options.expectedHighlights === undefined ? undefined : { [fieldID]: options.expectedHighlights },
      });
    }
    // Capture formatting along with text before awaiting the transaction. A
    // highlight-only edit must conflict just like a concurrent text edit.
    formattingSnapshot(row, entries, expected, options = {}) {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("高亮保存选项无效。");
      const desired = Object.create(null), originals = Object.create(null);
      for (const name of ["highlights", "expectedHighlights"]) {
        if (options[name] !== undefined && (!options[name] || typeof options[name] !== "object" || Array.isArray(options[name]))) {
          throw new Error("高亮字段格式无效。");
        }
        if (options[name] && Object.keys(options[name]).some(id => !entries.some(([fieldID]) => fieldID === id))) {
          throw new Error("高亮包含未选择的字段。");
        }
      }
      for (const [id, value] of entries) {
        if (options.highlights && Object.prototype.hasOwnProperty.call(options.highlights, id)) {
          desired[id] = this.C.normalizeHighlights(value, options.highlights[id]);
        }
        if (options.expectedHighlights && Object.prototype.hasOwnProperty.call(options.expectedHighlights, id)) {
          originals[id] = this.C.normalizeHighlights(expected[id], options.expectedHighlights[id]);
        } else if (row.highlights && typeof row.highlights === "object") {
          originals[id] = this.C.normalizeHighlights(expected[id], row.highlights[id] || []);
        }
      }
      return { desired, originals };
    }
    formattingConflicts(fresh, formatting) {
      return Object.entries(formatting.originals).some(([id, ranges]) =>
        JSON.stringify(fresh.highlights[id] || []) !== JSON.stringify(ranges));
    }
    trimmedHighlights(value, ranges) {
      const left = value.length - value.trimStart().length, text = value.trim();
      return this.C.normalizeHighlights(text, ranges.map(range => ({ ...range,
        start: Math.max(0, range.start - left), end: Math.min(text.length, range.end - left),
      })).filter(range => range.start < range.end));
    }
    changedFields(entries, originals, fresh, formatting) {
      return entries.filter(([id, value]) => value.trim() !== originals[id].trim()
        || (Object.prototype.hasOwnProperty.call(formatting.desired, id)
          && JSON.stringify(this.trimmedHighlights(value, formatting.desired[id])) !== JSON.stringify(fresh.highlights[id] || [])));
    }
    async saveFields(project, row, changes, expected, options = {}) {
      const fields = (project.fields || this.C.FIELDS).map(f => ({ ...f, aliases: [...(f.aliases || [])] }));
      const entries = Object.entries(changes);
      if (!entries.length) throw new Error("请先选择需要写入的字段。");
      for (const [id, value] of entries) {
        const field = this.C.fieldByID(id, fields);
        if (!field || field.archived) throw new Error("未知或已移除的分析字段。");
        if (typeof value !== "string" || typeof expected[id] !== "string") throw new Error("字段内容或原值格式不正确。");
      }
      const originals = Object.fromEntries(entries.map(([id]) => [id, expected[id]]));
      const formatting = this.formattingSnapshot(row, entries, originals, options);
      project = { ...project, fields };
      if (!row.editable || !this.Z.Libraries.get(project.libraryID)?.editable) throw new Error("此文献不能编辑项目笔记。");
      let saved;
      const touched = [];
      await this.Z.DB.executeTransaction(async () => {
        const paper = await this.Z.Items.getAsync(row.id);
        if (!paper || paper.deleted || paper.libraryID !== project.libraryID || paper.key !== row.key) {
          throw new Error("文献已删除或发生变化，请刷新后重试。");
        }
        if (paper.isEditable && !paper.isEditable()) throw new Error("此文献当前不可编辑。");
        const fresh = await this.noteFor(paper, project);
        if (entries.some(([id]) => fresh.values[id] !== originals[id]) || this.formattingConflicts(fresh, formatting)) {
          throw new Error("选中的字段或高亮已在其他窗口或设备中修改。请保留草稿，关闭预览并刷新后核对。");
        }
        const changed = this.changedFields(entries, originals, fresh, formatting);
        if (!changed.length) { saved = fresh; return; }
        let note = fresh.note;
        const existing = !!note;
        if (!note) {
          note = new this.Z.Item("note");
          note.libraryID = project.libraryID;
          note.parentID = paper.id;
          note.addTag(this.C.noteTag(project.id));
          touched.push({ note, paper, existing });
          note.setNote(this.C.createNote(project.name, Object.fromEntries(changed), fields, formatting.desired));
        } else {
          let html = note.getNote();
          for (const [id, value] of changed) html = this.C.updateNote(html, id, value, this.Parser, fields, formatting.desired[id]);
          touched.push({ note, paper, existing });
          note.setNote(html);
        }
        await note.save();
        const parsed = this.C.parseNote(note.getNote(), this.Parser, fields);
        saved = { note, values: parsed.values, highlights: parsed.highlights };
      }).catch(async error => {
        if (error.committed) { this.Z.logError?.(error); return; }
        await this.recoverRolledBackWrites(touched);
        throw error;
      });
      return saved;
    }
    async recoverRolledBackWrites(touched) {
      const reload = async (item, types) => {
        if (typeof item.reload === "function") await item.reload(types, true);
        else if (typeof this.Z.Items.reload === "function") await this.Z.Items.reload([item.id], types, true);
        else this.Z.Items.unload?.(item.id);
      };
      for (const { note, existing } of touched) {
        if (!existing) continue;
        try { await reload(note, null); note._clearChanged?.(); }
        catch (recoveryError) { this.Z.logError?.(recoveryError); this.Z.Items.unload?.(note.id); }
      }
      for (const paper of new Set(touched.map(record => record.paper))) {
        try { await reload(paper, ["primaryData", "childItems"]); paper.clearBestAttachmentState?.(); }
        catch (recoveryError) { this.Z.logError?.(recoveryError); this.Z.Items.unload?.(paper.id); }
      }
    }
    async importRows(project, operations) {
      if (!project || typeof project.id !== "string" || !project.id || !Number.isInteger(project.libraryID)) {
        throw new Error("当前项目无效，请重新选择分类。");
      }
      if (!Array.isArray(operations) || !operations.length) throw new Error("请先选择需要导入的内容。");
      if (operations.length > 10000) throw new Error("一次最多导入 10000 篇文献，请分批导入。");
      const fields = (project.fields || this.C.FIELDS).map(f => ({ ...f, aliases: [...(f.aliases || [])] }));
      project = { ...project, fields };
      const collectionID = project.collection?.id;
      const seenIDs = new Set(), seenKeys = new Set();
      let totalChars = 0;
      // Capture all caller-controlled data before the first await. Keep only the
      // original row reference in the result so the UI can refresh after commit.
      const snapshots = operations.map(operation => {
        const row = operation?.row;
        if (!row || !Number.isInteger(row.id) || row.id <= 0 || typeof row.key !== "string" || !row.key
          || row.libraryID !== project.libraryID || !row.editable) {
          throw new Error("导入包含不可编辑或不属于当前文献库的文献。");
        }
        const identity = { id: row.id, key: row.key, libraryID: row.libraryID };
        const key = `${identity.libraryID}:${identity.key}`;
        if (seenIDs.has(identity.id) || seenKeys.has(key)) throw new Error("同一文献在导入中出现多次，请先合并重复行。");
        seenIDs.add(identity.id); seenKeys.add(key);
        if (!operation.changes || typeof operation.changes !== "object" || Array.isArray(operation.changes)
          || !operation.expected || typeof operation.expected !== "object" || Array.isArray(operation.expected)) {
          throw new Error("导入字段或原值格式不正确，请重新解析表格。");
        }
        const entries = Object.entries(operation.changes);
        if (!entries.length || entries.length > 40) throw new Error("每篇文献请选择 1–40 个需要导入的字段。");
        const originals = Object.create(null);
        for (const [id, value] of entries) {
          const field = this.C.fieldByID(id, fields);
          if (!field || field.archived) throw new Error("导入包含未知或已移出的分析字段。");
          if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(operation.expected, id)
            || typeof operation.expected[id] !== "string") throw new Error("导入字段内容或原值格式不正确。");
          if (value.length > 200000) throw new Error("单个导入字段不能超过 200000 个字符，请拆分内容。");
          totalChars += value.length;
          if (totalChars > 10000000) throw new Error("导入内容过长，请分批导入。");
          originals[id] = operation.expected[id];
        }
        const formatting = this.formattingSnapshot(row, entries, originals, {
          highlights: operation.highlights, expectedHighlights: operation.expectedHighlights,
        });
        return { row, identity, entries, originals, formatting };
      });
      if (!this.Z.Libraries.get(project.libraryID)?.editable) throw new Error("当前文献库不能编辑项目笔记。");
      const records = [];
      const touched = [];
      let importedRows = 0, changedFields = 0;
      await this.Z.DB.executeTransaction(async () => {
        if (!this.Z.Libraries.get(project.libraryID)?.editable) throw new Error("当前文献库不能编辑项目笔记。");
        const collection = this.Z.Collections.getByLibrary(project.libraryID, true)
          .find(candidate => candidate.id === collectionID && candidate.key === project.collectionKey
            && candidate.libraryID === project.libraryID && !candidate.deleted);
        if (!collection || this.C.projectID(this.Z.Libraries.get(project.libraryID), collection.key) !== project.id) {
          throw new Error("当前项目分类已变化或不存在，请关闭预览并重新选择分类。");
        }
        const allowed = new Set((await this.itemsFor({ ...project, collection }, project.recursive !== false)).map(paper => paper.id));
        if (snapshots.some(snapshot => !allowed.has(snapshot.identity.id))) {
          throw new Error("当前项目文献范围已变化，部分文献已不在此分类中；本次没有导入，请关闭预览并刷新后核对。");
        }
        const staged = [];
        for (const snapshot of snapshots) {
          const { identity, entries, originals, formatting } = snapshot;
          const paper = await this.Z.Items.getAsync(identity.id);
          if (!paper || paper.deleted || paper.key !== identity.key || paper.libraryID !== identity.libraryID) {
            throw new Error("导入文献已删除或发生变化，请关闭预览并刷新后重试。");
          }
          if (!paper.isRegularItem() || paper.parentID || (paper.isEditable && !paper.isEditable())) {
            throw new Error("导入包含当前不可编辑的文献，请重新核对。");
          }
          const fresh = await this.noteFor(paper, project);
          if (fresh.note?.isEditable && !fresh.note.isEditable()) throw new Error("导入包含不可编辑的项目笔记。");
          if (entries.some(([id]) => fresh.values[id] !== originals[id]) || this.formattingConflicts(fresh, formatting)) {
            throw new Error("部分字段已在其他窗口或设备中修改，本次没有导入。请保留表格，关闭预览并刷新后核对。");
          }
          const changed = this.changedFields(entries, originals, fresh, formatting);
          let html = null;
          if (changed.length) {
            if (fresh.note) {
              html = fresh.note.getNote();
              for (const [id, value] of changed) html = this.C.updateNote(html, id, value, this.Parser, fields, formatting.desired[id]);
            } else html = this.C.createNote(project.name, Object.fromEntries(changed), fields, formatting.desired);
            // Validate every resulting note before any Item object is changed.
            this.C.parseNote(html, this.Parser, fields);
          }
          staged.push({ ...snapshot, paper, fresh, changed, html });
        }
        // Zotero's transaction rolls back all writes if any subsequent save
        // fails. Do not call saveFields() here: every paper belongs to this one
        // shared transaction and all conflicts have already been checked.
        for (const stage of staged) {
          let { note, values, highlights } = stage.fresh;
          if (stage.changed.length) {
            const existing = !!note;
            if (!note) {
              note = new this.Z.Item("note");
              note.libraryID = project.libraryID;
              note.parentID = stage.paper.id;
              note.addTag(this.C.noteTag(project.id));
            }
            touched.push({ note, paper: stage.paper, existing });
            note.setNote(stage.html);
            await note.save();
            const parsed = this.C.parseNote(note.getNote(), this.Parser, fields);
            values = parsed.values; highlights = parsed.highlights;
            importedRows++;
            changedFields += stage.changed.length;
          }
          records.push({ row: stage.row, note, values, highlights });
        }
      }).catch(async error => {
        // Zotero marks errors raised after SQLite committed. The completed
        // writes are real, so keep the result and let the UI display them.
        if (error.committed) {
          this.Z.logError?.(error);
          return;
        }
        // SQLite rollback does not restore cached Item objects. New Items are
        // unloaded by Zotero's own rollback callback; reload existing notes and
        // parent childItems so later writes cannot persist phantom formatting.
        await this.recoverRolledBackWrites(touched);
        throw error;
      });
      return { records, importedRows, changedFields };
    }
    async paperSource(row, { mode = "indexed", maxChars = 60000, signal } = {}) {
      const checkCancelled = () => { if (signal?.aborted) throw new Error("已取消读取论文。"); };
      checkCancelled();
      const paper = await this.Z.Items.getAsync(row.id);
      if (!paper || paper.deleted || paper.key !== row.key || paper.libraryID !== row.libraryID) {
        throw new Error("文献已变化，请刷新后重试。");
      }
      await this.Z.Items.loadDataTypes([paper], ["itemData"]);
      const metadata = { title: row.title, authors: row.authors, year: row.year,
        abstract: paper.isRegularItem() ? this.htmlText(paper.getField("abstractNote") || "") : "" };
      let text = metadata.abstract;
      let label = "仅摘要";
      let warning = "";
      if (mode === "indexed") {
        let full = "";
        let partial = false;
        const attachment = row.attachmentID ? await this.Z.Items.getAsync(row.attachmentID) : null;
        if (attachment && !attachment.deleted && (attachment.id === paper.id || attachment.parentID === paper.id)) {
          const fulltext = this.Z.FullText || this.Z.Fulltext;
          try {
            const cache = fulltext?.getItemCacheFile(attachment);
            if (cache?.exists()) {
              // Avoid unbounded reads for unusually large indexed files.
              full = await this.Z.File.getContentsAsync(cache.path, "utf-8", 2000000);
              if (cache.fileSize > 2000000) warning = "索引文本较大，仅读取前 2 MB。";
              label = "Zotero 已索引文本（可能为部分原文）";
              if (fulltext.getIndexedState) {
                try { partial = await fulltext.getIndexedState(attachment) === fulltext.INDEX_STATE_PARTIAL; } catch (_) { /* keep conservative label */ }
              }
            }
          } catch (_) { warning = "索引暂不可读取，本次尝试使用本地 PDF 或摘要。"; }
          if ((!full?.trim() || partial) && attachment.attachmentContentType === "application/pdf" && this.Z.PDFWorker?.getFullText) {
            checkCancelled();
            try {
              const extracted = await this.Z.PDFWorker.getFullText(attachment.id, null);
              const extractedText = typeof extracted === "string" ? extracted : extracted?.text;
              if (extractedText?.trim()) { full = extractedText; label = "本地 PDF 提取文本"; warning = ""; }
            } catch (_) { warning = "PDF 提取未完成，本次仅使用可读取的索引或摘要。"; }
          }
        }
        checkCancelled();
        if (full?.trim()) text = full;
        else {
          label = "仅摘要（原文文本不可用）";
          warning = "未获取到可用原文；本次只能依据摘要，不能代表通读全文。扫描版 PDF 需先完成 OCR。";
        }
      }
      if (!text?.trim()) throw new Error("没有可用的原文文本或摘要，请先为文献添加可提取文字的 PDF 或补充摘要。");
      const limit = Math.max(1000, Math.min(300000, Number(maxChars) || 60000));
      const truncated = text.length > limit;
      if (truncated) {
        const marker = "\n[中间部分因长度限制省略]\n";
        const remaining = limit - marker.length;
        const head = Math.floor(remaining * 0.75);
        text = text.slice(0, head) + marker + text.slice(-(remaining - head));
        warning += `${warning ? " " : ""}文本超过上限，本次仅使用开头与结尾摘录。`;
      }
      checkCancelled();
      metadata.abstract = mode === "abstract" ? "" : metadata.abstract.slice(0, 6000);
      return { text, label, warning, truncated, chars: text.length, paper: metadata };
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
