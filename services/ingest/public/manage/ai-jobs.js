"use strict";

async function openAiOrganizer(itemScope = null) {
  state.aiItemScope = itemScope;
  if (itemScope) {
    elements.aiGroupStrategy.value = "existing";
    document.querySelectorAll('input[name="ai-field"]').forEach((input) => { input.checked = itemScope.fields.includes(input.value); });
  }
  document.querySelectorAll('input[name="ai-field"]').forEach((input) => { input.disabled = Boolean(itemScope); });
  elements.aiGroupStrategy.disabled = Boolean(itemScope);
  clearTimeout(state.aiPollTimer);
  elements.aiSetupError.textContent = "";
  elements.aiApplyError.textContent = "";
  populateAiGroups();
  updateAiScopeControls();
  elements.aiDialog.showModal();
  try {
    const [config, result] = await Promise.all([
      apiRequest("/ai/config"),
      apiRequest("/ai/jobs?limit=20&offset=0")
    ]);
    state.aiConfig = config;
    const jobs = Array.isArray(result?.jobs) ? result.jobs : [];
    state.aiHistoryOffset = jobs.length;
    state.aiHistoryHasMore = Number.isInteger(result?.nextOffset);
    renderAiHistory(jobs, true);
    if (!config.configured) {
      showAiView("setup");
      elements.aiSetupError.textContent = "请先在站点设置中保存并测试 AI 模型配置";
      elements.prepareAiJob.disabled = true;
      return;
    }
    elements.prepareAiJob.disabled = false;
    const latest = jobs
      .filter((job) => ["queued", "running", "partial", "failed", "completed"].includes(job.status))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
    if (latest && !state.aiItemScope) {
      state.aiLogs = [];
      state.aiLogSequence = 0;
      const detail = await apiRequest(`/ai/jobs/${segment(latest.id)}`);
      renderAiJob(detail);
      showAiView("current");
      await loadAiLogs(detail.id, true);
    } else showAiView("setup");
  } catch (error) {
    showAiView("setup");
    elements.aiSetupError.textContent = readableError(error);
  }
}

function closeAiOrganizer() {
  clearTimeout(state.aiPollTimer);
  state.aiPollTimer = null;
  if (elements.aiDialog.open) elements.aiDialog.close();
}

function handleAiViewTabClick(event) {
  const button = event.target.closest("button[data-ai-view]");
  if (!button) return;
  showAiView(button.dataset.aiView);
}

function showAiView(view) {
  const target = view === "current" && !state.aiJob ? "setup" : view;
  state.aiView = target;
  elements.aiSetupView.hidden = target !== "setup";
  elements.aiJobView.hidden = target !== "current";
  elements.aiHistoryView.hidden = target !== "history";
  if (target !== "current") {
    clearTimeout(state.aiPollTimer);
    state.aiPollTimer = null;
  }
  elements.aiViewTabs.querySelectorAll("button[data-ai-view]").forEach((button) => {
    if (button.dataset.aiView === target) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
    if (button.dataset.aiView === "current") button.disabled = !state.aiJob;
  });
  if (target === "setup") {
    elements.aiStartConfirmation.hidden = true;
    elements.prepareAiJob.hidden = false;
    elements.aiApplyError.textContent = "";
    populateAiGroups();
    updateAiScopeControls();
    updateAiGroupingControls();
  }
  if (target === "history" && !elements.aiHistoryList.children.length) void loadAiHistory(true);
  if (target === "current" && state.aiJob) renderAiJob(state.aiJob);
}

function populateAiGroups() {
  const previous = elements.aiSingleGroup.value || state.currentGroupId;
  elements.aiSingleGroup.replaceChildren();
  elements.aiMultipleGroups.replaceChildren();
  for (const group of NavManageCore.orderedGroupTree(state.catalog)) {
    const path = NavManageCore.groupPath(state.catalog, group);
    const childCount = state.catalog.groups.filter((candidate) => candidate.parentId === group.id)
      .reduce((total, child) => total + child.items.length, 0);
    const totalCount = group.items.length + childCount;
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = `${path}（${totalCount}）`;
    elements.aiSingleGroup.append(option);

    const label = document.createElement("label");
    label.className = "choice-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = group.id;
    input.name = "ai-group";
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = path;
    const count = document.createElement("small");
    count.textContent = `${totalCount} 个网址${childCount ? "，含子分组" : ""}`;
    copy.append(name, count);
    label.append(input, copy);
    elements.aiMultipleGroups.append(label);
  }
  if (state.catalog.groups.some((group) => group.id === previous)) elements.aiSingleGroup.value = previous;
}

function currentAiScopeType() {
  if (state.aiItemScope) return "items";
  return document.querySelector('input[name="ai-scope"]:checked')?.value || "single";
}

function updateAiScopeControls() {
  const type = currentAiScopeType();
  document.querySelector("#ai-item-scope-panel").hidden = type !== "items";
  document.querySelector("#ai-group-scope-controls").hidden = type === "items";
  if (state.aiItemScope) {
    const ids = new Set(state.aiItemScope.ids);
    const items = state.catalog.groups.flatMap((group) => group.items).filter((item) => ids.has(item.id));
    document.querySelector("#ai-item-scope-copy").textContent = `${items.length} 个书签：${items.map((item) => `${item.title || item.url}（缺${state.aiItemScope.fields.filter((field) => !item[field]?.trim()).map((field) => field === "title" ? "标题" : "介绍").join("、")}）`).join("；")}。已有内容保留，建议需审核后应用。`;
  }
  elements.aiSingleGroupField.hidden = type !== "single";
  elements.aiMultipleGroups.hidden = type !== "multiple";
  updateAiScopeSummary();
}

