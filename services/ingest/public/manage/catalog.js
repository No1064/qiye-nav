"use strict";

async function loadCatalog(options = {}) {
  const previousGroupId = options.preferredGroupId || state.currentGroupId;
  const previousGroupName = options.preferredGroupName
    || NavManageCore.findGroup(state.catalog, previousGroupId)?.name;
  if (!options.silent) setLoading(true);
  try {
    const result = await apiRequest("/catalog");
    state.catalog = NavManageCore.normalizeCatalog(result);
    const nameMatch = previousGroupName
      ? state.catalog.groups.find((group) => group.name === previousGroupName)
      : null;
    state.currentGroupId = (state.catalog.groups.some((group) => group.id === previousGroupId) ? previousGroupId : null)
      || nameMatch?.id
      || state.catalog.groups[0]?.id
      || null;
    if (!options.silent) setLoading(false);
    renderCatalog();
    return state.catalog;
  } catch (error) {
    if (options.authenticating) throw error;
    if (error instanceof ApiError && error.status === 401) {
      showLogin("登录已失效，请重新登录");
      throw error;
    }
    renderLoadError(error);
    throw error;
  } finally {
    if (!options.silent) setLoading(false);
  }
}

function setLoading(loading) {
  state.loading = loading;
  elements.loadingState.hidden = !loading;
  if (loading) {
    elements.errorState.hidden = true;
    elements.emptyState.hidden = true;
    elements.itemList.hidden = true;
  }
}

function renderLoadError(error) {
  elements.loadingState.hidden = true;
  elements.itemList.hidden = true;
  elements.emptyState.hidden = true;
  elements.errorState.hidden = false;
  elements.errorMessage.textContent = readableError(error);
}

function renderCatalog() {
  renderGroups();
  renderItems();
  const totalItems = state.catalog.groups.reduce((sum, group) => sum + group.items.length, 0);
  elements.catalogSummary.textContent = `${state.catalog.groups.length} 个分组，${totalItems} 个网址`;
}

function openSettingsDialog() {
  const settings = state.catalog.settings;
  elements.settingsError.textContent = "";
  elements.settingsTitle.value = settings.title;
  elements.settingsSubtitle.value = settings.subtitle;
  elements.settingsSearchEngine.value = settings.defaultSearchEngine;
  elements.settingsLocalHosts.value = settings.localAccessHosts.join("\n");
  elements.aiTestResult.textContent = "";
  elements.aiApiKey.value = "";
  elements.settingsDialog.showModal();
  void loadAiConfig().catch((error) => {
    elements.settingsError.textContent = `无法读取 AI 配置：${readableError(error)}`;
  });
  elements.settingsTitle.focus();
  elements.settingsTitle.select();
}

async function loadAiConfig() {
  const config = await apiRequest("/ai/config");
  state.aiConfig = config;
  elements.aiProvider.value = config.provider || "deepseek";
  elements.aiBaseUrl.value = config.baseUrl || (config.provider === "deepseek" ? "https://api.deepseek.com" : "");
  elements.aiModel.value = config.model || (config.provider === "deepseek" ? "deepseek-v4-flash" : "");
  elements.aiApiKey.value = "";
  elements.aiApiKey.placeholder = config.hasApiKey ? "已安全保存，留空则保留" : "输入 API Key";
  elements.agentName.value = config.agentName || "";
  elements.agentRolePrompt.value = config.agentRolePrompt || "";
  elements.agentCapabilityPrompt.value = config.agentCapabilityPrompt || "";
  elements.aiConfigStatus.textContent = config.configured ? "已配置" : "尚未配置";
  elements.aiConfigStatus.classList.toggle("ready", Boolean(config.configured));
  return config;
}

function handleAiProviderChange() {
  const switchingToDeepSeek = elements.aiProvider.value === "deepseek";
  if (switchingToDeepSeek
      && (!elements.aiBaseUrl.value.trim() || elements.aiBaseUrl.value.trim() === state.aiConfig?.baseUrl)) {
    elements.aiBaseUrl.value = "https://api.deepseek.com";
  }
  if (switchingToDeepSeek && !elements.aiModel.value.trim()) {
    elements.aiModel.value = "deepseek-v4-flash";
  }
  if (!switchingToDeepSeek && state.aiConfig?.provider === "deepseek") {
    if (elements.aiBaseUrl.value.trim() === "https://api.deepseek.com") elements.aiBaseUrl.value = "";
    if (elements.aiModel.value.trim() === "deepseek-v4-flash") elements.aiModel.value = "";
  }
}

function aiConfigPayload() {
  const provider = elements.aiProvider.value;
  const baseUrl = elements.aiBaseUrl.value.trim();
  const model = elements.aiModel.value.trim();
  const apiKey = elements.aiApiKey.value;
  const agentName = elements.agentName.value.trim();
  const agentRolePrompt = elements.agentRolePrompt.value.trim();
  const agentCapabilityPrompt = elements.agentCapabilityPrompt.value.trim();
  if (!model) throw new Error("请填写 AI 模型名称");
  if (!agentName || !agentRolePrompt || !agentCapabilityPrompt) throw new Error("请完整填写导航助手配置");
  if (!isHttpUrl(baseUrl) || !baseUrl.startsWith("https://")) throw new Error("AI Base URL 必须是公网 HTTPS 地址");
  return {
    provider,
    baseUrl,
    model,
    agentName,
    agentRolePrompt,
    agentCapabilityPrompt,
    ...(apiKey ? { apiKey } : {})
  };
}

