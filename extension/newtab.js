(function newTabDashboard() {
  "use strict";

  const core = window.QiyeNewTabCore;
  const runtime = window.QiyeRuntime;
  const SETTINGS_KEY = "navIngestSettings";
  const SNAPSHOT_KEY = "navNewTabSnapshot";
  const ACTIVITY_KEY = "navNewTabActivity";
  const PREFERENCES_KEY = "navNewTabPreferences";
  const RECENT_SEARCHES_KEY = "navNewTabRecentSearches";
  const MEMO_KEY = "navNewTabMemo";
  const AGENT_SESSIONS_KEY = "navAgentSessions";
  const ICON_CHOICES_KEY = "navIconChoicesV1";
  let iconChoices = {};
  let iconSaveTimer;
  const OFF_MARKER = "qiye-newtab-off-guard";
  const SNAPSHOT_SCHEMA = 1;

  const state = {
    catalog: null, items: [], itemMap: new Map(), activity: { schemaVersion: 1, items: [] },
    preferences: core.mergePreferences(), recentSearches: readRecentSearches(),
    activeGroupId: "", snapshotAt: "", source: "network", controller: null,
    searchActions: [], activeSearchIndex: -1, groupFilterQuery: "",
    viewMode: "group", expandedAllGroupIds: new Set(), healthSummary: null,
    collapsedGroupIds: new Set(), groupsInitialized: false,
    agentHistory: [], agentBusy: false, agentSessions: [], agentSessionId: "", agentHistoryVisible: false,
    settings: NavShared.mergeSettings()
  };
  const provider = new RuntimeActivityStore(ACTIVITY_KEY);
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    brandTitle: $("#brand-title"), clock: $("#clock"), today: $("#today"), greeting: $("#greeting"), topbarGreeting: $("#topbar-greeting"), themeSelect: $("#theme-select"),
    searchForm: $("#search-form"), searchInput: $("#search-input"), searchEngine: $("#search-engine"),
    searchWrap: $("#search-wrap"), searchPanel: $("#search-panel"), searchResults: $("#search-results"),
    connectionBadge: $("#connection-badge"), connectionCopy: $("#connection-copy"),
    loading: $("#loading-state"), error: $("#error-state"), errorMessage: $("#error-message"),
    errorRetry: $("#error-retry"), errorOptions: $("#error-options"), empty: $("#empty-state"),
    emptyManage: $("#empty-manage"), content: $("#content"),
    frequentSection: $("#frequent-section"), recentSection: $("#recent-section"),
    frequentList: $("#frequent-list"), recentList: $("#recent-list"), frequentHint: $("#frequent-hint"),
    groups: $("#catalog-groups"), catalogPath: $("#catalog-path"), groupTitle: $("#catalog-group-title"), itemCount: $("#catalog-item-count"), items: $("#catalog-items"),
    groupFilter: $("#group-filter"),
    allSites: $("#all-sites"), allSitesCount: $("#all-sites-count"), manageLink: $("#manage-link"), healthManageLink: $("#health-manage-link"),
    settings: $("#settings-dialog"), recordActivity: $("#record-activity"), showFrequent: $("#show-frequent"), showRecent: $("#show-recent"),
    clearSearches: $("#clear-searches"), calendarMonth: $("#calendar-month"), calendarGrid: $("#calendar-grid"), familyServiceList: $("#family-service-list"),
    memoInput: $("#memo-input"), memoStatus: $("#memo-status"),
    agentShell: $("#agent-shell"), agentForm: $("#agent-form"), agentOpen: $("#agent-open"), agentInput: $("#agent-input"), agentSubmit: $("#agent-submit"),
    agentPanel: $("#agent-panel"), agentMessages: $("#agent-messages"), agentModel: $("#agent-model"), agentStatus: $("#agent-status"),
    agentName: $("#agent-name"), agentHistory: $("#agent-history"), agentHistoryList: $("#agent-history-list"),
    widgetDupCount: $("#widget-dup-count"), widgetBrokenCount: $("#widget-broken-count"), widgetMetaCount: $("#widget-meta-count"),
    offlineStatus: $("#offline-status"), snapshotTime: $("#snapshot-time")
  };

  void initialize();

  async function initialize() {
    void runtime.retireLegacyWebShell();
    const storedSettings = await storageGet(SETTINGS_KEY);
    let parsedSettings = storedSettings;
    if (typeof storedSettings === "string") {
      try { parsedSettings = JSON.parse(storedSettings); } catch (_error) { parsedSettings = null; }
    }
    state.settings = NavShared.mergeSettings({ ...runtime.defaultSettings, ...(parsedSettings || {}) });
    if (core.resolveNewTabMode(state.settings) !== "dashboard") {
      await restoreDefaultNewTab();
      return;
    }
    try { const saved = await storageGet(ICON_CHOICES_KEY); iconChoices = (typeof saved === "string" ? JSON.parse(saved) : saved) || {}; } catch { iconChoices = {}; }
    configureEnvironmentLabels();
    bindEvents();
    initializeThemeControl();
    initializeScrollRegions();
    setDateAndGreeting();
    renderCalendar();
    await initializeMemo();
    await initializeAgentSessions();
    startClock();
    const loaded = await loadCatalog();
    if (!loaded && state.source !== "snapshot") return;
  }

  async function restoreDefaultNewTab() {
    document.documentElement.classList.add("newtab-off");
    if (sessionStorage.getItem(OFF_MARKER)) { renderOffState(); return; }
    sessionStorage.setItem(OFF_MARKER, "1");
    const fallback = setTimeout(renderOffState, 500);
    if (await runtime.restoreDefaultNewTab()) return;
    renderOffState();
    clearTimeout(fallback);
  }

  function renderOffState() {
    document.documentElement.classList.add("newtab-off");
    document.body.replaceChildren();
    const shell = document.createElement("main");
    shell.className = "off-shell";
    const mark = document.createElement("img");
    mark.className = "brand-mark";
    mark.src = "assets/brand-mark.svg";
    mark.alt = "";
    const title = document.createElement("h1");
    title.textContent = "新标签页接管已关闭";
    const copy = document.createElement("p");
    copy.textContent = "在扩展设置中开启「接管新标签页」后，这里会显示栖页导航桌面。";
    const actions = document.createElement("div");
    actions.className = "off-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "primary-button";
    open.textContent = "打开扩展设置";
    open.addEventListener("click", () => void runtime.openSettings());
    actions.append(open);
    shell.append(mark, title, copy, actions);
    document.body.append(shell);
  }

  function configureEnvironmentLabels() {
    if (runtime.isExtension) return;
    const optionsButton = $("#options-button");
    optionsButton.setAttribute("aria-label", "打开管理页");
    optionsButton.title = "管理网址与分组";
    $("#error-options").textContent = "打开管理页";
    elements.errorMessage.textContent = "请确认导航服务正在运行。";
  }

  async function storageGet(key) {
    return runtime.storageGet(key);
  }
  async function storageSet(key, value) {
    await runtime.storageSet(key, value);
  }
  async function storageRemove(key) {
    await runtime.storageRemove(key);
  }

  function RuntimeActivityStore(key) {
    this.key = key;
  }
  RuntimeActivityStore.prototype.load = async function load(validIds, now) {
    try {
      const raw = await storageGet(this.key);
      return core.sanitizeActivity(raw ? JSON.parse(raw) : null, validIds, now);
    } catch (_error) { return { schemaVersion: 1, items: [] }; }
  };
  RuntimeActivityStore.prototype.record = async function record(itemId, validIds, now) {
    now = Number.isFinite(now) ? now : Date.now();
    const activity = await this.load(validIds, now);
    const row = activity.items.find((entry) => entry.itemId === itemId);
    if (row) { row.count += 1; row.lastActivatedAt = now; }
    else activity.items.push({ itemId, count: 1, lastActivatedAt: now });
    const clean = core.sanitizeActivity(activity, validIds, now);
    await storageSet(this.key, JSON.stringify(clean));
    return clean;
  };
  RuntimeActivityStore.prototype.prune = async function prune(validIds, now) {
    const clean = await this.load(validIds, now);
    await storageSet(this.key, JSON.stringify(clean));
    return clean;
  };
  RuntimeActivityStore.prototype.clear = function clear() { return storageRemove(this.key); };

  async function readPreferences() {
    try {
      return core.mergePreferences(JSON.parse(await storageGet(PREFERENCES_KEY) || "null"));
    } catch (_error) { return core.mergePreferences(); }
  }
  function savePreferences() {
    void storageSet(PREFERENCES_KEY, JSON.stringify(state.preferences));
  }
  function readRecentSearches() {
    try {
      const value = JSON.parse(window.localStorage?.getItem("qiyeStartRecentSearches") || "null");
      return core.sanitizeRecentSearches(value);
    } catch (_error) { return { schemaVersion: 1, items: [] }; }
  }
  function saveRecentSearches() {
    try { window.localStorage?.setItem("qiyeStartRecentSearches", JSON.stringify(state.recentSearches)); } catch (_error) { /* Keep in memory. */ }
  }
  function setDateAndGreeting() {
    const now = new Date();
    elements.today.dateTime = now.toISOString().slice(0, 10);
    const dateParts = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).formatToParts(now);
    const date = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(now);
    const weekday = dateParts.find(({ type }) => type === "weekday")?.value || "";
    elements.today.textContent = `${date} · ${weekday}`;
    updateGreeting();
  }
  function updateGreeting() {
    const hour = new Date().getHours();
    const period = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
    elements.topbarGreeting.textContent = period;
    elements.greeting.textContent = hour < 6 ? "夜深了，慢慢找。" : hour < 12 ? "早上好，今天想去哪里？" : hour < 18 ? "下午好，找点有用的。" : "晚上好，回到熟悉的地方。";
  }
  function startClock() {
    const render = () => {
      const now = new Date();
      elements.clock.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      elements.clock.dateTime = now.toISOString();
    };
    render();
    let renderedDay = new Date().getDate();
    setInterval(() => {
      render();
      updateGreeting();
      const day = new Date().getDate();
      if (day !== renderedDay) { renderedDay = day; setDateAndGreeting(); renderCalendar(); }
    }, 30_000);
  }
  function renderCalendar() {
    const now = new Date();
    elements.calendarMonth.textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(now);
    elements.calendarGrid.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const cell of core.monthCalendar(now.getFullYear(), now.getMonth(), now)) {
      const day = document.createElement("span");
      day.textContent = String(cell.day);
      if (!cell.currentMonth) day.classList.add("is-outside");
      if (cell.today) { day.classList.add("is-today"); day.setAttribute("aria-current", "date"); }
      fragment.append(day);
    }
    elements.calendarGrid.append(fragment);
  }
  async function initializeMemo() {
    const saved = await storageGet(MEMO_KEY);
    elements.memoInput.value = typeof saved === "string" ? saved.slice(0, 2000) : "";
  }
  function initializeThemeControl() {
    elements.themeSelect.value = QiyeTheme.getPreference();
    const updateThemeColor = (resolved) => {
      const themeColor = resolved === "light" ? "#f1f2ec" : "#0b0e0d";
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor);
    };
    updateThemeColor(QiyeTheme.resolve(elements.themeSelect.value));
    elements.themeSelect.addEventListener("change", () => {
      elements.themeSelect.value = QiyeTheme.setPreference(elements.themeSelect.value);
    });
    document.addEventListener("qiye:themechange", (event) => {
      updateThemeColor(event.detail?.resolved);
    });
  }
  function initializeScrollRegions() {
    for (const region of document.querySelectorAll(".scroll-region")) {
      let timer = 0;
      region.addEventListener("scroll", () => {
        region.classList.add("is-scrolling");
        clearTimeout(timer);
        timer = setTimeout(() => region.classList.remove("is-scrolling"), 700);
      }, { passive: true });
    }
  }
  function apiBaseUrl() { return state.settings.apiBaseUrl; }
  function bindEvents() {
    $("#refresh-button").addEventListener("click", () => void loadCatalog());
    $("#error-retry").addEventListener("click", () => void loadCatalog());
    $("#error-options").addEventListener("click", () => void runtime.openSettings());
    $("#options-button").addEventListener("click", () => void runtime.openSettings());
    $("#settings-button").addEventListener("click", openSettings);
    $("#hide-frequent").addEventListener("click", hideFrequent);
    $("#hide-recent").addEventListener("click", hideRecent);
    $("#clear-frequent").addEventListener("click", clearActivity);
    $("#clear-recent").addEventListener("click", clearActivity);
    $("#clear-activity").addEventListener("click", clearActivity);
    elements.clearSearches.addEventListener("click", clearRecentSearches);
    elements.settings.addEventListener("close", saveSettings);
    let memoTimer = 0;
    elements.memoInput.addEventListener("input", () => {
      elements.memoStatus.textContent = "保存中";
      clearTimeout(memoTimer);
      memoTimer = setTimeout(async () => {
        await storageSet(MEMO_KEY, elements.memoInput.value.slice(0, 2000));
        elements.memoStatus.textContent = "已保存到本机";
      }, 350);
    });
    elements.memoInput.addEventListener("change", () => void storageSet(MEMO_KEY, elements.memoInput.value.slice(0, 2000)));
    elements.groupFilter.addEventListener("input", () => {
      state.groupFilterQuery = elements.groupFilter.value.trim();
      renderGroups();
    });
    elements.allSites.addEventListener("click", showAllView);
    elements.searchInput.addEventListener("input", renderSearchResults);
    elements.searchInput.addEventListener("keydown", handleSearchKeydown);
    elements.searchInput.addEventListener("focus", () => { if (elements.searchInput.value.trim()) renderSearchResults(); });
    elements.searchEngine.addEventListener("change", () => { if (elements.searchInput.value.trim()) renderSearchResults(); });
    elements.searchForm.addEventListener("submit", handleSearchSubmit);
    elements.agentForm.addEventListener("submit", handleAgentSubmit);
    elements.agentInput.addEventListener("input", updateAgentSubmit);
    elements.agentInput.addEventListener("focus", expandAgentPanel);
    elements.agentOpen.addEventListener("click", toggleAgentPanel);
    $("#agent-collapse").addEventListener("click", collapseAgentPanel);
    $("#agent-new").addEventListener("click", startNewAgentConversation);
    $("#agent-history-toggle").addEventListener("click", toggleAgentHistory);
    elements.agentHistoryList.addEventListener("click", handleAgentHistoryClick);
    document.addEventListener("pointerdown", (event) => {
      if (!elements.searchWrap.contains(event.target)) closeSearchPanel();
      if (!elements.agentPanel.hidden && !elements.agentShell.contains(event.target)) collapseAgentPanel();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.agentPanel.hidden && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        collapseAgentPanel();
        elements.agentOpen.focus();
        return;
      }
      const commandShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const slashShortcut = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget(event.target);
      if (!commandShortcut && !slashShortcut) return;
      event.preventDefault();
      elements.searchInput.focus();
    });
    window.addEventListener("online", () => { updateConnection(); void loadCatalog(); });
    window.addEventListener("offline", updateConnection);
  }
  function setView(view, message = "") {
    elements.loading.hidden = view !== "loading";
    elements.loading.setAttribute("aria-busy", String(view === "loading"));
    elements.error.hidden = view !== "error";
    elements.empty.hidden = view !== "empty";
    elements.content.hidden = view !== "content";
    if (message) elements.errorMessage.textContent = message;
  }

  function newAgentId() {
    return globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function sanitizeAgentSessions(value) {
    const rows = Array.isArray(value?.sessions) ? value.sessions : [];
    let remaining = 50_000;
    const sessions = rows.slice(0, 20).flatMap((row) => {
      if (!row || typeof row !== "object" || !row.id || remaining <= 0) return [];
      const messages = (Array.isArray(row.messages) ? row.messages : []).slice(-20).flatMap((message) => {
        if (!message || !["user", "assistant"].includes(message.role) || remaining <= 0) return [];
        const content = String(message.content || "").slice(0, Math.min(4_000, remaining));
        if (!content) return [];
        remaining -= content.length;
        return [{ role: message.role, content, sources: Array.isArray(message.sources) ? message.sources.slice(0, 8) : [] }];
      });
      if (!messages.length) return [];
      return [{ id: String(row.id).slice(0, 100), title: String(row.title || messages[0].content).slice(0, 60), updatedAt: Number(row.updatedAt) || 0, messages }];
    });
    return { sessions, currentId: sessions.some((row) => row.id === value?.currentId) ? value.currentId : sessions[0]?.id || "" };
  }
  async function initializeAgentSessions() {
    try {
      const parsed = JSON.parse(await storageGet(AGENT_SESSIONS_KEY) || "null");
      const clean = sanitizeAgentSessions(parsed);
      state.agentSessions = clean.sessions;
      state.agentSessionId = clean.currentId;
      state.agentHistory = state.agentSessions.find((row) => row.id === clean.currentId)?.messages || [];
      renderAgentConversation();
    } catch (_error) { state.agentSessions = []; state.agentHistory = []; renderAgentConversation(); }
    updateAgentSubmit();
  }
  async function saveAgentSessions() {
    const clean = sanitizeAgentSessions({ sessions: state.agentSessions, currentId: state.agentSessionId });
    state.agentSessions = clean.sessions;
    await storageSet(AGENT_SESSIONS_KEY, JSON.stringify({ schemaVersion: 1, currentId: state.agentSessionId, sessions: state.agentSessions }));
  }
  function persistCurrentAgentConversation() {
    if (!state.agentHistory.length) return;
    const now = Date.now();
    if (!state.agentSessionId) state.agentSessionId = newAgentId();
    const session = {
      id: state.agentSessionId,
      title: state.agentHistory.find((row) => row.role === "user")?.content.slice(0, 60) || "新对话",
      updatedAt: now,
      messages: state.agentHistory.slice(-20),
    };
    state.agentSessions = [session, ...state.agentSessions.filter((row) => row.id !== session.id)].slice(0, 20);
    void saveAgentSessions();
  }
  function startNewAgentConversation() {
    persistCurrentAgentConversation();
    state.agentSessionId = "";
    state.agentHistory = [];
    state.agentHistoryVisible = false;
    elements.agentHistory.hidden = true;
    elements.agentMessages.hidden = false;
    $("#agent-history-toggle").setAttribute("aria-pressed", "false");
    elements.agentModel.textContent = "";
    renderAgentConversation();
    expandAgentPanel();
    elements.agentStatus.textContent = "已开始新对话";
    elements.agentInput.focus();
    updateAgentSubmit();
  }
  function setAgentPanelExpanded(expanded) {
    elements.agentPanel.hidden = !expanded;
    elements.agentOpen.setAttribute("aria-expanded", String(expanded));
    const action = expanded ? "收起导航助手" : "展开导航助手";
    elements.agentOpen.setAttribute("aria-label", action);
    elements.agentOpen.title = action;
  }
  function expandAgentPanel() { setAgentPanelExpanded(true); }
  function collapseAgentPanel() { setAgentPanelExpanded(false); }
  function toggleAgentPanel() {
    if (elements.agentPanel.hidden) {
      expandAgentPanel();
      elements.agentInput.focus();
    } else collapseAgentPanel();
  }
  function toggleAgentHistory() {
    state.agentHistoryVisible = !state.agentHistoryVisible;
    elements.agentHistory.hidden = !state.agentHistoryVisible;
    elements.agentMessages.hidden = state.agentHistoryVisible;
    $("#agent-history-toggle").setAttribute("aria-pressed", String(state.agentHistoryVisible));
    expandAgentPanel();
    if (state.agentHistoryVisible) renderAgentHistory();
  }
  function renderAgentHistory() {
    elements.agentHistoryList.replaceChildren();
    if (!state.agentSessions.length) {
      elements.agentHistoryList.removeAttribute("role");
      elements.agentHistoryList.append(agentEmpty("还没有历史对话", "完成一次提问后，对话会保存在这里。"));
      return;
    }
    elements.agentHistoryList.setAttribute("role", "list");
    for (const session of state.agentSessions) {
      const row = document.createElement("div"); row.className = "agent-history-row"; row.setAttribute("role", "listitem");
      const open = document.createElement("button"); open.type = "button"; open.className = "agent-history-open"; open.dataset.sessionId = session.id;
      if (session.id === state.agentSessionId) open.setAttribute("aria-current", "true");
      const title = document.createElement("strong"); title.textContent = session.title;
      const time = document.createElement("small"); time.textContent = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(session.updatedAt);
      open.append(title, time);
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "agent-history-delete"; remove.dataset.deleteSessionId = session.id; remove.textContent = "×"; remove.setAttribute("aria-label", `删除对话 ${session.title}`); remove.title = `删除对话 ${session.title}`;
      row.append(open, remove); elements.agentHistoryList.append(row);
    }
  }
  function handleAgentHistoryClick(event) {
    const deleteButton = event.target.closest("[data-delete-session-id]");
    if (deleteButton) {
      const id = deleteButton.dataset.deleteSessionId;
      const deletedIndex = state.agentSessions.findIndex((row) => row.id === id);
      state.agentSessions = state.agentSessions.filter((row) => row.id !== id);
      if (state.agentSessionId === id) { state.agentSessionId = ""; state.agentHistory = []; renderAgentConversation(); }
      void saveAgentSessions();
      renderAgentHistory();
      const next = elements.agentHistoryList.querySelectorAll(".agent-history-open")[Math.min(deletedIndex, state.agentSessions.length - 1)];
      (next || $("#agent-history-toggle")).focus();
      return;
    }
    const open = event.target.closest("[data-session-id]");
    const session = state.agentSessions.find((row) => row.id === open?.dataset.sessionId);
    if (!session) return;
    state.agentSessionId = session.id; state.agentHistory = session.messages.slice(); state.agentHistoryVisible = false;
    $("#agent-history-toggle").setAttribute("aria-pressed", "false");
    renderAgentConversation(); elements.agentHistory.hidden = true; elements.agentMessages.hidden = false; void saveAgentSessions();
  }
  function renderAgentConversation() {
    elements.agentMessages.replaceChildren();
    for (const message of state.agentHistory) agentMessage(message.role, message.content, "", message.sources || []);
    if (!state.agentHistory.length) elements.agentMessages.append(agentEmpty("有什么想快速找到的？", "输入问题，或从上方查看历史对话。"));
  }
  function agentEmpty(titleText, copyText) {
    const empty = document.createElement("div");
    empty.className = "agent-empty";
    const mark = document.createElement("span"); mark.className = "agent-empty-mark"; mark.setAttribute("aria-hidden", "true");
    const title = document.createElement("strong"); title.textContent = titleText;
    const copy = document.createElement("p"); copy.textContent = copyText;
    empty.append(mark, title, copy);
    return empty;
  }
  function updateAgentSubmit() {
    elements.agentSubmit.disabled = state.agentBusy || !elements.agentInput.value.trim();
  }

  function appendAgentInline(container, content, sourceIds) {
    const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]\n]+\]\([^)]+\))/g;
    let offset = 0;
    for (const match of content.matchAll(pattern)) {
      if (match.index > offset) container.append(document.createTextNode(content.slice(offset, match.index)));
      const token = match[0];
      if (token.startsWith("**")) { const strong = document.createElement("strong"); strong.textContent = token.slice(2, -2); container.append(strong); }
      else if (token.startsWith("*")) { const em = document.createElement("em"); em.textContent = token.slice(1, -1); container.append(em); }
      else if (token.startsWith("`")) { const code = document.createElement("code"); code.textContent = token.slice(1, -1); container.append(code); }
      else {
        const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/); const id = parts?.[2].startsWith("nav:") ? parts[2].slice(4) : ""; const item = sourceIds.has(id) ? state.itemMap.get(id) : null;
        if (item) { const link = document.createElement("a"); link.href = itemUrl(item); link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = parts[1]; link.addEventListener("click", () => void recordClick(item.id)); container.append(link); }
        else container.append(document.createTextNode(parts?.[1] || token));
      }
      offset = match.index + token.length;
    }
    if (offset < content.length) container.append(document.createTextNode(content.slice(offset)));
  }
  function renderAgentMarkdown(container, content, sources) {
    const sourceIds = new Set(sources.map((source) => String(source.itemId || "")));
    let list = null; let listType = "";
    for (const line of String(content).split(/\r?\n/)) {
      const match = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/);
      if (match) {
        const type = match[2] ? "ol" : "ul";
        if (!list || listType !== type) { list = document.createElement(type); listType = type; container.append(list); }
        const item = document.createElement("li"); appendAgentInline(item, match[3], sourceIds); list.append(item); continue;
      }
      list = null; listType = ""; if (!line.trim()) continue;
      const paragraph = document.createElement("p"); appendAgentInline(paragraph, line, sourceIds); container.append(paragraph);
    }
  }

  function agentMessage(role, content, className = "", sources = []) {
    const article = document.createElement("article");
    article.className = `agent-message is-${role}${className ? ` ${className}` : ""}`;
    const label = document.createElement("strong");
    label.textContent = role === "user" ? "你" : "栖页";
    const copy = document.createElement("div");
    copy.className = "agent-copy";
    renderAgentMarkdown(copy, content, sources);
    article.append(label, copy);
    elements.agentMessages.append(article);
    elements.agentMessages.scrollTop = elements.agentMessages.scrollHeight;
    return article;
  }

  function agentErrorMessage(code, fallback) {
    const messages = {
      ai_not_configured: "请先在管理后台的 AI 整理中配置统一模型。",
      agent_rate_limited: "导航助手正在处理其他问题，请稍后再试。",
      ai_timeout: "模型响应超时，请稍后重试。",
      ai_auth_failed: "后台模型凭据已失效，请重新配置。",
    };
    return messages[code] || fallback || "暂时无法回答，请稍后再试。";
  }

  async function handleAgentSubmit(event) {
    event.preventDefault();
    const question = elements.agentInput.value.trim();
    if (!question || state.agentBusy) return;
    state.agentBusy = true;
    elements.agentForm.setAttribute("aria-busy", "true");
    elements.agentPanel.setAttribute("aria-busy", "true");
    elements.agentInput.value = "";
    elements.agentInput.disabled = true;
    elements.agentSubmit.disabled = true;
    state.agentHistoryVisible = false;
    elements.agentHistory.hidden = true;
    elements.agentMessages.hidden = false;
    expandAgentPanel();
    agentMessage("user", question);
    const pending = agentMessage("assistant", "正在查找导航目录…", "is-pending");
    elements.agentStatus.textContent = "导航助手正在回答";
    try {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (runtime.isExtension && state.settings.token) headers.Authorization = `Bearer ${state.settings.token}`;
      const response = await fetch(`${apiBaseUrl()}/api/v1/agent/query`, {
        method: "POST",
        headers,
        credentials: runtime.isExtension ? "omit" : "same-origin",
        cache: "no-store",
        body: JSON.stringify({ question, history: state.agentHistory.slice(-6) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `服务返回 ${response.status}`), { code: payload?.error?.code });
      pending.remove();
      const answer = String(payload.answer || "目录中没有足够信息回答这个问题。").slice(0, 4_000);
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      agentMessage("assistant", answer, "", sources);
      state.agentHistory.push(
        { role: "user", content: question },
        { role: "assistant", content: answer, sources: sources.map((source) => ({ itemId: String(source.itemId || "") })) },
      );
      state.agentHistory = state.agentHistory.slice(-20);
      persistCurrentAgentConversation();
      if (payload.agentName) elements.agentName.textContent = String(payload.agentName).slice(0, 80);
      elements.agentModel.textContent = payload.model ? `模型 · ${String(payload.model).slice(0, 80)}` : "";
      elements.agentStatus.textContent = "回答完成";
    } catch (error) {
      pending.remove();
      agentMessage("assistant", agentErrorMessage(error.code, error.message), "is-error");
      elements.agentStatus.textContent = "回答失败";
    } finally {
      state.agentBusy = false;
      elements.agentForm.setAttribute("aria-busy", "false");
      elements.agentPanel.setAttribute("aria-busy", "false");
      elements.agentInput.disabled = false;
      updateAgentSubmit();
      if (!elements.agentPanel.hidden) elements.agentInput.focus();
    }
  }
  async function loadCatalog() {
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    const timeout = setTimeout(() => state.controller.abort(), 10_000);
    if (!state.catalog) setView("loading");
    try {
      const response = await fetch(`${apiBaseUrl()}/api/v1/catalog`, {
        headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store", signal: state.controller.signal
      });
      if (!response.ok) throw new Error(`服务返回 ${response.status}`);
      const catalog = core.normalizeCatalog(await response.json());
      const savedAt = new Date().toISOString();
      await storageSet(SNAPSHOT_KEY, JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA, savedAt, catalog }));
      await useCatalog(catalog, "network", savedAt);
      return true;
    } catch (error) {
      const snapshot = await readSnapshot();
      if (snapshot) { await useCatalog(snapshot.catalog, "snapshot", snapshot.savedAt); return true; }
      setView("error", error.name === "AbortError"
        ? `连接等待时间过长，且当前浏览器没有可用快照。${runtime.isExtension ? "请检查扩展设置里的 API 地址与授权。" : "请确认导航服务正在运行。"}`
        : `无法连接服务，且当前浏览器没有可用快照。${runtime.isExtension ? "请检查扩展设置里的 API 地址与授权。" : "请确认导航服务正在运行。"}`);
      return false;
    } finally { clearTimeout(timeout); }
  }
  async function readSnapshot() {
    try {
      const value = JSON.parse(await storageGet(SNAPSHOT_KEY) || "null");
      if (!value || value.schemaVersion !== SNAPSHOT_SCHEMA || !value.savedAt || !value.catalog) return null;
      const catalog = core.normalizeCatalog(value.catalog);
      return catalog.groups.length ? { catalog, savedAt: value.savedAt } : null;
    } catch (_error) { return null; }
  }
  async function useCatalog(catalog, source, savedAt) {
    state.catalog = catalog;
    state.items = core.flattenCatalog(catalog);
    state.itemMap = new Map(state.items.map((item) => [item.id, item]));
    state.activity = await provider.prune(new Set(state.itemMap.keys()));
    state.source = source;
    state.snapshotAt = savedAt;
    const displayGroups = core.displayGroups(catalog);
    if (!state.groupsInitialized) {
      state.groupsInitialized = true;
    } else {
      state.collapsedGroupIds = new Set([...state.collapsedGroupIds].filter((id) => catalog.groups.some((group) => group.id === id)));
    }
    if (!state.activeGroupId || !displayGroups.some((group) => group.id === state.activeGroupId)) {
      state.activeGroupId = displayGroups[0]?.id || "";
    }
    const manageUrl = `${apiBaseUrl()}/manage/#health`;
    elements.emptyManage.href = `${apiBaseUrl()}/manage/`;
    elements.manageLink.href = `${apiBaseUrl()}/manage/`;
    elements.manageLink.target = "_blank";
    elements.manageLink.rel = "noopener noreferrer";
    for (const link of [elements.healthManageLink]) {
      link.href = manageUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    elements.brandTitle.textContent = catalog.settings.title;
    elements.searchEngine.value = catalog.settings.defaultSearchEngine;
    document.title = `${catalog.settings.title} · 新标签页`;
    if (!state.items.length && !catalog.groups.length) setView("empty");
    else { setView("content"); renderDashboard(); }
    updateConnection();
  }
  function updateConnection() {
    const offline = state.source === "snapshot" || !navigator.onLine;
    elements.connectionBadge.classList.toggle("is-offline", offline);
    elements.connectionCopy.textContent = offline ? "离线 · 本地快照" : `已连接 · ${state.items.length} 个网址`;
    elements.offlineStatus.hidden = !offline;
    if (offline && state.snapshotAt) {
      const savedAt = new Date(state.snapshotAt);
      elements.snapshotTime.textContent = Number.isNaN(savedAt.getTime()) ? "较早" : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(savedAt);
      elements.snapshotTime.dateTime = state.snapshotAt;
    }
  }
  function isTypingTarget(target) {
    return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
  }
  function renderDashboard() {
    renderActivity();
    renderGroups();
    renderFamilyServices();
    renderHealth();
    renderMainView();
  }
  function renderFamilyServices() {
    elements.familyServiceList.replaceChildren();
    const rows = core.familyServiceItems(state.catalog, 3);
    if (!rows.length) {
      const empty = document.createElement("span");
      empty.className = "dock-empty";
      empty.textContent = "在家庭服务或 NAS 分组中添加网址";
      elements.familyServiceList.append(empty);
      return;
    }
    rows.forEach((item, index) => elements.familyServiceList.append(familyServiceItem(item, index)));
  }
  function renderActivity() {
    elements.frequentSection.hidden = !state.preferences.showFrequent;
    elements.recentSection.hidden = !state.preferences.showRecent;
    renderFrequent();
    renderRecent();
  }
  function renderMainView() {
    if (state.viewMode === "all") renderAllView();
    else renderCurrentGroup();
  }
  function showAllView() {
    state.viewMode = "all";
    elements.allSites.setAttribute("aria-pressed", "true");
    renderGroups();
    renderMainView();
  }
  function renderAllView() {
    if (!state.catalog) return;
    const groups = core.filterGroupTree(state.catalog, state.groupFilterQuery);
    elements.catalogPath.textContent = "全部网址";
    elements.groupTitle.textContent = "分组聚合";
    elements.itemCount.textContent = `${state.items.length} 个网址`;
    elements.items.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const group of groups) {
      const block = document.createElement("div");
      block.className = "all-group-block";
      const header = document.createElement("button");
      header.type = "button";
      header.className = "all-group-heading";
      const expanded = state.expandedAllGroupIds.has(group.id);
      const total = core.groupTotalCount(state.catalog, group.id);
      const name = document.createElement("span");
      name.textContent = group.name;
      const count = document.createElement("small");
      count.textContent = `${total} 个网址`;
      header.append(name, count);
      header.setAttribute("aria-expanded", String(expanded));
      header.addEventListener("click", () => {
        if (expanded) state.expandedAllGroupIds.delete(group.id);
        else state.expandedAllGroupIds.add(group.id);
        renderAllView();
      });
      block.append(header);
      if (expanded) {
        const rows = core.groupEntries(state.catalog, group.id).map(({ group: sourceGroup, item }) =>
          ({ ...item, groupId: sourceGroup.id, groupName: sourceGroup.name }));
        const grid = document.createElement("div");
        grid.className = "card-grid all-group-grid";
        rows.forEach((item, index) => grid.append(siteCard(item, index)));
        block.append(grid);
      }
      fragment.append(block);
    }
    elements.items.append(fragment);
  }
  async function renderHealth() {
    elements.allSitesCount.textContent = String(state.items.length);
    try {
      const response = await fetch(`${apiBaseUrl()}/api/v1/health/summary`, { headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`服务返回 ${response.status}`);
      state.healthSummary = await response.json();
      const counts = state.healthSummary?.counts || {};
      const duplicateCount = counts.duplicates ?? 0;
      const brokenCount = (counts.deadLinks ?? 0) + (counts.brokenLinks ?? 0);
      const metaCount = counts.missingMetadata ?? 0;
      elements.widgetDupCount.textContent = String(duplicateCount);
      elements.widgetBrokenCount.textContent = String(brokenCount);
      elements.widgetMetaCount.textContent = String(metaCount);
    } catch (_error) {
      for (const el of [elements.widgetDupCount, elements.widgetBrokenCount, elements.widgetMetaCount]) el.textContent = "…";
    }
  }
  function renderFrequent() {
    elements.frequentList.replaceChildren();
    const activityRows = core.activityItems(state.activity, state.itemMap, "frequent", 6);
    const fallbackGroup = state.catalog.groups.find((group) => group.items.length) || { id: "", name: "", items: [] };
    const fallbackItems = fallbackGroup.items.map((item) => ({ ...item, groupId: fallbackGroup.id, groupName: fallbackGroup.name }));
    const rows = core.dashboardFrequentItems(state.activity, state.itemMap, fallbackItems, 6);
    elements.frequentHint.textContent = !state.preferences.recordActivity
      ? "点击记录已关闭"
      : activityRows.length
        ? "按点击次数排序"
        : `还没有点击记录，先显示${fallbackGroup.name || "默认分组"}的前 6 项`;
    if (!rows.length) elements.frequentList.append(emptyInline("还没有常用网址", "从管理页向分组添加网址。"));
    else rows.slice(0, 6).forEach((item, index) => elements.frequentList.append(siteCard(item, index)));
  }
  function renderRecent() {
    elements.recentList.replaceChildren();
    const rows = core.activityItems(state.activity, state.itemMap, "recent", 6);
    if (!rows.length) {
      const empty = document.createElement("span");
      empty.className = "dock-empty";
      empty.textContent = "从本页打开过的网址会出现在这里";
      elements.recentList.append(empty);
    } else rows.forEach(({ item }, index) => elements.recentList.append(dockItem(item, index)));
  }
  function renderGroups() {
    elements.groups.replaceChildren();
    const groups = core.filterGroupTree(state.catalog, state.groupFilterQuery);
    const fragment = document.createDocumentFragment();
    for (const group of groups) {
      if (!state.groupFilterQuery && group.parentId && state.collapsedGroupIds.has(group.parentId)) continue;
      const row = document.createElement("div");
      row.className = `group-row${group.parentId ? " is-child" : ""}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "group-button";
      const children = core.childGroups(state.catalog, group.id).filter((child) => child.items.length);
      const label = document.createElement("span");
      label.className = "group-label";
      const name = document.createElement("span");
      name.className = "group-name";
      name.textContent = group.name;
      label.append(name);
      if (children.length) {
        const disclosure = document.createElement("span");
        const expanded = !state.collapsedGroupIds.has(group.id);
        disclosure.className = "group-disclosure";
        disclosure.textContent = "›";
        disclosure.setAttribute("aria-hidden", "true");
        label.append(disclosure);
        button.setAttribute("aria-expanded", String(expanded));
      }
      const count = document.createElement("small");
      const total = core.groupTotalCount(state.catalog, group.id);
      count.textContent = String(total);
      button.append(label, count);
      button.setAttribute("aria-current", state.viewMode === "group" && group.id === state.activeGroupId ? "true" : "false");
      button.setAttribute("aria-label", `${group.name}，${total} 个网址`);
      button.addEventListener("click", () => selectGroup(group.id, children.length > 0));
      row.append(button);
      fragment.append(row);
    }
    elements.groups.append(fragment);
    if (!groups.length) {
      const empty = document.createElement("span");
      empty.className = "dock-empty";
      empty.textContent = "没有匹配的分组，换个关键词";
      elements.groups.append(empty);
    }
  }
  function selectGroup(groupId, toggleChildren = false) {
    const selectionChanged = state.viewMode !== "group" || state.activeGroupId !== groupId;
    if (toggleChildren) {
      if (state.collapsedGroupIds.has(groupId)) state.collapsedGroupIds.delete(groupId);
      else state.collapsedGroupIds.add(groupId);
    }
    state.activeGroupId = groupId;
    if (state.viewMode === "all") {
      state.viewMode = "group";
      elements.allSites.setAttribute("aria-pressed", "false");
    }
    renderGroups();
    if (!selectionChanged) return;
    renderMainView();
    document.querySelector(".main-column")?.scrollTo({ top: 0, behavior: "smooth" });
  }
  function renderCurrentGroup() {
    if (!state.catalog) return;
    const group = state.catalog.groups.find((entry) => entry.id === state.activeGroupId);
    const rows = core.groupEntries(state.catalog, group?.id).map(({ group: sourceGroup, item }) =>
      ({ ...item, groupId: sourceGroup.id, groupName: sourceGroup.name }));
    elements.catalogPath.textContent = group?.parentId ? parentName(group.parentId) : "当前分组";
    elements.groupTitle.textContent = group?.name || "未选择分组";
    elements.itemCount.textContent = `${rows.length} 个网址`;
    renderCards(rows);
  }
  function renderCards(items) {
    elements.items.replaceChildren();
    if (!items.length) elements.items.append(emptyInline("这里没有匹配的网址", "换一个分组或搜索词试试。"));
    else {
      const fragment = document.createDocumentFragment();
      items.forEach((item, index) => fragment.append(siteCard(item, index)));
      elements.items.append(fragment);
    }
    elements.items.classList.remove("is-switching");
    void elements.items.offsetWidth;
    elements.items.classList.add("is-switching");
  }
  function handleSearchSubmit(event) {
    event.preventDefault();
    const query = elements.searchInput.value.trim();
    if (!query) return;
    if (!state.searchActions.length) renderSearchResults();
    const target = event.ctrlKey || event.metaKey
      ? state.searchActions.find((action) => action.type === "web") || state.searchActions[0]
      : state.searchActions[state.activeSearchIndex] || state.searchActions[0];
    executeSearchAction(target);
  }
  function renderSearchResults() {
    const query = elements.searchInput.value.trim();
    elements.searchResults.replaceChildren();
    state.searchActions = [];
    state.activeSearchIndex = -1;
    if (!state.catalog) { closeSearchPanel(); return; }
    if (!query) {
      state.recentSearches.items.slice(0, core.RECENT_SEARCH_MAX).forEach((recent) => {
        appendSearchAction({ type: "recent", query: recent, url: core.searchUrl(recent, elements.searchEngine.value) });
      });
      if (!state.searchActions.length) { closeSearchPanel(); return; }
      elements.searchPanel.hidden = false;
      elements.searchInput.setAttribute("aria-expanded", "true");
      setActiveSearchIndex(0);
      return;
    }
    core.searchItems(state.items, query).slice(0, 7).forEach((item, index) => appendSearchAction({ type: "item", item, index }));
    const commandUrl = core.commandSearchUrl(query);
    if (commandUrl) appendSearchAction({ type: "command", query, url: commandUrl });
    appendSearchAction({ type: "web", query, url: core.searchUrl(query, elements.searchEngine.value) });
    elements.searchPanel.hidden = false;
    elements.searchInput.setAttribute("aria-expanded", "true");
    setActiveSearchIndex(0);
  }
  function appendSearchAction(action) {
    const index = state.searchActions.length;
    state.searchActions.push(action);
    const option = document.createElement("button");
    option.type = "button";
    option.id = `search-option-${index}`;
    option.className = "search-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    const icon = document.createElement("span");
    icon.className = "search-option-icon";
    if (action.item) icon.append(siteIcon(action.item, action.index ?? 0));
    else {
      icon.textContent = action.type === "command" ? "!" : action.type === "recent" ? "↺" : "⌕";
      icon.setAttribute("aria-hidden", "true");
    }
    const copy = document.createElement("span");
    copy.className = "search-option-copy";
    const title = document.createElement("strong");
    const meta = document.createElement("small");
    if (action.item) {
      title.textContent = action.item.title;
      meta.textContent = `${action.item.groupName} · ${action.item.description || safeHost(action.item.url)}`;
    } else if (action.type === "command") {
      const command = action.query.split(/\s+/)[0];
      title.textContent = `${command} 搜索“${action.query.replace(/^![a-z0-9]+\s+/i, "")}”`;
      meta.textContent = "命令式搜索";
    } else if (action.type === "recent") {
      title.textContent = `搜索“${action.query}”`;
      meta.textContent = "最近搜索";
    } else {
      title.textContent = `搜索“${action.query}”`;
      meta.textContent = elements.searchEngine.options[elements.searchEngine.selectedIndex].text;
    }
    copy.append(title, meta);
    option.append(icon, copy);
    option.addEventListener("pointermove", () => setActiveSearchIndex(index));
    option.addEventListener("click", () => executeSearchAction(action));
    elements.searchResults.append(option);
  }
  function setActiveSearchIndex(index) {
    if (!state.searchActions.length) return;
    state.activeSearchIndex = (index + state.searchActions.length) % state.searchActions.length;
    elements.searchResults.querySelectorAll(".search-option").forEach((option, optionIndex) => {
      const active = optionIndex === state.activeSearchIndex;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", String(active));
      if (active) { elements.searchInput.setAttribute("aria-activedescendant", option.id); option.scrollIntoView({ block: "nearest" }); }
    });
  }
  function handleSearchKeydown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (elements.searchPanel.hidden) renderSearchResults();
      else setActiveSearchIndex(state.activeSearchIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Escape") { event.preventDefault(); closeSearchPanel(); }
  }
  function executeSearchAction(action) {
    if (!action) return;
    if (action.item) openItem(action.item);
    else {
      if (action.type !== "recent") rememberRecentSearch(action.query);
      window.open(action.url, "_blank", "noopener,noreferrer");
    }
    closeSearchPanel();
  }
  function rememberRecentSearch(query) {
    state.recentSearches = core.recordRecentSearch(state.recentSearches, query);
    saveRecentSearches();
  }
  function clearRecentSearches() {
    state.recentSearches = { schemaVersion: 1, items: [] };
    saveRecentSearches();
  }
  function closeSearchPanel() {
    elements.searchPanel.hidden = true;
    elements.searchInput.setAttribute("aria-expanded", "false");
    elements.searchInput.removeAttribute("aria-activedescendant");
    state.activeSearchIndex = -1;
  }
  function parentName(id) { return state.catalog.groups.find((group) => group.id === id)?.name || "下级分组"; }
  function siteCard(item, index = 0) {
    const link = document.createElement("a");
    link.className = `site-card grad-${index % 6}`;
    link.href = itemUrl(item);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const targetUrl = itemUrl(item);
    const metadata = core.cardMetadata(item, targetUrl);
    const descriptionText = metadata.description;
    const tags = metadata.tags;
    const visibleTagSummary = [metadata.visibleTags.join(" · "), metadata.remainingTagCount ? `+${metadata.remainingTagCount}` : ""].filter(Boolean).join(" ");
    link.title = [item.title, targetUrl, item.description, visibleTagSummary].filter(Boolean).join("\n");
    link.setAttribute("aria-label", [
      `访问 ${item.title}`,
      descriptionText,
      metadata.visibleTags.length ? `标签：${metadata.visibleTags.join("、")}${metadata.remainingTagCount ? `，另有 ${metadata.remainingTagCount} 个` : ""}` : "",
      `目标地址 ${targetUrl}`,
    ].filter(Boolean).join("，"));
    link.addEventListener("click", () => void recordClick(item.id));
    const top = document.createElement("span");
    top.className = "site-card-top";
    top.append(siteIcon(item, index));
    const content = document.createElement("span");
    content.className = "site-card-content";
    const title = document.createElement("span");
    title.className = "site-title";
    title.textContent = item.title;
    content.append(title);
    const description = document.createElement("span");
    description.className = "site-description";
    description.textContent = descriptionText;
    content.append(description);
    if (tags.length) {
      const tagList = document.createElement("span");
      tagList.className = "site-tags";
      metadata.visibleTags.forEach((tag) => {
        const chip = document.createElement("span"); chip.className = "site-tag"; chip.textContent = tag; tagList.append(chip);
      });
      if (metadata.remainingTagCount) {
        const more = document.createElement("span"); more.className = "site-tag site-tag-more"; more.textContent = `+${metadata.remainingTagCount}`; tagList.append(more);
      }
      content.append(tagList);
    }
    top.append(content);
    link.append(top);
    return link;
  }
  function dockItem(item, index = 0) {
    const link = document.createElement("a");
    link.className = "dock-item";
    link.href = itemUrl(item);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = `${item.title}\n${item.url}`;
    link.setAttribute("aria-label", `再次打开 ${item.title}，${item.url}`);
    link.addEventListener("click", () => void recordClick(item.id));
    link.append(siteIcon(item, index));
    const title = document.createElement("span");
    title.className = "site-title";
    title.textContent = item.title;
    link.append(title);
    return link;
  }
  function familyServiceItem(item, index = 0) {
    const link = dockItem(item, index);
    link.className = "family-service-item";
    const status = document.createElement("small");
    status.textContent = "未检测";
    link.append(status);
    return link;
  }
  function siteIcon(item, index = 0) {
    const icon = document.createElement("span");
    icon.className = `site-icon grad-${index % 6}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = core.getInitials(item.title);
    const sources = core.getIconCandidates(item);
    const candidates = sources.flatMap((source) => item.id ? [`${apiBaseUrl()}/api/v1/icons/${encodeURIComponent(item.id)}?source=${encodeURIComponent(source)}`, source] : [source]);
    const choiceKey = JSON.stringify([item.id, item.url, item.icon, item.title]);
    const preferred = iconChoices[choiceKey];
    if (preferred && Date.now() - preferred.at < 7 * 86400000 && candidates.includes(preferred.url)) {
      candidates.splice(candidates.indexOf(preferred.url), 1);
      candidates.unshift(preferred.url);
    }
    if (candidates.length) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      let candidateIndex = 0;
      image.addEventListener("load", () => {
        icon.replaceChildren(image);
        iconChoices[choiceKey] = { url: candidates[candidateIndex], at: Date.now() };
        clearTimeout(iconSaveTimer);
        iconSaveTimer = setTimeout(() => {
          const entries = Object.entries(iconChoices).sort((a, b) => b[1].at - a[1].at).slice(0, 1000);
          iconChoices = Object.fromEntries(entries);
          void storageSet(ICON_CHOICES_KEY, JSON.stringify(iconChoices));
        }, 300);
      });
      image.addEventListener("error", () => { const next = candidates[++candidateIndex]; if (next) image.src = next; else image.remove(); });
      icon.append(image);
      image.src = candidates[candidateIndex];
    }
    return icon;
  }
  function emptyInline(title, copy) {
    const box = document.createElement("div");
    box.className = "empty-inline";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.textContent = copy;
    box.append(strong, span);
    return box;
  }
  function safeHost(url) { try { return new URL(url).hostname; } catch (_error) { return url; } }
  function itemUrl(item) { return core.chooseUrl(item, location.hostname, state.catalog.settings.localAccessHosts); }
  function openItem(item) { void recordClick(item.id); window.open(itemUrl(item), "_blank", "noopener,noreferrer"); }
  async function recordClick(itemId) {
    if (!state.preferences.recordActivity) return;
    state.activity = await provider.record(itemId, new Set(state.itemMap.keys()));
    setTimeout(renderActivity, 0);
  }
  function hideFrequent() { state.preferences.showFrequent = false; savePreferences(); renderActivity(); }
  function hideRecent() { state.preferences.showRecent = false; savePreferences(); renderActivity(); }
  function openSettings() {
    elements.recordActivity.checked = state.preferences.recordActivity;
    elements.showFrequent.checked = state.preferences.showFrequent;
    elements.showRecent.checked = state.preferences.showRecent;
    elements.settings.showModal();
  }
  function saveSettings() {
    state.preferences.recordActivity = elements.recordActivity.checked;
    state.preferences.showFrequent = elements.showFrequent.checked;
    state.preferences.showRecent = elements.showRecent.checked;
    savePreferences();
    if (state.catalog) renderActivity();
  }
  async function clearActivity() {
    await provider.clear();
    state.activity = { schemaVersion: 1, items: [] };
    renderActivity();
  }

  void readPreferences().then((preferences) => {
    state.preferences = preferences;
    if (state.catalog) renderActivity();
  });
})();