function selectedAiGroupIds() {
  if (state.aiItemScope) return state.catalog.groups.filter((group) => group.items.some((item) => state.aiItemScope.ids.includes(item.id))).map((group) => group.id);
  const type = currentAiScopeType();
  if (type === "all") return state.catalog.groups.map((group) => group.id);
  const selected = type === "single"
    ? (elements.aiSingleGroup.value ? [elements.aiSingleGroup.value] : [])
    : [...elements.aiMultipleGroups.querySelectorAll('input[name="ai-group"]:checked')].map((input) => input.value);
  const ids = new Set(selected);
  for (const group of state.catalog.groups) if (group.parentId && ids.has(group.parentId)) ids.add(group.id);
  return [...ids];
}

function updateAiScopeSummary() {
  if (state.aiItemScope) {
    const count = state.aiItemScope.ids.length;
    elements.aiScopeSummary.textContent = `仅分析选中的 ${count} 个书签，只补缺失字段`;
    return count;
  }
  const ids = new Set(selectedAiGroupIds());
  const count = state.catalog.groups
    .filter((group) => ids.has(group.id))
    .reduce((total, group) => total + group.items.length, 0);
  elements.aiScopeSummary.textContent = `将分析 ${count} 个网址`;
  return count;
}

function selectedAiFields() {
  return [...document.querySelectorAll('input[name="ai-field"]:checked')].map((input) => input.value);
}

function updateAiGroupingControls() {
  const enabled = elements.aiGroupStrategy.value !== "existing";
  elements.aiGroupingOptions.hidden = !enabled;
  document.querySelector("#ai-destination-field").hidden = enabled || Boolean(state.aiItemScope);
  document.querySelector("#ai-strategy-field").hidden = Boolean(state.aiItemScope);
}

function prepareAiJob() {
  elements.aiSetupError.textContent = "";
  const count = updateAiScopeSummary();
  const fields = selectedAiFields();
  if (!selectedAiGroupIds().length) {
    elements.aiSetupError.textContent = "请至少选择一个分组";
    return;
  }
  if (!count) {
    elements.aiSetupError.textContent = "选择范围内没有可整理的网址";
    return;
  }
  if (!fields.length) {
    elements.aiSetupError.textContent = "请至少选择一个建议字段";
    return;
  }
  if (elements.aiGroupStrategy.value !== "existing" && !fields.includes("groupId")) {
    elements.aiSetupError.textContent = "平衡重组或完全重建需要同时选择“分组”字段";
    return;
  }
  if (elements.aiGroupStrategy.value !== "existing") {
    try {
      const options = readAiGroupingOptions(count);
      const mode = options.automatic ? "自动预计" : "计划";
      elements.aiConfirmSummary.textContent = `${count} 个网址，${fields.length} 类字段；${mode} ${options.resolved.targetGroupCount} 个目标分组，容量 ${options.resolved.minGroupSize} 至 ${options.resolved.maxGroupSize}。分析只生成建议，不会直接修改目录。`;
    } catch (error) {
      elements.aiSetupError.textContent = error.message;
      return;
    }
  } else {
    elements.aiConfirmSummary.textContent = state.aiItemScope ? `${count} 个书签，仅补缺失的${fields.map((field) => field === "title" ? "标题" : "介绍").join("、")}；保留已有内容，不移动分组。分析只生成建议，审核后应用。` : `${count} 个网址，${fields.length} 类字段；允许移入${document.querySelector("#ai-destination-scope").value === "all" ? "全部现有分组" : "所选范围内分组（含子分组及父级）"}。分析只生成建议，不会直接修改目录。`;
  }
  elements.aiStartConfirmation.hidden = false;
  elements.prepareAiJob.hidden = true;
}

function readAiGroupingOptions(count) {
  return NavManageCore.aiGroupingOptions({
    targetGroupCount: elements.aiTargetGroupCount.value,
    minGroupSize: elements.aiMinGroupSize.value,
    maxGroupSize: elements.aiMaxGroupSize.value
  }, count, elements.aiGroupStrategy.value);
}

async function startAiJob() {
  const scopeType = currentAiScopeType();
  const ids = selectedAiGroupIds();
  const itemCount = updateAiScopeSummary();
  setButtonBusy(elements.confirmAiStart, true, "正在启动");
  elements.aiSetupError.textContent = "";
  try {
    const job = await apiRequest("/ai/jobs", {
      method: "POST",
      body: {
        scope: state.aiItemScope ? { type: "items", ids: state.aiItemScope.ids } : scopeType === "all" ? { type: "all" } : { type: "groups", ids },
        missingOnly: Boolean(state.aiItemScope),
        fields: selectedAiFields(),
        groupStrategy: elements.aiGroupStrategy.value,
        destinationScope: document.querySelector("#ai-destination-scope").value,
        allowNewGroups: elements.aiGroupStrategy.value !== "existing",
        groupingOptions: elements.aiGroupStrategy.value === "existing"
          ? {}
          : readAiGroupingOptions(itemCount).request
      },
      versioned: false
    });
    state.aiLogs = [];
    state.aiLogSequence = 0;
    renderAiJob(job);
    showAiView("current");
  } catch (error) {
    elements.aiSetupError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.confirmAiStart, false, "确认启动");
  }
}

