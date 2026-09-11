"use strict";

const HEALTH_STATUS_LABELS = {
  queued: "排队中", running: "扫描中", pausing: "正在暂停", paused: "已暂停",
  completed: "扫描完成", failed: "扫描失败", cancelled: "已取消", applied: "已应用"
};

const HEALTH_ISSUE_LABELS = {
  exact_duplicate: "完全重复", possible_duplicate: "疑似重复", suspected_duplicate: "疑似重复", duplicate_title: "标题重复", duplicate: "重复",
  broken: "访问失败", dead_link: "失效地址", redirect: "重定向",
  permanent_redirect: "永久重定向", temporary_redirect: "临时重定向", remote_ok: "地址正常",
  missing_metadata: "资料缺失", empty_group: "空分组", unauthorized: "需要登录"
};

function bindHealthEvents() {
  document.querySelector("#transfer-button").addEventListener("click", () => document.querySelector("#transfer-dialog").showModal());
  document.querySelector("#close-transfer-dialog").addEventListener("click", () => document.querySelector("#transfer-dialog").close());
  document.querySelector("#health-to-ai").addEventListener("click", () => void transferHealthToAi());
  elements.healthButton.addEventListener("click", () => void openHealthCenter());
  elements.closeHealthDialog.addEventListener("click", closeHealthCenter);
  elements.healthDialog.addEventListener("close", stopHealthPolling);
  elements.healthTabs.addEventListener("click", handleHealthTabClick);
  elements.startLocalHealthJob.addEventListener("click", () => void createHealthJob(false));
  elements.startRemoteHealthJob.addEventListener("click", () => void createHealthJob(true));
  document.querySelectorAll('input[name="health-scope"]').forEach((input) => input.addEventListener("change", updateHealthScopeControls));
  elements.healthSingleGroup.addEventListener("change", updateHealthScopeSummary);
  elements.healthMultipleGroups.addEventListener("change", updateHealthScopeSummary);
  elements.refreshHealthJobs.addEventListener("click", () => void loadHealthJobs());
  elements.pauseHealthJob.addEventListener("click", () => void healthJobAction("pause"));
  elements.resumeHealthJob.addEventListener("click", () => void healthJobAction("resume"));
  elements.cancelHealthJob.addEventListener("click", () => void healthJobAction("cancel"));
  elements.healthHistoryList.addEventListener("click", handleHealthHistoryClick);
  [elements.healthIssueFilter, elements.healthGroupFilter, elements.healthDomainFilter, elements.healthStatusFilter]
    .forEach((control) => control.addEventListener("change", renderHealthFindings));
  elements.healthFindingList.addEventListener("change", handleHealthActionChange);
  document.querySelector("#health-advisory-list").addEventListener("change", handleHealthActionChange);
  elements.selectFilteredHealth.addEventListener("click", selectFilteredHealthFindings);
  document.querySelector("#recommend-filtered-health").addEventListener("click", recommendFilteredHealthFindings);
  elements.clearHealthSelection.addEventListener("click", clearHealthSelection);
  elements.previewHealthActions.addEventListener("click", previewHealthActions);
  elements.cancelHealthApply.addEventListener("click", () => { elements.healthApplyPreview.hidden = true; });
  elements.confirmHealthApply.addEventListener("click", () => void applyHealthActions());
  elements.restoreHealthChangeSet.addEventListener("click", () => void restoreHealthChangeSet());
  elements.exportHtml.addEventListener("click", () => void downloadBookmarks("html"));
  elements.exportJson.addEventListener("click", () => void downloadBookmarks("json"));
  elements.importFile.addEventListener("change", resetImportPreview);
  elements.jsonRestore.addEventListener("change", () => {
    state.importPreview = null;
    elements.importPreviewPanel.hidden = true;
    elements.importError.textContent = elements.jsonRestore.checked ? "请重新生成预览，确认完整恢复的影响" : "";
  });
  elements.previewImport.addEventListener("click", () => void previewBookmarkImport());
  elements.applyImport.addEventListener("click", () => void applyBookmarkImport());
  if (location.hash === "#health") void openHealthCenter();
}

async function openHealthCenter() {
  elements.healthDialog.showModal();
  showHealthView("scan");
  populateHealthScopeControls();
  await loadHealthJobs();
  if (state.healthJob) showHealthView("results");
}

function closeHealthCenter() {
  stopHealthPolling();
  elements.healthDialog.close();
}

function stopHealthPolling() {
  clearTimeout(state.healthPollTimer);
  state.healthPollTimer = null;
}

function handleHealthTabClick(event) {
  const button = event.target.closest("button[data-health-view]");
  if (button) showHealthView(button.dataset.healthView);
}

