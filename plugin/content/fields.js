/* ResearchGrid project fields and reusable templates. AGPL-3.0-or-later. */
(function (root) {
  "use strict";
  const C = root.PLMCore || (typeof require === "function" ? require("./core.js") : null);
  const MAX_FIELDS = 40;
  const MAX_STORED_FIELDS = 200;
  const REQUIREMENTS = {
    task_evidence: "说明研究任务、文献类型，以及它为当前项目提供哪类证据。",
    methods_sample: "记录研究设计、参与者或样本、实验条件与主要分析方法。",
    outcomes: "列出关注的观测指标、测量方法及关键结果。",
    findings: "概括核心发现；区分作者结论与自己的解释，必要时注明原文页码。",
    limitations: "记录研究局限、适用条件和仍需核实的问题。",
    relevance: "说明这篇文献如何支持、补充或挑战当前项目的研究问题。",
    remarks: "填写自己的想法、待办事项或需要回看原文的内容。",
  };
  let sequence = 0;
  function uniqueID(prefix = "custom_") {
    return prefix + (root.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${(++sequence).toString(36)}_${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, "_");
  }
  function defaults() {
    return C.FIELDS.map(f => ({ ...f, requirement: REQUIREMENTS[f.id] || "", archived: false, aliases: [] }));
  }
  function normalize(fields) {
    if (!Array.isArray(fields)) throw new Error("字段配置格式不正确。");
    if (fields.length > MAX_STORED_FIELDS) throw new Error(`字段记录过多，最多保留 ${MAX_STORED_FIELDS} 个字段。`);
    const ids = new Set();
    const owners = new Map();
    const reserved = new Map(C.FIELDS.map(f => [f.label, f.id]));
    const normalized = fields.map(f => {
      if (!f || typeof f !== "object" || typeof f.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,119}$/.test(f.id)
        || ["constructor", "prototype"].includes(f.id)) throw new Error("字段标识无效，请重新添加这个字段。");
      if (ids.has(f.id)) throw new Error("字段标识重复，请重新添加重复的字段。");
      ids.add(f.id);
      const label = typeof f.label === "string" ? f.label.trim() : "";
      if (!label) throw new Error("每个字段都需要填写名称。");
      if (label.length > 80) throw new Error("字段名称不能超过 80 个字符。");
      const requirement = typeof f.requirement === "string" ? f.requirement.trim() : "";
      if (requirement.length > 5000) throw new Error(`“${label}”的填写要求不能超过 5000 个字符。`);
      const aliases = [...new Set((Array.isArray(f.aliases) ? f.aliases : []).filter(a => typeof a === "string" && a.trim()).map(a => a.trim()))];
      if (aliases.some(a => a.length > 80)) throw new Error(`“${label}”的历史名称过长。`);
      for (const name of [label, ...aliases]) {
        if (reserved.has(name) && reserved.get(name) !== f.id) throw new Error(`“${name}”是原有字段名称，请使用原字段或换一个名称。`);
        if (owners.has(name) && owners.get(name) !== f.id) throw new Error(`字段名称或历史名称“${name}”重复，请换一个名称。`);
        owners.set(name, f.id);
      }
      return { id: f.id, label, requirement, visible: !f.archived && f.visible !== false, archived: !!f.archived, aliases };
    });
    const active = normalized.filter(f => !f.archived);
    if (!active.length) throw new Error("至少保留一个项目字段。");
    if (active.length > MAX_FIELDS) throw new Error(`一个项目最多使用 ${MAX_FIELDS} 个字段。`);
    if (!active.some(f => f.visible)) throw new Error("至少显示一个项目字段。");
    return normalized;
  }
  function builtins() {
    const base = defaults();
    const byID = id => ({ ...base.find(f => f.id === id), visible: true, aliases: [] });
    return [
      { id: "general", name: "通用文献分析", fields: base },
      { id: "empirical", name: "实证研究", fields: [
        { id: "research_question", label: "研究问题与假设", requirement: "记录作者的研究问题、主要假设，以及与当前项目的对应关系。", visible: true, archived: false, aliases: [] },
        byID("methods_sample"), byID("outcomes"), byID("findings"), byID("limitations"), byID("relevance"), byID("remarks"),
      ] },
      { id: "theory_review", name: "理论与综述", fields: [
        { id: "theory_framework", label: "理论框架与概念", requirement: "说明核心理论、概念定义及它们之间的关系。", visible: true, archived: false, aliases: [] },
        byID("task_evidence"),
        { id: "review_scope", label: "文献范围与研究脉络", requirement: "记录综述覆盖范围、纳入标准、研究分支和主要争议。", visible: true, archived: false, aliases: [] },
        byID("findings"), byID("limitations"), byID("relevance"), byID("remarks"),
      ] },
    ].map(t => ({ ...t, fields: normalize(t.fields) }));
  }
  function applyTemplate(existing, templateFields) {
    const current = normalize(existing);
    const incoming = normalize(templateFields).filter(f => !f.archived);
    const used = new Set();
    const applied = incoming.map(field => {
      const previous = current.find(f => f.id === field.id) || current.find(f => f.label === field.label && !used.has(f.id));
      const id = previous?.id || field.id;
      if (used.has(id)) throw new Error("模板含重复字段，无法应用。");
      used.add(id);
      const aliases = [...new Set([...(previous?.aliases || []), ...(field.aliases || []),
        ...(previous && previous.label !== field.label ? [previous.label] : [])])];
      return { ...field, id, aliases, archived: false };
    });
    return normalize([...applied, ...current.filter(f => !used.has(f.id)).map(f => ({ ...f, archived: true, visible: false }))]);
  }

  class Manager {
    constructor(options) {
      this.options = options;
      this.document = options.document;
      this.dialog = null;
      this.busy = false;
      this.draft = [];
    }
    el(tag, attrs = {}, ...children) {
      const el = this.document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
        else if (key === "value") el.value = value;
        else if (key === "checked" || key === "disabled") el[key] = !!value;
        else el.setAttribute(key, value === true ? "" : String(value));
      }
      for (const child of children.flat()) if (child != null) el.append(typeof child === "string" ? this.document.createTextNode(child) : child);
      return el;
    }
    async open() {
      if (this.dialog?.open) { this.dialog.focus(); return; }
      if (this.options.beforeOpen && !await this.options.beforeOpen()) return;
      const project = this.options.getProject();
      if (!project) { this.options.notify?.("请先选择一个研究项目。"); return; }
      this.project = { id: project.id, name: project.name };
      this.draft = normalize(this.options.getFields());
      this.initial = JSON.stringify(this.draft);
      this.errorText = "";
      this.ensureDialog();
      this.render();
      this.dialog.showModal();
    }
    ensureDialog() {
      if (this.dialog) return;
      this.dialog = this.el("dialog", { id: "fieldManagerDialog", "aria-labelledby": "rg-fields-title" });
      this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
      this.document.body.append(this.dialog);
    }
    dirty() { return JSON.stringify(this.draft) !== this.initial; }
    close(force = false) {
      if (this.busy) return false;
      if (!force && this.dirty() && !this.document.defaultView.confirm("放弃尚未保存的项目字段修改？")) return false;
      this.dialog.close();
      return true;
    }
    fail(error) {
      this.errorText = error.message || String(error);
      if (this.errorNode) this.errorNode.textContent = this.errorText;
    }
    allTemplates() {
      return [...builtins().map(t => ({ ...t, optionID: `builtin:${t.id}`, builtin: true })),
        ...this.options.getTemplates().map(t => ({ ...t, optionID: `custom:${t.id}`, builtin: false }))];
    }
    render() {
      const active = this.draft.filter(f => !f.archived);
      const archived = this.draft.filter(f => f.archived);
      const templates = this.allTemplates();
      this.templateSelect = this.el("select", { id: "rg-template-select", "aria-label": "通用字段模板" });
      this.templateSelect.append(this.el("option", { value: "" }, "选择通用字段模板"),
        ...templates.map(t => this.el("option", { value: t.optionID }, `${t.builtin ? "内置" : "我的模板"} · ${t.name}`)));
      const templateControls = this.el("section", { class: "rg-fields-templates" },
        this.el("h3", {}, "通用字段模板"),
        this.el("p", { class: "rg-fields-hint" }, "应用模板会生成当前项目的独立副本，保存后生效。未包含的原字段会移入下方“已移出字段”。"),
        this.el("div", { class: "rg-fields-row" }, this.templateSelect,
          this.el("button", { type: "button", onclick: () => this.loadTemplate() }, "应用到项目草稿"),
          this.el("button", { type: "button", onclick: () => this.deleteTemplate() }, "删除我的模板")));
      this.templateName = this.el("input", { id: "rg-template-name", type: "text", maxlength: "80", placeholder: "模板名称", "aria-label": "新模板名称" });
      templateControls.append(this.el("div", { class: "rg-fields-row" }, this.templateName,
        this.el("button", { type: "button", onclick: () => this.saveTemplate() }, "另存为通用模板")));
      const list = this.el("div", { class: "rg-fields-list" }, ...active.map((field, index) => this.fieldCard(field, index, active.length)));
      this.errorNode = this.el("p", { class: "rg-fields-error", role: "alert", id: "rg-fields-error" }, this.errorText);
      this.dialog.replaceChildren(...[
        this.el("div", { class: "rg-fields-heading" }, this.el("h2", { id: "rg-fields-title" }, "项目字段"),
          this.el("button", { type: "button", class: "rg-fields-close", "aria-label": "关闭项目字段", onclick: () => this.close() }, "×")),
        this.el("p", { class: "rg-fields-project" }, this.project.name),
        this.el("p", { class: "rg-fields-hint" }, "字段名称、填写要求、顺序和显示状态只用于当前项目。字段配置与通用模板保存在本机；已填写的分析仍保存在 Zotero 项目笔记。"),
        templateControls,
        this.el("div", { class: "rg-fields-heading" }, this.el("h3", {}, `当前项目字段（${active.length} / ${MAX_FIELDS}）`),
          this.el("button", { type: "button", id: "rg-add-field", onclick: () => this.addField() }, "添加字段")), list,
        archived.length ? this.el("section", { class: "rg-fields-archived" }, this.el("h3", {}, "已移出字段"),
          this.el("p", { class: "rg-fields-hint" }, "移出不会删除笔记中的历史内容。恢复后可继续查看和编辑。"),
          ...archived.map(field => this.el("div", { class: "rg-fields-row", "data-archived-field-id": field.id },
            this.el("span", {}, field.label), this.el("button", { type: "button", onclick: () => { field.archived = false; field.visible = true; this.render(); } }, "恢复字段")))) : null,
        this.errorNode,
        this.el("div", { class: "rg-fields-footer" },
          this.el("button", { type: "button", onclick: () => this.close() }, "取消"),
          this.el("button", { type: "button", class: "primary", id: "rg-save-fields", onclick: () => this.save() }, "保存项目字段"))].filter(child => child != null));
    }
    fieldCard(field, index, length) {
      const name = this.el("input", { type: "text", value: field.label, maxlength: "80", "aria-label": `字段名称：${field.label}`,
        oninput: event => { field.label = event.target.value; } });
      const requirement = this.el("textarea", { rows: "2", maxlength: "5000", "aria-label": `填写要求：${field.label}`,
        placeholder: "希望这个项目在此字段记录什么？例如：记录实验条件、指标定义及原文页码。",
        oninput: event => { field.requirement = event.target.value; } });
      requirement.value = field.requirement;
      const move = offset => {
        const other = this.draft.filter(f => !f.archived)[index + offset];
        if (!other) return;
        const a = this.draft.indexOf(field), b = this.draft.indexOf(other);
        [this.draft[a], this.draft[b]] = [this.draft[b], this.draft[a]];
        this.render();
      };
      return this.el("article", { class: "rg-fields-card", "data-field-id": field.id },
        this.el("div", { class: "rg-fields-row" }, this.el("label", { class: "rg-fields-name" }, this.el("span", {}, "字段名称"), name),
          this.el("label", { class: "rg-fields-check" }, this.el("input", { type: "checkbox", checked: field.visible,
            onchange: event => { field.visible = event.target.checked; } }), "显示"),
          this.el("button", { type: "button", disabled: index === 0, "aria-label": `上移字段：${field.label}`, onclick: () => move(-1) }, "↑"),
          this.el("button", { type: "button", disabled: index === length - 1, "aria-label": `下移字段：${field.label}`, onclick: () => move(1) }, "↓"),
          this.el("button", { type: "button", onclick: () => { field.archived = true; field.visible = false; this.render(); } }, "移出项目")),
        this.el("label", { class: "rg-fields-requirement" }, this.el("span", {}, "填写要求"), requirement));
    }
    addField() {
      if (this.draft.filter(f => !f.archived).length >= MAX_FIELDS) { this.fail(new Error(`一个项目最多使用 ${MAX_FIELDS} 个字段。`)); return; }
      let label = "新字段", suffix = 2;
      while (this.draft.some(f => f.label === label)) label = `新字段 ${suffix++}`;
      this.draft.push({ id: uniqueID(), label, requirement: "", visible: true, archived: false, aliases: [] });
      this.render();
      this.dialog.querySelector('.rg-fields-card:last-child input[type="text"]')?.focus();
    }
    preparedFields() {
      const previous = this.options.getFields();
      return normalize(this.draft.map(field => {
        const old = previous.find(f => f.id === field.id);
        return { ...field, aliases: [...new Set([...(field.aliases || []), ...(old?.aliases || []),
          ...(old && old.label !== field.label.trim() ? [old.label] : [])])] };
      }));
    }
    loadTemplate() {
      if (this.busy) return;
      const selected = this.allTemplates().find(t => t.optionID === this.templateSelect.value);
      if (!selected) { this.fail(new Error("请先选择一个通用字段模板。")); return; }
      try {
        this.draft = applyTemplate(this.preparedFields(), selected.fields);
        this.errorText = "";
        this.render();
        this.options.notify?.("模板已应用到项目草稿，点击“保存项目字段”后生效。");
      } catch (e) { this.fail(e); }
    }
    setBusy(value) {
      if (this.busy === value) return;
      this.busy = value;
      for (const control of this.dialog.querySelectorAll("button,input,select,textarea")) {
        if (value) {
          control.dataset.rgDisabled = control.disabled ? "1" : "0";
          control.disabled = true;
        } else {
          control.disabled = control.dataset.rgDisabled === "1";
          delete control.dataset.rgDisabled;
        }
      }
    }
    async save() {
      if (this.busy) return;
      try {
        if (this.options.getProject()?.id !== this.project.id) throw new Error("当前项目已经变化，请关闭窗口后重新打开项目字段。");
        const fields = this.preparedFields();
        this.setBusy(true);
        await this.options.saveFields(fields);
        this.initial = JSON.stringify(fields);
        this.draft = fields;
        this.setBusy(false);
        this.close(true);
        this.options.notify?.("已保存当前项目的字段。");
      } catch (e) { this.setBusy(false); this.fail(e); }
    }
    async saveTemplate() {
      if (this.busy) return;
      try {
        const name = this.templateName.value.trim();
        if (!name) throw new Error("请填写模板名称。");
        const templates = this.options.getTemplates();
        if (templates.some(t => t.name === name)) throw new Error("已有同名模板，请换一个名称。");
        if (templates.length >= 50) throw new Error("最多保存 50 个通用模板，请先删除不再使用的模板。");
        const template = { id: uniqueID("template_"), name, fields: normalize(this.preparedFields().filter(f => !f.archived)) };
        this.setBusy(true);
        await this.options.saveTemplates([...templates, template]);
        this.setBusy(false);
        this.errorText = "";
        this.render();
        this.options.notify?.("已保存为通用模板，其他项目可以应用；当前项目字段尚需单独保存。");
      } catch (e) { this.setBusy(false); this.fail(e); }
    }
    async deleteTemplate() {
      if (this.busy) return;
      try {
        const selected = this.allTemplates().find(t => t.optionID === this.templateSelect.value);
        if (!selected || selected.builtin) throw new Error("请选择一个“我的模板”；内置模板会保留。");
        if (!this.document.defaultView.confirm(`删除通用模板“${selected.name}”？已经应用到项目的字段不会改变。`)) return;
        this.setBusy(true);
        await this.options.saveTemplates(this.options.getTemplates().filter(t => t.id !== selected.id));
        this.setBusy(false);
        this.errorText = "";
        this.render();
        this.options.notify?.("已删除通用模板，已应用的项目保持原样。");
      } catch (e) { this.setBusy(false); this.fail(e); }
    }
  }
  const api = { MAX_FIELDS, defaults, normalize, builtins, applyTemplate, Manager };
  root.RGFields = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