function aiStatusLabel(status) {
  return {
    queued: "任务已排队",
    running: "正在分析网址",
    paused: "任务已暂停",
    completed: "分析完成",
    partial: "部分批次未完成",
    failed: "分析未完成",
    cancelled: "任务已取消",
    awaiting_review: "待审核",
    partially_applied: "部分已应用",
    applied: "已应用"
  }[status] || "任务状态未知";
}

function renderAiJob(job) {
  state.aiJob = job;
  const progress = job.progress || { total: 0, processed: 0, succeeded: 0, failed: 0 };
  const planning = job.planningProgress;
  const showingPlanning = Boolean(planning && (job.phase === "group_planning" || (!job.groupPlan && progress.processed === 0)));
  elements.aiJobStatus.textContent = aiStatusLabel(job.lifecycleStatus || job.status);
  elements.aiJobPhase.textContent = {
    queued: "任务排队",
    group_planning: "正在规划分组",
    topic_extraction: "正在提取主题",
    item_analysis: "正在逐项分析",
    aggregation: "正在汇总结果",
    applying: "正在应用变更",
    applied: "变更已应用",
    review: "分析结果"
  }[job.phase] || "任务进度";
  if (showingPlanning && job.status === "failed") elements.aiJobPhase.textContent = "分组规划中止";
  const shownTotal = showingPlanning ? planning.total : progress.total;
  const shownCompleted = showingPlanning ? planning.completed : progress.processed;
  elements.aiProgress.max = Math.max(1, shownTotal || 0);
  elements.aiProgress.value = Math.min(shownCompleted || 0, elements.aiProgress.max);
  elements.aiProgressRatio.textContent = `${shownCompleted || 0} / ${shownTotal || 0}`;
  elements.aiProgressCopy.textContent = job.phase === "group_planning"
    ? `已完成 ${planning?.completed || 0} 个网址的分组规划，逐网址字段分析尚未开始`
    : `${progress.succeeded || 0} 个网址已完成分析`;
  const plannedGroups = Array.isArray(job.groupPlan?.groups)
    ? job.groupPlan.groups.filter((group) => !group.existingGroupId && Number(group.itemCount) > 0).length
    : 0;
  const allSuggestions = Array.isArray(job.suggestions) ? job.suggestions : [];
  const pendingCount = allSuggestions.filter((entry) => entry.status === "pending").length;
  const appliedCount = allSuggestions.filter((entry) => entry.status === "applied").length;
  elements.aiKeptCount.textContent = `${job.decisionStats?.kept || 0} 项保持 · ${pendingCount} 项待应用 · ${appliedCount} 项已应用 · ${plannedGroups} 个拟新分组`;
  elements.aiFailureCount.textContent = showingPlanning && planning.failed
    ? `${planning.failed} 个网址规划待重试`
    : `${job.failures?.length || 0} 个失败批次`;
  renderAiFailures(job);
  renderAiChangeSets(job);
  const running = ["queued", "running"].includes(job.status);
  const retryable = ["partial", "failed"].includes(job.status) && (job.failures?.length || progress.failed);
  elements.cancelAiJob.hidden = !running;
  elements.pauseAiJob.hidden = job.status !== "running";
  elements.resumeAiJob.hidden = job.status !== "paused";
  elements.retryAiJob.hidden = !retryable;
  elements.deleteAiHistory.hidden = running || ["applied", "partially_applied"].includes(job.lifecycleStatus);
  renderAiProposedGroups(job);
  const suggestions = allSuggestions.filter((entry) => entry.status === "pending" || entry.status === "applied");
  elements.aiReviewSection.hidden = running || !suggestions.length;
  if (!elements.aiReviewSection.hidden) renderAiSuggestions(suggestions, job);
  if (!running && !suggestions.length) {
    elements.aiReviewSection.hidden = false;
    elements.aiSuggestionList.replaceChildren(createAiEmptyReview(job.status));
    elements.aiSuggestionCount.textContent = "0 项待应用 · 0 项已应用";
    elements.applyAiSuggestions.disabled = true;
  }
  elements.selectAllSuggestions.hidden = pendingCount === 0;
  elements.clearSuggestions.hidden = pendingCount === 0;
  elements.applyAiSuggestions.hidden = pendingCount === 0;
  clearTimeout(state.aiPollTimer);
  if (running && state.aiView === "current") state.aiPollTimer = setTimeout(() => void pollAiJob(job.id), 1400);
}

function renderAiChangeSets(job) {
  const history = Array.isArray(job.applyHistory) ? job.applyHistory : [];
  elements.aiChangeSetSection.hidden = history.length === 0;
  elements.aiChangeSetList.replaceChildren();
  for (const changeSet of history) {
    const row = document.createElement("div");
    row.className = "ai-log-entry";
    const title = document.createElement("strong");
    title.textContent = `${changeSet.appliedSuggestionIds?.length || 0} 项已应用 · ${changeSet.conflicts?.length || 0} 项冲突`;
    const detail = document.createElement("small");
    detail.textContent = `${changeSet.operations?.length || 0} 条变更 · ${formatAiDate(changeSet.appliedAt)}`;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "button button-secondary danger-text";
    restore.dataset.restoreChangeSet = changeSet.changeSetId;
    restore.textContent = "恢复整个变更集";
    row.append(title, detail, restore);
    elements.aiChangeSetList.append(row);
  }
}