function showHealthView(view) {
  elements.healthScanView.hidden = view !== "scan";
  elements.healthResultsView.hidden = view !== "results";
  elements.healthTabs.querySelectorAll("button[data-health-view]").forEach((button) => {
    if (button.dataset.healthView === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (view === "results") renderHealthFindings();
}

function populateHealthScopeControls() {
  const previous = elements.healthSingleGroup.value;
  elements.healthSingleGroup.replaceChildren();
  elements.healthMultipleGroups.replaceChildren();
  state.catalog.groups.forEach((group) => {
    elements.healthSingleGroup.append(new Option(healthGroupPath(group), group.id));
    const choice = document.createElement("label");
    choice.className = "choice-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = group.id;
    const copy = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = healthGroupPath(group);
    const small = document.createElement("small");
    small.textContent = `${group.items.length} 个网址`;
    copy.append(strong, small);
    choice.append(input, copy);
    elements.healthMultipleGroups.append(choice);
  });
  if ([...elements.healthSingleGroup.options].some((option) => option.value === previous)) elements.healthSingleGroup.value = previous;
  updateHealthScopeControls();
}

function updateHealthScopeControls() {
  const mode = document.querySelector('input[name="health-scope"]:checked')?.value || "single";
  elements.healthSingleGroupField.hidden = mode !== "single";
  elements.healthMultipleGroups.hidden = mode !== "multiple";
  updateHealthScopeSummary();
}

function updateHealthScopeSummary() {
  const scope = selectedHealthScope();
  const ids = scope.type === "all" ? state.catalog.groups.map((group) => group.id) : scope.ids;
  const count = state.catalog.groups.filter((group) => ids.includes(group.id)).reduce((total, group) => total + group.items.length, 0);
  elements.healthScopeSummary.textContent = `将检查 ${ids.length} 个分组、${count} 个网址`;
}

function selectedHealthScope() {
  const mode = document.querySelector('input[name="health-scope"]:checked')?.value || "single";
  if (mode === "all") return { type: "all" };
  const selected = mode === "single" ? [elements.healthSingleGroup.value].filter(Boolean)
    : [...elements.healthMultipleGroups.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  const ids = new Set(selected);
  state.catalog.groups.forEach((group) => {
    if (group.parentId && ids.has(group.parentId)) ids.add(group.id);
  });
  return { type: "groups", ids: [...ids] };
}

function healthScopeLabel(scope) {
  if (!scope || scope.type === "all") return "全部分组";
  const ids = scope.ids || [];
  if (ids.length === 1) return healthGroupLabel(ids[0]);
  return `${ids.length} 个分组`;
}

function healthGroupPath(group) {
  const parent = group.parentId ? state.catalog.groups.find((candidate) => candidate.id === group.parentId) : null;
  return parent ? `${parent.name} / ${group.name}` : group.name;
}

async function createHealthJob(includeRemote) {
  const button = includeRemote ? elements.startRemoteHealthJob : elements.startLocalHealthJob;
  const idleLabel = includeRemote ? "远程检查" : "仅本地检查";
  elements.startLocalHealthJob.disabled = true;
  elements.startRemoteHealthJob.disabled = true;
  setButtonBusy(button, true, "正在创建");
  try {
    const scope = selectedHealthScope();
    if (scope.type === "groups" && !scope.ids.length) throw new Error("请至少选择一个分组");
    const response = await apiRequest("/health/jobs", { method: "POST", body: { includeRemote, scope }, versioned: false });
    state.healthJob = response.job || response;
    state.healthActions.clear();
    state.healthDraftActions.clear();
    state.healthFeedback?.clear();
    renderHealthJob();
    await loadHealthJobs();
    pollHealthJob();
    showToastMessage(includeRemote ? "远程检查已启动" : "本地检查已启动");
  } catch (error) {
    showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(button, false, idleLabel);
    elements.startLocalHealthJob.disabled = false;
    elements.startRemoteHealthJob.disabled = false;
  }
}

async function loadHealthJobs() {
  try {
    const response = await apiRequest("/health/jobs", { versioned: false });
    state.healthJobs = Array.isArray(response) ? response : response.jobs || response.items || [];
    renderHealthHistory();
    const active = state.healthJobs.find((job) => ["queued", "running", "pausing", "paused"].includes(job.status));
    if (active) {
      state.healthJob = await fetchHealthJob(active.id);
      renderHealthJob();
      if (["queued", "running", "pausing"].includes(state.healthJob.status)) pollHealthJob();
    } else if (!state.healthJob && state.healthJobs[0]) {
      state.healthJob = await fetchHealthJob(state.healthJobs[0].id);
      renderHealthJob();
    }
  } catch (error) {
    elements.healthHistoryList.replaceChildren(healthText("无法读取扫描记录：" + readableError(error), "health-muted"));
  }
}

async function fetchHealthJob(id) {
  const response = await apiRequest(`/health/jobs/${encodeURIComponent(id)}`, { versioned: false });
  return response.job || response;
}

function pollHealthJob() {
  stopHealthPolling();
  state.healthPollTimer = setTimeout(async () => {
    if (!state.healthJob || !elements.healthDialog.open) return;
    try {
      state.healthJob = await fetchHealthJob(state.healthJob.id);
      renderHealthJob();
      if (["queued", "running", "pausing"].includes(state.healthJob.status)) pollHealthJob();
      else await loadHealthJobs();
    } catch (error) {
      showToastMessage(readableError(error), "error");
    }
  }, 1500);
}

async function healthJobAction(action) {
  if (!state.healthJob?.id) return;
  const button = action === "pause" ? elements.pauseHealthJob : action === "resume" ? elements.resumeHealthJob : elements.cancelHealthJob;
  const busyLabel = action === "pause" ? "正在暂停" : action === "resume" ? "正在继续" : "正在取消";
  setButtonBusy(button, true, busyLabel);
  try {
    const response = await apiRequest(`/health/jobs/${encodeURIComponent(state.healthJob.id)}/${action}`, { method: "POST", body: {}, versioned: false });
    state.healthJob = response.job || response;
    renderHealthJob();
    pollHealthJob();
  } catch (error) {
    showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(button, false, action === "pause" ? "暂停" : action === "resume" ? "继续" : "取消任务");
  }
}

function renderHealthJob() {
  const job = state.healthJob;
  if (!job) return;
  const progress = job.progress || {};
  const completed = progress.processed === undefined
    ? Number(progress.completed ?? job.completed ?? 0)
    : Number(progress.processed) + Number(progress.skipped || 0);
  const total = Number(progress.total ?? job.total ?? 0);
  elements.healthJobStatus.textContent = HEALTH_STATUS_LABELS[job.status] || job.status || "未知状态";
  elements.healthProgress.max = Math.max(1, total);
  elements.healthProgress.value = Math.min(total || 1, completed);
  elements.healthProgressCopy.textContent = total
    ? `已检查 ${completed} / ${total}，发现 ${healthFindings(job).length} 项需关注内容`
    : (job.error?.message || job.message || "正在准备扫描");
  elements.pauseHealthJob.hidden = !["queued", "running"].includes(job.status);
  elements.resumeHealthJob.hidden = job.status !== "paused";
  elements.cancelHealthJob.hidden = !["queued", "running", "pausing", "paused"].includes(job.status);
  const latestChangeSet = job.changeSet || (Array.isArray(job.changeSets) ? job.changeSets[job.changeSets.length - 1] : null);
  state.healthChangeSet = latestChangeSet || null;
  renderHealthChangeSet();
  populateHealthFilters();
  renderHealthFindings();
}

function renderHealthHistory() {
  elements.healthHistoryList.replaceChildren();
  if (!state.healthJobs.length) {
    elements.healthHistoryList.append(healthText("还没有扫描记录。", "health-muted"));
    return;
  }
  state.healthJobs.forEach((job) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "health-history-row";
    button.dataset.jobId = job.id;
    const title = healthText(HEALTH_STATUS_LABELS[job.status] || job.status || "扫描任务", "health-history-title");
    const mode = job.includeRemote === false ? "仅本地" : "远程";
    const meta = healthText(`${mode} · ${healthScopeLabel(job.scope)} · ${formatHealthDate(job.createdAt)} · ${Number(job.findingCount ?? job.issueCount ?? healthFindings(job).length)} 项问题`, "health-muted");
    button.append(title, meta);
    elements.healthHistoryList.append(button);
  });
}

async function handleHealthHistoryClick(event) {
  const button = event.target.closest("button[data-job-id]");
  if (!button) return;
  try {
    state.healthJob = await fetchHealthJob(button.dataset.jobId);
    state.healthActions.clear();
    state.healthDraftActions.clear();
    state.healthFeedback?.clear();
    renderHealthJob();
    showHealthView("results");
  } catch (error) {
    showToastMessage(readableError(error), "error");
  }
}

function healthFindings(job = state.healthJob) {
  if (!job) return [];
  const report = job.report || job.result || {};
  const local = Array.isArray(job.findings) ? job.findings : Array.isArray(report.findings) ? report.findings : Array.isArray(report.issues) ? report.issues : [];
  const remote = (job.remoteResults || []).map((result) => ({
    id: `remote:${result.item.itemId}`,
    kind: result.category === "ok" ? "remote_ok" : result.category === "permanent_redirect" ? "permanent_redirect"
      : result.category === "temporary_redirect" ? "temporary_redirect" : result.category === "auth_required" ? "unauthorized"
        : result.category === "not_found" ? "dead_link" : "broken",
    message: result.error || healthStatusLabel(String(result.status ?? result.category)),
    item: result.item,
    items: [result.item],
    itemId: result.item.itemId,
    groupId: result.item.groupId,
    groupName: result.item.groupName,
    url: result.item.url,
    status: result.status ?? result.category,
    location: result.location,
    remoteCategory: result.category
  }));
  // Old scans may have marked parent containers as empty; reconcile these with the live catalog.
  const currentGroups = state.catalog?.groups || [];
  const parents = new Set(currentGroups.map((group) => group.parentId).filter(Boolean));
  return [...local, ...remote].filter((finding) => {
    if (healthIssueType(finding) !== "empty_group") return true;
    const group = currentGroups.find((entry) => entry.id === finding.groupId);
    return !group || (!group.items.length && !parents.has(group.id));
  });
}

function populateHealthFilters() {
  const findings = healthFindings();
  fillHealthSelect(elements.healthIssueFilter, findings.map(healthIssueType), (value) => HEALTH_ISSUE_LABELS[value] || value);
  fillHealthSelect(elements.healthGroupFilter, findings.flatMap(healthFindingGroupIds), healthGroupLabel);
  fillHealthSelect(elements.healthDomainFilter, findings.map(healthDomain), String);
  fillHealthSelect(elements.healthStatusFilter, findings.map(healthFindingStatus), healthStatusLabel);
}

function fillHealthSelect(select, values, labeler) {
  const current = select.value;
  while (select.options.length > 1) select.remove(1);
  [...new Set(values.filter(Boolean))].sort().forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = labeler(value);
    select.append(option);
  });
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderHealthFindings() {
  const findings = healthFindings().filter(healthFindingMatchesFilters);
  elements.healthFindingList.replaceChildren();
  elements.healthApplyPreview.hidden = true;
  const aiCount = selectedHealthAiItems().length;
  elements.healthFindingSummary.textContent = state.healthJob ? `${findings.length} 项符合当前筛选，${state.healthActions.size} 项已勾选（${aiCount} 项待交给 AI，${Math.max(0, [...state.healthActions.values()].filter((entry) => !entry.action).length - aiCount)} 项待指定处理）` : "请先选择历史任务";
  document.querySelector("#health-advisory-panel").hidden = true;
  if (!findings.length) {
    elements.healthFindingList.append(healthText(state.healthJob ? "当前筛选下没有问题。" : "从历史任务中打开一份报告。", "health-empty"));
    return;
  }
  const primary = findings.filter((finding) => !healthIsAdvisory(finding));
  const advisory = findings.filter(healthIsAdvisory);
  if (!primary.length) elements.healthFindingList.append(healthText("当前范围没有需要处理的重复、空分组或地址问题。", "health-empty"));
  primary.forEach((finding, index) => elements.healthFindingList.append(renderHealthFinding(finding, index)));
  const panel = document.querySelector("#health-advisory-panel");
  const list = document.querySelector("#health-advisory-list");
  list.replaceChildren();
  panel.hidden = !advisory.length;
  document.querySelector("#health-advisory-summary").textContent = `资料缺失与参考提示（${advisory.length} 项）`;
  advisory.forEach((finding, index) => list.append(renderHealthFinding(finding, index)));
}

function healthFindingMatchesFilters(finding) {
  return (!elements.healthIssueFilter.value || healthIssueType(finding) === elements.healthIssueFilter.value)
    && (!elements.healthGroupFilter.value || healthFindingGroupIds(finding).includes(elements.healthGroupFilter.value))
    && (!elements.healthDomainFilter.value || healthDomain(finding) === elements.healthDomainFilter.value)
    && (!elements.healthStatusFilter.value || healthFindingStatus(finding) === elements.healthStatusFilter.value);
}

function healthIsAdvisory(finding) {
  return ["missing_metadata", "possible_duplicate", "suspected_duplicate", "duplicate_title", "duplicate", "remote_ok", "unauthorized"].includes(healthIssueType(finding));
}

function healthMissingTextItem(finding) {
  if (healthIssueType(finding) !== "missing_metadata") return null;
  const ref = healthComparedItems(finding)[0];
  const item = state.catalog.groups.flatMap((group) => group.items).find((entry) => entry.id === (ref?.itemId || ref?.id));
  return item && (!item.title?.trim() || !item.description?.trim()) ? item : null;
}

function healthFindingSelectable(finding) {
  return healthIssueType(finding) === "missing_metadata" ? Boolean(healthMissingTextItem(finding)) : !healthIsAdvisory(finding);
}

function selectedHealthAiItems() {
  const selected = new Set(state.healthActions.keys());
  const items = healthFindings().filter((finding) => selected.has(healthFindingId(finding))).map(healthMissingTextItem).filter(Boolean);
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

async function transferHealthToAi() {
  const items = selectedHealthAiItems();
  if (!items.length) { showToastMessage("请先选择缺少标题或介绍的书签；仅缺图标的条目请在编辑书签中处理", "error"); return; }
  const fields = ["title", "description"].filter((field) => items.some((item) => !item[field]?.trim()));
  closeHealthCenter();
  await openAiOrganizer({ ids: items.map((item) => item.id), fields });
}

function healthAppliedOperation(finding) {
  const operations = (state.healthJob?.changeSets || []).flatMap((changeSet) => changeSet.operations || []);
  const rows = state.catalog.groups.flatMap((group) => group.items.map((item) => ({ item, group })));
  return operations.slice().reverse().find((operation) => {
    if (operation.actionId !== healthFindingId(finding)) return false;
    const current = rows.find(({ item }) => item.id === operation.itemId);
    if (operation.type === "delete_empty_group") return !state.catalog.groups.some((group) => group.id === operation.groupId);
    if (operation.type === "delete_item") return !current;
    if (!current) return false;
    if (operation.type === "replace_url") return current.item.url === operation.after;
    if (operation.type === "move_item") return current.group.id === operation.after;
    if (operation.type === "fill_metadata") return ["title", "description", "icon"].every((field) => (current.item[field] || "") === (operation.after?.[field] || ""));
    return false;
  });
}

function renderHealthFinding(finding, index) {
  const card = document.createElement("article");
  card.className = `health-finding-card${state.healthActions.has(healthFindingId(finding)) ? " is-selected" : ""}`;
  const findingId = healthFindingId(finding);
  const applied = healthAppliedOperation(finding);
  const recommendation = recommendedHealthAction(finding);
  const draft = state.healthDraftActions.get(findingId);
  const selected = state.healthActions.get(findingId);
  const header = document.createElement("header");
  const heading = document.createElement("div");
  const selection = document.createElement("label");
  selection.className = "health-finding-selection";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.healthSelectFinding = findingId;
  checkbox.checked = Boolean(selected) && !applied;
  checkbox.disabled = Boolean(applied) || !healthFindingSelectable(finding);
  selection.append(checkbox, healthText("选择此项"));
  heading.append(selection, healthText(HEALTH_ISSUE_LABELS[healthIssueType(finding)] || healthIssueType(finding), "health-issue-badge"));
  const title = document.createElement("h4");
  title.textContent = finding.title || finding.item?.title || finding.message || `健康问题 ${index + 1}`;
  heading.append(title);
  header.append(heading, healthText(finding.explanation || finding.reason || healthFindingExplanation(finding), "health-muted"));
  card.append(header);

  const compared = healthComparedItems(finding);
  if (compared.length > 1) {
    const comparison = document.createElement("div");
    comparison.className = "health-duplicate-grid";
    compared.slice(0, 2).forEach((item, itemIndex) => comparison.append(renderComparedItem(item, itemIndex === 0 ? "记录 A" : "记录 B")));
    card.append(comparison);
  } else if (compared[0]) card.append(renderComparedItem(compared[0], "目标书签"));

  const feedback = state.healthFeedback?.get(findingId);
  if (applied) {
    card.append(healthText(applied.type === "fill_metadata" ? "已补充可获取资料 · 本次报告已处理，如仍有缺失请重新扫描或使用 AI 整理" : "已应用 · 本次报告已处理", "health-recommendation"));
    return card;
  }
  if (feedback) card.append(healthText(feedback, "health-recommendation"));
  if (finding.redirectUrl || finding.targetUrl || finding.location) {
    card.append(healthText(`建议新地址：${finding.redirectUrl || finding.targetUrl || finding.location}`, "health-redirect-target"));
  }
  if (healthIsAdvisory(finding)) {
    card.append(healthText(healthIssueType(finding) === "missing_metadata" ? "资料补全由 AI 整理处理；标题与介绍已完整的条目无需转交，图标请在编辑书签中维护。" : "仅供参考：同名或相似地址不代表重复，不提供自动删除。", "health-muted"));
    return card;
  }
  const control = document.createElement("label");
  control.className = "field health-action-field";
  const label = document.createElement("span");
  label.textContent = "处理方式";
  const select = document.createElement("select");
  select.dataset.findingId = findingId;
  select.append(new Option("暂不处理（默认）", ""));
  healthActionOptions(finding).forEach(([value, text]) => select.append(new Option(text, value)));
  select.value = selected?.action ?? draft?.action ?? recommendation?.action ?? "";
  control.append(label, select);
  if (recommendation) control.append(healthText("已显示推荐动作，勾选此项后才会应用。", "health-recommendation"));
  card.append(control);
  if (select.value === "move_item") card.append(renderHealthMoveTarget(finding));
  return card;
}

function renderComparedItem(item, label) {
  const currentGroup = state.catalog.groups.find((group) => group.items.some((entry) => entry.id === (item.itemId || item.id)));
  const current = currentGroup?.items.find((entry) => entry.id === (item.itemId || item.id));
  if (current) item = { ...item, ...current, groupName: currentGroup.name };
  const box = document.createElement("section");
  box.className = "health-compared-item";
  box.append(healthText(label, "eyebrow"));
  const title = document.createElement("strong");
  title.textContent = item.title || "未命名书签";
  const url = healthText(item.url || item.remoteUrl || "无地址", "health-url");
  const detail = healthText(`${item.groupName || item.group?.name || "未分组"} · ${(item.tags || []).length} 个标签${item.description ? " · 有介绍" : " · 无介绍"}`, "health-muted");
  box.append(title, url, detail);
  return box;
}

function healthActionOptions(finding) {
  const type = healthIssueType(finding);
  if (["possible_duplicate", "suspected_duplicate", "duplicate_title", "duplicate"].includes(type)) return [];
  if (type === "exact_duplicate") {
    return healthComparedItems(finding).slice(0, 2).map((item, index) => [`delete_item:${item.id || item.itemId}`, `保留${index === 0 ? " B" : " A"}，删除${index === 0 ? " A" : " B"}`]);
  }
  if (["redirect", "permanent_redirect", "temporary_redirect"].includes(type)) return [["replace_url", "替换为重定向后地址"]];
  if (["broken", "dead_link"].includes(type)) return [["delete_item", "删除该书签"], ["move_item", "移动到其他分组"]];
  if (type === "missing_metadata") return [];
  if (type === "empty_group") return [["delete_empty_group", "删除空分组"]];
  if (["remote_ok", "unauthorized"].includes(type)) return [];
  if (healthComparedItems(finding)[0]) return [["move_item", "移动到其他分组"]];
  return [];
}

function renderHealthMoveTarget(finding) {
  const field = document.createElement("label");
  field.className = "field health-move-target";
  field.append(healthText("目标分组"));
  const select = document.createElement("select");
  select.dataset.healthTargetFor = healthFindingId(finding);
  select.append(new Option("请选择分组", ""));
  state.catalog.groups.filter((group) => group.id !== finding.groupId).forEach((group) => select.append(new Option(group.name, group.id)));
  select.value = state.healthActions.get(healthFindingId(finding))?.targetGroupId || state.healthDraftActions.get(healthFindingId(finding))?.targetGroupId || "";
  field.append(select);
  return field;
}

function handleHealthActionChange(event) {
  const checkbox = event.target.closest("input[data-health-select-finding]");
  if (checkbox) {
    const finding = healthFindings().find((entry) => healthFindingId(entry) === checkbox.dataset.healthSelectFinding);
    if (!finding || !healthFindingSelectable(finding) || healthAppliedOperation(finding)) return;
    const draft = state.healthDraftActions.get(checkbox.dataset.healthSelectFinding) || recommendedHealthAction(finding);
    if (checkbox.checked) state.healthActions.set(checkbox.dataset.healthSelectFinding, { findingId: checkbox.dataset.healthSelectFinding, action: "", ...draft });
    else state.healthActions.delete(checkbox.dataset.healthSelectFinding);
    elements.healthApplyPreview.hidden = true;
    renderHealthFindings();
    return;
  }
  const select = event.target.closest("select[data-finding-id]");
  const target = event.target.closest("select[data-health-target-for]");
  if (target) {
    const draft = state.healthDraftActions.get(target.dataset.healthTargetFor) || { action: "move_item" };
    draft.targetGroupId = target.value;
    state.healthDraftActions.set(target.dataset.healthTargetFor, draft);
    const current = state.healthActions.get(target.dataset.healthTargetFor);
    if (current) current.targetGroupId = target.value;
    elements.healthApplyPreview.hidden = true;
    return;
  }
  if (!select) return;
  state.healthDraftActions.set(select.dataset.findingId, { action: select.value });
  if (state.healthActions.has(select.dataset.findingId)) state.healthActions.set(select.dataset.findingId, { findingId: select.dataset.findingId, action: select.value });
  else state.healthActions.delete(select.dataset.findingId);
  elements.healthApplyPreview.hidden = true;
  renderHealthFindings();
}

function selectFilteredHealthFindings() {
  healthFindings().filter(healthFindingMatchesFilters).forEach((finding) => {
    if (healthAppliedOperation(finding) || !healthFindingSelectable(finding)) return;
    const id = healthFindingId(finding);
    const draft = state.healthDraftActions.get(id) || recommendedHealthAction(finding);
    state.healthActions.set(id, { findingId: id, action: "", ...draft });
  });
  renderHealthFindings();
}

function recommendFilteredHealthFindings() {
  let count = 0;
  healthFindings().filter(healthFindingMatchesFilters).forEach((finding) => {
    const recommendation = recommendedHealthAction(finding);
    if (!recommendation) return;
    const id = healthFindingId(finding);
    state.healthDraftActions.set(id, recommendation);
    state.healthActions.set(id, { findingId: id, ...recommendation });
    count++;
  });
  renderHealthFindings();
  showToastMessage(`已选择 ${count} 项永久跳转修正；请预览后应用`);
}

function clearHealthSelection() {
  state.healthActions.clear();
  elements.healthApplyPreview.hidden = true;
  renderHealthFindings();
}

function recommendedHealthAction(finding) {
  if (!finding || healthAppliedOperation(finding)) return null;
  const type = healthIssueType(finding);
  if (type === "permanent_redirect" && (finding.redirectUrl || finding.targetUrl || finding.location)) return { action: "replace_url" };
  return null;
}

function completenessScore(item) {
  return [item.title, item.description, item.icon, item.localUrl].filter((value) => String(value || "").trim()).length
    + Math.min(2, Array.isArray(item.tags) ? item.tags.length : 0);
}

function uniqueHealthActionPayloads() {
  const payloads = [];
  const touchedItems = new Set();
  const signatures = new Set();
  for (const selection of state.healthActions.values()) {
    const payload = healthActionPayload(selection);
    if (!payload) continue;
    if (payload.itemId && touchedItems.has(payload.itemId)) continue;
    const signature = [payload.type, payload.itemId || payload.groupId, payload.url || "", payload.targetGroupId || ""].join(":");
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    if (payload.itemId) touchedItems.add(payload.itemId);
    payloads.push(payload);
  }
  return payloads;
}

function previewHealthActions() {
  const actions = uniqueHealthActionPayloads();
  if (!actions.length) {
    showToastMessage(selectedHealthAiItems().length ? "选中的是资料缺失项，请点击“将选中缺失项交给 AI”" : "请先为待处理的问题选择处理方式", "error");
    return;
  }
  const destructive = actions.filter((entry) => /delete|keep_|merge_/.test(entry.type)).length;
  const updates = actions.length - destructive;
  elements.healthApplySummary.textContent = `共 ${actions.length} 项：${destructive} 项包含删除或合并，${updates} 项更新。应用前服务端将创建写前备份。`;
  const pending = [...state.healthActions.values()].filter((entry) => !entry.action).length;
  elements.healthApplySummary.textContent += pending ? ` ${pending} 项未指定动作，将跳过。` : "";
  elements.healthApplyPreview.hidden = false;
  elements.healthApplyPreview.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function applyHealthActions() {
  if (!state.healthJob?.id || !state.healthActions.size) return;
  setButtonBusy(elements.confirmHealthApply, true, "正在应用");
  try {
    const actions = uniqueHealthActionPayloads();
    if (!actions.length) { showToastMessage("当前没有可应用的变更", "error"); return; }
    if (actions.some((action) => action.type === "move_item" && !action.targetGroupId)) {
      showToastMessage("请为移动动作选择目标分组", "error");
      return;
    }
    const response = await apiRequest(`/health/jobs/${encodeURIComponent(state.healthJob.id)}/apply`, {
      method: "POST", body: { actions }
    });
    if (response.catalog?.version) state.catalog = NavManageCore.normalizeCatalog(response.catalog);
    state.healthChangeSet = response.changeSet || null;
    if (response.job) state.healthJob = response.job;
    else if (response.changeSet?.changeSetId) {
      state.healthJob.changeSets ??= [];
      state.healthJob.changeSets.push(response.changeSet);
    }
    state.healthFeedback ??= new Map();
    for (const action of actions) {
      const conflict = response.changeSet?.conflicts?.find((entry) => entry.actionId === action.id);
      const applied = response.changeSet?.operations?.some((entry) => entry.actionId === action.id);
      state.healthFeedback.set(action.id, conflict ? "未应用：目录内容已变化或目标不可用，请重新扫描" : applied ? "已应用" : "未修改：没有可写入的变更，请重新扫描");
    }
    state.healthActions.clear();
    state.healthDraftActions.clear();
    renderHealthJob();
    renderHealthFindings();
    renderHealthChangeSet();
    renderCatalog();
    showToastMessage(`已应用 ${response.changeSet?.operations?.length ?? 0} 项处理，${response.changeSet?.conflicts?.length ?? 0} 项冲突未应用`);
  } catch (error) {
    showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(elements.confirmHealthApply, false, "确认应用");
  }
}

function healthActionPayload(selection) {
  if (!selection.action) return null;
  const finding = healthFindings().find((entry) => healthFindingId(entry) === selection.findingId) || {};
  if (healthAppliedOperation(finding)) return null;
  const compared = healthComparedItems(finding);
  const selectedItemId = selection.action.startsWith("delete_item:") ? selection.action.split(":").slice(1).join(":") : finding.itemId || finding.item?.id || compared[0]?.itemId || compared[0]?.id;
  const selectedItem = compared.find((item) => String(item.id || item.itemId) === String(selectedItemId)) || finding.item || finding;
  const action = selection.action.split(":")[0];
  if (action === "fill_metadata") return null; // Historical operations remain readable, but new enrichment uses AI.
  if (action === "replace_url") {
    const expectedUrl = finding.url || selectedItem.url;
    const target = finding.redirectUrl || finding.targetUrl || finding.location || finding.details?.targetUrl;
    let url = target;
    try { url = new URL(target, expectedUrl).toString(); } catch { /* 由服务端完成最终校验 */ }
    return { id: selection.findingId, type: action, itemId: selectedItemId, expectedUrl, url };
  }
  if (action === "move_item") return { id: selection.findingId, type: action, itemId: selectedItemId, expectedGroupId: finding.groupId || selectedItem.groupId, targetGroupId: selection.targetGroupId };
  if (action === "delete_empty_group") return { id: selection.findingId, type: action, groupId: finding.groupId, expectedName: healthGroupLabel(finding.groupId) || finding.groupName || finding.title };
  return { id: selection.findingId, type: "delete_item", itemId: selectedItemId, expectedGroupId: selectedItem.groupId || finding.groupId, expectedUrl: selectedItem.url || finding.url };
}

function renderHealthChangeSet() {
  const changeSet = state.healthChangeSet;
  elements.healthChangeSetPanel.hidden = !changeSet?.changeSetId;
  if (!changeSet?.changeSetId) return;
  elements.healthChangeSetSummary.textContent = `${(changeSet.operations || []).length} 项操作，${(changeSet.conflicts || []).length} 项冲突未应用。恢复前会再次备份当前目录。`;
}

async function restoreHealthChangeSet() {
  const id = state.healthChangeSet?.changeSetId;
  if (!id) return;
  setButtonBusy(elements.restoreHealthChangeSet, true, "正在恢复");
  try {
    const response = await apiRequest(`/health/change-sets/${encodeURIComponent(id)}/restore`, { method: "POST", body: {} });
    if (response.catalog) state.catalog = NavManageCore.normalizeCatalog(response.catalog);
    await loadCatalog().catch(() => {});
    elements.healthChangeSetPanel.hidden = true;
    state.healthFeedback?.clear();
    renderHealthFindings();
    showToastMessage("变更集已完整恢复");
  } catch (error) {
    showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(elements.restoreHealthChangeSet, false, "恢复整个变更集");
  }
}

async function downloadBookmarks(format) {
  const button = format === "html" ? elements.exportHtml : elements.exportJson;
  setButtonBusy(button, true, "正在导出");
  try {
    const response = await fetch(`${API_ROOT}/bookmarks/export?format=${format}`, { credentials: "same-origin", headers: { Accept: format === "json" ? "application/json" : "text/html" } });
    if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `qiye-bookmarks-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(button, false, format === "html" ? "导出 HTML" : "导出 JSON");
  }
}

function resetImportPreview() {
  state.importPreview = null;
  state.importSource = null;
  elements.importPreviewPanel.hidden = true;
  elements.importError.textContent = "";
  const file = elements.importFile.files?.[0];
  elements.importFileName.textContent = file?.name || "未选择文件";
  const json = Boolean(file && (/json$/i.test(file.name) || file.type === "application/json"));
  elements.jsonRestoreOption.hidden = !json;
  if (!json) elements.jsonRestore.checked = false;
}

async function previewBookmarkImport() {
  const file = elements.importFile.files?.[0];
  if (!file) {
    elements.importError.textContent = "请先选择 HTML 或 JSON 文件";
    return;
  }
  const format = /json$/i.test(file.name) || file.type === "application/json" ? "json" : "html";
  setButtonBusy(elements.previewImport, true, "正在预览");
  elements.importError.textContent = "";
  try {
    state.importSource = { format, content: await file.text(), filename: file.name };
    const response = await apiRequest("/bookmarks/import/preview", { method: "POST", body: { ...state.importSource, restore: elements.jsonRestore.checked }, versioned: false });
    state.importPreview = response.preview || response;
    renderImportPreview();
  } catch (error) {
    elements.importError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.previewImport, false, "生成导入预览");
  }
}

function renderImportPreview() {
  const preview = state.importPreview || {};
  const counts = preview.counts || preview.summary || preview;
  const metrics = [
    ["新增书签", counts.new ?? counts.added ?? counts.newItems ?? 0],
    ["已有重复", counts.duplicates ?? counts.duplicate ?? 0],
    ["资料冲突", counts.conflicts ?? counts.conflict ?? 0],
    ["新建分组", counts.newGroups ?? counts.groups ?? 0]
  ];
  elements.importPreviewSummary.textContent = `已解析 ${Number(counts.sourceItems ?? counts.total ?? counts.parsed ?? metrics[0][1] + metrics[1][1])} 条书签`;
  if (elements.jsonRestore.checked && preview.expectedCounts) {
    elements.importPreviewSummary.textContent = `完整恢复将写入 ${preview.expectedCounts.groups} 个分组、${preview.expectedCounts.items} 条书签`;
    metrics.splice(0, metrics.length,
      ["备份分组", preview.expectedCounts.groups],
      ["备份书签", preview.expectedCounts.items],
      ["替换现有目录", preview.replacingNonEmptyCatalog ? "是" : "否"],
      ["内容校验", preview.expectedHash ? "已通过" : "未提供"]
    );
  }
  elements.importPreviewDetails.replaceChildren();
  metrics.forEach(([label, value]) => {
    const metric = document.createElement("div");
    metric.className = "import-preview-metric";
    metric.append(healthText(String(value), "metric-number"), healthText(label));
    elements.importPreviewDetails.append(metric);
  });
  elements.importPreviewPanel.hidden = false;
  setButtonVisual(elements.applyImport, elements.jsonRestore.checked ? "确认替换并恢复" : "确认增量导入");
  elements.importPreviewPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function applyBookmarkImport() {
  if (!state.importPreview || !state.importSource) return;
  const plannedNewItems = Number(state.importPreview.counts?.newItems ?? 0);
  const restoring = elements.jsonRestore.checked;
  setButtonBusy(elements.applyImport, true, "正在导入");
  try {
    const response = await apiRequest("/bookmarks/import/apply", {
      method: "POST", body: { ...state.importSource, confirmed: true, restore: elements.jsonRestore.checked }
    });
    await loadCatalog();
    if (response.result?.changeSetId) {
      state.healthChangeSet = { ...response.result, operations: [], conflicts: [] };
      renderHealthChangeSet();
    }
    showToastMessage(restoring ? "JSON 备份已完整恢复" : `导入完成，新增 ${plannedNewItems} 条书签`);
    elements.importFile.value = "";
    resetImportPreview();
  } catch (error) {
    elements.importError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.applyImport, false, elements.jsonRestore.checked ? "确认替换并恢复" : "确认增量导入");
  }
}

function healthFindingId(finding) { return String(finding.id || finding.findingId || finding.issueId || `${healthIssueType(finding)}:${finding.itemId || finding.groupId || healthDomain(finding)}`); }
function healthIssueType(finding) { return String(finding.type || finding.issueType || finding.kind || "unknown"); }
function healthComparedItems(finding) {
  const unique = new Map();
  [finding.item || (finding.itemId ? finding : null), ...(finding.relatedItems || finding.items || finding.candidates || [])].filter(Boolean).forEach((item) => {
    const id = String(item.id || item.itemId || `${item.groupId || ""}:${item.url || ""}`);
    if (!unique.has(id)) unique.set(id, item);
  });
  return [...unique.values()];
}
function healthDomain(finding) {
  const raw = finding.domain || healthComparedItems(finding)[0]?.url || finding.url;
  try { return new URL(raw).hostname; } catch { return raw || ""; }
}
function healthFindingGroupIds(finding) { return [...new Set([finding.groupId, ...healthComparedItems(finding).map((item) => item.groupId)].filter(Boolean))]; }
function healthGroupLabel(groupId) { return state.catalog.groups.find((group) => group.id === groupId)?.name || groupId; }
function healthFindingStatus(finding) { return String(finding.status ?? finding.httpStatus ?? finding.statusCode ?? finding.details?.status ?? ""); }
function healthStatusLabel(value) {
  const labels = { ok: "正常 2xx", permanent_redirect: "永久重定向", temporary_redirect: "临时重定向", unauthorized: "需要登录 401/403", not_found: "失效 404/410", timeout: "请求超时", dns_error: "DNS 错误", skipped_private: "已跳过私网" };
  return labels[value] || (/^2\d\d$/.test(value) ? `正常 HTTP ${value}` : /^3\d\d$/.test(value) ? `重定向 HTTP ${value}` : /^\d+$/.test(value) ? `HTTP ${value}` : value);
}
function healthFindingExplanation(finding) {
  if (healthIssueType(finding) === "empty_group") return "没有网址，也没有子分组；可按需删除。作为目录容器的父分组不算空分组。";
  const status = finding.httpStatus || finding.statusCode;
  if (status === 401 || status === 403) return `HTTP ${status} 表示需要登录，不会当作死链。`;
  if (status) return `检查返回 HTTP ${status}。`;
  return "请核对书签内容后选择处理方式。";
}
function healthText(value, className = "") { const element = document.createElement("p"); element.textContent = value; if (className) element.className = className; return element; }
function formatHealthDate(value) { if (!value) return "时间未知"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false }); }