async function saveAiConfig(options = {}) {
  if (!state.aiConfig && !elements.aiApiKey.value && !options.required) return null;
  const provider = elements.aiProvider.value;
  const baseUrl = elements.aiBaseUrl.value.trim();
  const model = elements.aiModel.value.trim();
  const changed = provider !== state.aiConfig?.provider
    || baseUrl !== (state.aiConfig?.baseUrl || "")
    || model !== (state.aiConfig?.model || "")
    || elements.agentName.value.trim() !== (state.aiConfig?.agentName || "")
    || elements.agentRolePrompt.value.trim() !== (state.aiConfig?.agentRolePrompt || "")
    || elements.agentCapabilityPrompt.value.trim() !== (state.aiConfig?.agentCapabilityPrompt || "")
    || Boolean(elements.aiApiKey.value);
  if (!changed && !options.required) return state.aiConfig;
  const config = await apiRequest("/ai/config", {
    method: "PATCH",
    body: aiConfigPayload(),
    versioned: false
  });
  state.aiConfig = config;
  elements.aiApiKey.value = "";
  elements.aiApiKey.placeholder = config.hasApiKey ? "已安全保存，留空则保留" : "输入 API Key";
  elements.aiConfigStatus.textContent = config.configured ? "已配置" : "尚未配置";
  elements.aiConfigStatus.classList.toggle("ready", Boolean(config.configured));
  return config;
}

async function testAiConfig() {
  setButtonBusy(elements.testAiConfig, true, "连接中");
  elements.aiTestResult.textContent = "";
  elements.settingsError.textContent = "";
  try {
    await saveAiConfig({ required: true });
    const result = await apiRequest("/ai/config/test", {
      method: "POST",
      body: {},
      versioned: false
    });
    elements.aiTestResult.textContent = `连接正常 · ${result.model} · ${result.latencyMs} ms`;
    elements.aiTestResult.classList.add("success-text");
  } catch (error) {
    elements.aiTestResult.classList.remove("success-text");
    elements.settingsError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.testAiConfig, false, "保存并测试");
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const title = elements.settingsTitle.value.trim();
  const subtitle = elements.settingsSubtitle.value.trim();
  const localAccessHosts = [...new Set(
    elements.settingsLocalHosts.value
      .split(/\r?\n/)
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  )];
  if (!title || !subtitle) {
    elements.settingsError.textContent = "站点名称和首页副标题不能为空";
    return;
  }
  setButtonBusy(elements.saveSettings, true, "正在保存");
  elements.settingsError.textContent = "";
  try {
    await saveAiConfig();
    await mutate("/settings", {
      method: "PATCH",
      body: {
        title,
        subtitle,
        defaultSearchEngine: elements.settingsSearchEngine.value,
        localAccessHosts
      },
      preferredGroupId: state.currentGroupId,
      success: "站点设置已更新"
    });
    elements.settingsDialog.close();
  } catch (error) {
    elements.settingsError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.saveSettings, false, "保存设置");
  }
}