function handleAiChangeSetClick(event) {
  const button = event.target.closest("button[data-restore-change-set]");
  if (!button) return;
  const changeSetId = button.dataset.restoreChangeSet;
  openConfirm({
    title: "恢复整个 AI 变更集？",
    message: "当前目录会先自动备份，然后完整恢复到该次应用前的版本。",
    label: "确认恢复",
    action: async () => {
      const result = await apiRequest(`/ai/change-sets/${segment(changeSetId)}/restore`, { method: "POST", body: {} });
      state.catalog = NavManageCore.normalizeCatalog(result.catalog);
      renderCatalog();
      showToastMessage("变更集已完整恢复");
    }
  });
}

function renderAiFailures(job) {
  const failures = Array.isArray(job.failures) ? job.failures : [];
  elements.aiFailureDetails.hidden = failures.length === 0;
  elements.aiFailureList.replaceChildren();
  if (!failures.length) return;
  const stage = job.groupPlan ? "逐网址分析" : job.planningProgress?.completed >= job.planningProgress?.total
    ? "合并目标分组" : "提取网址主题";
  elements.aiFailureSummary.textContent = `${stage}未完成；已保留前面成功的结果。`;
  for (const failure of failures) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = failure.batch > 0 ? `批次 ${failure.batch}` : stage;
    const message = document.createElement("span");
    message.textContent = aiFailureMessage(failure.error);
    const code = document.createElement("code");
    const range = Array.isArray(failure.itemIds) && failure.itemIds.length
      ? ` · ${failure.itemIds.length} 条` : "";
    const http = failure.httpStatus ? ` · HTTP ${failure.httpStatus}` : "";
    const requestId = failure.providerRequestId ? ` · request ${failure.providerRequestId}` : "";
    code.textContent = `${failure.error?.code || "ai_job_failed"}${range}${http}${requestId}`;
    item.append(title, message, code);
    if (failure.suggestedAction) {
      const advice = document.createElement("small");
      advice.textContent = failure.suggestedAction;
      item.append(advice);
    }
    elements.aiFailureList.append(item);
  }
  const messages = failures.map((failure) => String(failure.error?.message || ""));
  elements.aiFailureAdvice.textContent = messages.some((message) => /invalid existing group/i.test(message))
    ? "模型复用了现有分组 ID，但又修改了名称或层级。新版重试时会将这类冲突安全降级为“新建分组建议”。"
    : "可先查看响应日志定位模型原始输出，再重试失败阶段；已完成的分析不会重跑。";
}

function aiFailureMessage(error) {
  const message = String(error?.message || "AI 任务失败");
  if (/invalid existing group/i.test(message)) return "模型复用现有分组时更改了名称、层级，或引用了无效 ID。";
  if (error?.code === "ai_timeout" || /timed out/i.test(message)) return "模型生成响应超时，已完成的前置分析会保留。";
  if (/invalid json|not valid json|did not return json/i.test(message)) return "模型未返回可解析的 JSON 结构。";
  if (/group count|leaf group count/i.test(message)) return "模型生成的分组数超出了设定范围。";
  if (/at least one new group/i.test(message)) return "已选择重新分组，但模型没有提出任何新分组。";
  if (/omitted|missing/i.test(message)) return "模型遗漏了本批中的部分网址或字段。";
  if (/no completion|empty/i.test(message)) return "模型返回了空内容。";
  return message;
}

async function pollAiJob(jobId) {
  try {
    const job = await apiRequest(`/ai/jobs/${segment(jobId)}`);
    renderAiJob(job);
    await loadAiLogs(jobId);
  } catch (error) {
    elements.aiApplyError.textContent = readableError(error);
  }
}

function createAiEmptyReview(status) {
  const empty = document.createElement("div");
  empty.className = "ai-empty-review";
  const title = document.createElement("strong");
  title.textContent = status === "cancelled" ? "任务已取消" : "没有待审核建议";
  const copy = document.createElement("p");
  copy.textContent = status === "completed" ? "现有内容已经很整齐，可以调整范围或字段后再试。" : "可重试失败批次或新建任务。";
  empty.append(title, copy);
  return empty;
}

