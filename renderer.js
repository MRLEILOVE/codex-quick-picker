window.codexPlus.extension((ctx) => {
  const shared = { activePicker: undefined, savedCarets: new WeakMap() };
  registerQuickPicker(ctx, shared, "mcp");
  registerQuickPicker(ctx, shared, "skill");
});

function registerQuickPicker(ctx, shared, kind) {
  const isSkill = kind === "skill";
  const catalogLabel = isSkill ? "Skill" : "MCP";
  const itemLabel = isSkill ? "技能" : "服务";
  const trigger = isSkill ? "~" : "#";
  const composerSelector = "[data-codex-composer-root]";
  const editorSelector = '[data-codex-composer][contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]';
  const searchKeywords = {
    cubed_sugar: "方糖",
    ai_accompany: "AI陪伴",
    kuaige: "快歌",
    xiaoyuan: "小元",
    mysql: "数据库",
    prod: "生产",
    test: "测试",
    tls: "日志",
    sls: "日志",
    api_kit: "APIKit Eolink 接口",
    yunxiao: "云效"
  };
  const aliasStorageKey = `${kind}Aliases`;
  const pinStorageKey = isSkill ? "pinnedSkills" : "pinnedMcps";
  const recentUseStorageKey = `${kind}LastUsed`;
  const groupStorageKey = `${kind}Groups`;
  const groupOrderKey = `${kind}GroupTabOrder`;
  const templateStorageKey = `${kind}InsertionTemplate`;
  const defaultInsertionTemplate = isSkill ? "$" + "{{skill}} " : "{{mcp}} ";
  const ungrouped = "ungrouped";
  const savedCarets = shared.savedCarets;
  let pendingCatalog;

  // 合并同一对话并发请求，完成后交给后台按配置变化判断是否刷新。
  function listServers() {
    const sessionId = ctx.currentSessionId();
    if (pendingCatalog?.sessionId === sessionId) {
      return pendingCatalog.result;
    }
    const request = { sessionId };
    pendingCatalog = request;
    request.result = ctx.backend.call("listEnabled", { sessionId, kind }).finally(() => {
      if (pendingCatalog === request) {
        pendingCatalog = undefined;
      }
    });
    return request.result;
  }

  function loadAliases() {
    return new Map(Object.entries(ctx.storage.get(aliasStorageKey, {}) ?? {}));
  }

  function loadInsertionTemplate() {
    const template = ctx.storage.get(templateStorageKey, defaultInsertionTemplate);
    return typeof template === "string" && template.trim() ? template : defaultInsertionTemplate;
  }

  function applyInsertionTemplate(template, name, alias) {
    return template.replace(/\{\{\s*(mcp|skill|alias)\s*\}\}/g, (token, key) => {
      if (key === "alias") {
        return alias || name;
      }
      return key === kind ? name : token;
    });
  }

  function loadPins() {
    const names = ctx.storage.get(pinStorageKey, []);
    return new Set(Array.isArray(names) ? names : []);
  }

  function loadRecentUses() {
    return new Map(Object.entries(ctx.storage.get(recentUseStorageKey, {}) ?? {}));
  }

  function loadGroups() {
    const groups = ctx.storage.get(groupStorageKey, []);
    return Array.isArray(groups) ? groups : [];
  }

  function orderGroups(groups) {
    const items = new Map(groups.map((group) => [group.id, group]));
    items.set(ungrouped, { id: ungrouped, name: "未分组" });
    const saved = ctx.storage.get(groupOrderKey, []);
    const ids = new Set(Array.isArray(saved) ? saved : []);
    for (const id of items.keys()) {
      ids.add(id);
    }
    // 安装旧版时没有顺序记录，按已有分组顺序显示；已移除的分组不再占位。
    return [...ids].filter((id) => items.has(id)).map((id) => items.get(id));
  }

  function filterGroup(names, groupId, groups) {
    if (!groupId) {
      return names;
    }
    if (groupId === ungrouped) {
      const assigned = new Set(groups.flatMap((group) => group.services));
      return names.filter((name) => !assigned.has(name));
    }
    const members = new Set(groups.find((group) => group.id === groupId)?.services);
    return names.filter((name) => members.has(name));
  }

  function searchServers(names, query, customAliases) {
    const terms = query.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean);
    return names.filter((name) => {
      const key = name.toLowerCase().replace(/-/g, "_");
      const words = Object.entries(searchKeywords)
        .filter(([part]) => (`_${key}_`).includes(`_${part}_`))
        .map(([, label]) => label);
      const searchable = [name, key, customAliases.get(name), ...words, words.join("")]
        .join(" ").normalize("NFKC").toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }

  function currentCaret(editor) {
    const selection = document.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.focusNode)) {
      return null;
    }
    const caret = document.createRange();
    caret.setStart(selection.focusNode, selection.focusOffset);
    caret.collapse(true);
    return caret;
  }

  if (!isSkill) {
    ctx.listen(document, "selectionchange", () => {
      const node = document.getSelection()?.focusNode;
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const editor = element?.closest(editorSelector);
      if (editor?.closest(composerSelector)) {
        const caret = currentCaret(editor);
        if (caret) {
          savedCarets.set(editor, caret);
        }
      }
    });
    const prefetchForEditor = (element) => {
      if (element?.matches?.(editorSelector) && element.closest(composerSelector)) {
        void listServers().catch(() => {});
      }
    };
    ctx.listen(document, "focusin", (event) => prefetchForEditor(event.target));
    prefetchForEditor(document.activeElement);
  }

  function focusRange(editor, range) {
    editor.focus();
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insertIntoDraft(editor, caret, text, useDefaultSpacing) {
    const range = caret && editor.contains(caret.startContainer) ? caret : document.createRange();
    if (range !== caret) {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    let prefix = "";
    if (useDefaultSpacing) {
      const before = range.cloneRange();
      before.setStart(editor, 0);
      prefix = /\S$/.test(before.toString()) ? " " : "";
    }
    focusRange(editor, range);
    // 复用 Chromium 编辑命令，让 Codex 编辑器同步草稿并保留撤销记录。
    return document.execCommand("insertText", false, prefix + text);
  }

  function dismissPicker(restoreCaret = false) {
    const picker = shared.activePicker;
    shared.activePicker = undefined;
    if (!picker) {
      return;
    }
    picker.dialog.close();
    picker.dialog.remove();
    if (restoreCaret && picker.editor.isConnected && ctx.currentSessionId() === picker.sessionId) {
      const caret = picker.range?.cloneRange();
      if (caret && picker.editor.contains(caret.endContainer)) {
        caret.collapse(false);
        focusRange(picker.editor, caret);
      } else {
        picker.editor.focus();
      }
    }
  }

  if (!isSkill) {
    const style = document.createElement("style");
    style.setAttribute("data-codex-plus-ext", "");
    style.textContent = `
    .mcp-picker-button {
      height: 28px; padding: 0 6px; border: 0; border-radius: 8px;
      color: var(--color-token-text-secondary, currentColor); background: transparent;
      cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; flex: none;
    }
    .mcp-picker-button:hover, .mcp-picker-result:hover, .mcp-picker-result:focus-visible {
      background: color-mix(in srgb, currentColor 10%, transparent);
    }
    .mcp-picker-dialog {
      position: fixed; inset: 0; margin: auto; box-sizing: border-box;
      width: min(440px, calc(100vw - 32px)); padding: 14px; border-radius: 14px;
      height: min(540px, calc(100vh - 32px)); overflow: hidden;
      color-scheme: light dark;
      border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
      color: var(--color-token-text-primary, CanvasText);
      background: var(--color-token-main-surface-primary, Canvas);
      box-shadow: 0 14px 48px rgb(0 0 0 / 26%);
    }
    .mcp-picker-dialog[open] { display: flex; flex-direction: column; }
    .mcp-picker-dialog > section { flex: 1; min-height: 0; overflow: auto; }
    .mcp-picker-selection-page:not([hidden]) { display: flex; flex-direction: column; }
    .mcp-picker-selection-page > * { flex-shrink: 0; }
    .mcp-picker-selection-page > .mcp-picker-results {
      flex: 1 1 auto; min-height: 72px; max-height: none;
    }
    .mcp-picker-dialog::backdrop { background: rgb(0 0 0 / 16%); }
    .mcp-picker-header, .mcp-picker-header-actions {
      display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;
    }
    .mcp-picker-header-actions { gap: 4px; margin: 0; flex-wrap: wrap; justify-content: flex-end; }
    .mcp-picker-heading { margin: 0; font: inherit; font-weight: 600; flex: none; }
    .mcp-picker-close { width: 28px; padding: 0; font-size: 20px; line-height: 1; }
    .mcp-picker-query {
      box-sizing: border-box; width: 100%; padding: 8px 10px; border-radius: 8px;
      border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      background: transparent; color: inherit; font: inherit;
    }
    .mcp-picker-group-tabs:not([hidden]) {
      display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 8px;
    }
    .mcp-picker-group-tab {
      height: auto; min-height: 28px; max-width: 100%; padding: 3px 8px;
      overflow-wrap: anywhere; white-space: normal;
    }
    .mcp-picker-group-tab[aria-selected="true"] {
      color: var(--color-token-text-primary, currentColor);
      background: color-mix(in srgb, currentColor 13%, transparent);
    }
    .mcp-picker-group-tab[draggable="true"] { cursor: grab; }
    .mcp-picker-group-tab[draggable="true"]:active { cursor: grabbing; }
    .mcp-picker-group-tab[data-group-drop="before"] { box-shadow: inset 2px 0 currentColor; }
    .mcp-picker-group-tab[data-group-drop="after"] { box-shadow: inset -2px 0 currentColor; }
    .mcp-picker-group-tools { display: flex; justify-content: flex-end; margin-top: 8px; }
    .mcp-picker-group-summary {
      display: flex; width: 100%; height: auto; min-height: 28px; justify-content: space-between;
      align-items: center; gap: 8px; text-align: left;
    }
    .mcp-picker-group-summary > span:first-child { overflow-wrap: anywhere; }
    .mcp-picker-group-summary > span:last-child { flex: none; }
    .mcp-picker-button:disabled { opacity: .45; cursor: default; }
    .mcp-picker-results { margin-top: 8px; max-height: min(40vh, 300px); overflow: auto; }
    .mcp-picker-row { display: flex; align-items: center; gap: 4px; padding-right: 2px; }
    .mcp-picker-drag-handle { width: 24px; padding: 0; cursor: grab; font-size: 16px; }
    .mcp-picker-drag-handle:active { cursor: grabbing; }
    .mcp-picker-row[data-mcp-drop="before"] { box-shadow: inset 0 2px var(--color-token-text-primary, currentColor); }
    .mcp-picker-row[data-mcp-drop="after"] { box-shadow: inset 0 -2px var(--color-token-text-primary, currentColor); }
    .mcp-picker-pin { min-width: 60px; }
    .mcp-picker-pin[aria-pressed="true"] {
      color: var(--color-token-text-primary, currentColor);
      background: color-mix(in srgb, currentColor 10%, transparent);
    }
    .mcp-picker-result {
      display: block; flex: 1; min-width: 0; padding: 7px 9px; border: 0; border-radius: 7px;
      background: transparent; color: inherit; text-align: left; font: inherit;
      overflow-wrap: anywhere; cursor: pointer;
    }
    .mcp-picker-service-id {
      display: block; margin-top: 2px; font-size: 11px;
      color: var(--color-token-text-secondary, currentColor);
    }
    .mcp-picker-alias-form label { display: block; margin-bottom: 8px; overflow-wrap: anywhere; }
    .mcp-picker-group-form > label { display: block; margin: 7px 0 4px; }
    .mcp-picker-group-member {
      display: flex; align-items: center; gap: 8px; padding: 7px 8px;
      border-radius: 7px; overflow-wrap: anywhere; cursor: pointer;
    }
    .mcp-picker-group-member:hover, .mcp-picker-group-member:has(input:checked) {
      background: color-mix(in srgb, currentColor 9%, transparent);
    }
    .mcp-picker-group-member input[type="checkbox"] {
      appearance: auto; display: block; position: static; flex: none;
      width: 16px; height: 16px; margin: 0; opacity: 1; cursor: pointer;
    }
    .mcp-picker-group-error:not(:empty) { color: var(--color-token-text-error, currentColor); margin-top: 8px; }
    .mcp-picker-alias-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
    .mcp-picker-alias-save {
      background: var(--color-token-text-primary, CanvasText);
      color: var(--color-token-main-surface-primary, Canvas);
    }
    .mcp-picker-alias-save:hover { background: var(--color-token-text-secondary, CanvasText); }
    .mcp-picker-status { margin: 8px 2px 2px; color: var(--color-token-text-secondary, currentColor); }
    .mcp-picker-template-field { min-height: 88px; resize: vertical; }
    .mcp-picker-template-help { margin: 6px 2px 12px; font-size: 12px; }
    .mcp-picker-template-preview {
      margin: 4px 0 0; padding: 8px 10px; border-radius: 8px; max-height: 110px; overflow: auto;
      background: color-mix(in srgb, currentColor 8%, transparent);
      white-space: pre-wrap; overflow-wrap: anywhere; font: inherit;
    }
    `;
    ctx.effect(() => {
      document.head.append(style);
      return () => {
        dismissPicker();
        style.remove();
      };
    });
  }

  function createAliasForm(onSave, onCancel) {
    const form = document.createElement("form");
    form.className = "mcp-picker-alias-form";
    form.hidden = true;
    const label = document.createElement("label");
    label.htmlFor = "mcp-picker-alias";
    const field = document.createElement("input");
    field.id = label.htmlFor;
    field.type = "text";
    field.className = "mcp-picker-query";
    field.maxLength = 60;
    field.placeholder = "输入便于搜索的别名";
    const actions = document.createElement("div");
    actions.className = "mcp-picker-alias-actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mcp-picker-button mcp-picker-alias-remove";
    remove.textContent = "移除别名";
    remove.addEventListener("click", () => onSave(""));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mcp-picker-button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", onCancel);
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "mcp-picker-button mcp-picker-alias-save";
    save.textContent = "保存";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      onSave(field.value.trim());
    });
    actions.append(remove, cancel, save);
    form.append(label, field, actions);

    return {
      form,
      edit(name, alias) {
        label.textContent = `设置别名 · ${name}`;
        field.value = alias ?? "";
        remove.hidden = !alias;
        form.hidden = false;
        field.focus();
        field.select();
      }
    };
  }

  function groupButton(label, type = "button", className = "") {
    const button = document.createElement("button");
    button.type = type;
    button.className = `mcp-picker-button ${className}`.trim();
    button.textContent = label;
    return button;
  }

  function createTemplatePage(names, onSave) {
    const page = document.createElement("section");
    page.className = "mcp-picker-template-page";
    page.setAttribute("aria-label", "插入模板");
    page.hidden = true;
    const form = document.createElement("form");
    const field = document.createElement("textarea");
    field.className = "mcp-picker-query mcp-picker-template-field";
    field.setAttribute("aria-label", "插入文本模板");
    field.setAttribute("aria-describedby", "mcp-picker-template-help");
    field.required = true;
    const help = document.createElement("p");
    help.id = "mcp-picker-template-help";
    help.className = "mcp-picker-template-help";
    help.textContent = `{{${kind}}} 为实际${itemLabel}名，{{alias}} 为别名，未设置别名时使用实际名称。`;
    const previewLabel = document.createElement("div");
    previewLabel.textContent = "预览";
    const preview = document.createElement("pre");
    preview.className = "mcp-picker-template-preview";
    const error = document.createElement("div");
    error.className = "mcp-picker-group-error";
    error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "mcp-picker-alias-actions";
    const reset = groupButton("恢复默认", "button", "mcp-picker-template-reset");
    const save = groupButton("保存模板", "submit", "mcp-picker-alias-save");
    actions.append(reset, save);
    form.append(field, help, previewLabel, preview, error, actions);
    page.append(form);

    function refreshPreview() {
      const aliases = loadAliases();
      const example = names.find((name) => aliases.has(name)) ?? names[0] ?? `example_${kind}`;
      preview.textContent = applyInsertionTemplate(field.value, example, aliases.get(example));
    }

    field.addEventListener("input", () => {
      error.textContent = "";
      refreshPreview();
    });
    reset.addEventListener("click", () => {
      field.value = defaultInsertionTemplate;
      error.textContent = "";
      refreshPreview();
      field.focus();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!field.value.trim()) {
        error.textContent = "请输入要插入的文本。";
        return;
      }
      try {
        ctx.storage.set(templateStorageKey, field.value);
      } catch {
        error.textContent = "无法保存插入模板，请再试一次。";
        return;
      }
      onSave();
    });
    return {
      page,
      edit() {
        field.value = loadInsertionTemplate();
        error.textContent = "";
        refreshPreview();
        field.focus();
      }
    };
  }

  function renderGroupTabs(bar, panel, groups, selected, onSelect, { onReorder, showUngrouped = false }) {
    const items = [{ id: "", name: "全部" }, ...orderGroups(groups)
      .filter((item) => showUngrouped || item.id !== ungrouped)];
    let draggedId;
    let dropTab;

    function markDrop(tab, position) {
      if (dropTab && dropTab !== tab) {
        dropTab.removeAttribute("data-group-drop");
      }
      if (tab && tab.dataset.groupDrop !== position) {
        tab.dataset.groupDrop = position;
      }
      dropTab = tab;
    }

    const tabs = items.map(({ id, name }) => {
      const tab = groupButton(name, "button", "mcp-picker-group-tab");
      tab.id = `${bar.id}-${id || "all"}`;
      tab.dataset.groupId = id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", panel.id);
      tab.addEventListener("click", () => {
        activate(tab);
        onSelect(id);
      });
      if (id) {
        tab.draggable = true;
        tab.title = "拖拽排序，或按 Alt + ← / →";
        const isAfter = (event) => {
          const box = tab.getBoundingClientRect();
          return event.clientX >= box.left + box.width / 2;
        };
        tab.addEventListener("dragstart", (event) => {
          draggedId = id;
          event.dataTransfer.setData("application/x-mcp-picker-group", id);
          event.dataTransfer.effectAllowed = "move";
        });
        tab.addEventListener("dragend", () => {
          draggedId = undefined;
          markDrop(null);
        });
        tab.addEventListener("dragover", (event) => {
          if (draggedId && draggedId !== id) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            markDrop(tab, isAfter(event) ? "after" : "before");
          }
        });
        tab.addEventListener("dragleave", () => {
          if (dropTab === tab) {
            markDrop(null);
          }
        });
        tab.addEventListener("drop", (event) => {
          if (!draggedId || draggedId === id) {
            return;
          }
          event.preventDefault();
          const source = draggedId;
          draggedId = undefined;
          markDrop(null);
          onReorder(source, id, isAfter(event), bar);
        });
      }
      return tab;
    });

    function activate(selectedTab) {
      for (const tab of tabs) {
        tab.setAttribute("aria-selected", String(tab === selectedTab));
        tab.tabIndex = tab === selectedTab ? 0 : -1;
      }
      panel.setAttribute("aria-labelledby", selectedTab.id);
    }

    // 使用 roving tabindex，使 Tab 进入当前选项，左右方向键在分组之间切换。
    bar.onkeydown = (event) => {
      const current = tabs.indexOf(event.target);
      if (current === -1 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const step = event.key === "ArrowLeft" ? -1 : 1;
      if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        const source = tabs[current].dataset.groupId;
        const target = tabs[current + step]?.dataset.groupId;
        if (source && target) {
          onReorder(source, target, step > 0, bar);
        }
        return;
      }
      const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)
        : tabs[(tabs.length + current + step) % tabs.length];
      next.focus();
      next.click();
    };
    bar.replaceChildren(...tabs);
    activate(tabs.find((tab) => tab.dataset.groupId === selected) || tabs[0]);
  }

  function createGroupForm(names, { onSave, onMemberChange, onRemove, onCancel }) {
    const form = document.createElement("form");
    form.className = "mcp-picker-group-form";
    form.hidden = true;
    const nameLabel = document.createElement("label");
    nameLabel.htmlFor = "mcp-picker-group-name";
    nameLabel.textContent = "分组名称";
    const nameField = document.createElement("input");
    nameField.id = nameLabel.htmlFor;
    nameField.className = "mcp-picker-query";
    nameField.maxLength = 60;
    nameField.required = true;
    const memberLabel = document.createElement("label");
    memberLabel.htmlFor = "mcp-picker-group-query";
    const memberQuery = document.createElement("input");
    memberQuery.id = memberLabel.htmlFor;
    memberQuery.type = "search";
    memberQuery.className = "mcp-picker-query";
    memberQuery.placeholder = `搜索${itemLabel}名或别名`;
    const list = document.createElement("div");
    list.className = "mcp-picker-results";
    const error = document.createElement("div");
    error.className = "mcp-picker-group-error";
    error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "mcp-picker-alias-actions";
    const remove = groupButton("移除分组", "button", "mcp-picker-group-remove");
    const cancel = groupButton("取消", "button", "mcp-picker-group-cancel");
    const save = groupButton("保存分组", "submit", "mcp-picker-alias-save");
    actions.append(remove, cancel, save);
    form.append(nameLabel, nameField, memberLabel, memberQuery, list, error, actions);

    let groupId;
    let members;
    function showMembers() {
      const aliases = loadAliases();
      const matches = searchServers(names, memberQuery.value, aliases);
      const rows = matches.map((name) => {
        const label = document.createElement("label");
        label.className = "mcp-picker-group-member";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = name;
        checkbox.checked = members.has(name);
        checkbox.addEventListener("change", () => {
          // 已有分组逐项保存，新分组则保留勾选直到提交。
          const failure = groupId ? onMemberChange(groupId, name, checkbox.checked) : "";
          error.textContent = failure;
          if (failure) {
            checkbox.checked = members.has(name);
            return;
          }
          if (checkbox.checked) {
            members.add(name);
          } else {
            members.delete(name);
          }
        });
        const text = document.createElement("span");
        const alias = aliases.get(name);
        text.textContent = alias && alias !== name ? `${alias}（${name}）` : name;
        label.append(checkbox, text);
        return label;
      });
      list.replaceChildren(...rows);
      if (!rows.length) {
        list.textContent = `没有匹配的已启用 ${catalogLabel}。`;
      }
    }

    memberQuery.addEventListener("input", showMembers);
    cancel.addEventListener("click", onCancel);
    remove.addEventListener("click", () => {
      if (remove.dataset.confirmed !== "true") {
        remove.dataset.confirmed = "true";
        remove.textContent = "确认移除分组";
        return;
      }
      error.textContent = onRemove(groupId);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      error.textContent = onSave({ id: groupId, name: nameField.value.trim(), services: [...members] });
    });

    return {
      form,
      edit(group, focusName = true) {
        groupId = group?.id;
        // 继续保留当前未启用的成员，待服务重新启用时仍归属于原分组。
        members = new Set(group?.services ?? []);
        memberLabel.textContent = groupId ? "选择分组成员（勾选立即保存）" : "选择分组成员（保存分组后生效）";
        save.textContent = groupId ? "保存名称" : "保存分组";
        cancel.textContent = groupId ? "返回" : "取消";
        nameField.value = group?.name ?? "";
        memberQuery.value = "";
        error.textContent = "";
        remove.hidden = !groupId;
        remove.textContent = "移除分组";
        delete remove.dataset.confirmed;
        showMembers();
        form.hidden = false;
        if (focusName) {
          nameField.focus();
        }
      }
    };
  }

  async function openPicker(editor, range, { query = "", token = "", button } = {}) {
    if (shared.activePicker || !editor.isConnected) {
      return;
    }
    const sessionId = ctx.currentSessionId();
    const picker = document.createElement("dialog");
    shared.activePicker = { dialog: picker, button, editor, range, sessionId };
    picker.className = "mcp-picker-dialog";
    picker.setAttribute("data-codex-plus-ext", "");
    picker.setAttribute("data-mcp-picker-dialog", "");
    picker.setAttribute("role", "dialog");
    picker.setAttribute("aria-modal", "true");
    picker.setAttribute("aria-label", `选择 ${catalogLabel}`);
    const header = document.createElement("div");
    header.className = "mcp-picker-header";
    const heading = document.createElement("h2");
    heading.className = "mcp-picker-heading";
    heading.textContent = `选择 ${catalogLabel}`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mcp-picker-button mcp-picker-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `关闭 ${catalogLabel} 选择器`);
    close.title = "关闭（Esc）";
    close.addEventListener("click", () => dismissPicker(true));
    const headerActions = document.createElement("div");
    headerActions.className = "mcp-picker-header-actions";
    const manageGroup = groupButton("分组管理", "button", "mcp-picker-group-manage");
    const manageTemplate = groupButton("插入模板", "button", "mcp-picker-template-manage");
    const backToPicker = groupButton("返回选择器", "button", "mcp-picker-group-back");
    manageGroup.hidden = true;
    manageTemplate.hidden = true;
    backToPicker.hidden = true;
    headerActions.append(manageGroup, manageTemplate, backToPicker, close);
    header.append(heading, headerActions);
    const input = document.createElement("input");
    input.type = "search";
    input.className = "mcp-picker-query";
    input.placeholder = `搜索${itemLabel}名或别名`;
    input.setAttribute("aria-label", input.placeholder);
    input.value = query;
    const groupBar = document.createElement("div");
    groupBar.id = "mcp-picker-filter-tabs";
    groupBar.className = "mcp-picker-group-tabs";
    groupBar.setAttribute("role", "tablist");
    groupBar.setAttribute("aria-label", "项目分组");
    groupBar.hidden = true;
    let pickerGroupId = "";
    const results = document.createElement("div");
    results.id = "mcp-picker-filter-panel";
    results.className = "mcp-picker-results";
    results.setAttribute("role", "tabpanel");
    const status = document.createElement("p");
    status.className = "mcp-picker-status";
    status.setAttribute("role", "status");
    status.textContent = `正在读取 ${catalogLabel}…`;
    let editingName;
    const aliasEditor = createAliasForm(saveAlias, finishEditingAlias);
    const pickerPage = document.createElement("section");
    pickerPage.className = "mcp-picker-selection-page";
    pickerPage.append(input, groupBar, results, status, aliasEditor.form);
    const managementPage = document.createElement("section");
    managementPage.className = "mcp-picker-management-page";
    managementPage.setAttribute("aria-label", "分组管理");
    managementPage.hidden = true;
    let currentPage = "selection";
    picker.append(header, pickerPage, managementPage);

    function setSearchVisible(visible) {
      input.hidden = !visible;
      groupBar.hidden = !visible;
      manageGroup.hidden = !visible;
      manageTemplate.hidden = !visible;
      results.hidden = !visible;
      status.hidden = !visible;
    }

    function finishEditingAlias() {
      editingName = undefined;
      aliasEditor.form.hidden = true;
      setSearchVisible(true);
      input.focus();
    }

    function saveAlias(value) {
      if (editingName === undefined) {
        return;
      }
      // 以实际服务名为键，保存时只更新当前服务的别名。
      const saved = loadAliases();
      if (value) {
        saved.set(editingName, value);
      } else {
        saved.delete(editingName);
      }
      try {
        ctx.storage.set(aliasStorageKey, Object.fromEntries(saved));
      } catch {
        ctx.toast(`无法保存 ${catalogLabel} 别名，请再试一次。`, { type: "error" });
        return;
      }
      finishEditingAlias();
      input.dispatchEvent(new Event("input"));
    }

    function choose(name) {
      const template = loadInsertionTemplate();
      const text = applyInsertionTemplate(template, name, loadAliases().get(name));
      dismissPicker();
      // 快捷符入口只替换触发词，按钮入口在原光标处插入；切换对话后放弃旧的编辑位置。
      if (!editor.isConnected || ctx.currentSessionId() !== sessionId
          || (token && (!editor.contains(range.startContainer) || range.toString() !== token))
          || !insertIntoDraft(editor, range, text, template === defaultInsertionTemplate)) {
        ctx.toast("输入框已切换或无法插入，请再试一次。", { type: "warn" });
        return;
      }
      // 插入成功后才按实际服务名记录本次使用，取消置顶后也能沿用这条记录。
      try {
        const recentUses = loadRecentUses();
        recentUses.set(name, Date.now());
        ctx.storage.set(recentUseStorageKey, Object.fromEntries(recentUses));
      } catch {
        ctx.toast(`${itemLabel}调用文本已插入，无法保存最近使用记录。`, { type: "warn" });
      }
    }

    picker.addEventListener("cancel", (event) => {
      event.preventDefault();
      dismissPicker(true);
    });
    picker.addEventListener("click", (event) => {
      if (event.target === picker) {
        dismissPicker(true);
      }
    });
    picker.addEventListener("keydown", (event) => {
      if (event.isComposing || editingName !== undefined || currentPage !== "selection"
          || groupBar.contains(document.activeElement) || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
        return;
      }
      const options = Array.from(results.querySelectorAll(".mcp-picker-result"));
      const focused = options.indexOf(document.activeElement);
      if (event.key === "Enter") {
        if (document.activeElement === input && options[0]) {
          event.preventDefault();
          options[0].click();
        }
        return;
      }
      event.preventDefault();
      if (event.key === "ArrowDown") {
        options[Math.min(focused + 1, options.length - 1)]?.focus();
      } else if (focused > 0) {
        options[focused - 1].focus();
      } else {
        input.focus();
      }
    });

    document.body.append(picker);
    picker.showModal();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    try {
      const names = await listServers();
      if (!picker.open) {
        return;
      }
      const templateEditor = createTemplatePage(names, () => showPage("selection"));
      picker.append(templateEditor.page);
      function refreshPickerTabs() {
        const groups = loadGroups();
        if (pickerGroupId !== ungrouped && !groups.some((group) => group.id === pickerGroupId)) {
          pickerGroupId = "";
        }
        renderGroupTabs(groupBar, results, groups, pickerGroupId, (id) => {
          pickerGroupId = id;
          showMatches();
        }, { onReorder: moveGroupTab, showUngrouped: true });
      }

      const managementTabs = document.createElement("div");
      managementTabs.id = "mcp-picker-management-tabs";
      managementTabs.className = "mcp-picker-group-tabs";
      managementTabs.setAttribute("role", "tablist");
      managementTabs.setAttribute("aria-label", "管理项目分组");
      const tools = document.createElement("div");
      tools.className = "mcp-picker-group-tools";
      const addGroup = groupButton("新建分组", "button", "mcp-picker-group-add");
      tools.append(addGroup);
      const managementPanel = document.createElement("div");
      managementPanel.id = "mcp-picker-management-panel";
      managementPanel.setAttribute("role", "tabpanel");
      const groupOverview = document.createElement("div");
      groupOverview.className = "mcp-picker-results mcp-picker-group-overview";
      let managedGroupId = "";
      const groupEditor = createGroupForm(names, {
        onSave(group) {
          if (!group.name) {
            return "请输入分组名称。";
          }
          const groups = loadGroups();
          const normalized = group.name.normalize("NFKC").toLowerCase();
          if (groups.some((item) => item.id !== group.id && item.name.normalize("NFKC").toLowerCase() === normalized)) {
            return "这个分组名称已存在。";
          }
          const existing = groups.find((item) => item.id === group.id);
          if (group.id && !existing) {
            return "这个分组已被移除，请重新打开分组列表。";
          }
          const updated = {
            ...group,
            id: group.id || `group-${crypto.randomUUID()}`,
            services: existing?.services ?? group.services
          };
          const next = group.id
            ? groups.map((item) => item.id === group.id ? updated : item)
            : [...groups, updated];
          return saveGroups(next, updated.id);
        },
        onMemberChange(id, name, checked) {
          const groups = loadGroups();
          const group = groups.find((item) => item.id === id);
          if (!group) {
            return "这个分组已被移除，请重新打开分组列表。";
          }
          // 每次只修改一个成员，从当前存储读取其他成员和分组字段。
          const members = new Set(group.services);
          if (checked) {
            members.add(name);
          } else {
            members.delete(name);
          }
          const next = groups.map((item) => item.id === id ? { ...item, services: [...members] } : item);
          const error = persistGroups(next);
          if (error) {
            return error;
          }
          refreshManagementOverview(next);
          showMatches();
          return "";
        },
        onRemove(id) {
          // 移除的是本地分组记录，成员的启用状态、置顶和使用记录各自独立。
          return saveGroups(loadGroups().filter((group) => group.id !== id));
        },
        onCancel: () => renderManagement()
      });
      managementPanel.append(groupOverview, groupEditor.form);
      managementPage.append(managementTabs, tools, managementPanel);

      function showManagedGroup(id, focusName = false) {
        const group = loadGroups().find((item) => item.id === id);
        managedGroupId = group?.id ?? "";
        groupOverview.hidden = Boolean(group);
        groupEditor.form.hidden = !group;
        if (group) {
          groupEditor.edit(group, focusName);
        }
      }

      function refreshManagementOverview(groups) {
        const rows = orderGroups(groups).filter((group) => group.id !== ungrouped).map((group) => {
          const item = groupButton("", "button", "mcp-picker-group-summary");
          const label = document.createElement("span");
          label.textContent = group.name;
          const count = document.createElement("span");
          count.textContent = `${group.services.length} 个 ${catalogLabel}`;
          item.append(label, count);
          item.addEventListener("click", () => renderManagement(group.id, true));
          return item;
        });
        groupOverview.replaceChildren(...rows);
        if (!rows.length) {
          groupOverview.textContent = "还没有项目分组。";
        }
      }

      function refreshManagementTabs(groups) {
        renderGroupTabs(managementTabs, managementPanel, groups, managedGroupId, showManagedGroup, {
          onReorder: moveGroupTab
        });
      }

      function renderManagement(selected = "", focusName = false) {
        showManagedGroup(selected, focusName);
        const groups = loadGroups();
        refreshManagementTabs(groups);
        refreshManagementOverview(groups);
        if (!focusName) {
          managementTabs.querySelector('[aria-selected="true"]')?.focus();
        }
      }

      function moveGroupTab(source, target, after, bar) {
        const groups = loadGroups();
        const ids = orderGroups(groups).map((group) => group.id);
        const from = ids.indexOf(source);
        if (source === target || from === -1 || !ids.includes(target)) {
          return;
        }
        ids.splice(from, 1);
        ids.splice(ids.indexOf(target) + Number(after), 0, source);
        try {
          ctx.storage.set(groupOrderKey, ids);
        } catch {
          ctx.toast("无法保存分组顺序，请再试一次。", { type: "error" });
          return;
        }
        refreshPickerTabs();
        refreshManagementTabs(groups);
        refreshManagementOverview(groups);
        Array.from(bar.children).find((tab) => tab.dataset.groupId === source)?.focus();
      }

      function persistGroups(groups) {
        try {
          ctx.storage.set(groupStorageKey, groups);
          return "";
        } catch {
          return `无法保存 ${catalogLabel} 分组，请再试一次。`;
        }
      }

      function saveGroups(groups, selected = "") {
        const error = persistGroups(groups);
        if (error) {
          return error;
        }
        pickerGroupId = selected;
        refreshPickerTabs();
        showMatches();
        renderManagement(selected);
        return "";
      }

      function showPage(page) {
        currentPage = page;
        const selection = page === "selection";
        pickerPage.hidden = !selection;
        managementPage.hidden = page !== "groups";
        templateEditor.page.hidden = page !== "template";
        manageGroup.hidden = !selection;
        manageTemplate.hidden = !selection;
        backToPicker.hidden = selection;
        const titles = { selection: `选择 ${catalogLabel}`, groups: "分组管理", template: "插入模板" };
        heading.textContent = titles[page];
        picker.setAttribute("aria-label", heading.textContent);
        if (page === "groups") {
          renderManagement(pickerGroupId);
        } else if (page === "template") {
          templateEditor.edit();
        } else {
          input.focus();
        }
      }

      manageGroup.addEventListener("click", () => showPage("groups"));
      manageTemplate.addEventListener("click", () => showPage("template"));
      backToPicker.addEventListener("click", () => showPage("selection"));
      addGroup.addEventListener("click", () => {
        renderManagement();
        groupOverview.hidden = true;
        groupEditor.edit();
      });
      let draggedPin;
      let dropRow;

      function markDrop(row, position) {
        if (dropRow && dropRow !== row) {
          dropRow.removeAttribute("data-mcp-drop");
        }
        if (row && row.dataset.mcpDrop !== position) {
          row.dataset.mcpDrop = position;
        }
        dropRow = row;
      }

      function savePins(order, name, focusDrag = false) {
        try {
          ctx.storage.set(pinStorageKey, order);
        } catch {
          ctx.toast(`无法保存 ${catalogLabel} 置顶顺序，请再试一次。`, { type: "error" });
          return;
        }
        showMatches(name, focusDrag);
      }

      function movePin(source, target, after) {
        // 从完整的已保存顺序移动一项，保留筛选或禁用而暂时不可见的置顶项。
        const order = [...loadPins()];
        const from = order.indexOf(source);
        if (source === target || from === -1 || !order.includes(target)) {
          return;
        }
        order.splice(from, 1);
        order.splice(order.indexOf(target) + Number(after), 0, source);
        savePins(order, source, true);
      }

      function createDragHandle(name, row, visiblePins) {
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "mcp-picker-button mcp-picker-drag-handle";
        handle.textContent = "⠿";
        handle.draggable = true;
        handle.title = "拖拽排序，或按 Alt + ↑ / ↓";
        handle.setAttribute("aria-label", `调整 ${name} 的置顶顺序`);
        const isAfter = (clientY) => {
          const box = row.getBoundingClientRect();
          return clientY >= box.top + box.height / 2;
        };
        handle.addEventListener("dragstart", (event) => {
          draggedPin = name;
          event.dataTransfer.setData("application/x-mcp-picker-pin", name);
          event.dataTransfer.effectAllowed = "move";
        });
        handle.addEventListener("dragend", () => {
          draggedPin = undefined;
          markDrop(null);
        });
        row.addEventListener("dragover", (event) => {
          if (draggedPin && draggedPin !== name) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            markDrop(row, isAfter(event.clientY) ? "after" : "before");
          }
        });
        row.addEventListener("dragleave", (event) => {
          if (dropRow === row && !row.contains(event.relatedTarget)) {
            markDrop(null);
          }
        });
        row.addEventListener("drop", (event) => {
          if (!draggedPin || draggedPin === name) {
            return;
          }
          event.preventDefault();
          const source = draggedPin;
          draggedPin = undefined;
          markDrop(null);
          movePin(source, name, isAfter(event.clientY));
        });
        handle.addEventListener("keydown", (event) => {
          if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const down = event.key === "ArrowDown";
          const neighbor = visiblePins[visiblePins.indexOf(name) + (down ? 1 : -1)];
          if (neighbor) {
            movePin(name, neighbor, down);
          }
        });
        return handle;
      }

      const showMatches = (focusName, focusDrag = false) => {
        markDrop(null);
        const customAliases = loadAliases();
        const pins = loadPins();
        // 按分组限定搜索范围，随后沿用置顶和最近使用顺序。
        const inGroup = filterGroup(names, pickerGroupId, loadGroups());
        const matches = searchServers(inGroup, input.value, customAliases);
        const matchedSet = new Set(matches);
        const visiblePins = [...pins].filter((name) => matchedSet.has(name));
        const recentUses = loadRecentUses();
        // 置顶顺序以手动排列为准，未使用过的服务保持原相对顺序。
        const unpinned = matches.filter((name) => !pins.has(name));
        unpinned.sort((left, right) => (recentUses.get(right) ?? 0) - (recentUses.get(left) ?? 0));
        const ordered = [...visiblePins, ...unpinned];
        let controlToFocus;
        const rows = ordered.map((name) => {
          const row = document.createElement("div");
          row.className = "mcp-picker-row";
          const alias = customAliases.get(name);
          const option = document.createElement("button");
          option.type = "button";
          option.className = "mcp-picker-result";
          option.textContent = alias || name;
          if (alias && alias !== name) {
            const serviceId = document.createElement("span");
            serviceId.className = "mcp-picker-service-id";
            serviceId.textContent = name;
            option.append(serviceId);
          }
          option.addEventListener("click", () => choose(name));
          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "mcp-picker-button mcp-picker-alias-edit";
          edit.textContent = "别名";
          edit.setAttribute("aria-label", `设置 ${name} 的别名`);
          edit.addEventListener("click", () => {
            editingName = name;
            setSearchVisible(false);
            aliasEditor.edit(name, alias);
          });
          const pin = document.createElement("button");
          const pinned = pins.has(name);
          pin.type = "button";
          pin.className = "mcp-picker-button mcp-picker-pin";
          pin.textContent = pinned ? "取消置顶" : "置顶";
          pin.setAttribute("aria-label", `置顶 ${name}`);
          pin.setAttribute("aria-pressed", String(pinned));
          pin.addEventListener("click", () => {
            // 用实际服务名保存，修改别名后仍保留置顶状态。
            const latest = loadPins();
            if (latest.has(name)) {
              latest.delete(name);
            } else {
              latest.add(name);
            }
            savePins([...latest], name);
          });
          const handle = pinned ? createDragHandle(name, row, visiblePins) : null;
          if (handle) {
            row.append(handle);
          }
          if (name === focusName) {
            controlToFocus = focusDrag && handle ? handle : pin;
          }
          row.append(option, edit, pin);
          return row;
        });
        results.replaceChildren(...rows);
        results.scrollTop = 0;
        controlToFocus?.focus();
        status.textContent = matches.length ? `${matches.length} / ${inGroup.length} 个 ${catalogLabel}`
          : (inGroup.length ? `没有匹配的${itemLabel}。` : `当前范围没有已启用的 ${catalogLabel}。`);
      };
      input.addEventListener("input", () => showMatches());
      refreshPickerTabs();
      groupBar.hidden = false;
      manageGroup.hidden = false;
      manageTemplate.hidden = false;
      showMatches();
    } catch {
      status.textContent = `无法读取 ${catalogLabel} 列表，请关闭后重试。`;
    }
  }

  ctx.registerInputTrigger({
    trigger,
    items(query, { editor }) {
      const sessionId = ctx.currentSessionId();
      const token = trigger + query;
      // 等宿主处理完输入事件，再确认触发词与光标仍在原位置。
      ctx.setTimeout(() => {
        if (ctx.currentSessionId() !== sessionId || !editor.contains(document.activeElement) || shared.activePicker) {
          return;
        }
        const range = currentCaret(editor);
        const node = range?.startContainer;
        const start = (range?.startOffset ?? 0) - token.length;
        if (node?.nodeType === Node.TEXT_NODE && start >= 0
            && node.textContent.slice(start, range.startOffset) === token) {
          range.setStart(node, start);
          void openPicker(editor, range, { query, token });
        }
      }, 0);
      // 宿主的候选菜单最多显示 12 项，完整结果由共用的选择器呈现。
      return [];
    }
  });

  ctx.registerSlot({
    slot: "composer.left",
    render({ container }) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mcp-picker-button";
      button.dataset.quickPickerKind = kind;
      button.setAttribute("data-codex-plus-ext", "");
      button.setAttribute("aria-haspopup", "dialog");
      button.title = `选择 ${catalogLabel}（${trigger}）`;
      button.textContent = catalogLabel;
      container.append(button);

      // 保留插槽容器供宿主管理生命周期，只把本扩展的按钮放到「+」后面。
      function placeButton() {
        const row = container.parentElement?.parentElement;
        const addButton = row?.querySelector('[data-composer-navigation-target="add-context"]');
        const plus = addButton && Array.from(row.children).find((node) => node.contains(addButton));
        const mcpButton = isSkill ? row?.querySelector(':scope > [data-quick-picker-kind="mcp"]') : null;
        const anchor = mcpButton || plus;
        if (anchor) {
          if (anchor.nextElementSibling !== button) {
            anchor.after(button);
          }
        } else if (button.parentElement !== container) {
          container.append(button);
        }
      }
      placeButton();
      const stopPlacing = ctx.onScan(placeButton, { phase: "light" });

      // 鼠标点击按钮时保留输入框焦点，打开搜索前就能捕获当前光标。
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        const editor = container.closest(composerSelector)?.querySelector(editorSelector);
        if (!editor) {
          ctx.toast("请先打开一个 Codex 输入框。", { type: "warn" });
          return;
        }
        const caret = currentCaret(editor) || savedCarets.get(editor);
        void openPicker(editor, caret, { button });
      });

      return () => {
        stopPlacing();
        if (shared.activePicker?.button === button) {
          dismissPicker();
        }
        button.remove();
      };
    }
  });
}