function renderGroups() {
  elements.groupList.replaceChildren();
  const fragment = document.createDocumentFragment();
  NavManageCore.orderedGroupTree(state.catalog).forEach((group) => {
    const siblings = state.catalog.groups.filter((candidate) => candidate.parentId === group.parentId);
    const siblingIndex = siblings.findIndex((candidate) => candidate.id === group.id);
    const row = document.createElement("div");
    row.className = `group-row${group.parentId ? " is-child" : ""}${group.id === state.currentGroupId ? " active" : ""}`;
    row.dataset.groupId = group.id;
    row.dataset.parentId = group.parentId || "";
    if (group.parentId && state.collapsedGroupIds.has(group.parentId)) row.hidden = true;
    row.draggable = siblings.length > 1;

    const select = document.createElement("button");
    select.type = "button";
    select.className = "group-select-button";
    select.dataset.action = "select-group";
    select.setAttribute("aria-current", group.id === state.currentGroupId ? "page" : "false");

    const label = document.createElement("span");
    label.className = "group-label";
    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = group.name;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = String(NavManageCore.groupTotalCount(state.catalog, group.id));
    label.append(name);

    const actions = document.createElement("span");
    actions.className = "group-sort-actions";
    actions.append(
      createMiniButton("chevron-up", "group-up", `上移分组 ${group.name}`, siblingIndex === 0),
      createMiniButton("chevron-down", "group-down", `下移分组 ${group.name}`, siblingIndex === siblings.length - 1)
    );
    const children = state.catalog.groups.filter((candidate) => candidate.parentId === group.id);
    if (children.length) {
      row.classList.add("has-children");
      const disclosure = document.createElement("span");
      disclosure.className = "group-disclosure";
      disclosure.textContent = "›";
      disclosure.setAttribute("aria-hidden", "true");
      label.append(disclosure);
      select.setAttribute("aria-expanded", String(!state.collapsedGroupIds.has(group.id)));
    }
    select.append(label, count);
    row.append(select, actions);
    fragment.append(row);
  });
  elements.groupList.append(fragment);

  elements.mobileGroupList.replaceChildren();
  for (const group of NavManageCore.orderedGroupTree(state.catalog)) {
    if (group.parentId && state.collapsedGroupIds.has(group.parentId)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mobile-group-button${group.id === state.currentGroupId ? " active" : ""}`;
    button.dataset.groupId = group.id;
    button.setAttribute("aria-current", group.id === state.currentGroupId ? "page" : "false");
    const label = document.createElement("span");
    label.textContent = `${NavManageCore.groupPath(state.catalog, group)} (${NavManageCore.groupTotalCount(state.catalog, group.id)})`;
    const hasChildren = state.catalog.groups.some((candidate) => candidate.parentId === group.id);
    if (hasChildren) {
      button.setAttribute("aria-expanded", String(!state.collapsedGroupIds.has(group.id)));
      const disclosure = document.createElement("span"); disclosure.className = "group-disclosure"; disclosure.textContent = "›"; disclosure.setAttribute("aria-hidden", "true"); label.append(" ", disclosure);
    }
    button.append(label);
    elements.mobileGroupList.append(button);
  }
}

function createMiniButton(iconName, action, label, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mini-button";
  button.dataset.action = action;
  button.append(createIcon(iconName));
  button.setAttribute("aria-label", label);
  button.title = label;
  button.disabled = disabled;
  return button;
}

function renderItems() {
  if (state.loading) return;
  const currentGroup = NavManageCore.findGroup(state.catalog, state.currentGroupId);
  const visible = NavManageCore.listVisibleItems(state.catalog, state.currentGroupId, state.query);
  const isSearching = Boolean(state.query.trim());
  const isAggregate = Boolean(currentGroup && state.catalog.groups.some((group) => group.parentId === currentGroup.id));

  elements.loadingState.hidden = true;
  elements.errorState.hidden = true;
  elements.groupActions.hidden = !currentGroup || isSearching;
  elements.currentTitle.textContent = isSearching ? "搜索结果" : NavManageCore.groupPath(state.catalog, currentGroup) || "网址";
  elements.currentSummary.textContent = isSearching
    ? `在全部分组中找到 ${visible.length} 个网址`
    : currentGroup
      ? isAggregate
        ? `${visible.length} 个网址（含下级分组），选择子分组后可调整顺序`
        : `${currentGroup.items.length} 个网址，可拖动调整顺序`
      : "先创建一个分组，再添加网址";

  elements.itemList.replaceChildren();
  renderBulkToolbar(visible);
  if (!visible.length) {
    elements.itemList.hidden = true;
    elements.emptyState.hidden = false;
    if (isSearching) {
      elements.emptyTitle.textContent = "没有匹配的网址";
      elements.emptyMessage.textContent = "尝试缩短关键词，或搜索网址和标签。";
      elements.emptyAddItem.hidden = true;
    } else if (!currentGroup) {
      elements.emptyTitle.textContent = "还没有分组";
      elements.emptyMessage.textContent = "先创建一个分组，再向其中添加网址。";
      setButtonVisual(elements.emptyAddItem, "新建分组");
      elements.emptyAddItem.hidden = false;
    } else {
      elements.emptyTitle.textContent = "这个分组还没有网址";
      elements.emptyMessage.textContent = "添加第一个网址，稍后可以继续调整分组和顺序。";
      setButtonVisual(elements.emptyAddItem, "新增网址");
      elements.emptyAddItem.hidden = false;
    }
    return;
  }

  elements.emptyState.hidden = true;
  elements.itemList.hidden = false;
  const fragment = document.createDocumentFragment();
  visible.forEach(({ group, item }, visibleIndex) => {
    const groupIndex = group.items.findIndex((entry) => entry.id === item.id);
    fragment.append(createItemRow(group, item, groupIndex, isSearching || isAggregate, isSearching || isAggregate));
  });
  elements.itemList.append(fragment);
}

function itemSelectionKey(groupId, itemId) {
  return `${groupId}\0${itemId}`;
}

function selectedItemReferences() {
  return [...state.selectedItems].map((key) => {
    const [groupId, itemId] = key.split("\0");
    return { groupId, itemId };
  });
}

function renderBulkToolbar(visible) {
  const visibleKeys = visible.map(({ group, item }) => itemSelectionKey(group.id, item.id));
  const selectedVisible = visibleKeys.filter((key) => state.selectedItems.has(key)).length;
  elements.bulkToolbar.hidden = visible.length === 0;
  elements.bulkActions.hidden = state.selectedItems.size === 0;
  elements.bulkSelectedCount.textContent = `${state.selectedItems.size} 项已选`;
  elements.selectVisibleItems.checked = visibleKeys.length > 0 && selectedVisible === visibleKeys.length;
  elements.selectVisibleItems.indeterminate = selectedVisible > 0 && selectedVisible < visibleKeys.length;
  const previousTarget = elements.bulkTargetGroup.value;
  elements.bulkTargetGroup.replaceChildren();
  for (const group of NavManageCore.orderedGroupTree(state.catalog)) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = NavManageCore.groupPath(state.catalog, group);
    elements.bulkTargetGroup.append(option);
  }
  elements.bulkTargetGroup.value = state.catalog.groups.some((group) => group.id === previousTarget)
    ? previousTarget
    : state.currentGroupId || state.catalog.groups[0]?.id || "";
}

function handleItemSelectionChange(event) {
  const checkbox = event.target.closest('input[data-select-item="true"]');
  const row = event.target.closest(".item-row");
  if (!checkbox || !row) return;
  const key = itemSelectionKey(row.dataset.groupId, row.dataset.itemId);
  if (checkbox.checked) state.selectedItems.add(key);
  else state.selectedItems.delete(key);
  row.classList.toggle("is-selected", checkbox.checked);
  renderBulkToolbar(NavManageCore.listVisibleItems(state.catalog, state.currentGroupId, state.query));
}

function toggleVisibleItemSelection() {
  const visible = NavManageCore.listVisibleItems(state.catalog, state.currentGroupId, state.query);
  for (const { group, item } of visible) {
    const key = itemSelectionKey(group.id, item.id);
    if (elements.selectVisibleItems.checked) state.selectedItems.add(key);
    else state.selectedItems.delete(key);
  }
  renderItems();
}

function clearItemSelection() {
  state.selectedItems.clear();
  if (!state.loading) renderItems();
}

async function bulkMoveSelectedItems() {
  const items = selectedItemReferences();
  const targetGroupId = elements.bulkTargetGroup.value;
  if (!items.length || !targetGroupId) return;
  setButtonBusy(elements.bulkMoveItems, true, "正在移动");
  try {
    await mutate("/items/move", {
      method: "POST",
      body: { items, targetGroupId },
      preferredGroupId: targetGroupId,
      success: `已移动 ${items.length} 个网址`
    });
    state.selectedItems.clear();
    state.currentGroupId = targetGroupId;
    renderCatalog();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(elements.bulkMoveItems, false, "批量移动");
  }
}

function createItemRow(group, item, itemIndex, sortingDisabled, showGroup) {
  const row = document.createElement("article");
  row.className = `item-row${state.selectedItems.has(itemSelectionKey(group.id, item.id)) ? " is-selected" : ""}`;
  row.dataset.groupId = group.id;
  row.dataset.itemId = item.id;
  row.draggable = !sortingDisabled && group.items.length > 1;
  row.setAttribute("role", "listitem");

  const selection = document.createElement("label");
  selection.className = "item-selection";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.selectItem = "true";
  checkbox.checked = state.selectedItems.has(itemSelectionKey(group.id, item.id));
  checkbox.setAttribute("aria-label", `选择 ${item.title}`);
  selection.append(checkbox);

  const drag = document.createElement("button");
  drag.type = "button";
  drag.className = "drag-handle";
  drag.append(createIcon("grip-vertical"));
  drag.setAttribute("aria-label", `拖动 ${item.title} 调整顺序`);
  drag.title = sortingDisabled ? "聚合或搜索视图下不能排序" : "拖动调整顺序";
  drag.disabled = sortingDisabled || group.items.length < 2;

  const icon = createSiteIcon(item);
  const main = document.createElement("div");
  main.className = "item-main";
  const titleLine = document.createElement("div");
  titleLine.className = "item-title-line";
  const title = document.createElement("span");
  title.className = "item-title";
  title.textContent = item.title;
  titleLine.append(title);
  if (item.localUrl) titleLine.append(createBadge("NAS", "nas-badge"));
  if (showGroup) titleLine.append(createBadge(NavManageCore.groupPath(state.catalog, group), "search-group-label"));
  const description = document.createElement("p");
  description.className = "item-description";
  description.textContent = item.description || item.url;
  main.append(titleLine, description);

  const routes = document.createElement("div");
  routes.className = "item-routes";
  routes.append(createRouteLine(item.localUrl ? "远程地址" : "网站地址", item.url));
  if (item.localUrl) routes.append(createRouteLine("局域网地址", item.localUrl));

  const actions = document.createElement("div");
  actions.className = "item-actions";
  const up = createItemAction("chevron-up", "item-up", `上移 ${item.title}`, "move-button");
  const down = createItemAction("chevron-down", "item-down", `下移 ${item.title}`, "move-button");
  up.disabled = sortingDisabled || itemIndex === 0;
  down.disabled = sortingDisabled || itemIndex === group.items.length - 1;
  actions.append(
    up,
    down,
    createItemAction("edit", "edit-item", `编辑 ${item.title}`),
    createItemAction("trash", "delete-item", `删除 ${item.title}`, "delete-list-button danger-text")
  );

  row.append(selection, drag, icon, main, routes, actions);
  return row;
}

function createSiteIcon(item) {
  const box = document.createElement("span");
  box.className = "site-icon";
  const fallback = firstGlyph(item.title);
  const iconUrl = faviconUrl(item);
  if (iconUrl) {
    const image = document.createElement("img");
    image.src = iconUrl;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      box.replaceChildren(document.createTextNode(fallback));
    }, { once: true });
    box.append(image);
  } else {
    box.textContent = fallback;
  }
  return box;
}

function createBadge(text, className) {
  const badge = document.createElement("span");
  badge.className = className;
  badge.textContent = text;
  return badge;
}

function createRouteLine(label, value) {
  const line = document.createElement("div");
  line.className = "route-line";
  const strong = document.createElement("strong");
  strong.textContent = label;
  const text = document.createElement("span");
  text.textContent = value;
  text.title = value;
  line.append(strong, text);
  return line;
}

function createItemAction(iconName, action, label, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `item-action ${extraClass}`.trim();
  button.dataset.action = action;
  button.append(createIcon(iconName));
  button.setAttribute("aria-label", label);
  button.title = label;
  return button;
}

function selectGroup(groupId) {
  if (!state.catalog.groups.some((group) => group.id === groupId)) return;
  state.currentGroupId = groupId;
  state.selectedItems.clear();
  state.query = "";
  elements.globalSearch.value = "";
  renderCatalog();
  elements.content.focus({ preventScroll: true });
}

function handleEmptyAction() {
  if (state.catalog.groups.length) openItemDrawer();
  else openGroupDialog("create");
}

function handleGroupListClick(event) {
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest(".group-row");
  if (!button || !row) return;
  const groupId = row.dataset.groupId;
  if (button.dataset.action === "select-group") {
    if (state.catalog.groups.some((group) => group.parentId === groupId)) {
      if (state.collapsedGroupIds.has(groupId)) state.collapsedGroupIds.delete(groupId);
      else state.collapsedGroupIds.add(groupId);
    }
    selectGroup(groupId);
  }
  if (button.dataset.action === "group-up") void moveGroupByButton(groupId, -1);
  if (button.dataset.action === "group-down") void moveGroupByButton(groupId, 1);
}

function handleItemListClick(event) {
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest(".item-row");
  if (!button || !row) return;
  const group = NavManageCore.findGroup(state.catalog, row.dataset.groupId);
  const item = group?.items.find((entry) => entry.id === row.dataset.itemId);
  if (!group || !item) return;
  if (button.dataset.action === "edit-item") openItemDrawer(item, group.id);
  if (button.dataset.action === "delete-item") openDeleteItemDialog(item, group.id);
  if (button.dataset.action === "item-up") void moveItemByButton(group, item.id, -1);
  if (button.dataset.action === "item-down") void moveItemByButton(group, item.id, 1);
}

function openGroupDialog(mode) {
  if (mode === "rename" && !state.currentGroupId) return;
  state.groupDialogMode = mode;
  elements.groupNameError.textContent = "";
  elements.groupName.classList.remove("invalid");
  const current = NavManageCore.findGroup(state.catalog, state.currentGroupId);
  elements.groupDialogTitle.textContent = mode === "rename" ? "编辑分组" : "新建分组";
  elements.saveGroup.textContent = mode === "rename" ? "保存分组" : "创建分组";
  elements.groupName.value = mode === "rename" ? current?.name || "" : "";
  elements.groupParent.replaceChildren();
  const rootOption = document.createElement("option");
  rootOption.value = "";
  rootOption.textContent = "顶层分组";
  elements.groupParent.append(rootOption);
  for (const group of state.catalog.groups.filter((group) => !group.parentId && group.id !== current?.id)) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name;
    elements.groupParent.append(option);
  }
  elements.groupParent.value = mode === "rename" ? current?.parentId || "" : "";
  elements.groupDialog.showModal();
  elements.groupName.focus();
  if (mode === "rename") elements.groupName.select();
}

async function handleGroupSubmit(event) {
  event.preventDefault();
  const name = elements.groupName.value.trim();
  const parentId = elements.groupParent.value || null;
  if (!name) {
    elements.groupNameError.textContent = "请输入分组名称";
    elements.groupName.classList.add("invalid");
    elements.groupName.focus();
    return;
  }
  setButtonBusy(elements.saveGroup, true, "正在保存");
  try {
    if (state.groupDialogMode === "rename") {
      const groupId = state.currentGroupId;
      await mutate(`/groups/${segment(groupId)}`, {
        method: "PATCH",
        body: { name, parentId },
        preferredGroupId: groupId,
        success: "分组名称已更新"
      });
    } else {
      await mutate("/groups", {
        method: "POST",
        body: { name, ...(parentId ? { parentId } : {}) },
        preferredGroupName: name,
        success: "分组已创建"
      });
      const created = state.catalog.groups.findLast((group) => group.name === name && group.parentId === (parentId || undefined));
      if (created) selectGroup(created.id);
    }
    elements.groupDialog.close();
  } catch (error) {
    elements.groupNameError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.saveGroup, false, state.groupDialogMode === "rename" ? "保存分组" : "创建分组");
  }
}

function openDeleteGroupDialog() {
  const group = NavManageCore.findGroup(state.catalog, state.currentGroupId);
  if (!group) return;
  const children = state.catalog.groups.filter((entry) => entry.parentId === group.id);
  if (children.length) {
    showToastMessage(`请先迁移或删除 ${children.length} 个子分组，再删除“${group.name}”`, "error");
    return;
  }
  const otherGroups = state.catalog.groups.filter((entry) => entry.id !== group.id);
  elements.deleteTargetGroup.replaceChildren();
  for (const target of otherGroups) {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = NavManageCore.groupPath(state.catalog, target);
    elements.deleteTargetGroup.append(option);
  }
  const hasItems = group.items.length > 0;
  elements.groupDeleteOptions.hidden = !hasItems;
  const moveChoice = elements.confirmDialog.querySelector('input[name="delete-mode"][value="move"]');
  const deleteChoice = elements.confirmDialog.querySelector('input[name="delete-mode"][value="delete"]');
  moveChoice.disabled = otherGroups.length === 0;
  moveChoice.checked = otherGroups.length > 0;
  deleteChoice.checked = otherGroups.length === 0;
  updateDeleteTargetState();

  openConfirm({
    title: "删除分组",
    message: hasItems
      ? `“${group.name}”包含 ${group.items.length} 个网址。请选择迁移网址，或明确同时删除。`
      : `确定删除空分组“${group.name}”吗？`,
    label: "删除分组",
    action: async () => {
      let body;
      let preferredGroupId = otherGroups[0]?.id;
      if (hasItems) {
        const mode = elements.confirmDialog.querySelector('input[name="delete-mode"]:checked')?.value;
        if (mode === "move") {
          const targetId = elements.deleteTargetGroup.value;
          body = { moveItemsToGroupId: targetId };
          preferredGroupId = targetId;
        } else {
          body = { deleteItems: true };
        }
      }
      await mutate(`/groups/${segment(group.id)}`, {
        method: "DELETE",
        ...(body ? { body } : {}),
        preferredGroupId,
        success: "分组已删除"
      });
    }
  });
}

function updateDeleteTargetState() {
  const mode = elements.confirmDialog.querySelector('input[name="delete-mode"]:checked')?.value;
  elements.deleteTargetGroup.disabled = mode !== "move";
}

function openItemDrawer(item = null, groupId = state.currentGroupId) {
  if (!state.catalog.groups.length) {
    openGroupDialog("create");
    return;
  }
  const group = NavManageCore.findGroup(state.catalog, groupId) || state.catalog.groups[0];
  state.drawer = { mode: item ? "edit" : "create", item, groupId: group.id };
  state.lastFocused = document.activeElement;
  elements.itemForm.reset();
  clearUrlErrors();
  elements.metadataPreview.hidden = true;
  elements.metadataPreview.classList.remove("no-icon");
  elements.metadataIcon.hidden = false;
  populateDrawerGroups(item ? group.id : state.currentGroupId || group.id);
  elements.itemId.value = item?.id || "";
  elements.itemOriginalGroup.value = group.id;
  elements.itemUrl.value = item?.url || "";
  elements.itemLocalUrl.value = item?.localUrl || "";
  elements.itemTitle.value = item?.title || "";
  elements.itemDescription.value = item?.description || "";
  elements.itemIcon.value = item?.icon || "";
  elements.itemTags.value = (item?.tags || []).join(", ");
  elements.drawerTitle.textContent = item ? "编辑网址" : "新增网址";
  elements.drawerSubtitle.textContent = item
    ? "修改地址、介绍、图标、标签或所属分组。"
    : "普通网站填写远程地址，NAS 可再填写局域网地址。";
  elements.saveItem.textContent = item ? "保存修改" : "添加网址";
  elements.clearItemInDrawer.hidden = !item;
  elements.drawerBackdrop.hidden = false;
  elements.drawer.removeAttribute("inert");
  elements.drawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  requestAnimationFrame(() => (item ? elements.itemTitle : elements.itemUrl).focus());
}

function populateDrawerGroups(selectedGroupId) {
  elements.itemGroup.replaceChildren();
  for (const group of NavManageCore.orderedGroupTree(state.catalog)) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = NavManageCore.groupPath(state.catalog, group);
    elements.itemGroup.append(option);
  }
  elements.itemGroup.value = selectedGroupId;
}

function closeItemDrawer() {
  if (!state.drawer) return;
  clearTimeout(state.metadataTimer);
  document.body.classList.remove("drawer-open");
  elements.drawer.setAttribute("aria-hidden", "true");
  elements.drawer.setAttribute("inert", "");
  setTimeout(() => {
    if (!document.body.classList.contains("drawer-open")) elements.drawerBackdrop.hidden = true;
  }, 270);
  state.drawer = null;
  state.lastFocused?.focus?.();
}

async function handleItemSubmit(event) {
  event.preventDefault();
  if (!validateItemUrls()) return;
  const isEdit = state.drawer?.mode === "edit";
  const originalGroupId = elements.itemOriginalGroup.value;
  const targetGroupId = elements.itemGroup.value;
  const itemId = elements.itemId.value;
  const fields = collectItemFields(isEdit);
  setButtonBusy(elements.saveItem, true, "正在保存");

  try {
    if (isEdit) {
      await mutate(`/groups/${segment(originalGroupId)}/items/${segment(itemId)}`, {
        method: "PATCH",
        body: fields,
        preferredGroupId: originalGroupId,
        success: targetGroupId === originalGroupId ? "网址已更新" : "网址内容已更新"
      });
      if (targetGroupId !== originalGroupId) {
        await mutate(`/groups/${segment(originalGroupId)}/items/${segment(itemId)}/move`, {
          method: "POST",
          body: { targetGroupId },
          preferredGroupId: targetGroupId,
          success: "网址已移动到新分组"
        });
      }
    } else {
      await mutate("/items", {
        method: "POST",
        body: { groupId: targetGroupId, ...fields },
        preferredGroupId: targetGroupId,
        success: "网址已添加"
      });
    }
    state.currentGroupId = targetGroupId;
    closeItemDrawer();
    renderCatalog();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(elements.saveItem, false, isEdit ? "保存修改" : "添加网址");
  }
}

function collectItemFields(isEdit) {
  const optionalValue = (value) => {
    const trimmed = value.trim();
    return trimmed || (isEdit ? null : undefined);
  };
  const fields = {
    title: elements.itemTitle.value.trim(),
    url: elements.itemUrl.value.trim(),
    localUrl: optionalValue(elements.itemLocalUrl.value),
    description: optionalValue(elements.itemDescription.value),
    icon: optionalValue(elements.itemIcon.value),
    tags: NavManageCore.normalizeTags(elements.itemTags.value)
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function validateItemUrls() {
  clearUrlErrors();
  let valid = true;
  if (!isHttpUrl(elements.itemUrl.value)) {
    elements.itemUrlError.textContent = "远程地址必须是完整的 HTTP 或 HTTPS URL";
    elements.itemUrl.classList.add("invalid");
    valid = false;
  }
  if (elements.itemLocalUrl.value.trim() && !isHttpUrl(elements.itemLocalUrl.value)) {
    elements.itemLocalUrlError.textContent = "局域网地址必须是完整的 HTTP 或 HTTPS URL";
    elements.itemLocalUrl.classList.add("invalid");
    valid = false;
  }
  if (!valid) (elements.itemUrl.classList.contains("invalid") ? elements.itemUrl : elements.itemLocalUrl).focus();
  return valid;
}

function clearUrlErrors() {
  elements.itemUrlError.textContent = "";
  elements.itemLocalUrlError.textContent = "";
  elements.itemUrl.classList.remove("invalid");
  elements.itemLocalUrl.classList.remove("invalid");
}

function scheduleMetadataPreview() {
  clearTimeout(state.metadataTimer);
  state.metadataTimer = setTimeout(() => {
    if (state.drawer?.mode === "create" && isHttpUrl(elements.itemUrl.value)) void previewMetadata(true);
  }, 650);
}

async function previewMetadata(automatic) {
  const url = elements.itemUrl.value.trim();
  if (!isHttpUrl(url)) {
    if (!automatic) {
      elements.itemUrlError.textContent = "先输入完整的 HTTP 或 HTTPS URL";
      elements.itemUrl.classList.add("invalid");
      elements.itemUrl.focus();
    }
    return;
  }
  setButtonBusy(elements.previewMetadata, true, "读取中");
  try {
    const result = await apiRequest("/metadata/preview", {
      method: "POST",
      body: { url },
      versioned: false
    });
    const metadata = result?.metadata ?? result ?? {};
    const title = metadata.title || "已读取网页信息";
    const description = metadata.description || metadata.finalUrl || url;
    const icon = metadata.favicon || metadata.icon || "";
    if (!elements.itemTitle.value.trim() || state.drawer?.mode === "create") elements.itemTitle.value = title;
    if (metadata.description && (!elements.itemDescription.value.trim() || state.drawer?.mode === "create")) {
      elements.itemDescription.value = metadata.description;
    }
    if (icon && (!elements.itemIcon.value.trim() || state.drawer?.mode === "create")) elements.itemIcon.value = icon;
    elements.metadataTitle.textContent = title;
    elements.metadataDescription.textContent = description;
    elements.metadataIcon.src = isImageUrl(icon) ? icon : "/favicon.svg";
    elements.metadataIcon.hidden = false;
    elements.metadataPreview.classList.remove("no-icon");
    elements.metadataPreview.hidden = false;
    if (!automatic) showToastMessage("网页标题、介绍和图标已读取");
  } catch (error) {
    if (!automatic) {
      const code = error instanceof ApiError ? error.body?.error?.code : "";
      showToastMessage(code === "metadata_access_denied" || (error instanceof ApiError && error.status === 403)
        ? "目标网站拒绝自动读取。你仍可手动填写标题和介绍后保存网址。"
        : readableError(error), "error");
    }
  } finally {
    setButtonBusy(elements.previewMetadata, false, "读取信息");
  }
}

function openDeleteItemDialog(item, groupId) {
  elements.groupDeleteOptions.hidden = true;
  openConfirm({
    title: "删除网址",
    message: `确定删除“${item.title}”吗？删除后无法在管理页中撤销。`,
    label: "删除网址",
    action: async () => {
      await mutate(`/groups/${segment(groupId)}/items/${segment(item.id)}`, {
        method: "DELETE",
        preferredGroupId: groupId,
        success: "网址已删除"
      });
      if (state.drawer?.item?.id === item.id) closeItemDrawer();
    }
  });
}

function deleteDrawerItem() {
  const item = state.drawer?.item;
  if (item) openDeleteItemDialog(item, state.drawer.groupId);
}

function openConfirm({ title, message, label, action }) {
  state.confirmAction = action;
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmSubmit.textContent = label;
  elements.confirmDialog.showModal();
  elements.confirmSubmit.focus();
}

function closeConfirmDialog() {
  state.confirmAction = null;
  if (elements.confirmDialog.open) elements.confirmDialog.close();
}

async function handleConfirmSubmit(event) {
  event.preventDefault();
  if (!state.confirmAction) return;
  const action = state.confirmAction;
  setButtonBusy(elements.confirmSubmit, true, "正在处理");
  try {
    await action();
    closeConfirmDialog();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(elements.confirmSubmit, false, "确认删除");
  }
}

async function mutate(path, options) {
  if (state.busy) throw new Error("另一项操作正在进行，请稍候");
  state.busy = true;
  try {
    await apiRequest(path, options);
    await loadCatalog({
      silent: true,
      preferredGroupId: options.preferredGroupId,
      preferredGroupName: options.preferredGroupName
    });
    if (options.success) showToastMessage(options.success);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      showToastMessage("目录已在其他位置更新，已为你刷新，请重新操作", "error");
      await loadCatalog({ silent: true }).catch(() => {});
    }
    throw error;
  } finally {
    state.busy = false;
  }
}

async function moveGroupByButton(groupId, delta) {
  const group = NavManageCore.findGroup(state.catalog, groupId);
  if (!group) return;
  const siblings = state.catalog.groups.filter((candidate) => candidate.parentId === group.parentId);
  const siblingIndex = siblings.findIndex((candidate) => candidate.id === groupId);
  const target = siblings[siblingIndex + delta];
  if (!target) return;
  const ids = state.catalog.groups.map((candidate) => candidate.id);
  const next = [...ids];
  const sourceIndex = next.indexOf(group.id);
  const targetIndex = next.indexOf(target.id);
  [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
  if (next.join("\0") === ids.join("\0")) return;
  await saveGroupOrder(next);
}

async function saveGroupOrder(groupIds) {
  applyGroupOrder(groupIds);
  try {
    await mutate("/order", {
      method: "PUT",
      body: { scope: "groups", groupIds },
      preferredGroupId: state.currentGroupId,
      success: "分组顺序已保存"
    });
  } catch (error) {
    showToastMessage(readableError(error), "error");
    await loadCatalog({ silent: true }).catch(() => {});
  }
}

function applyGroupOrder(groupIds) {
  const byId = new Map(state.catalog.groups.map((group) => [group.id, group]));
  state.catalog.groups = groupIds.map((id) => byId.get(id)).filter(Boolean);
  renderCatalog();
}

async function moveItemByButton(group, itemId, delta) {
  const ids = group.items.map((item) => item.id);
  const next = NavManageCore.moveId(ids, itemId, delta);
  if (next.join("\0") === ids.join("\0")) return;
  await saveItemOrder(group.id, next);
}

async function saveItemOrder(groupId, itemIds) {
  applyItemOrder(groupId, itemIds);
  try {
    await mutate("/order", {
      method: "PUT",
      body: { scope: "items", groupId, itemIds },
      preferredGroupId: groupId,
      success: "网址顺序已保存"
    });
  } catch (error) {
    showToastMessage(readableError(error), "error");
    await loadCatalog({ silent: true }).catch(() => {});
  }
}

function applyItemOrder(groupId, itemIds) {
  const group = NavManageCore.findGroup(state.catalog, groupId);
  if (!group) return;
  const byId = new Map(group.items.map((item) => [item.id, item]));
  group.items = itemIds.map((id) => byId.get(id)).filter(Boolean);
  renderCatalog();
}

function bindDragAndDrop(container, type) {
  container.addEventListener("dragstart", (event) => {
    const selector = type === "group" ? ".group-row" : ".item-row";
    const row = event.target.closest(selector);
    if (!row?.draggable) return;
    state.drag = {
      type,
      id: type === "group" ? row.dataset.groupId : row.dataset.itemId,
      groupId: row.dataset.groupId,
      parentId: row.dataset.parentId || ""
    };
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.drag.id);
  });
  container.addEventListener("dragover", (event) => {
    if (state.drag?.type !== type) return;
    const selector = type === "group" ? ".group-row" : ".item-row";
    const row = event.target.closest(selector);
    if (!row) return;
    if (type === "item" && row.dataset.groupId !== state.drag.groupId) return;
    if (type === "group" && (row.dataset.parentId || "") !== state.drag.parentId) return;
    event.preventDefault();
    container.querySelectorAll(".drop-target").forEach((entry) => entry.classList.remove("drop-target"));
    row.classList.add("drop-target");
  });
  container.addEventListener("drop", (event) => {
    if (state.drag?.type !== type) return;
    event.preventDefault();
    const selector = type === "group" ? ".group-row" : ".item-row";
    const row = event.target.closest(selector);
    if (!row) return;
    if (type === "group") {
      if ((row.dataset.parentId || "") !== state.drag.parentId) return;
      const ids = state.catalog.groups.map((group) => group.id);
      void saveGroupOrder(NavManageCore.reorderIds(ids, state.drag.id, row.dataset.groupId));
    } else if (row.dataset.groupId === state.drag.groupId) {
      const group = NavManageCore.findGroup(state.catalog, state.drag.groupId);
      const ids = group.items.map((item) => item.id);
      void saveItemOrder(group.id, NavManageCore.reorderIds(ids, state.drag.id, row.dataset.itemId));
    }
    clearDragState(container);
  });
  container.addEventListener("dragend", () => clearDragState(container));
}

function clearDragState(container) {
  container.querySelectorAll(".dragging, .drop-target").forEach((entry) => {
    entry.classList.remove("dragging", "drop-target");
  });
  state.drag = null;
}