function renderAiProposedGroups(job) {
  const pendingByPlanId = new Map();
  const appliedByPlanId = new Map();
  for (const suggestion of Array.isArray(job.suggestions) ? job.suggestions : []) {
    if (!suggestion.createsGroup || typeof suggestion.suggestedValue !== "string") continue;
    const key = suggestion.planGroupId || suggestion.suggestedValue;
    const counts = suggestion.status === "pending" ? pendingByPlanId : suggestion.status === "applied" ? appliedByPlanId : null;
    if (counts) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const groups = Array.isArray(job.groupPlan?.groups)
    ? job.groupPlan.groups.filter((group) => Number(group.itemCount) > 0 || job.groupPlan.groups.some((child) => child.parentPlanGroupId === group.id && Number(child.itemCount) > 0))
    : [];
  elements.aiProposedGroupList.replaceChildren();
  elements.aiProposedGroupsSection.hidden = groups.length === 0;
  elements.aiGroupPlanSummary.classList.remove("has-warning");
  if (groups.length) {
    const retired = job.groupPlan?.retireGroupIds?.length || 0;
    const warnings = Array.isArray(job.groupPlan?.warnings) ? job.groupPlan.warnings.filter(Boolean) : [];
    elements.aiGroupPlanSummary.textContent = `${job.groupPlan.summary} · ${groups.length} 个目标分组 · ${retired} 个旧分组待清理${warnings.length ? ` · ${warnings.join(" ")}` : ""}`;
    elements.aiGroupPlanSummary.classList.toggle("has-warning", warnings.length > 0);
  }
  for (const group of groups) {
    const label = document.createElement("label");
    label.className = `ai-proposed-group${group.parentPlanGroupId ? " is-child" : ""}`;
    const isParent = groups.some((candidate) => candidate.parentPlanGroupId === group.id);
    if (!group.existingGroupId) {
      if (pendingByPlanId.get(group.id)) {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        input.dataset.proposedGroup = group.id;
        label.append(input);
      } else {
        const badge = document.createElement("span");
        badge.className = "ai-status-badge is-applied";
        badge.textContent = isParent ? "上级" : appliedByPlanId.get(group.id) ? "已应用" : "已记录";
        label.append(badge);
      }
    } else {
      const badge = document.createElement("span");
      badge.className = "ai-plan-type";
      badge.textContent = "保留";
      label.append(badge);
    }
    const copy = document.createElement("span");
    const heading = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = group.name;
    const count = document.createElement("small");
    const childItems = groups.filter((child) => child.parentPlanGroupId === group.id).reduce((total, child) => total + Number(child.itemCount || 0), 0);
    count.textContent = `${Number(group.itemCount || 0) + childItems || pendingByPlanId.get(group.id) || 0} 个网址`;
    heading.append(name, count);
    const description = document.createElement("small");
    const sources = (group.sourceGroupIds || []).map((id) => state.catalog.groups.find((entry) => entry.id === id)?.name).filter(Boolean);
    const parent = group.parentPlanGroupId ? groups.find((candidate) => candidate.id === group.parentPlanGroupId) : null;
    description.textContent = `${parent ? `${parent.name} / ` : ""}${group.existingGroupId ? "沿用现有分组" : isParent ? "新建上级分组" : "新建项目分组"}${sources.length ? ` · 来源：${sources.join("、")}` : ""} · ${group.description || group.reason || "按内容主题归类"}`;
    copy.append(heading, description);
    label.append(copy);
    elements.aiProposedGroupList.append(label);
  }
}

function handleProposedGroupSelection(event) {
  const input = event.target.closest("input[data-proposed-group]");
  if (!input) return;
  elements.aiSuggestionList.querySelectorAll("input[data-proposed-group]").forEach((suggestion) => {
    if (suggestion.dataset.proposedGroup === input.dataset.proposedGroup) suggestion.checked = input.checked;
  });
  updateAiItemMasters();
  updateAiApplyCount();
}

function updateAiItemMasters() {
  elements.aiSuggestionList.querySelectorAll("input[data-ai-item]").forEach((master) => {
    const children = [...elements.aiSuggestionList.querySelectorAll(
      `input[data-item-id="${CSS.escape(master.dataset.aiItem)}"]`
    )];
    master.checked = children.length > 0 && children.every((input) => input.checked);
    master.indeterminate = children.some((input) => input.checked) && !master.checked;
  });
}

function toggleAiLogs() {
  elements.aiLogSection.hidden = !elements.aiLogSection.hidden;
  setButtonVisual(elements.toggleAiLogs, elements.aiLogSection.hidden ? "查看响应日志" : "收起响应日志");
  if (!elements.aiLogSection.hidden && state.aiJob) void loadAiLogs(state.aiJob.id);
}

async function loadAiLogs(jobId, reset = false) {
  if (reset) {
    state.aiLogs = [];
    state.aiLogSequence = 0;
  }
  const result = await apiRequest(`/ai/jobs/${segment(jobId)}/logs?after=${state.aiLogSequence}`);
  const logs = Array.isArray(result?.logs) ? result.logs : [];
  if (logs.length) state.aiLogs.push(...logs);
  state.aiLogSequence = Number(result?.nextSequence) || state.aiLogSequence;
  renderAiLogs();
}

function renderAiLogs() {
  elements.aiLogList.replaceChildren();
  if (!state.aiLogs.length) {
    const empty = document.createElement("p");
    empty.className = "ai-log-empty";
    empty.textContent = "模型响应后，日志会实时显示在这里。";
    elements.aiLogList.append(empty);
    return;
  }
  for (const log of state.aiLogs) {
    const details = document.createElement("details");
    details.className = `ai-log-entry ${log.status === "error" ? "is-error" : ""}`;
    const summary = document.createElement("summary");
    const title = document.createElement("strong");
    title.textContent = `${aiLogPhaseLabel(log.phase)} · 批次 ${log.batch}${log.splitPart ? `.${log.splitPart}` : ""} · ${log.itemCount || 0} 条 · 第 ${log.attempt} 次`;
    const meta = document.createElement("span");
    const tokens = Number(log.usage?.totalTokens) || 0;
    meta.textContent = `${log.status === "success" ? "成功" : "失败"} · ${log.durationMs || 0} ms${tokens ? ` · ${tokens} tokens` : ""}`;
    summary.append(title, meta);
    const body = document.createElement("div");
    body.className = "ai-log-body";
    const provider = document.createElement("p");
    provider.textContent = `${log.provider || "AI"} · ${log.model || "未知模型"}${log.finishReason ? ` · ${log.finishReason}` : ""}`;
    body.append(provider);
    if (log.timeoutMs) {
      const timing = document.createElement("p");
      const stage = log.timeoutStage === "response_body" ? "读取模型响应" : log.timeoutStage === "request" ? "等待模型响应" : "未触发超时";
      timing.textContent = `时限 ${Math.round(log.timeoutMs / 1000)} 秒 · 实际 ${((log.durationMs || 0) / 1000).toFixed(1)} 秒 · ${stage}`;
      body.append(timing);
    }
    if (log.error) {
      const error = document.createElement("p");
      error.className = "field-error";
      error.textContent = `${log.error.code}: ${log.error.message}`;
      body.append(error);
      if (log.providerRequestId || log.httpStatus || log.suggestedAction) {
        const diagnostic = document.createElement("p");
        diagnostic.textContent = [log.httpStatus ? `HTTP ${log.httpStatus}` : "", log.providerRequestId ? `request ${log.providerRequestId}` : "", log.suggestedAction || ""].filter(Boolean).join(" · ");
        body.append(diagnostic);
      }
    }
    if (typeof log.content === "string") {
      const pre = document.createElement("pre");
      pre.textContent = `${log.content}${log.truncated ? "\n\n[响应内容已截断]" : ""}`;
      body.append(pre);
    } else if (log.truncated) {
      const purged = document.createElement("p");
      purged.textContent = "原始响应已按保留策略清理，任务摘要仍会永久保留。";
      body.append(purged);
    }
    details.append(summary, body);
    elements.aiLogList.append(details);
  }
}

function aiLogPhaseLabel(phase) {
  return {
    group_planning: "候选分组",
    group_consolidation: "合并分组",
    item_analysis: "网址分析"
  }[phase] || "AI 响应";
}

async function loadAiHistory(reset = false) {
  const offset = reset ? 0 : state.aiHistoryOffset;
  setButtonBusy(reset ? elements.refreshAiHistory : elements.loadMoreAiHistory, true, "正在加载");
  try {
    const result = await apiRequest(`/ai/jobs?limit=20&offset=${offset}`);
    const jobs = Array.isArray(result?.jobs) ? result.jobs : [];
    if (reset) {
      state.aiHistoryOffset = 0;
      renderAiHistory(jobs, true);
    } else renderAiHistory(jobs, false);
    state.aiHistoryOffset = offset + jobs.length;
    state.aiHistoryHasMore = Number.isInteger(result?.nextOffset);
    elements.loadMoreAiHistory.hidden = !state.aiHistoryHasMore;
  } catch (error) {
    showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(reset ? elements.refreshAiHistory : elements.loadMoreAiHistory, false, reset ? "刷新" : "加载更多");
  }
}

function renderAiHistory(jobs, reset) {
  if (reset) elements.aiHistoryList.replaceChildren();
  for (const job of jobs) elements.aiHistoryList.append(createAiHistoryRow(job));
  elements.aiHistoryEmpty.hidden = elements.aiHistoryList.children.length > 0;
}

function createAiHistoryRow(job) {
  const article = document.createElement("article");
  article.className = "ai-history-row";
  const main = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = formatAiHistoryTitle(job);
  const meta = document.createElement("small");
  meta.textContent = `${formatAiDate(job.createdAt)} · ${job.model || "模型未记录"}`;
  main.append(title, meta);
  const metrics = document.createElement("div");
  metrics.className = "ai-history-metrics";
  const status = document.createElement("span");
  status.textContent = aiStatusLabel(job.lifecycleStatus || job.status);
  const changes = document.createElement("span");
  changes.textContent = `${job.suggestionCount || 0} 项修改`;
  const groups = document.createElement("span");
  groups.textContent = `${job.proposedGroupCount || 0} 个新分组`;
  metrics.append(status, changes, groups);
  if (job.appliedAt) {
    const applied = document.createElement("span");
    applied.textContent = `已应用 ${job.appliedCount || 0} 项`;
    applied.className = "success-text";
    metrics.append(applied);
  }
  const open = document.createElement("button");
  open.type = "button";
  open.className = "button button-secondary";
  open.dataset.aiHistoryId = job.id;
  open.textContent = "查看";
  article.append(main, metrics, open);
  return article;
}

function formatAiHistoryTitle(job) {
  const scope = job.scope?.type === "all" ? "全部分组" : `${job.scope?.ids?.length || 0} 个${job.scope?.type === "items" ? "书签" : "分组"}`;
  const strategy = job.missingOnly ? "仅补缺失资料" : job.groupStrategy === "rebuild" ? "完全重建"
    : job.groupStrategy === "reorganize" ? "平衡重组" : `保守整理 · ${job.destinationScope === "all" ? "全部现有分组" : "所选范围内"}`;
  return `${scope} · ${strategy}`;
}

function formatAiDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

async function handleAiHistoryClick(event) {
  const button = event.target.closest("button[data-ai-history-id]");
  if (!button) return;
  setButtonBusy(button, true, "正在打开");
  try {
    const job = await apiRequest(`/ai/jobs/${segment(button.dataset.aiHistoryId)}`);
    state.aiLogs = [];
    state.aiLogSequence = 0;
    renderAiJob(job);
    showAiView("current");
    await loadAiLogs(job.id, true);
  } catch (error) {
    showToastMessage(readableError(error), "error");
  } finally {
    setButtonBusy(button, false, "查看");
  }
}

function confirmDeleteAiHistory() {
  if (!state.aiJob || ["queued", "running"].includes(state.aiJob.status)) return;
  openConfirm({
    title: "删除整理记录",
    message: "确定删除这条 AI 整理历史吗？导航目录中已经应用的修改不会回滚。",
    label: "删除记录",
    action: async () => {
      await apiRequest(`/ai/jobs/${segment(state.aiJob.id)}`, { method: "DELETE", expectEmpty: true });
      state.aiJob = null;
      state.aiLogs = [];
      state.aiLogSequence = 0;
      await loadAiHistory(true);
      showAiView("history");
      showToastMessage("整理记录已删除");
    }
  });
}

function renderAiSuggestions(suggestions, job) {
  elements.aiSuggestionList.replaceChildren();
  const byItem = new Map();
  for (const suggestion of suggestions) {
    const list = byItem.get(suggestion.itemId) || [];
    list.push(suggestion);
    byItem.set(suggestion.itemId, list);
  }
  for (const [itemId, itemSuggestions] of byItem) {
    const original = findCatalogItem(itemId);
    const article = document.createElement("article");
    article.className = "ai-review-item";
    const header = document.createElement("header");
    const pending = itemSuggestions.filter((suggestion) => suggestion.status === "pending");
    const applied = itemSuggestions.filter((suggestion) => suggestion.status === "applied");
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = original?.title || "网址建议";
    const url = document.createElement("small");
    url.textContent = original?.url || itemId;
    heading.append(title, url);
    if (pending.length) {
      const master = document.createElement("input");
      master.type = "checkbox";
      master.checked = true;
      master.dataset.aiItem = itemId;
      master.setAttribute("aria-label", `选择 ${original?.title || "此网址"} 的全部待应用建议`);
      header.append(master);
    } else {
      const badge = document.createElement("span");
      badge.className = "ai-status-badge is-applied";
      badge.textContent = "已应用";
      header.append(badge);
    }
    header.append(heading);
    const fields = document.createElement("div");
    fields.className = "ai-review-fields";
    for (const suggestion of [...pending, ...applied]) fields.append(createAiSuggestionRow(suggestion, job.appliedAt));
    article.append(header, fields);
    elements.aiSuggestionList.append(article);
  }
  const pendingCount = suggestions.filter((suggestion) => suggestion.status === "pending").length;
  const appliedCount = suggestions.filter((suggestion) => suggestion.status === "applied").length;
  elements.aiSuggestionCount.textContent = `${pendingCount} 项待应用 · ${appliedCount} 项已应用`;
  syncProposedGroupMasters();
  updateAiApplyCount();
}

function createAiSuggestionRow(suggestion, fallbackAppliedAt) {
  const labels = { title: "标题", groupId: "分组", description: "介绍", tags: "标签" };
  const isApplied = suggestion.status === "applied";
  const row = document.createElement(isApplied ? "div" : "label");
  row.className = "ai-suggestion-row";
  if (isApplied) row.classList.add("is-applied");
  if (!isApplied) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.value = suggestion.id;
    checkbox.dataset.aiSuggestion = "true";
    checkbox.dataset.itemId = suggestion.itemId;
    if (suggestion.createsGroup && typeof suggestion.suggestedValue === "string") {
      checkbox.dataset.proposedGroup = suggestion.planGroupId || suggestion.suggestedValue;
    }
    row.append(checkbox);
  }
  const copy = document.createElement("span");
  copy.className = "ai-suggestion-copy";
  const top = document.createElement("span");
  top.className = "ai-suggestion-top";
  const field = document.createElement("strong");
  field.textContent = labels[suggestion.field] || suggestion.field;
  const confidence = document.createElement("small");
  const confidenceLabel = Number.isFinite(suggestion.confidence) ? `${Math.round(suggestion.confidence * 100)}% 置信度` : "AI 建议";
  const appliedAt = suggestion.appliedAt || fallbackAppliedAt;
  confidence.textContent = isApplied
    ? `已应用${appliedAt ? ` · ${formatAiDate(appliedAt)}` : ""} · ${confidenceLabel}`
    : confidenceLabel;
  top.append(field, confidence);
  const diff = document.createElement("span");
  diff.className = "ai-diff";
  const before = document.createElement("del");
  before.textContent = displayAiValue(suggestion.field, suggestion.currentValue) || "空";
  const after = document.createElement("ins");
  after.textContent = displayAiSuggestionValue(suggestion) || "空";
  diff.append(before, after);
  const reason = document.createElement("small");
  reason.className = "ai-reason";
  reason.textContent = suggestion.createsGroup ? `建议新建分组 · ${suggestion.reason || "更便于归类"}` : suggestion.reason || "模型建议调整";
  copy.append(top, diff, reason);
  row.append(copy);
  return row;
}

