/* ResearchGrid delimited-table exchange. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const C = root.PLMCore || (typeof require === "function" ? require("./core.js") : null);
  const LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, records: 10000, columns: 100, cellChars: 200000 });
  const HEADERS = ["记录类型", "项目", "项目标识", "文献标识", "文献Key", "文献链接", "标题", "作者", "年份", "引用键"];
  const META = new Set(["recordType", "projectID", "itemURL", "itemKey", "title", "citekey"]);
  const FIELD_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,119}$/;
  const norm = value => String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  const headerNorm = value => norm(value).replace(/[\s_-]+/g, "");
  const META_LABELS = new Map();
  function names(type, aliases) { for (const label of aliases) META_LABELS.set(headerNorm(label), "meta:" + type); }
  names("recordType", ["记录类型", "record type", "recordType", "row type"]);
  names("projectID", ["项目标识", "项目ID", "project id", "project key", "projectID"]);
  names("itemURL", ["文献标识", "文献链接", "条目链接", "Zotero链接", "itemURL", "item URI", "Zotero URL", "Zotero URI"]);
  names("itemKey", ["文献Key", "文献键", "条目Key", "条目键", "Zotero Key", "itemKey", "item key"]);
  names("title", ["标题", "题名", "论文标题", "论文名称", "文献标题", "文献名称", "title", "paper title", "article title", "论文", "文献"]);
  names("citekey", ["引用键", "citekey", "citation key", "citationKey", "BibTeX key"]);
  const KNOWN_IGNORED = new Set(["项目", "项目名", "project", "project name", "作者", "authors", "author", "年份", "year", "标签", "tags", "批注数量", "annotation count", "项目笔记链接", "note link", "原文链接", "pdf link", "doi", "url", "序号", "编号"].map(headerNorm));
  function error(message) { throw new Error(message); }
  function activeFields(fields) {
    if (!Array.isArray(fields)) error("项目字段配置无效。");
    const active = fields.filter(field => field && !field.archived);
    const ids = new Set();
    for (const field of active) {
      if (!FIELD_ID.test(field.id) || ["constructor", "prototype"].includes(field.id) || ids.has(field.id)) error("项目字段标识无效或重复。");
      ids.add(field.id);
      if (typeof field.label !== "string" || !field.label.trim()) error("项目字段名称无效。");
    }
    return active;
  }
  function csvCell(value) {
    let text = String(value ?? "");
    // Quoting does not neutralize formulas when a table is opened in a spreadsheet.
    if (/^[\s\uFEFF]*[=+@-]/u.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function projectLibrary(project) {
    if (project.library?.libraryType === "group") return `groups/${project.library.groupID}`;
    const group = String(project.id || "").match(/^group:(\d+):collection:/);
    return group ? `groups/${group[1]}` : "library";
  }
  function itemURL(row, project) {
    return row.itemURL || (row.key ? `zotero://select/${projectLibrary(project)}/items/${row.key}` : "");
  }
  function exportTemplate(rows, project, fields, { delimiter = "," } = {}) {
    if (![",", "\t"].includes(delimiter)) error("只支持 CSV 或 TSV 分隔符。");
    if (!project?.id || !Array.isArray(rows)) error("请先选择研究项目和文献。");
    const active = activeFields(fields);
    if (rows.length >= LIMITS.records) error(`一次模板最多导出 ${LIMITS.records - 1} 篇文献，请按搜索条件拆分。`);
    if (active.length + HEADERS.length > LIMITS.columns) error("项目字段过多，无法导出表格模板。");
    const header = [...HEADERS, ...active.map(field => `${field.label} [${field.id}]`)];
    const instructions = ["填写要求", project.name || "", project.id, "", "", "", "请保留文献标识和字段标识，仅填写右侧分析字段。", "", "", "", ...active.map(field => field.requirement || "")];
    const data = rows.map(row => ["文献", project.name || "", project.id, itemURL(row, project), row.key || "", itemURL(row, project),
      row.title || "", row.authors || "", row.year || "", row.citekey || "", ...active.map(() => "")]);
    return "\uFEFF" + [header, instructions, ...data].map(record => record.map(csvCell).join(delimiter)).join("\r\n") + "\r\n";
  }
  function checkSize(text) {
    if (text.length > LIMITS.bytes) error("表格超过 10 MB，请拆分后导入。");
    let bytes = 0;
    for (const char of text) {
      const point = char.codePointAt(0);
      bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
      if (bytes > LIMITS.bytes) error("表格超过 10 MB，请拆分后导入。");
    }
    if (text.includes("\u0000")) error("表格包含空字符，请使用 UTF-8 编码的 CSV/TSV 文件。");
  }
  function detectDelimiter(text) {
    let quotes = false, commas = 0, tabs = 0;
    for (let index = 0; index < text.length; index++) {
      const ch = text[index];
      if (ch === '"') {
        if (quotes && text[index + 1] === '"') { index++; continue; }
        quotes = !quotes;
      } else if (!quotes) {
        if (ch === "\r" || ch === "\n") break;
        if (ch === ",") commas++;
        if (ch === "\t") tabs++;
      }
    }
    return tabs > commas ? "\t" : ",";
  }
  function parse(input, { delimiter } = {}) {
    if (typeof input !== "string") error("请提供 CSV 或 TSV 文本。");
    checkSize(input);
    let text = input.replace(/^\uFEFF/, ""), lineOffset = 0;
    const fenced = text.match(/^\s*```(?:csv|tsv|text)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t\r\n]*$/i);
    if (fenced) { lineOffset = text.slice(0, text.indexOf(fenced[1])).split(/\r\n|\r|\n/).length - 1; text = fenced[1]; }
    if (!text.trim()) error("表格为空，请选择文件或粘贴已填写的 CSV/TSV。");
    delimiter ??= detectDelimiter(text);
    if (![",", "\t"].includes(delimiter)) error("只支持 CSV 或 TSV 分隔符。");
    const raw = [];
    let cells = [], value = "", quoted = false, closed = false, line = 1 + lineOffset, startLine = line;
    const finishCell = () => {
      if (value.length > LIMITS.cellChars) error(`第 ${startLine} 行有单元格超过 ${LIMITS.cellChars} 字符，请缩短后导入。`);
      cells.push(value); value = ""; closed = false;
      if (cells.length > LIMITS.columns) error(`表格列数超过 ${LIMITS.columns} 列。`);
    };
    const finishRow = () => {
      finishCell();
      if (cells.some(cell => cell.trim())) raw.push({ line: startLine, cells });
      cells = [];
      if (raw.length > LIMITS.records + 1) error(`表格超过 ${LIMITS.records} 行，请拆分后导入。`);
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { value += '"'; i++; }
          else { quoted = false; closed = true; }
        } else if (ch === "\r" || ch === "\n") {
          if (ch === "\r" && text[i + 1] === "\n") i++;
          value += "\n"; line++;
        } else value += ch;
      } else if (ch === delimiter) finishCell();
      else if (ch === "\r" || ch === "\n") {
        finishRow();
        if (ch === "\r" && text[i + 1] === "\n") i++;
        line++; startLine = line;
      } else if (closed) error(`第 ${line} 行引号结束后存在多余字符，请检查分隔符或引号。`);
      else if (ch === '"') {
        if (value) error(`第 ${line} 行存在未正确转义的引号。`);
        quoted = true;
      } else value += ch;
    }
    if (quoted) error(`第 ${startLine} 行开始的引号没有结束。`);
    if (value || cells.length || closed) finishRow();
    if (!raw.length) error("没有可读取的表头。");
    const header = raw.shift();
    const headers = header.cells.map(value => value.trim());
    const seen = new Set();
    for (let i = 0; i < headers.length; i++) {
      if (!headers[i]) error(`第 ${i + 1} 列表头为空，请填写列名或删除空列。`);
      const key = norm(headers[i]);
      if (seen.has(key)) error(`表头“${headers[i]}”重复，请为每列提供不同的名称。`);
      seen.add(key);
    }
    for (const record of raw) if (record.cells.length !== headers.length) {
      error(`第 ${record.line} 行有 ${record.cells.length} 列，表头为 ${headers.length} 列；请检查逗号、制表符或多行引号。`);
    }
    return { headers, records: raw, delimiter };
  }
  function explicitID(header) {
    const suffix = header.match(/\[([a-zA-Z][a-zA-Z0-9_-]{0,119})\]\s*$/);
    return suffix?.[1] || null;
  }
  function candidates(header, fields) {
    const original = C?.FIELDS?.find(field => norm(field.label) === norm(header));
    if (original) return fields.filter(field => field.id === original.id);
    return fields.filter(field => [field.label, ...(field.aliases || [])].some(label => norm(label) === norm(header)));
  }
  function inferMappings(headers, fields) {
    const active = activeFields(fields);
    return headers.map(header => {
      if (/\[zotero:[a-zA-Z][a-zA-Z0-9_-]*\]\s*$/.test(header)) return "ignore";
      const explicit = explicitID(header);
      if (explicit) return active.some(field => field.id === explicit) ? "field:" + explicit : "ignore";
      if (active.some(field => field.id === header.trim())) return "field:" + header.trim();
      const meta = META_LABELS.get(headerNorm(header));
      if (meta) return meta;
      const found = candidates(header, active);
      return found.length === 1 ? "field:" + found[0].id : "ignore";
    });
  }
  function canonicalURL(value) {
    const match = String(value || "").trim().match(/^zotero:\/\/select\/(library|groups\/[1-9]\d*)\/items\/([a-z0-9]{8})$/i);
    return match ? `zotero://select/${match[1].toLowerCase()}/items/${match[2].toUpperCase()}` : null;
  }
  function addIndex(index, key, row) {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  function buildPlan(table, { project, fields, rows, mappings, overwrite = false, clearBlanks = false } = {}) {
    if (!project?.id || !Array.isArray(rows)) error("请先选择当前研究项目。");
    if (!table || !Array.isArray(table.headers) || !Array.isArray(table.records)) error("表格格式无效，请重新选择文件或粘贴文本。");
    const active = activeFields(fields), byField = new Map(active.map(field => [field.id, field]));
    const chosen = mappings ? [...mappings] : inferMappings(table.headers, active);
    if (chosen.length !== table.headers.length) error("列映射数量与表头不一致。");
    const fieldColumns = [], metaColumns = new Map(), fieldOwners = new Set(), warnings = [];
    chosen.forEach((mapping, index) => {
      if (mapping === "ignore") return;
      if (typeof mapping !== "string") error("表格列映射无效。");
      if (mapping.startsWith("field:")) {
        const id = mapping.slice(6);
        if (!byField.has(id)) error("列映射包含当前项目不可用或已移出的字段。");
        if (fieldOwners.has(id)) error(`多列表格同时对应“${byField.get(id).label}”，请调整列映射后重试。`);
        fieldOwners.add(id); fieldColumns.push({ index, id });
      } else if (mapping.startsWith("meta:") && META.has(mapping.slice(5))) {
        const type = mapping.slice(5);
        if (!metaColumns.has(type)) metaColumns.set(type, []);
        metaColumns.get(type).push(index);
      } else error("表格列映射无效。");
    });
    const ignored = table.headers.filter((header, index) => chosen[index] === "ignore" && !KNOWN_IGNORED.has(headerNorm(header))
      && !/\[zotero:[a-zA-Z][a-zA-Z0-9_-]*\]\s*$/.test(header));
    for (const header of ignored) if (candidates(header, active).length > 1) warnings.push(`列“${header}”可能对应多个字段，已忽略，请手动指定列映射。`);
    if (ignored.length) warnings.push(`未映射的列不会导入：${ignored.slice(0, 8).join("、")}${ignored.length > 8 ? ` 等 ${ignored.length} 列` : ""}。`);
    if (!fieldColumns.length) warnings.push("没有映射到当前项目分析字段，请先调整列映射。");
    if (clearBlanks && !overwrite) warnings.push("清空空白单元格需要同时允许覆盖已有内容；当前仍保留原值。");
    const urlIndex = new Map(), keyIndex = new Map(), citeIndex = new Map(), titleIndex = new Map();
    for (const row of rows) {
      addIndex(urlIndex, canonicalURL(itemURL(row, project)), row);
      addIndex(keyIndex, String(row.key || "").trim().toUpperCase(), row);
      addIndex(citeIndex, String(row.citekey || "").trim(), row);
      addIndex(titleIndex, norm(row.title), row);
    }
    const output = [];
    const getMeta = (record, type) => {
      const values = [...new Set((metaColumns.get(type) || []).map(i => record.cells[i].trim()).filter(Boolean))];
      const normal = type === "itemURL" ? values.map(canonicalURL) : type === "itemKey" ? values.map(v => v.toUpperCase()) : values;
      if (values.length > 1 && new Set(normal).size > 1) error("同一行提供了互相冲突的文献或项目标识。");
      return values[0] || "";
    };
    for (const record of table.records) {
      const result = { line: record.line, status: "skip", message: "", changes: {}, expected: {}, expectedHighlights: {}, protectedFields: [], matchBy: "", target: null };
      output.push(result);
      try {
        if (!Array.isArray(record.cells) || record.cells.length !== table.headers.length || record.cells.some(cell => typeof cell !== "string")) error("此行单元格格式无效。");
        const type = norm(getMeta(record, "recordType"));
        if (["填写要求", "填写说明", "说明", "instructions", "requirements", "requirement"].includes(type)) {
          result.message = "填写要求行，仅作说明，不导入。"; continue;
        }
        if (type && !["文献", "论文", "paper", "article", "item", "data"].includes(type)) error("记录类型不是文献行，请检查表格。");
        const projectID = getMeta(record, "projectID");
        if (projectID && projectID !== project.id) error("项目标识与当前项目不同，已阻止导入。请切换到对应项目。");
        const url = getMeta(record, "itemURL"), key = getMeta(record, "itemKey").toUpperCase();
        const citekey = getMeta(record, "citekey"), title = getMeta(record, "title");
        result.sourceTitle = title;
        let matches;
        if (url) {
          const canonical = canonicalURL(url);
          if (!canonical) error("文献标识不是有效的 Zotero 条目链接，未使用标题回退。请核对或调整列映射。");
          if (key && canonical.split("/").pop() !== key) error("文献链接与文献 Key 不一致，已阻止此行导入。");
          matches = urlIndex.get(canonical); result.matchBy = "itemURL";
          if (!matches?.length) error("文献标识不属于当前项目文献，未使用标题回退。");
        } else if (key) {
          matches = keyIndex.get(key); result.matchBy = "itemKey";
          if (!matches?.length) error("文献 Key 不属于当前项目文献，未使用标题回退。");
        } else if (citekey) {
          matches = citeIndex.get(citekey); result.matchBy = "citekey";
          if (!matches?.length) error("引用键在当前项目中没有匹配，未使用标题回退。");
        } else if (title) {
          matches = titleIndex.get(norm(title)); result.matchBy = "title";
          if (!matches?.length) error("标题与当前项目文献没有完全匹配。");
        } else error("缺少文献链接、文献 Key、引用键或唯一标题，无法匹配文献。");
        if (matches.length !== 1) error("当前标识匹配到多篇文献，无法唯一确定，请使用文献链接。");
        const target = result.target = matches[0];
        const changes = [], expected = [], expectedHighlights = [];
        for (const { index, id } of fieldColumns) {
          const incoming = record.cells[index];
          const old = Object.prototype.hasOwnProperty.call(target.values || {}, id) ? String(target.values[id] ?? "") : "";
          if (!incoming.trim() && !(clearBlanks && overwrite && old.trim())) { continue; }
          const value = incoming.trim() ? incoming : "";
          if (value.trim() === old.trim()) { continue; }
          if (old.trim() && !overwrite) { result.protectedFields.push(id); continue; }
          changes.push([id, value]); expected.push([id, old]);
          expectedHighlights.push([id, C.normalizeHighlights(old, target.highlights?.[id] || [])]);
        }
        result.changes = Object.fromEntries(changes); result.expected = Object.fromEntries(expected);
        result.expectedHighlights = Object.fromEntries(expectedHighlights);
        if (!changes.length) {
          result.message = result.protectedFields.length ? `已有 ${result.protectedFields.length} 个字段受到保护，未覆盖。` : "没有需要写入的内容（空白或与原值相同）。";
          continue;
        }
        if (target.editable === false) error("此文献或项目笔记当前不可编辑，已阻止导入。");
        result.status = "ready";
        const method = { itemURL: "文献标识", itemKey: "文献 Key", citekey: "唯一引用键", title: "唯一标题" }[result.matchBy];
        result.message = `按${method}匹配，准备写入 ${changes.length} 个字段。`;
        if (title && norm(title) !== norm(target.title)) result.message += " 表格标题与当前条目不同，请核对。";
        if (result.protectedFields.length) result.message += ` 已有 ${result.protectedFields.length} 个字段保留原值。`;
      } catch (e) {
        result.status = "error"; result.message = e.message;
        result.changes = {}; result.expected = {}; result.expectedHighlights = {};
      }
    }
    // Duplicate paper rows are never applied in file order: neither wins silently.
    const targets = new Map();
    for (const result of output) if (result.target) {
      const id = result.target.id ?? itemURL(result.target, project);
      if (!targets.has(id)) targets.set(id, []);
      targets.get(id).push(result);
    }
    for (const same of targets.values()) if (same.length > 1) for (const result of same) {
      result.status = "error"; result.message = "表格中有多行对应同一文献，请合并后重新导入。";
      result.changes = {}; result.expected = {}; result.expectedHighlights = {};
    }
    if (output.some(result => result.matchBy === "title" && result.target)) warnings.push("部分行仅按唯一标题匹配，请在写入前核对文献。优先保留模板中的文献标识。");
    const stats = { total: output.length, ready: 0, skip: 0, error: 0, changes: 0 };
    for (const result of output) { stats[result.status]++; stats.changes += Object.keys(result.changes).length; }
    return { rows: output, mappings: chosen, warnings, stats };
  }
  const api = { LIMITS, exportTemplate, parse, inferMappings, buildPlan };
  root.RGTable = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