function displayAiValue(field, value) {
  if (field === "groupId") return NavManageCore.groupPath(state.catalog, state.catalog.groups.find((group) => group.id === value)) || String(value ?? "");
  if (Array.isArray(value)) return value.join("、");
  return String(value ?? "");
}

function displayAiSuggestionValue(suggestion) {
  if (suggestion.field !== "groupId" || !suggestion.planGroupId) {
    return displayAiValue(suggestion.field, suggestion.suggestedValue);
  }
  const groups = state.aiJob?.groupPlan?.groups || [];
  const target = groups.find((group) => group.id === suggestion.planGroupId);
  if (!target) return displayAiValue(suggestion.field, suggestion.suggestedValue);
  const parent = target.parentPlanGroupId
    ? groups.find((group) => group.id === target.parentPlanGroupId)
    : null;
  return parent ? `${parent.name} / ${target.name}` : target.name;
}

function findCatalogItem(itemId) {
  for (const group of state.catalog.groups) {
    const item = group.items.find((entry) => entry.id === itemId);
    if (item) return item;
  }
  return null;
}

function handleAiSuggestionSelection(event) {
  const itemMaster = event.target.closest('input[data-ai-item]');
  if (itemMaster) {
    elements.aiSuggestionList.querySelectorAll(`input[data-item-id="${CSS.escape(itemMaster.dataset.aiItem)}"]`)
      .forEach((input) => { input.checked = itemMaster.checked; });
  } else if (event.target.matches('input[data-ai-suggestion]')) {
    const itemId = event.target.dataset.itemId;
    const children = [...elements.aiSuggestionList.querySelectorAll(`input[data-item-id="${CSS.escape(itemId)}"]`)];
    const master = elements.aiSuggestionList.querySelector(`input[data-ai-item="${CSS.escape(itemId)}"]`);
    if (master) {
      master.checked = children.every((input) => input.checked);
      master.indeterminate = children.some((input) => input.checked) && !master.checked;
    }
  }
  syncProposedGroupMasters();
  updateAiApplyCount();
}

function setAllAiSuggestions(checked) {
  elements.aiSuggestionList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = checked;
    input.indeterminate = false;
  });
  elements.aiProposedGroupList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = checked;
    input.indeterminate = false;
  });
  updateAiApplyCount();
}

function syncProposedGroupMasters() {
  elements.aiProposedGroupList.querySelectorAll("input[data-proposed-group]").forEach((master) => {
    const children = [...elements.aiSuggestionList.querySelectorAll("input[data-proposed-group]")]
      .filter((input) => input.dataset.proposedGroup === master.dataset.proposedGroup);
    master.checked = children.length > 0 && children.every((input) => input.checked);
    master.indeterminate = children.some((input) => input.checked) && !master.checked;
  });
}

function selectedAiSuggestionIds() {
  return [...elements.aiSuggestionList.querySelectorAll('input[data-ai-suggestion]:checked')].map((input) => input.value);
}

function updateAiApplyCount() {
  const count = selectedAiSuggestionIds().length;
  setButtonVisual(elements.applyAiSuggestions, count ? `应用 ${count} 项修改` : "选择要应用的修改", true);
  elements.applyAiSuggestions.disabled = !count;
}

async function applyAiSuggestions() {
  const suggestionIds = selectedAiSuggestionIds();
  if (!suggestionIds.length || !state.aiJob) return;
  setButtonBusy(elements.applyAiSuggestions, true, "正在应用");
  elements.aiApplyError.textContent = "";
  try {
    const result = await apiRequest(`/ai/jobs/${segment(state.aiJob.id)}/apply`, {
      method: "POST",
      body: {
        suggestionIds,
        retireGroupIds: state.aiJob.groupPlan?.retireGroupIds || []
      }
    });
    state.catalog = NavManageCore.normalizeCatalog(result.catalog || result);
    renderCatalog();
    const conflicts = result.applyResult?.conflicts || [];
    showToastMessage(`已应用 ${result.applied ?? suggestionIds.length} 项 AI 建议${conflicts.length ? `，${conflicts.length} 项冲突已保留当前值` : ""}`);
    if (conflicts.length) {
      elements.aiApplyError.textContent = conflicts.map((conflict) =>
        `网址 ${conflict.itemId} 的 ${conflict.field} 在分析后已变更，本次保留当前值。`
      ).join(" ");
    }
    renderAiJob(await apiRequest(`/ai/jobs/${segment(state.aiJob.id)}`));
  } catch (error) {
    const code = error instanceof ApiError ? error.body?.error?.code : "";
    elements.aiApplyError.textContent = code === "ai_suggestion_stale"
      ? `网址 ${error.body?.error?.details?.itemId || ""} 的 ${error.body?.error?.details?.field || "内容"} 在分析后已变更，本次未应用任何建议。`
      : code === "ai_group_plan_stale"
        ? `分组“${error.body?.error?.details?.groupName || "未知分组"}”的名称或层级在分析后已变更，本次未应用任何建议。`
        : readableError(error);
  } finally {
    elements.applyAiSuggestions.disabled = false;
    updateAiApplyCount();
  }
}

async function retryAiJob() {
  if (!state.aiJob) return;
  setButtonBusy(elements.retryAiJob, true, "正在重试");
  try {
    renderAiJob(await apiRequest(`/ai/jobs/${segment(state.aiJob.id)}/retry`, {
      method: "POST",
      body: {},
      versioned: false
    }));
  } catch (error) {
    elements.aiApplyError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.retryAiJob, false, "重试失败批次");
  }
}

async function pauseAiJob() {
  if (!state.aiJob) return;
  setButtonBusy(elements.pauseAiJob, true, "正在暂停");
  try {
    renderAiJob(await apiRequest(`/ai/jobs/${segment(state.aiJob.id)}/pause`, { method: "POST", body: {}, versioned: false }));
  } catch (error) {
    elements.aiApplyError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.pauseAiJob, false, "暂停任务");
  }
}

async function resumeAiJob() {
  if (!state.aiJob) return;
  setButtonBusy(elements.resumeAiJob, true, "正在继续");
  try {
    renderAiJob(await apiRequest(`/ai/jobs/${segment(state.aiJob.id)}/resume`, { method: "POST", body: {}, versioned: false }));
  } catch (error) {
    elements.aiApplyError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.resumeAiJob, false, "继续任务");
  }
}

async function cancelAiJob() {
  if (!state.aiJob) return;
  setButtonBusy(elements.cancelAiJob, true, "正在取消");
  try {
    await apiRequest(`/ai/jobs/${segment(state.aiJob.id)}`, {
      method: "DELETE",
      expectEmpty: true,
      versioned: false
    });
    renderAiJob({ ...state.aiJob, status: "cancelled" });
  } catch (error) {
    elements.aiApplyError.textContent = readableError(error);
  } finally {
    setButtonBusy(elements.cancelAiJob, false, "取消任务");
  }
}
