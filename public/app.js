let sessionId = null;
let eventSource = null;
let agentBubble = null;
let agentText = "";
let isAgentRunning = false;
let scrollThrottleTimer = null;
let userHasScrolledUp = false;
let hasMessages = false;
let landingVisible = false;
let landingInvocationId = 0;
let pendingImages = [];
let reconnectAttempts = 0;
let reconnectTimer = null;
let catchUpInProgress = false;
let syncPollTimer = null;
let isSyncingToCloud = false;
let textOffsetAfterCatchUp = 0;
let lastSentMessage = null;
let timeoutRetryCount = 0;
let thinkingStartTime = null;
let thinkingTimerInterval = null;
let lastEventTime = 0;
let ambientTickerTimer = null;
let ambientTickerItems = [];
let ambientTickerIndex = 0;
let planningMode = localStorage.getItem("planningMode") === "true";
let lastKnownConversations = [];

const messages      = document.getElementById("messages");
const scrollAnchor  = document.getElementById("scroll-anchor");
const input         = document.getElementById("input");
const sendBtn       = document.getElementById("send-btn");
const statusBar     = document.getElementById("status-bar");
const statusText    = document.getElementById("status-text");
const newSessionBtn = document.getElementById("new-session-btn");
const statusDot     = document.getElementById("status-dot");
const kbBadge       = document.getElementById("kb-badge");
const kbDot         = document.getElementById("kb-dot");
const appEl         = document.getElementById("app");
const confirmModal  = document.getElementById("confirm-modal");
const modalConfirm  = document.getElementById("modal-confirm");
const modalCancel   = document.getElementById("modal-cancel");
const alertsSettingsBtn = document.getElementById("alerts-settings-btn");
const generateBriefBtn = document.getElementById("generate-brief-btn");
const modelBadge    = document.getElementById("model-badge");
const modelModeEl   = document.getElementById("model-mode");
const modelNameEl   = document.getElementById("model-name");
const scrollBottomBtn = document.getElementById("scroll-bottom-btn");
const planToggle     = document.getElementById("plan-toggle");
const planBanner     = document.getElementById("plan-mode-banner");
let currentModelMode = "auto";
const FULL_MODEL_ID = "claude-sonnet-4-6";

const TOOL_LABELS = {
  web_search: "🔍 SEARCHING THE WEB",
  describe_image: "👁️ ANALYZING IMAGE",
  render_page: "🌐 RENDERING PAGE",
  notes_create: "📝 WRITING TO VAULT",
  notes_update: "📝 UPDATING VAULT",
  notes_read: "📖 READING VAULT",
  notes_search: "📖 SEARCHING VAULT",
  notes_list: "📖 BROWSING VAULT",
  notes_list_recursive: "📖 BROWSING VAULT",
  notes_delete: "🗑️ VAULT CLEANUP",
  notes_rename: "📝 RENAMING IN VAULT",
  notes_rename_folder: "📝 RENAMING FOLDER",
  notes_file_info: "📖 CHECKING FILE INFO",
  calendar_events: "📅 CHECKING CALENDAR",
  calendar_create: "📅 CREATING EVENT",
  calendar_update: "📅 UPDATING EVENT",
  calendar_delete: "📅 REMOVING EVENT",
  gmail_search: "📧 SEARCHING EMAIL",
  gmail_read: "📧 READING EMAIL",
  gmail_send: "📧 SENDING EMAIL",
  gmail_reply: "📧 REPLYING TO EMAIL",
  gmail_draft: "📧 DRAFTING EMAIL",
  weather: "🌤️ CHECKING WEATHER",
  delegate: "🤖 CONSULTING SPECIALIST",
  stock_price: "📈 CHECKING STOCKS",
  stock_chart: "📈 LOADING CHART",
  task_list: "✅ CHECKING TASKS",
  task_create: "✅ CREATING TASK",
  task_update: "✅ UPDATING TASK",
  task_complete: "✅ COMPLETING TASK",
  news_search: "📰 SEARCHING NEWS",
  news_top: "📰 TOP HEADLINES",
  docs_list: "📄 LISTING DOCS",
  docs_get: "📄 READING DOC",
  docs_create: "📄 CREATING DOC",
  docs_append: "📄 WRITING TO DOC",
  slides_list: "📽️ LISTING SLIDES",
  slides_get: "📽️ READING SLIDES",
  slides_create: "📽️ CREATING SLIDES",
  slides_append: "📽️ ADDING SLIDE",
  youtube_search: "🎬 SEARCHING YOUTUBE",
  youtube_video: "🎬 VIDEO DETAILS",
  youtube_channel: "🎬 CHANNEL INFO",
  youtube_trending: "🎬 TRENDING VIDEOS",
  twitter_search: "🐦 SEARCHING TWITTER",
  maps_search: "🗺️ SEARCHING MAPS",
  maps_directions: "🗺️ GETTING DIRECTIONS",
  conversation_search: "💬 SEARCHING HISTORY",
  interview: "📋 PREPARING FORM",
  drive_list: "📁 BROWSING DRIVE",
  drive_get: "📁 CHECKING FILE",
  drive_create_folder: "📁 CREATING FOLDER",
  drive_move: "📁 MOVING FILE",
  drive_rename: "📁 RENAMING FILE",
  drive_delete: "🗑️ TRASHING FILE",
  sheets_list: "📊 LISTING SHEETS",
  sheets_read: "📊 READING SHEET",
  sheets_append: "📊 ADDING ROWS",
  sheets_update: "📊 UPDATING SHEET",
  sheets_create: "📊 CREATING SHEET",
  sheets_add_sheet: "📊 ADDING TAB",
  sheets_delete_sheet: "📊 REMOVING TAB",
  sheets_clear: "📊 CLEARING CELLS",
  sheets_format_cells: "📊 FORMATTING CELLS",
  sheets_auto_resize: "📊 RESIZING COLUMNS",
  sheets_merge_cells: "📊 MERGING CELLS",
  sheets_batch_update: "📊 UPDATING SHEET",
  sheets_sort: "📊 SORTING DATA",
  docs_insert_text: "📄 INSERTING TEXT",
  docs_delete_content: "📄 DELETING CONTENT",
  docs_insert_table: "📄 INSERTING TABLE",
  docs_format_text: "📄 FORMATTING TEXT",
  docs_insert_image: "📄 INSERTING IMAGE",
  docs_replace_text: "📄 FIND & REPLACE",
  docs_insert_heading: "📄 ADDING HEADING",
  docs_batch_update: "📄 UPDATING DOC",
  slides_insert_table: "📽️ INSERTING TABLE",
  slides_insert_image: "📽️ INSERTING IMAGE",
  slides_insert_shape: "📽️ ADDING SHAPE",
  slides_format_text: "📽️ FORMATTING TEXT",
  slides_delete_slide: "📽️ DELETING SLIDE",
  slides_duplicate_slide: "📽️ DUPLICATING SLIDE",
  slides_replace_text: "📽️ FIND & REPLACE",
  slides_batch_update: "📽️ UPDATING SLIDES",
};

const DELEGATE_LABELS = {
  "deep-researcher": "📚 Deep Research",
  "analyst": "📈 Market Analysis",
  "moodys": "🏢 Moody's Specialist",
  "real-estate": "🏠 Property Search",
  "email-drafter": "📧 Drafting Email",
  "nutritionist": "🥗 Meal Planning",
  "family-planner": "👨‍👩‍👧 Family Planning",
  "knowledge-organizer": "📖 Organizing Vault",
  "project-planner": "📋 Project Planning",
};
function getToolStatusLabel(toolName) {
  if (!toolName) return "🧠 THINKING...";
  return TOOL_LABELS[toolName] || `⚙️ ${toolName.toUpperCase().replace(/_/g, " ")}`;
}
function getReadableToolName(toolName) {
  if (!toolName) return null;
  if (toolName.startsWith("delegate:")) {
    const agentId = toolName.split(":")[1];
    return DELEGATE_LABELS[agentId] || "🤖 Specialist";
  }
  return TOOL_LABELS[toolName] || toolName.replace(/_/g, " ");
}

function checkAuth(res) {
  if (res.status === 401) {
    window.location.href = "/login.html";
    return false;
  }
  return true;
}

messages.addEventListener("scroll", () => {
  const threshold = 80;
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < threshold;
  userHasScrolledUp = !atBottom;
  if (scrollBottomBtn) {
    scrollBottomBtn.classList.toggle("hidden", atBottom);
  }
});

if (scrollBottomBtn) {
  scrollBottomBtn.addEventListener("click", () => {
    messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
    scrollBottomBtn.classList.add("hidden");
  });
}

if (window.visualViewport) {
  const vv = window.visualViewport;
  function onViewportResize() {
    const keyboardOpen = window.innerHeight - vv.height > 100;
    appEl.style.height = vv.height + "px";
    appEl.style.transform = vv.offsetTop > 0 ? "translateY(" + vv.offsetTop + "px)" : "";
    if (keyboardOpen) {
      document.body.classList.add("keyboard-open");
    } else {
      document.body.classList.remove("keyboard-open");
    }
    requestAnimationFrame(() => {
      if (!userHasScrolledUp) scrollToBottom();
    });
  }
  vv.addEventListener("resize", onViewportResize);
  vv.addEventListener("scroll", onViewportResize);
  if (window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches) {
    onViewportResize();
  }
}

(async () => {
  const savedSession = localStorage.getItem("activeSession");
  if (savedSession) {
    try {
      const res = await fetch(`/api/session/${savedSession}/status`);
      if (res.ok) {
        const status = await res.json();
        if (status.alive) {
          sessionId = savedSession;
          clearMessages();
          const msgs = status.messages || [];
          if (msgs.length > 0) {
            removeEmptyState();
            for (const msg of msgs) {
              if (msg.role === "user") appendBubble("user", msg.text, msg.timestamp);
              else if (msg.role === "agent") appendBubble("agent", msg.text, msg.timestamp);
            }
            hasMessages = true;
            if (msgs.length > 0 && !status.agentRunning) {
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg.role === "agent") renderSuggestionChipsFromText(lastMsg.text);
            }
          } else {
            showEmptyState();
          }
          if (status.pendingInterview) {
            isAgentRunning = !!status.agentRunning;
            renderInterviewForm(status.pendingInterview);
          } else if (status.agentRunning) {
            isAgentRunning = true;
            if (status.currentAgentText) {
              removeEmptyState();
              agentBubble = appendBubble("agent", "");
              agentText = status.currentAgentText;
              const bbl = agentBubble.querySelector(".bubble");
              bbl.innerHTML = renderMarkdown(agentText);
              bbl.dataset.rawText = agentText;
            }
            startThinkingTimer();
            showStatus(getToolStatusLabel(status.currentToolName));
          }
          openEventStream(sessionId);
          startSyncPolling();
          scrollToBottom();
          showSystemMsg("SESSION RESUMED.");
          if (planningMode) {
            fetch(`/api/session/${sessionId}/planning-mode`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: true }),
            }).catch(() => {});
          }
          return;
        }
      }
    } catch (err) { console.warn("Session restore failed:", err); }
    localStorage.removeItem("activeSession");
  }
  showLanding();
})();

async function startSession() {
  try {
    showStatus("[INITIALIZING...]");
    const res = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (!checkAuth(res)) return;
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    sessionId = data.sessionId;
    hasMessages = false;
    reconnectAttempts = 0;
    localStorage.setItem("activeSession", sessionId);
    updateModeDisplay(currentModelMode);
    updateModelBadge(FULL_MODEL_ID);
    openEventStream(sessionId);
    startSyncPolling();
    hideStatus();
    fetch(`/api/session/${sessionId}/model-mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: currentModelMode }),
    }).catch((err) => console.warn("Initial model-mode sync failed:", err));
    if (planningMode) {
      fetch(`/api/session/${sessionId}/planning-mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }).catch((err) => console.warn("Initial planning-mode sync failed:", err));
    }
  } catch (err) {
    showSystemMsg("ERR: " + err.message);
    hideStatus();
  }
}

const homeBtn = document.getElementById("home-btn");
homeBtn.addEventListener("click", () => {
  if (landingVisible) return;
  stopSyncPolling();
  if (eventSource) { eventSource.close(); eventSource = null; }
  showLanding();
});

newSessionBtn.addEventListener("click", async () => {
  if (landingVisible) return;
  stopSyncPolling();
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (sessionId) {
    await fetch(`/api/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
    localStorage.removeItem("activeSession");
    sessionId = null;
  }
  cleanupCurrentSession();
  clearMessages();
  showEmptyState();
  await startSession();
});

modalConfirm.addEventListener("click", () => {
  confirmModal.classList.add("hidden");
});

modalCancel.addEventListener("click", () => {
  confirmModal.classList.add("hidden");
});

confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) confirmModal.classList.add("hidden");
});

function cleanupCurrentSession() {
  stopSyncPolling();
  stopLandingTicker();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (eventSource) { eventSource.close(); eventSource = null; }
  agentBubble = null;
  agentText = "";
  isAgentRunning = false;
  hasMessages = false;
  reconnectAttempts = 0;
  setConnected(false);
}

function relativeTime(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffS = Math.floor((now - then) / 1000);
  if (diffS < 60) return "just now";
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return "yesterday";
  if (diffD < 7) return `${diffD}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function showLanding() {
  stopLandingTicker();
  landingVisible = true;
  input.disabled = true;
  sendBtn.disabled = true;

  const thisInvocation = ++landingInvocationId;

  let landing = document.getElementById("landing");
  if (landing) landing.remove();
  landing = document.createElement("div");
  landing.id = "landing";
  messages.parentElement.appendChild(landing);
  landing.innerHTML = `<div class="landing-header">
    <h2>[MISSION CONTROL]</h2>
    <div class="landing-header-actions">
      <button class="landing-header-btn" id="landing-cost-btn" title="Cost">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
        </svg>
      </button>
      <button class="landing-header-btn" id="landing-jobs-btn" title="Agents">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="10" rx="2"/><line x1="12" y1="2" x2="12" y2="6"/><circle cx="12" cy="6" r="2"/><circle cx="9" cy="16" r="1"/><circle cx="15" cy="16" r="1"/>
        </svg>
      </button>
      <button class="landing-header-btn" id="landing-settings-btn" title="Settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      <a href="/api/logout" class="landing-header-btn landing-off-btn" title="Log out">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
          <line x1="12" y1="2" x2="12" y2="12"/>
        </svg>
      </a>
    </div>
    <div class="landing-date"></div>
  </div>`;

  const dateEl = landing.querySelector(".landing-date");
  const now = new Date();
  dateEl.textContent = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  landing.querySelector("#landing-cost-btn").addEventListener("click", () => {
    openCostOverlay();
  });
  landing.querySelector("#landing-jobs-btn").addEventListener("click", () => {
    toggleJobsPanel();
  });
  landing.querySelector("#landing-settings-btn").addEventListener("click", () => {
    toggleSettings();
  });

  let convos = [];
  let glanceData = null;
  let landingAgentStatus = null;
  let inboxHistory = [];
  try {
    const [convRes, glanceRes, agentRes, inboxRes] = await Promise.all([
      fetch("/api/conversations").then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("/api/glance").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/agents/status").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/vault-inbox/history").then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    convos = convRes;
    glanceData = glanceRes;
    landingAgentStatus = agentRes;
    inboxHistory = inboxRes;
  } catch (err) { console.warn("Landing data fetch failed:", err); }

  if (thisInvocation !== landingInvocationId) return;

  convos.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  lastKnownConversations = convos;

  if (landingAgentStatus) {
    const isJobRunning = landingAgentStatus.job && landingAgentStatus.job.running;
    const activeSessions = landingAgentStatus.sessions || [];
    if (isJobRunning || activeSessions.length > 0) {
      const runIndicator = document.createElement("div");
      runIndicator.className = "landing-running-indicator";
      const runName = isJobRunning
        ? (landingAgentStatus.job.jobName || "Background job")
        : (activeSessions[0].conversationTitle || "Agent");
      const toolLabel = !isJobRunning && activeSessions[0]?.tool ? (getReadableToolName(activeSessions[0].tool) || activeSessions[0].tool) : "";
      runIndicator.innerHTML = `<div class="landing-running-dot"></div>
        <span class="landing-running-name">${escapeHtml(runName)}</span>
        ${toolLabel ? `<span class="landing-running-tool">${escapeHtml(toolLabel)}</span>` : ""}`;
      landing.appendChild(runIndicator);
    }
  }

  const dropBox = document.createElement("div");
  dropBox.className = "vault-inbox";
  const historyItems = (inboxHistory || []).filter(h => h.status === "filed").slice(0, 5);
  const historyHtml = historyItems.length > 0 ? `<div class="vault-inbox-history" id="vault-inbox-history">
    ${historyItems.map(h => {
      const ago = formatTimeAgo(new Date(h.createdAt).toISOString());
      return `<div class="vault-inbox-history-item">
        <span class="vault-inbox-history-icon">${h.filePath?.includes("YouTube") || h.url?.includes("youtu") ? "▶" : h.url?.includes("x.com") || h.url?.includes("twitter") ? "𝕏" : h.url?.includes("github") ? "⌘" : "◉"}</span>
        <span class="vault-inbox-history-title">${escapeHtml((h.title || h.url || "").slice(0, 50))}</span>
        <span class="vault-inbox-history-time">${ago}</span>
      </div>`;
    }).join("")}
  </div>` : "";
  dropBox.innerHTML = `
    <div class="vault-inbox-header">
      <span class="vault-inbox-label">VAULT INBOX</span>
    </div>
    <div class="vault-inbox-input-wrap">
      <input type="url" class="vault-inbox-input" id="vault-inbox-url" placeholder="Paste a YouTube, article, or tweet URL..." autocomplete="off" autocorrect="off" />
      <button class="vault-inbox-submit" id="vault-inbox-btn">→</button>
    </div>
    <div class="vault-inbox-status" id="vault-inbox-status"></div>
    ${historyHtml}
  `;
  landing.appendChild(dropBox);

  const vaultInput = dropBox.querySelector("#vault-inbox-url");
  const vaultBtn = dropBox.querySelector("#vault-inbox-btn");
  const vaultStatus = dropBox.querySelector("#vault-inbox-status");

  async function submitVaultInbox() {
    const url = vaultInput.value.trim();
    if (!url) return;
    vaultBtn.disabled = true;
    vaultInput.disabled = true;
    vaultStatus.className = "vault-inbox-status processing";
    vaultStatus.innerHTML = '<div class="vault-inbox-spinner"></div> Processing...';
    try {
      const res = await fetch("/api/vault-inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, source: "drop-box" }),
      });
      const data = await res.json();
      if (data.error) {
        vaultStatus.className = "vault-inbox-status error";
        vaultStatus.textContent = data.error;
      } else if (data.status === "duplicate") {
        vaultStatus.className = "vault-inbox-status duplicate";
        vaultStatus.innerHTML = `Already in vault → <span class="vault-inbox-path">${escapeHtml(data.filePath || "")}</span>`;
      } else if (data.status === "processing") {
        vaultStatus.className = "vault-inbox-status processing";
        vaultStatus.innerHTML = '<div class="vault-inbox-spinner"></div> Agent extracting & filing...';
        pollVaultInboxResult(data.id);
      }
    } catch (err) {
      vaultStatus.className = "vault-inbox-status error";
      vaultStatus.textContent = "Failed to submit";
    }
    vaultBtn.disabled = false;
    vaultInput.disabled = false;
  }

  async function pollVaultInboxResult(id) {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res = await fetch(`/api/vault-inbox/${id}`);
        const data = await res.json();
        if (data.status === "filed") {
          vaultStatus.className = "vault-inbox-status success";
          vaultStatus.innerHTML = `<span class="vault-inbox-check">✓</span> ${escapeHtml(data.title || "Filed")} → <span class="vault-inbox-path">${escapeHtml(data.filePath || "")}</span>`;
          vaultInput.value = "";
          const historyEl = document.getElementById("vault-inbox-history");
          if (historyEl) {
            const newItem = document.createElement("div");
            newItem.className = "vault-inbox-history-item";
            newItem.innerHTML = `<span class="vault-inbox-history-icon">◉</span>
              <span class="vault-inbox-history-title">${escapeHtml((data.title || "").slice(0, 50))}</span>
              <span class="vault-inbox-history-time">just now</span>`;
            historyEl.prepend(newItem);
          }
          return;
        } else if (data.status === "error") {
          vaultStatus.className = "vault-inbox-status error";
          vaultStatus.textContent = data.error || "Processing failed";
          return;
        }
      } catch {}
    }
    vaultStatus.className = "vault-inbox-status error";
    vaultStatus.textContent = "Timed out — check vault manually";
  }

  vaultBtn.addEventListener("click", submitVaultInbox);
  vaultInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitVaultInbox();
  });

  if (glanceData) {
    const cycles = buildLandingTickerCycles(glanceData);
    if (cycles.length > 0) {
      const ticker = document.createElement("div");
      ticker.className = "landing-glance";
      ticker.id = "landing-ticker";
      ticker.innerHTML = cycles[0];
      landing.appendChild(ticker);
      startLandingTicker(cycles);
    }
  }

  const taskSection = document.createElement("div");
  taskSection.className = "landing-tasks";
  const taskItems = (glanceData && glanceData.tasks && glanceData.tasks.items) ? glanceData.tasks.items : [];
  taskSection.innerHTML = `<div class="landing-tasks-header">
    <span class="landing-tasks-label">Tasks</span>
    <span class="landing-tasks-count">${taskItems.length}</span>
  </div>`;
  const taskList = document.createElement("div");
  taskList.className = "landing-task-list";

  const completedWrap = document.createElement("div");
  completedWrap.className = "completed-tasks-wrap";
  let completedLoaded = false;
  let completedListEl = null;

  function formatCompletedDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return d.toLocaleDateString();
  }

  function renderCompletedItem(t) {
    const item = document.createElement("div");
    item.className = "completed-task-item";
    item.dataset.id = t.id;
    item.innerHTML = `
      <span class="completed-task-title">${escapeHtml(t.title)}</span>
      <span class="completed-task-date">${formatCompletedDate(t.completedAt)}</span>
      <button class="task-restore">Restore</button>
    `;
    item.querySelector(".task-restore").addEventListener("click", async (e) => {
      e.stopPropagation();
      item.classList.add("task-restoring");
      try {
        const res = await fetch(`/api/tasks/${t.id}/restore`, { method: "PATCH" });
        if (!res.ok) throw new Error("failed");
        setTimeout(() => {
          item.remove();
          const emptyMsg = taskList.querySelector(".landing-tasks-empty");
          if (emptyMsg) emptyMsg.remove();
          taskList.appendChild(renderTaskItem({ id: t.id, title: t.title, priority: t.priority }));
          const countEl = taskSection.querySelector(".landing-tasks-count");
          if (countEl) countEl.textContent = taskList.querySelectorAll(".landing-task-item").length;
          updateCompletedToggleCount();
        }, 350);
      } catch {
        item.classList.remove("task-restoring");
      }
    });
    return item;
  }

  function updateCompletedToggleCount() {
    const toggle = completedWrap.querySelector(".completed-tasks-toggle");
    if (toggle && completedListEl) {
      const count = completedListEl.querySelectorAll(".completed-task-item").length;
      toggle.querySelector(".completed-toggle-text").textContent = `Completed (${count})`;
      if (count === 0) {
        completedWrap.innerHTML = "";
        completedLoaded = false;
      }
    }
  }

  function renderTaskItem(t) {
    const item = document.createElement("div");
    item.className = "landing-task-item";
    item.dataset.id = t.id;
    const priClass = t.priority === "high" ? "pri-high" : t.priority === "low" ? "pri-low" : "pri-med";
    item.innerHTML = `
      <button class="task-check" title="Complete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></button>
      <span class="task-pri-dot ${priClass}"></span>
      <span class="task-title">${escapeHtml(t.title)}</span>
      ${t.dueDate ? `<span class="task-due">${escapeHtml(t.dueDate)}</span>` : ""}
      <button class="task-go" title="Work on this">Go</button>
    `;
    item.querySelector(".task-check").addEventListener("click", async (e) => {
      e.stopPropagation();
      item.classList.add("task-completing");
      try {
        const res = await fetch(`/api/tasks/${t.id}/complete`, { method: "PATCH" });
        if (!res.ok) throw new Error("failed");
        setTimeout(() => {
          item.remove();
          const countEl = taskSection.querySelector(".landing-tasks-count");
          const remaining = taskList.querySelectorAll(".landing-task-item").length;
          if (countEl) countEl.textContent = remaining;
          if (remaining === 0) {
            taskList.innerHTML = `<div class="landing-tasks-empty">All clear</div>`;
          }
          if (completedLoaded && completedListEl) {
            completedListEl.prepend(renderCompletedItem({ id: t.id, title: t.title, priority: t.priority, completedAt: new Date().toISOString() }));
            updateCompletedToggleCount();
          } else if (!completedLoaded) {
            const toggle = document.createElement("button");
            toggle.className = "completed-tasks-toggle";
            toggle.innerHTML = `<span class="completed-tasks-chevron">▶</span> <span class="completed-toggle-text">Completed (1)</span>`;
            completedListEl = document.createElement("div");
            completedListEl.className = "completed-task-list";
            completedListEl.style.display = "none";
            completedListEl.appendChild(renderCompletedItem({ id: t.id, title: t.title, priority: t.priority, completedAt: new Date().toISOString() }));
            toggle.addEventListener("click", () => {
              toggle.classList.toggle("expanded");
              completedListEl.style.display = toggle.classList.contains("expanded") ? "flex" : "none";
            });
            completedWrap.appendChild(toggle);
            completedWrap.appendChild(completedListEl);
            completedLoaded = true;
          }
        }, 500);
      } catch {
        item.classList.remove("task-completing");
      }
    });
    item.querySelector(".task-go").addEventListener("click", (e) => {
      e.stopPropagation();
      hideLandingAndRun(async () => {
        if (sessionId) {
          await fetch(`/api/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
          localStorage.removeItem("activeSession");
          sessionId = null;
        }
        cleanupCurrentSession();
        clearMessages();
        showEmptyState();
        await startSession();
        input.value = `Help me with this task: ${t.title}`;
        sendMessage();
      });
    });
    return item;
  }

  if (taskItems.length === 0) {
    taskList.innerHTML = `<div class="landing-tasks-empty">All clear</div>`;
  } else {
    taskItems.forEach(t => taskList.appendChild(renderTaskItem(t)));
  }
  taskSection.appendChild(taskList);

  const addTaskWrap = document.createElement("div");
  addTaskWrap.className = "task-add-wrap";
  addTaskWrap.innerHTML = `<button class="task-add-toggle">+ Add task</button>`;
  const addForm = document.createElement("div");
  addForm.className = "task-add-form hidden";
  addForm.innerHTML = `
    <input type="text" class="task-add-input" placeholder="Task title..." />
    <select class="task-add-priority">
      <option value="medium">Med</option>
      <option value="high">High</option>
      <option value="low">Low</option>
    </select>
    <button class="task-add-submit">Add</button>
  `;
  addTaskWrap.appendChild(addForm);
  addTaskWrap.querySelector(".task-add-toggle").addEventListener("click", () => {
    addForm.classList.toggle("hidden");
    if (!addForm.classList.contains("hidden")) {
      addForm.querySelector(".task-add-input").focus();
    }
  });
  const submitTask = async () => {
    const titleInput = addForm.querySelector(".task-add-input");
    const priSelect = addForm.querySelector(".task-add-priority");
    const title = titleInput.value.trim();
    if (!title) return;
    titleInput.value = "";
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, priority: priSelect.value }),
      });
      if (res.ok) {
        const data = await res.json();
        const newTask = data.task;
        if (newTask) {
          const emptyMsg = taskList.querySelector(".landing-tasks-empty");
          if (emptyMsg) emptyMsg.remove();
          taskList.appendChild(renderTaskItem(newTask));
          const countEl = taskSection.querySelector(".landing-tasks-count");
          if (countEl) countEl.textContent = taskList.querySelectorAll(".landing-task-item").length;
        }
        addForm.classList.add("hidden");
      }
    } catch (err) { console.warn("Add task failed:", err); }
  };
  addForm.querySelector(".task-add-submit").addEventListener("click", submitTask);
  addForm.querySelector(".task-add-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitTask();
  });
  taskSection.appendChild(addTaskWrap);

  (async () => {
    try {
      const res = await fetch("/api/tasks/completed");
      if (!res.ok) return;
      const completed = await res.json();
      if (completed.length === 0) return;
      const toggle = document.createElement("button");
      toggle.className = "completed-tasks-toggle";
      toggle.innerHTML = `<span class="completed-tasks-chevron">▶</span> <span class="completed-toggle-text">Completed (${completed.length})</span>`;
      completedListEl = document.createElement("div");
      completedListEl.className = "completed-task-list";
      completedListEl.style.display = "none";
      completed.forEach(t => completedListEl.appendChild(renderCompletedItem(t)));
      toggle.addEventListener("click", () => {
        toggle.classList.toggle("expanded");
        completedListEl.style.display = toggle.classList.contains("expanded") ? "flex" : "none";
      });
      completedWrap.appendChild(toggle);
      completedWrap.appendChild(completedListEl);
      completedLoaded = true;
    } catch {}
  })();

  taskSection.appendChild(completedWrap);
  landing.appendChild(taskSection);

  const newBtn = document.createElement("button");
  newBtn.className = "landing-new-btn";
  newBtn.textContent = "[NEW MISSION]";
  newBtn.addEventListener("click", () => {
    hideLandingAndRun(async () => {
      if (sessionId) {
        await fetch(`/api/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
        localStorage.removeItem("activeSession");
        sessionId = null;
      }
      cleanupCurrentSession();
      clearMessages();
      showEmptyState();
      await startSession();
    });
  });
  landing.appendChild(newBtn);

  function getDateGroup(ts) {
    const now = new Date();
    const d = new Date(ts);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - startOfToday.getDay());
    if (d >= startOfToday) return "Today";
    if (d >= startOfYesterday) return "Yesterday";
    if (d >= startOfWeek) return "This Week";
    return "Earlier";
  }

  function renderGroupedCards(list, container) {
    container.innerHTML = "";
    let currentGroup = null;
    for (const convo of list) {
      const group = getDateGroup(convo.updatedAt || convo.createdAt);
      if (group !== currentGroup) {
        currentGroup = group;
        const header = document.createElement("div");
        header.className = "landing-group-header";
        header.textContent = group;
        container.appendChild(header);
      }
      container.appendChild(createLandingCard(convo, landingAgentStatus));
    }
  }

  let lastCardEl = null;
  if (convos.length > 0) {
    const last = convos[0];
    lastCardEl = document.createElement("div");
    lastCardEl.className = "landing-last";
    let previewHtml = "";
    try {
      const detailRes = await fetch(`/api/conversations/${last.id}`);
      if (detailRes.ok) {
        const detail = await detailRes.json();
        if (detail.messages && detail.messages.length > 0) {
          const previews = detail.messages.slice(-2);
          previewHtml = previews.map(m => {
            const role = m.role === "user" ? "rickin" : "darknode";
            const text = (m.text || "").slice(0, 100) + ((m.text || "").length > 100 ? "..." : "");
            return `<span class="preview-role">${role}:</span> ${escapeHtml(text)}`;
          }).join("<br>");
        }
      }
    } catch (err) { console.warn("Preview fetch failed:", err); }
    let lastStatusClass = "status-idle";
    let lastStatusLabel = "";
    if (landingAgentStatus) {
      const activeSession = (landingAgentStatus.sessions || []).find(s => s.conversationId === last.id);
      if (activeSession) {
        lastStatusClass = "status-running";
        lastStatusLabel = `<span class="landing-last-status status-running"><span class="dot-pulse" style="width:6px;height:6px"></span> RUNNING</span>`;
      } else {
        const recentCompletion = (landingAgentStatus.recentCompletions || []).find(c => c.conversationId === last.id);
        if (recentCompletion && Date.now() - recentCompletion.timestamp < 300000) {
          lastStatusClass = "status-completed";
          lastStatusLabel = `<span class="landing-last-status status-completed">✓ COMPLETED</span>`;
        }
      }
    }
    lastCardEl.innerHTML = `
      <div class="landing-last-label"><span class="landing-card-status ${lastStatusClass}" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>Last conversation${lastStatusLabel}</div>
      <div class="landing-last-title">${escapeHtml(last.title)}</div>
      <div class="landing-last-meta">${relativeTime(last.updatedAt || last.createdAt)} · ${last.messageCount} msgs</div>
      ${previewHtml ? `<div class="landing-last-preview">${previewHtml}</div>` : ""}
      <button class="landing-resume-btn">[RESUME]</button>
    `;
    lastCardEl.querySelector(".landing-resume-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      hideLandingAndRun(() => resumeConversation(last.id));
    });
    landing.appendChild(lastCardEl);
  }

  if (convos.length > 1) {
    const searchWrap = document.createElement("div");
    searchWrap.className = "landing-search-wrap";
    searchWrap.innerHTML = `<input type="text" class="landing-search" placeholder="Search conversations..." /><button class="landing-search-clear hidden">×</button>`;
    landing.appendChild(searchWrap);
    const searchInput = searchWrap.querySelector(".landing-search");
    const searchClear = searchWrap.querySelector(".landing-search-clear");

    const recentContainer = document.createElement("div");
    recentContainer.className = "landing-recent";
    const restConvos = convos.slice(1);
    const initialShow = Math.min(restConvos.length, 4);
    renderGroupedCards(restConvos.slice(0, initialShow), recentContainer);
    landing.appendChild(recentContainer);

    let viewAllBtn = null;
    let expanded = false;
    if (restConvos.length > 4) {
      viewAllBtn = document.createElement("button");
      viewAllBtn.className = "landing-view-all";
      viewAllBtn.textContent = "VIEW ALL";
      viewAllBtn.addEventListener("click", async () => {
        if (expanded) {
          renderGroupedCards(restConvos.slice(0, initialShow), recentContainer);
          viewAllBtn.textContent = "VIEW ALL";
          expanded = false;
          return;
        }
        viewAllBtn.textContent = "LOADING...";
        try {
          const allRes = await fetch("/api/conversations");
          const allConvos = allRes.ok ? await allRes.json() : convos;
          renderGroupedCards(allConvos.slice(1), recentContainer);
          viewAllBtn.textContent = "SHOW LESS";
          expanded = true;
        } catch (err) {
          console.warn("View all fetch failed:", err);
          viewAllBtn.textContent = "VIEW ALL";
        }
      });
      landing.appendChild(viewAllBtn);
    }

    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      searchClear.classList.toggle("hidden", !q);
      if (!q) {
        if (lastCardEl) lastCardEl.style.display = "";
        renderGroupedCards(expanded ? restConvos : restConvos.slice(0, initialShow), recentContainer);
        if (viewAllBtn) viewAllBtn.style.display = "";
        return;
      }
      if (lastCardEl) lastCardEl.style.display = "none";
      if (viewAllBtn) viewAllBtn.style.display = "none";
      const filtered = convos.filter(c => c.title.toLowerCase().includes(q));
      renderGroupedCards(filtered, recentContainer);
      if (filtered.length === 0) {
        recentContainer.innerHTML = `<div class="landing-empty">No matches found.</div>`;
      }
    });
    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input"));
      searchInput.focus();
    });
  }

  if (convos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "landing-empty";
    empty.textContent = "No previous missions.";
    landing.appendChild(empty);
  }

  let pullStartY = 0;
  let pullDelta = 0;
  let pullIndicator = null;
  landing.addEventListener("touchstart", (e) => {
    if (landing.scrollTop === 0) {
      pullStartY = e.touches[0].clientY;
      pullDelta = 0;
    } else {
      pullStartY = 0;
    }
  }, { passive: true });
  landing.addEventListener("touchmove", (e) => {
    if (!pullStartY) return;
    pullDelta = e.touches[0].clientY - pullStartY;
    if (pullDelta > 0 && landing.scrollTop === 0) {
      if (!pullIndicator) {
        pullIndicator = document.createElement("div");
        pullIndicator.className = "pull-indicator";
        landing.prepend(pullIndicator);
      }
      const clamped = Math.min(pullDelta, 100);
      pullIndicator.style.height = clamped + "px";
      pullIndicator.style.opacity = Math.min(clamped / 60, 1);
      pullIndicator.textContent = pullDelta > 60 ? "RELEASE TO REFRESH" : "PULL TO REFRESH";
    }
  }, { passive: true });
  landing.addEventListener("touchend", async () => {
    if (pullDelta > 60) {
      if (pullIndicator) {
        pullIndicator.textContent = "REFRESHING...";
        pullIndicator.style.height = "40px";
      }
      try {
        const [newConvRes, newGlanceRes] = await Promise.all([
          fetch("/api/conversations").then(r => r.ok ? r.json() : []).catch(() => []),
          fetch("/api/glance").then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (newGlanceRes) {
          const cycles = buildLandingTickerCycles(newGlanceRes);
          const tickerEl = landing.querySelector("#landing-ticker");
          if (cycles.length > 0) {
            if (tickerEl) {
              tickerEl.innerHTML = cycles[0];
            } else {
              const ticker = document.createElement("div");
              ticker.className = "landing-glance";
              ticker.id = "landing-ticker";
              ticker.innerHTML = cycles[0];
              const header = landing.querySelector(".landing-header");
              if (header) header.after(ticker);
            }
            startLandingTicker(cycles);
          } else if (tickerEl) {
            stopLandingTicker();
            tickerEl.remove();
          }
        }
        newConvRes.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
        if (newConvRes.length > 0 && lastCardEl) {
          const last = newConvRes[0];
          const titleEl = lastCardEl.querySelector(".landing-last-title");
          const metaEl = lastCardEl.querySelector(".landing-last-meta");
          if (titleEl) titleEl.textContent = last.title;
          if (metaEl) metaEl.textContent = `${relativeTime(last.updatedAt || last.createdAt)} · ${last.messageCount} msgs`;
        }
        const recentContainer = landing.querySelector(".landing-recent");
        if (recentContainer && newConvRes.length > 1) {
          const rest = newConvRes.slice(1);
          renderGroupedCards(rest.slice(0, 4), recentContainer);
        }
      } catch (err) { console.warn("Pull refresh failed:", err); }
    }
    if (pullIndicator) {
      pullIndicator.remove();
      pullIndicator = null;
    }
    pullStartY = 0;
    pullDelta = 0;
  }, { passive: true });
}

function createLandingCard(convo, agentStatus) {
  const card = document.createElement("div");
  card.className = "landing-card";
  card.dataset.convoId = convo.id;

  let statusClass = "status-idle";
  let toolHtml = "";
  if (agentStatus) {
    const activeSession = (agentStatus.sessions || []).find(s => s.conversationId === convo.id);
    if (activeSession) {
      statusClass = "status-running";
      if (activeSession.tool) {
        const readableTool = getReadableToolName(activeSession.tool) || activeSession.tool;
        toolHtml = `<div class="landing-card-tool">${escapeHtml(readableTool)}</div>`;
      }
    } else {
      const recentCompletion = (agentStatus.recentCompletions || []).find(c => c.conversationId === convo.id);
      if (recentCompletion && Date.now() - recentCompletion.timestamp < 300000) {
        statusClass = "status-completed";
      }
    }
  }

  card.innerHTML = `
    <div class="landing-card-status ${statusClass}"></div>
    <div class="landing-card-main">
      <div class="landing-card-title">${escapeHtml(convo.title)}</div>
      <div class="landing-card-meta">${relativeTime(convo.updatedAt || convo.createdAt)} · ${convo.messageCount} msgs</div>
      ${toolHtml}
    </div>
    <button class="landing-card-delete" title="Delete">×</button>
  `;
  card.querySelector(".landing-card-main").addEventListener("click", () => {
    hideLandingAndRun(() => resumeConversation(convo.id));
  });
  card.querySelector(".landing-card-delete").addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await fetch(`/api/conversations/${convo.id}`, { method: "DELETE" });
      card.remove();
    } catch (err) { console.warn("Delete conversation failed:", err); }
  });
  return card;
}

function hideLandingAndRun(fn, slideDirection) {
  const landing = document.getElementById("landing");
  if (landing) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      landing.remove();
      landingVisible = false;
      input.disabled = false;
      sendBtn.disabled = false;
      fn();
    };
    if (slideDirection === "left") {
      landing.style.transform = "translateX(-40px)";
      landing.style.opacity = "0";
      landing.style.pointerEvents = "none";
    } else {
      landing.classList.add("landing-hidden");
    }
    landing.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 500);
  } else {
    landingVisible = false;
    input.disabled = false;
    sendBtn.disabled = false;
    fn();
  }
}

function openEventStream(id) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/session/${id}/stream`);

  eventSource.addEventListener("open", () => {
    setConnected(true);
    lastEventTime = Date.now();
    startHeartbeatMonitor();
    const wasReconnecting = reconnectAttempts > 0;
    reconnectAttempts = 0;
    if (wasReconnecting) {
      catchUpSession(id, 0, true);
      hideStatus();
    }
  });

  eventSource.addEventListener("message", (e) => {
    lastEventTime = Date.now();
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    handleAgentEvent(event);
  });

  eventSource.addEventListener("error", () => {
    setConnected(false);
    if (!sessionId) return;
    const MAX_RETRIES = 30;
    if (reconnectAttempts >= MAX_RETRIES) {
      showSystemMsg("CONNECTION LOST. TAP + TO RECONNECT.");
      return;
    }
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
    if (isAgentRunning) {
      showStatus("[RECONNECTING...]");
    }
    reconnectTimer = setTimeout(() => {
      if (sessionId === id) openEventStream(id);
    }, delay);
  });
}

async function catchUpSession(sid, retryCount = 0, wasReconnecting = false) {
  if (catchUpInProgress) return;
  catchUpInProgress = true;
  try {
    let res;
    try {
      res = await fetch(`/api/session/${sid}/status`);
    } catch (fetchErr) {
      catchUpInProgress = false;
      if (retryCount < 1) {
        setTimeout(() => catchUpSession(sid, retryCount + 1), 2000);
      }
      return;
    }
    if (!res.ok) {
      catchUpInProgress = false;
      if (retryCount < 1) {
        setTimeout(() => catchUpSession(sid, retryCount + 1), 2000);
      }
      return;
    }
    const status = await res.json();
    if (!status.alive) {
      localStorage.removeItem("activeSession");
      stopHeartbeatMonitor();
      if (eventSource) { eventSource.close(); eventSource = null; }
      sessionId = null;
      catchUpInProgress = false;
      showSystemMsg("Session expired. Returning to home screen.");
      setTimeout(() => showLanding(), 1500);
      return;
    }

    const serverMessages = status.messages || [];
    const domBubbles = messages.querySelectorAll(".msg.user, .msg.agent");
    const domCount = domBubbles.length;

    if (serverMessages.length === domCount && status.agentRunning === isAgentRunning && !status.currentAgentText && !status.currentToolName && !status.pendingCount) {
      catchUpInProgress = false;
      return;
    }

    if (serverMessages.length > domCount) {
      removeEmptyState();
      removeSuggestionChips();
      agentBubble = null;
      agentText = "";
      const newCount = serverMessages.length - domCount;
      if (newCount > 0 && wasReconnecting) {
        const badge = document.createElement("div");
        badge.className = "reconnect-badge";
        const agentMsgs = serverMessages.slice(domCount).filter(m => m.role === "agent").length;
        if (agentMsgs > 0) {
          badge.textContent = `✓ ${agentMsgs} response${agentMsgs > 1 ? "s" : ""} completed while away`;
        } else {
          badge.textContent = `↓ ${newCount} new message${newCount > 1 ? "s" : ""}`;
        }
        messages.appendChild(badge);
      }
      for (let i = domCount; i < serverMessages.length; i++) {
        const msg = serverMessages[i];
        if (msg.role === "user") appendBubble("user", msg.text, msg.timestamp);
        else if (msg.role === "agent") appendBubble("agent", msg.text, msg.timestamp);
      }
      hasMessages = true;
    } else if (serverMessages.length < domCount || (!status.agentRunning && isAgentRunning)) {
      clearMessages();
      removeSuggestionChips();
      agentBubble = null;
      agentText = "";
      if (serverMessages.length > 0) {
        removeEmptyState();
        for (const msg of serverMessages) {
          if (msg.role === "user") appendBubble("user", msg.text, msg.timestamp);
          else if (msg.role === "agent") appendBubble("agent", msg.text, msg.timestamp);
        }
        hasMessages = true;
      }
    }

    if (status.pendingInterview && !messages.querySelector(".interview-card:not(.interview-submitted)")) {
      renderInterviewForm(status.pendingInterview);
    } else if (status.agentRunning) {
      if (status.currentAgentText) {
        if (!agentBubble) {
          removeEmptyState();
          agentBubble = appendBubble("agent", "");
        }
        agentText = status.currentAgentText;
        textOffsetAfterCatchUp = agentText.length;
        const bbl = agentBubble.querySelector(".bubble");
        bbl.innerHTML = renderMarkdown(agentText);
        bbl.dataset.rawText = agentText;
      } else {
        textOffsetAfterCatchUp = 0;
      }
      isAgentRunning = true;
      if (!thinkingStartTime) startThinkingTimer();
      const toolLabel = getToolStatusLabel(status.currentToolName);
      showStatus(status.pendingCount > 0 ? `${toolLabel} ${status.pendingCount} QUEUED` : toolLabel);
    } else {
      isAgentRunning = false;
      agentBubble = null;
      agentText = "";
      textOffsetAfterCatchUp = 0;
      hideStatus();
      if (serverMessages.length > 0) {
        const lastMsg = serverMessages[serverMessages.length - 1];
        if (lastMsg.role === "agent") renderSuggestionChipsFromText(lastMsg.text);
      }
    }
    scrollToBottom();
  } catch (err) {
    console.error("Catch-up failed:", err);
  }
  catchUpInProgress = false;
}

function setConnected(connected) {
  if (connected) {
    statusDot.classList.remove("disconnected");
    statusDot.title = "Server: connected";
  } else {
    statusDot.classList.add("disconnected");
    statusDot.title = "Server: disconnected";
  }
}

async function pollKbStatus() {
  try {
    const res = await fetch("/api/kb-status");
    if (!res.ok) throw new Error("not ok");
    const { online } = await res.json();
    if (online) {
      kbDot.classList.remove("offline");
      kbDot.title = "Knowledge Vault: connected";
      kbBadge.classList.remove("offline");
    } else {
      kbDot.classList.add("offline");
      kbDot.title = "Knowledge Vault: offline";
      kbBadge.classList.add("offline");
    }
  } catch {
    kbDot.classList.add("offline");
    kbDot.title = "Knowledge Vault: unknown";
    kbBadge.classList.add("offline");
  }
}
pollKbStatus();
setInterval(pollKbStatus, 2 * 60 * 1000);

let wasBackgrounded = false;
let heartbeatMonitor = null;

function startHeartbeatMonitor() {
  if (heartbeatMonitor) clearInterval(heartbeatMonitor);
  heartbeatMonitor = setInterval(() => {
    if (!sessionId || !eventSource) return;
    if (eventSource.readyState !== EventSource.OPEN) return;
    const elapsed = Date.now() - lastEventTime;
    if (elapsed > 45000) {
      console.log("[sse] heartbeat monitor: no events for 45s, force-reconnecting");
      forceReconnect();
    }
  }, 20000);
}

function stopHeartbeatMonitor() {
  if (heartbeatMonitor) { clearInterval(heartbeatMonitor); heartbeatMonitor = null; }
}

let reconnectInFlight = false;

function forceReconnect() {
  if (!sessionId || reconnectInFlight) return;
  reconnectInFlight = true;
  console.log("[sse] force-reconnecting stream");
  if (eventSource) { eventSource.close(); eventSource = null; }
  reconnectAttempts = 1;
  openEventStream(sessionId);
  setTimeout(() => { reconnectInFlight = false; }, 3000);
}

function attemptReconnect() {
  if (!sessionId) return;
  if (wasBackgrounded) {
    wasBackgrounded = false;
    forceReconnect();
    return;
  }
  if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
    reconnectAttempts = 0;
    openEventStream(sessionId);
  } else {
    const timeSinceLastEvent = Date.now() - lastEventTime;
    if (timeSinceLastEvent > 20000) {
      forceReconnect();
    }
  }
}

let visibilityDebounce = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    wasBackgrounded = true;
    return;
  }
  if (document.visibilityState !== "visible" || !sessionId) return;
  if (visibilityDebounce) clearTimeout(visibilityDebounce);
  visibilityDebounce = setTimeout(() => {
    visibilityDebounce = null;
    attemptReconnect();
  }, 300);
});

window.addEventListener("pageshow", (e) => {
  if (!sessionId) return;
  if (e.persisted) wasBackgrounded = true;
  setTimeout(() => attemptReconnect(), 300);
});

window.addEventListener("online", () => {
  attemptReconnect();
});

function handleAgentEvent(event) {
  if (event.type === "ping") return;
  if (catchUpInProgress && !["brief", "alert", "agent_end", "agent_start", "message_queued"].includes(event.type)) return;
  switch (event.type) {
    case "agent_start":
      isAgentRunning = true;
      agentBubble = null;
      agentText = "";
      textOffsetAfterCatchUp = 0;
      removeSuggestionChips();
      startThinkingTimer();
      showStatus("🧠 THINKING...");
      break;

    case "message_queued":
      showSystemMsg(`Queued — will process next (${event.position || 1} pending)`);
      break;

    case "message_update": {
      const ae = event.assistantMessageEvent;
      if (!ae) break;

      if (event.message && event.message.model) {
        updateModelBadge(event.message.model);
      }

      if (ae.type === "text_delta") {
        if (textOffsetAfterCatchUp > 0) {
          textOffsetAfterCatchUp -= ae.delta.length;
          if (textOffsetAfterCatchUp > 0) break;
          const overflow = -textOffsetAfterCatchUp;
          textOffsetAfterCatchUp = 0;
          if (overflow > 0 && overflow < ae.delta.length) {
            const newPart = ae.delta.slice(ae.delta.length - overflow);
            agentText += newPart;
          } else {
            break;
          }
        } else {
          agentText += ae.delta;
        }
        removeEmptyState();
        if (!agentBubble) {
          agentBubble = appendBubble("agent", "");
        }
        const bbl = agentBubble.querySelector(".bubble");
        bbl.innerHTML = renderMarkdown(agentText);
        bbl.dataset.rawText = agentText;
        throttledScroll();
      }
      break;
    }

    case "tool_execution_start": {
      const name = event.toolName ?? "tool";
      let label = TOOL_LABELS[name] || `⚙️ RUNNING ${name.toUpperCase()}`;
      if (name === "delegate" && event.toolInput) {
        const agentLabels = {
          "deep-researcher": "📚 DEEP RESEARCH",
          "analyst": "📈 MARKET ANALYSIS",
          "moodys": "🏢 MOODY'S SPECIALIST",
          "real-estate": "🏠 PROPERTY SEARCH",
          "email-drafter": "📧 DRAFTING EMAIL",
          "nutritionist": "🥗 MEAL PLANNING",
          "family-planner": "👨‍👩‍👧 FAMILY PLANNING",
          "knowledge-organizer": "📖 ORGANIZING VAULT",
          "project-planner": "📋 PROJECT PLANNING",
        };
        const agentId = event.toolInput.agent || "";
        label = agentLabels[agentId] || "🤖 CONSULTING SPECIALIST";
      }
      showStatusWithTimer(label);
      break;
    }

    case "tool_execution_end": {
      showStatusWithTimer("🧠 THINKING...");
      break;
    }

    case "interview_form":
      renderInterviewForm(event);
      break;

    case "interview_timeout": {
      const activeCard = messages.querySelector(".interview-card:not(.interview-submitted)");
      if (activeCard) {
        activeCard.classList.add("interview-submitted");
        activeCard.querySelectorAll("input, textarea").forEach(el => el.disabled = true);
        const btn = activeCard.querySelector(".interview-submit");
        if (btn) { btn.textContent = "TIMED OUT"; btn.disabled = true; }
      }
      hideStatus();
      break;
    }

    case "model_info":
      updateModelBadge(event.model);
      break;

    case "agent_end":
      if (agentBubble && agentText) {
        const rawForChips = agentText;
        agentText = stripSuggestionTag(agentText);
        const bbl = agentBubble.querySelector(".bubble");
        if (bbl) {
          bbl.innerHTML = renderMarkdown(agentText);
          bbl.dataset.rawText = agentText;
        }
        if (!agentBubble.querySelector(".copy-btn")) {
          const copyBtn = document.createElement("button");
          copyBtn.className = "copy-btn";
          copyBtn.textContent = "COPY";
          copyBtn.title = "Copy to clipboard";
          copyBtn.addEventListener("click", () => {
            const raw = bbl.dataset.rawText || bbl.textContent;
            navigator.clipboard.writeText(raw).then(() => {
              copyBtn.textContent = "COPIED";
              setTimeout(() => { copyBtn.textContent = "COPY"; }, 1500);
            });
          });
          const bblEl = agentBubble.querySelector(".bubble");
          if (bblEl) agentBubble.insertBefore(copyBtn, bblEl);
          else agentBubble.appendChild(copyBtn);
        }
        renderSuggestionChipsFromText(rawForChips);
      }
      const thinkingDuration = thinkingStartTime ? Math.floor((Date.now() - thinkingStartTime) / 1000) : 0;
      const completedText = agentText;
      isAgentRunning = false;
      agentBubble = null;
      agentText = "";
      stopThinkingTimer();
      hideStatus();
      input.focus();
      throttledScroll();
      if (thinkingDuration >= 15 && document.hidden) {
        playNotificationSound();
        showBrowserNotification("DarkNode Complete", completedText ? completedText.replace(/[#*_`]/g, "").slice(0, 120) : `Response ready (${thinkingDuration}s)`);
      }
      break;

    case "timeout":
      stopThinkingTimer();
      removeLastRetryError();
      if (timeoutRetryCount < 1 && lastSentMessage) {
        timeoutRetryCount++;
        showSystemMsg("TIMEOUT — RETRYING...");
        hideStatus();
        isAgentRunning = false;
        setTimeout(() => {
          if (!lastSentMessage || !sessionId) return;
          const body = { message: lastSentMessage.text || undefined };
          if (lastSentMessage.images && lastSentMessage.images.length > 0) body.images = lastSentMessage.images;
          fetch(`/api/session/${sessionId}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then(r => { if (!checkAuth(r)) return; }).catch(err => showSystemMsg("ERR: " + err.message));
        }, 2000);
      } else {
        showErrorWithRetry(event.error);
        isAgentRunning = false;
        hideStatus();
      }
      break;

    case "error":
      stopThinkingTimer();
      removeLastRetryError();
      showErrorWithRetry(event.error);
      isAgentRunning = false;
      hideStatus();
      break;

    case "brief":
      handleBrief(event);
      break;

    case "alert":
      handleAlert(event);
      break;

    case "job_start":
      updateAgentDot("running", event.jobName);
      jobsProgressTool = null;
      updateJobsBanner("running", event.jobName, null);
      break;

    case "job_progress":
      jobsProgressTool = event.toolName;
      updateAgentDot("running", event.jobName + (event.toolName ? " \u2014 " + event.toolName : ""));
      updateJobsBanner("running", event.jobName, event.toolName);
      break;

    case "job_complete":
      updateAgentDot("idle", null);
      showJobToast(event);
      jobsProgressTool = null;
      updateJobsBanner("idle");
      if (jobsPanel && jobsPanel.classList.contains("open")) loadJobsPanelData();
      if (hasMessages && !landingVisible) {
        const icon = event.status === "error" ? "🔴" : "🟢";
        const jobLabel = event.jobName || "Background task";
        const durationStr = event.durationMs ? ` (${Math.round(event.durationMs / 1000)}s)` : "";
        showSystemMsg(`${icon} ${jobLabel} ${event.status === "error" ? "failed" : "completed"}${durationStr}`);
      }
      break;
  }
}

function renderInterviewForm(event) {
  removeEmptyState();
  showStatus("[WAITING FOR YOUR INPUT...]");

  const card = document.createElement("div");
  card.className = "msg interview-card";

  let html = '<div class="interview-header">';
  if (event.title) {
    html += `<div class="interview-title">${escapeHtml(event.title)}</div>`;
  }
  if (event.description) {
    html += `<div class="interview-desc">${escapeHtml(event.description)}</div>`;
  }
  html += '</div><div class="interview-questions">';

  for (const q of event.questions) {
    html += `<div class="interview-q" data-qid="${escapeHtml(q.id)}" data-qtype="${q.type}">`;
    if (q.type === "info") {
      html += `<div class="interview-q-text interview-info">${escapeHtml(q.question)}</div>`;
      if (q.context) html += `<div class="interview-context">${escapeHtml(q.context)}</div>`;
    } else {
      html += `<div class="interview-q-text">${escapeHtml(q.question)}</div>`;
      if (q.context) html += `<div class="interview-context">${escapeHtml(q.context)}</div>`;

      if (q.type === "single" && q.options) {
        const recs = q.recommended ? (Array.isArray(q.recommended) ? q.recommended : [q.recommended]) : [];
        for (const opt of q.options) {
          const isRec = recs.includes(opt);
          html += `<label class="interview-option">
            <input type="radio" name="iv_${escapeHtml(q.id)}" value="${escapeHtml(opt)}"${isRec ? ' checked' : ''}>
            <span class="interview-radio"></span>
            <span class="interview-opt-label">${escapeHtml(opt)}</span>
            ${isRec ? '<span class="interview-rec">REC</span>' : ''}
          </label>`;
        }
        html += `<label class="interview-option interview-other-option">
          <input type="radio" name="iv_${escapeHtml(q.id)}" value="__other__">
          <span class="interview-radio"></span>
          <span class="interview-opt-label">Other</span>
          <input type="text" class="interview-other-input" placeholder="Specify..." disabled>
        </label>`;
      } else if (q.type === "multi" && q.options) {
        const recs = q.recommended ? (Array.isArray(q.recommended) ? q.recommended : [q.recommended]) : [];
        for (const opt of q.options) {
          const isRec = recs.includes(opt);
          html += `<label class="interview-option">
            <input type="checkbox" name="iv_${escapeHtml(q.id)}" value="${escapeHtml(opt)}"${isRec ? ' checked' : ''}>
            <span class="interview-check"></span>
            <span class="interview-opt-label">${escapeHtml(opt)}</span>
            ${isRec ? '<span class="interview-rec">REC</span>' : ''}
          </label>`;
        }
        html += `<label class="interview-option interview-other-option">
          <input type="checkbox" name="iv_${escapeHtml(q.id)}" value="__other__">
          <span class="interview-check"></span>
          <span class="interview-opt-label">Other</span>
          <input type="text" class="interview-other-input" placeholder="Specify..." disabled>
        </label>`;
      } else if (q.type === "text") {
        html += `<textarea class="interview-text" name="iv_${escapeHtml(q.id)}" rows="3" placeholder="Type your response..."></textarea>`;
      }
    }
    html += '</div>';
  }

  html += '</div>';
  html += '<div class="interview-actions"><button class="interview-submit">SUBMIT</button></div>';

  card.innerHTML = html;
  messages.insertBefore(card, scrollAnchor);
  agentBubble = null;
  agentText = "";
  throttledScroll();

  card.querySelectorAll(".interview-other-option").forEach(otherLabel => {
    const toggle = otherLabel.querySelector('input[type="radio"], input[type="checkbox"]');
    const textInput = otherLabel.querySelector(".interview-other-input");
    if (!toggle || !textInput) return;
    const name = toggle.name;
    const isRadio = toggle.type === "radio";

    textInput.addEventListener("click", (e) => e.stopPropagation());
    textInput.addEventListener("focus", () => { toggle.checked = true; });

    const updateOther = () => {
      textInput.disabled = !toggle.checked;
      if (toggle.checked) textInput.focus();
    };

    if (isRadio) {
      const parent = otherLabel.closest(".interview-q");
      if (parent) {
        parent.querySelectorAll(`input[name="${CSS.escape(name)}"]`).forEach(r => {
          r.addEventListener("change", updateOther);
        });
      }
    } else {
      toggle.addEventListener("change", updateOther);
    }
  });

  const submitBtn2 = card.querySelector(".interview-submit");
  submitBtn2.addEventListener("click", async () => {
    if (!sessionId) {
      submitBtn2.textContent = "NO ACTIVE SESSION";
      return;
    }

    const responses = [];
    for (const q of event.questions) {
      if (q.type === "info") continue;
      const qid = CSS.escape(q.id);
      const qEl = card.querySelector(`[data-qid="${qid}"]`);
      if (!qEl) continue;

      if (q.type === "single") {
        const checked = qEl.querySelector(`input[name="iv_${qid}"]:checked`);
        if (checked) {
          let val = checked.value;
          if (val === "__other__") {
            const otherInput = qEl.querySelector(".interview-other-input");
            val = otherInput && otherInput.value.trim() ? "Other: " + otherInput.value.trim() : "Other";
          }
          responses.push({ id: q.id, value: val });
        }
      } else if (q.type === "multi") {
        const checked = qEl.querySelectorAll(`input[name="iv_${qid}"]:checked`);
        const vals = Array.from(checked).map(c => {
          if (c.value === "__other__") {
            const otherInput = qEl.querySelector(".interview-other-input");
            return otherInput && otherInput.value.trim() ? "Other: " + otherInput.value.trim() : "Other";
          }
          return c.value;
        });
        if (vals.length > 0) responses.push({ id: q.id, value: vals });
      } else if (q.type === "text") {
        const textarea = qEl.querySelector("textarea");
        if (textarea && textarea.value.trim()) {
          responses.push({ id: q.id, value: textarea.value.trim() });
        }
      }
    }

    submitBtn2.disabled = true;
    submitBtn2.textContent = "SUBMITTING...";

    try {
      const resp = await fetch(`/api/session/${sessionId}/interview-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses }),
      });
      if (resp.status === 410) {
        submitBtn2.textContent = "EXPIRED";
        card.classList.add("interview-submitted");
        card.querySelectorAll("input, textarea").forEach(el => el.disabled = true);
        hideStatus();
        return;
      }
      if (!resp.ok) throw new Error("Server error");
      submitBtn2.textContent = "SUBMITTED";
      card.classList.add("interview-submitted");
      card.querySelectorAll("input, textarea").forEach(el => el.disabled = true);
      hideStatus();
    } catch (err) {
      submitBtn2.textContent = "ERROR — TAP TO RETRY";
      submitBtn2.disabled = false;
    }
  });

  const firstTextarea = card.querySelector(".interview-text");
  if (firstTextarea) firstTextarea.focus();
}

function handleBrief(event) {
  removeEmptyState();
  const wrapper = document.createElement("div");
  wrapper.className = "msg brief-msg";

  const header = document.createElement("div");
  header.className = "brief-header";
  const timeStr = new Date(event.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  header.textContent = `// ${event.briefType.toUpperCase()} BRIEF — ${timeStr}`;
  wrapper.appendChild(header);

  const body = document.createElement("div");
  body.className = "bubble brief-body";
  body.innerHTML = renderMarkdown(event.content);
  wrapper.appendChild(body);

  messages.insertBefore(wrapper, scrollAnchor);
  messages.scrollTop = wrapper.offsetTop - messages.offsetTop;

  if (document.hidden) {
    playAlertSound();
    showBrowserNotification(`${event.briefType.charAt(0).toUpperCase() + event.briefType.slice(1)} Brief Ready`, "Your scheduled briefing is available.");
  }
}

const pendingAlerts = [];

function handleAlert(event) {
  const icons = { calendar: "\u{1F4C5}", stock: "\u{1F4C8}", task: "\u2705", email: "\u{1F4E7}" };
  pendingAlerts.push({
    type: event.alertType,
    icon: icons[event.alertType] || "\u26A0",
    title: event.title,
    content: event.content,
    time: new Date(event.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  });
  updateGlanceAlerts();

  if (document.hidden) {
    playAlertSound();
    showBrowserNotification(event.title, event.content);
  }
}

function updateGlanceAlerts() {
  const bar = document.getElementById("glance-bar");
  const collapsed = document.getElementById("glance-collapsed");
  const expanded = document.getElementById("glance-expanded");
  if (!bar || !collapsed) return;

  let badge = collapsed.querySelector(".glance-alert-badge");
  if (pendingAlerts.length > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "glance-alert-badge";
      collapsed.appendChild(badge);
    }
    badge.textContent = `${pendingAlerts.length} alert${pendingAlerts.length !== 1 ? "s" : ""}`;
    bar.classList.add("has-alerts");
  } else {
    if (badge) badge.remove();
    bar.classList.remove("has-alerts");
  }

  if (expanded) {
    let alertSection = expanded.querySelector(".glance-alerts-section");
    if (pendingAlerts.length > 0) {
      if (!alertSection) {
        alertSection = document.createElement("div");
        alertSection.className = "glance-alerts-section";
        expanded.appendChild(alertSection);
      }
      alertSection.innerHTML = pendingAlerts.map(a =>
        `<div class="glance-alert-row"><span class="glance-alert-icon">${a.icon}</span><span class="glance-alert-text">${escapeHtml(a.title)}: ${escapeHtml(a.content)}</span><span class="glance-alert-time">${a.time}</span></div>`
      ).join("");
      const clearBtn = document.createElement("div");
      clearBtn.className = "glance-alerts-clear";
      clearBtn.textContent = "clear all";
      clearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pendingAlerts.length = 0;
        updateGlanceAlerts();
      });
      alertSection.appendChild(clearBtn);
    } else {
      if (alertSection) alertSection.remove();
    }
  }
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 440;
    osc.type = "sine";
    gain.gain.value = 0.1;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.stop(ctx.currentTime + 0.15);
  } catch (err) { console.warn("Notification sound failed:", err); }
}

function showBrowserNotification(title, body) {
  if (Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.ico" });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then(p => {
      if (p === "granted") new Notification(title, { body, icon: "/favicon.ico" });
    });
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      resolve({ mimeType: file.type, data: base64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function compressImage(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      const outMime = "image/jpeg";
      const dataUrl = canvas.toDataURL(outMime, quality);
      const base64 = dataUrl.split(",")[1];
      resolve({ mimeType: outMime, data: base64, preview: dataUrl });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(",")[1];
        resolve({ mimeType: file.type, data: base64, preview: dataUrl });
      };
      reader.readAsDataURL(file);
    };
    img.src = url;
  });
}

function addPendingImage(file) {
  if (!file.type.startsWith("image/")) return;
  if (pendingImages.length >= 5) return;
  compressImage(file).then((result) => {
    pendingImages.push(result);
    renderImagePreviews();
  });
}

function renderImagePreviews() {
  let container = document.getElementById("image-preview-bar");
  if (!container) {
    container = document.createElement("div");
    container.id = "image-preview-bar";
    const inputArea = document.getElementById("input-area");
    inputArea.insertBefore(container, inputArea.firstChild);
  }
  container.innerHTML = "";
  if (pendingImages.length === 0) {
    container.remove();
    return;
  }
  pendingImages.forEach((img, i) => {
    const wrap = document.createElement("div");
    wrap.className = "image-preview-item";
    const thumb = document.createElement("img");
    thumb.src = img.preview;
    const removeBtn = document.createElement("button");
    removeBtn.className = "image-preview-remove";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderImagePreviews();
    });
    wrap.appendChild(thumb);
    wrap.appendChild(removeBtn);
    container.appendChild(wrap);
  });
}

function removeSuggestionChips() {
  document.querySelectorAll(".suggestion-chips").forEach(el => el.remove());
}

function parseSuggestions(text) {
  const match = text.match(/\[suggestions:\s*([\s\S]*?)\]\s*$/);
  if (!match) return [];
  const inner = match[1];
  const suggestions = [];
  const re = /"([^"]*?)"/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const s = m[1].trim();
    if (s) suggestions.push(s);
  }
  return suggestions;
}

function stripSuggestionTag(text) {
  return text.replace(/\[suggestions:[\s\S]*?\]\s*$/, "").trimEnd();
}

function renderSuggestionChipsFromText(rawText) {
  if (!rawText) return;
  const suggestions = parseSuggestions(rawText);
  if (suggestions.length === 0) return;
  removeSuggestionChips();
  const chips = document.createElement("div");
  chips.className = "suggestion-chips";
  suggestions.forEach(text => {
    const chip = document.createElement("button");
    chip.className = "suggestion-chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      input.value = text;
      removeSuggestionChips();
      sendMessage();
    });
    chips.appendChild(chip);
  });
  messages.insertBefore(chips, scrollAnchor);
  throttledScroll();
}

async function sendMessage() {
  removeSuggestionChips();
  removeLastRetryError();
  const text = input.value.trim();
  const images = pendingImages.map(i => ({ mimeType: i.mimeType, data: i.data }));
  if ((!text && images.length === 0) || !sessionId || landingVisible) return;

  lastSentMessage = { text, images: images.length > 0 ? images : null };
  timeoutRetryCount = 0;
  removeEmptyState();
  hasMessages = true;
  const bubble = appendBubble("user", text || "(image attached)");
  if (images.length > 0) {
    const imgRow = document.createElement("div");
    imgRow.className = "msg-images";
    pendingImages.forEach(img => {
      const el = document.createElement("img");
      el.src = img.preview;
      imgRow.appendChild(el);
    });
    bubble.querySelector(".bubble").prepend(imgRow);
  }
  input.value = "";
  pendingImages = [];
  renderImagePreviews();
  autoResize();
  scrollToBottom();

  const body = { message: text || undefined };
  if (images.length > 0) body.images = images;

  try {
    const res = await fetch(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!checkAuth(res)) return;
    if (res.status === 404) {
      showSystemMsg("SESSION EXPIRED. RECONNECTING...");
      await startSession();
      const retry = await fetch(`/api/session/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!checkAuth(retry)) return;
      if (!retry.ok) throw new Error(await retry.text());
      return;
    }
    if (!res.ok) throw new Error(await res.text());
  } catch (err) {
    showSystemMsg("ERR: " + err.message);
  }
}

sendBtn.addEventListener("click", sendMessage);

const micBtn = document.getElementById("mic-btn");
let speechRecognition = null;
let isRecording = false;

function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = "en-US";

  let finalTranscript = "";
  let safetyTimer = null;

  function clearSafetyTimer() {
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  }

  function resetMicState() {
    clearSafetyTimer();
    isRecording = false;
    micBtn.classList.remove("recording");
  }

  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    input.value = finalTranscript + interim;
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  };

  rec.onend = () => {
    resetMicState();
    if (finalTranscript.trim()) {
      input.value = finalTranscript.trim();
      input.style.height = "auto";
      input.style.height = input.scrollHeight + "px";
      input.focus();
    } else {
      input.value = "";
    }
    finalTranscript = "";
  };

  rec.onerror = (e) => {
    resetMicState();
    finalTranscript = "";
    if (e.error === "not-allowed") {
      appendBubble("system", "Microphone access denied. Please allow microphone permission.");
    }
  };

  rec._resetTranscript = () => { finalTranscript = ""; };
  rec._clearSafetyTimer = clearSafetyTimer;
  rec._startSafetyTimer = () => {
    clearSafetyTimer();
    safetyTimer = setTimeout(() => {
      if (isRecording) {
        try { rec.stop(); } catch (_) {}
        resetMicState();
        if (finalTranscript.trim()) {
          input.value = finalTranscript.trim();
          input.style.height = "auto";
          input.style.height = input.scrollHeight + "px";
          input.focus();
        }
        finalTranscript = "";
      }
    }, 30000);
  };
  return rec;
}

if (micBtn) {
  micBtn.addEventListener("click", () => {
    if (input.disabled) return;
    if (isRecording && speechRecognition) {
      try { speechRecognition.stop(); } catch (_) {}
      setTimeout(() => {
        if (isRecording) {
          try { speechRecognition.abort(); } catch (_) {}
          isRecording = false;
          micBtn.classList.remove("recording");
          if (speechRecognition._clearSafetyTimer) speechRecognition._clearSafetyTimer();
        }
      }, 500);
      return;
    }
    if (!speechRecognition) {
      speechRecognition = initSpeechRecognition();
    }
    if (!speechRecognition) {
      appendBubble("system", "Voice input is not supported in this browser.");
      return;
    }
    speechRecognition._resetTranscript();
    input.value = "";
    try {
      speechRecognition.start();
      isRecording = true;
      micBtn.classList.add("recording");
      speechRecognition._startSafetyTimer();
    } catch (e) {
      isRecording = false;
      micBtn.classList.remove("recording");
    }
  });
}

let settingsPanel = null;
let settingsDebounce = null;

function applyTheme(theme) {
  if (theme === "light") {
    document.body.classList.add("light-theme");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#f7f5f2");
  } else {
    document.body.classList.remove("light-theme");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#000000");
  }
}

(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) applyTheme(saved);
})();

function createSettingsPanel() {
  if (settingsPanel) return settingsPanel;
  const panel = document.createElement("div");
  panel.className = "alerts-settings-panel";
  panel.innerHTML = `
    <button class="settings-close">\u2715</button>
    <div class="settings-section">
      <h3>// APPEARANCE</h3>
      <div class="settings-row"><label>Light Mode</label><input type="checkbox" class="settings-toggle" id="theme-toggle"></div>
    </div>
    <div class="settings-section">
      <h3>// ALERT SETTINGS</h3>
      <div class="settings-row"><label>Calendar Reminders</label><input type="checkbox" class="settings-toggle" data-alert="calendarReminder"></div>
      <div class="settings-row"><label>Minutes Before</label><input type="number" class="settings-input" data-alert-val="minutesBefore" min="5" max="120" value="30"></div>
      <div class="settings-row"><label>Stock Move Alerts</label><input type="checkbox" class="settings-toggle" data-alert="stockMove"></div>
      <div class="settings-row"><label>Threshold %</label><input type="number" class="settings-input" data-alert-val="thresholdPercent" min="1" max="50" value="3" step="0.5"></div>
      <div class="settings-row"><label>Task Deadline Alerts</label><input type="checkbox" class="settings-toggle" data-alert="taskDeadline"></div>
      <div class="settings-row"><label>Important Email Alerts</label><input type="checkbox" class="settings-toggle" data-alert="importantEmail"></div>
    </div>
    <div class="settings-section">
      <h3>// WATCHLIST</h3>
      <div class="watchlist-items" id="watchlist-items"></div>
      <div class="watchlist-add-row">
        <input type="text" class="watchlist-add-input" id="watchlist-input" placeholder="TICKER (e.g. AAPL, BTC)">
        <button class="settings-btn" id="watchlist-add-btn">ADD</button>
      </div>
    </div>
    <div class="settings-section settings-exit-section">
      <a href="/api/logout" class="settings-exit-btn" title="Log out">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
          <line x1="12" y1="2" x2="12" y2="12"/>
        </svg>
      </a>
    </div>
  `;
  document.body.appendChild(panel);
  settingsPanel = panel;

  panel.querySelector(".settings-close").addEventListener("click", toggleSettings);

  const themeToggle = panel.querySelector("#theme-toggle");
  themeToggle.checked = localStorage.getItem("theme") === "light";
  themeToggle.addEventListener("change", () => {
    const theme = themeToggle.checked ? "light" : "dark";
    localStorage.setItem("theme", theme);
    applyTheme(theme);
    debounceSaveSettings();
  });

  panel.querySelectorAll(".settings-toggle:not(#theme-toggle), .settings-select, .settings-input").forEach(el => {
    el.addEventListener("change", () => debounceSaveSettings());
  });

  panel.querySelector("#watchlist-add-btn").addEventListener("click", addWatchlistItem);
  panel.querySelector("#watchlist-input").addEventListener("keydown", e => {
    if (e.key === "Enter") addWatchlistItem();
  });

  return panel;
}

function toggleSettings() {
  const panel = createSettingsPanel();
  const isOpen = panel.classList.contains("open");
  if (isOpen) {
    panel.classList.remove("open");
  } else {
    loadSettingsConfig();
    panel.classList.add("open");
  }
}

async function loadSettingsConfig() {
  try {
    const res = await fetch("/api/alerts/config");
    if (!res.ok) return;
    const cfg = await res.json();
    const panel = settingsPanel;
    if (!panel) return;

    for (const key of ["calendarReminder", "stockMove", "taskDeadline", "importantEmail"]) {
      const toggle = panel.querySelector(`[data-alert="${key}"]`);
      if (toggle && cfg.alerts?.[key]) toggle.checked = cfg.alerts[key].enabled;
    }

    const mbInput = panel.querySelector('[data-alert-val="minutesBefore"]');
    if (mbInput && cfg.alerts?.calendarReminder) mbInput.value = cfg.alerts.calendarReminder.minutesBefore || 30;

    const thInput = panel.querySelector('[data-alert-val="thresholdPercent"]');
    if (thInput && cfg.alerts?.stockMove) thInput.value = cfg.alerts.stockMove.thresholdPercent || 3;

    renderWatchlist(cfg.watchlist || []);

    if (cfg.theme && !localStorage.getItem("theme")) {
      localStorage.setItem("theme", cfg.theme);
      applyTheme(cfg.theme);
    }
    const themeToggle = panel.querySelector("#theme-toggle");
    if (themeToggle) themeToggle.checked = (localStorage.getItem("theme") || cfg.theme) === "light";
  } catch (err) { console.warn("Load settings failed:", err); }

}

let scheduledJobsData = [];
let jobsPanel = null;
let jobsProgressTool = null;

function formatTimeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

async function saveJobUpdate(jobId, updates) {
  const res = await fetch(`/api/scheduled-jobs/${jobId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Save failed");
  }
}

function createJobsPanel() {
  if (jobsPanel) return jobsPanel;
  const panel = document.createElement("div");
  panel.className = "jobs-panel";
  panel.innerHTML = `
    <div class="jobs-panel-header">
      <h3>AGENTS</h3>
      <button class="jobs-panel-close">\u2715</button>
    </div>
    <div class="jobs-live-banner" id="jobs-live-banner">
      <span class="jobs-live-dot"></span>
      <span class="jobs-live-text">All agents idle</span>
    </div>
    <div class="jobs-panel-tabs">
      <button class="jobs-tab active" data-tab="dashboard">Dashboard</button>
      <button class="jobs-tab" data-tab="history">History</button>
      <button class="jobs-tab" data-tab="schedule">Schedule</button>
      <button class="jobs-tab" data-tab="custom">+ Custom</button>
    </div>
    <div class="jobs-panel-body">
      <div class="jobs-tab-content active" id="jobs-tab-dashboard">
        <div id="jobs-dashboard" class="jobs-dashboard"></div>
      </div>
      <div class="jobs-tab-content" id="jobs-tab-history">
        <div id="jobs-history-list" class="jobs-history-list"></div>
      </div>
      <div class="jobs-tab-content" id="jobs-tab-schedule">
        <div id="jobs-schedule-list" class="jobs-schedule-list"></div>
      </div>
      <div class="jobs-tab-content" id="jobs-tab-custom">
        <div id="jobs-custom-form-wrap" class="jobs-custom-form-wrap"></div>
      </div>
    </div>
    <div class="jobs-report-overlay hidden" id="jobs-report-overlay">
      <div class="jobs-report-modal">
        <div class="jobs-report-header">
          <button class="jobs-report-back">\u2190 Back</button>
          <span id="jobs-report-title"></span>
          <button class="jobs-report-close">\u2715</button>
        </div>
        <div class="jobs-report-body" id="jobs-report-body"></div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);
  jobsPanel = panel;

  panel.querySelector(".jobs-panel-close").addEventListener("click", toggleJobsPanel);
  const closeReportOverlay = () => {
    panel.querySelector("#jobs-report-overlay").classList.add("hidden");
  };
  panel.querySelector(".jobs-report-close").addEventListener("click", closeReportOverlay);
  panel.querySelector(".jobs-report-back").addEventListener("click", closeReportOverlay);

  panel.querySelectorAll(".jobs-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      panel.querySelectorAll(".jobs-tab").forEach(t => t.classList.remove("active"));
      panel.querySelectorAll(".jobs-tab-content").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      panel.querySelector(`#jobs-tab-${tab.dataset.tab}`).classList.add("active");
      if (tab.dataset.tab === "custom") renderCustomJobForm();
    });
  });

  return panel;
}

let jobsPanelPollInterval = null;
function toggleJobsPanel() {
  const panel = createJobsPanel();
  const isOpen = panel.classList.contains("open");
  if (isOpen) {
    panel.classList.remove("open");
    if (jobsPanelPollInterval) { clearInterval(jobsPanelPollInterval); jobsPanelPollInterval = null; }
  } else {
    panel.classList.add("open");
    loadJobsPanelData();
    jobsPanelPollInterval = setInterval(() => {
      if (panel.classList.contains("open")) loadJobsPanelData();
      else { clearInterval(jobsPanelPollInterval); jobsPanelPollInterval = null; }
    }, 10000);
  }
}

let jobsHistoryData = [];

async function loadJobsPanelData() {
  try {
    const [jobsRes, historyRes, statusRes] = await Promise.all([
      fetch("/api/scheduled-jobs").then(r => r.ok ? r.json() : []),
      fetch("/api/scheduled-jobs/history?limit=50").then(r => r.ok ? r.json() : []),
      fetch("/api/agents/status").then(r => r.ok ? r.json() : null),
    ]);
    scheduledJobsData = jobsRes;
    jobsHistoryData = historyRes;
    renderJobsDashboard(historyRes, jobsRes, statusRes);
    renderJobsHistory(historyRes);
    renderJobsSchedule();
    if (statusRes && statusRes.job && statusRes.job.running) {
      updateJobsBanner("running", statusRes.job.jobName, jobsProgressTool);
    } else {
      updateJobsBanner("idle");
    }
  } catch (err) { console.warn("Load jobs panel data failed:", err); }
}

function updateJobsBanner(state, jobName, toolName) {
  const banner = jobsPanel?.querySelector("#jobs-live-banner");
  if (!banner) return;
  const dot = banner.querySelector(".jobs-live-dot");
  const text = banner.querySelector(".jobs-live-text");
  if (state === "running") {
    banner.classList.add("active");
    dot.classList.add("active");
    let label = jobName || "Agent working...";
    if (toolName) {
      const readable = getReadableToolName(toolName) || toolName;
      label += ` \u2014 ${readable}`;
    }
    text.textContent = label;
  } else {
    banner.classList.remove("active");
    dot.classList.remove("active");
    text.textContent = "All agents idle";
  }
}

function getModelLabel(model) {
  if (!model) return null;
  if (model.includes("haiku")) return { label: "Haiku", cls: "model-haiku" };
  if (model.includes("sonnet")) return { label: "Sonnet", cls: "model-sonnet" };
  if (model.includes("opus")) return { label: "Opus", cls: "model-opus" };
  return { label: model.split("-").pop(), cls: "model-default" };
}

function estimateCost(model, tokensIn, tokensOut) {
  if (!model || !tokensIn) return 0;
  const rates = {
    haiku: { input: 1, output: 5 },
    sonnet: { input: 3, output: 15 },
    opus: { input: 15, output: 75 },
  };
  let tier = "sonnet";
  if (model.includes("haiku")) tier = "haiku";
  else if (model.includes("opus")) tier = "opus";
  const r = rates[tier];
  return ((tokensIn / 1_000_000) * r.input) + (((tokensOut || 0) / 1_000_000) * r.output);
}

function buildMiniRing(count, total, color, glowColor, label) {
  const circumference = 2 * Math.PI * 22;
  const pct = total > 0 ? count / total : 0;
  const arc = pct * circumference;
  return `
    <div class="mini-ring-wrap">
      <div class="mini-ring-svg">
        <svg viewBox="0 0 56 56">
          <circle cx="28" cy="28" r="22" fill="none" stroke="var(--ring-track)" stroke-width="4"/>
          <circle cx="28" cy="28" r="22" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-dasharray="0 ${circumference}" data-target="${arc} ${circumference}" transform="rotate(-90 28 28)" class="mini-ring-arc" style="filter:drop-shadow(0 0 4px ${glowColor});transition:stroke-dasharray 0.8s ease"/>
        </svg>
        <div class="mini-ring-count">${count}</div>
      </div>
      <div class="mini-ring-label">${label}</div>
    </div>
  `;
}

function animateMiniRings() {
  setTimeout(() => {
    document.querySelectorAll(".mini-ring-arc").forEach(el => {
      const target = el.getAttribute("data-target");
      if (target) el.setAttribute("stroke-dasharray", target);
    });
  }, 50);
}

function getJobFrequencyLabel(job) {
  const s = job.schedule;
  if (s.type === "interval") return `Every ${s.intervalMinutes >= 60 ? (s.intervalMinutes / 60) + 'h' : s.intervalMinutes + 'm'}`;
  const h = s.hour || 0;
  const m = s.minute || 0;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const timeStr = `${h12}:${String(m).padStart(2, "0")} ${ap}`;
  if (s.daysOfWeek) {
    const days = s.daysOfWeek.map(d => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]).join("/");
    return `${days} ${timeStr}`;
  }
  return `Daily ${timeStr}`;
}

function renderJobsDashboard(history, jobs, statusRes) {
  const container = jobsPanel?.querySelector("#jobs-dashboard");
  if (!container) return;

  const totalRuns = history.length;
  const successRuns = history.filter(h => h.status === "success").length;
  const errorRuns = history.filter(h => h.status === "error").length;
  const partialRuns = history.filter(h => h.status === "partial").length;

  const weightedScore = totalRuns > 0 ? Math.round(((successRuns * 100) + (partialRuns * 50)) / totalRuns) : 0;

  const activeJobs = jobs.filter(j => j.enabled).length;
  const idleJobs = jobs.filter(j => !j.enabled).length;
  const pendingJobs = jobs.filter(j => j.enabled && !j.lastRun).length;

  let activityHtml = "";
  if (statusRes) {
    const activityItems = [];
    if (statusRes.job && statusRes.job.running) {
      activityItems.push({ name: statusRes.job.jobName || "Background job", status: "running", time: "" });
    }
    (statusRes.sessions || []).forEach(s => {
      const toolLabel = s.tool ? getReadableToolName(s.tool) || s.tool : "";
      activityItems.push({ name: s.conversationTitle || "Session agent", status: "running", time: toolLabel ? `⚙ ${toolLabel}` : "" });
    });
    (statusRes.recentCompletions || []).forEach(c => {
      const ago = Date.now() - c.timestamp;
      let timeStr = "";
      if (ago < 60000) timeStr = "just now";
      else if (ago < 3600000) timeStr = Math.floor(ago / 60000) + "m ago";
      else if (ago < 86400000) timeStr = Math.floor(ago / 3600000) + "h ago";
      else timeStr = Math.floor(ago / 86400000) + "d ago";
      activityItems.push({ name: c.agent + ": " + (c.task || "").slice(0, 60), status: "done", time: timeStr });
    });
    if (activityItems.length > 0) {
      const rows = activityItems.slice(0, 8).map(item => {
        const dotClass = item.status === "running" ? "q-running" : "q-done";
        return `<div class="dash-activity-item">
          <div class="landing-queue-dot ${dotClass}"></div>
          <div class="dash-activity-name">${escapeHtml(item.name)}</div>
          <div class="dash-activity-time">${escapeHtml(item.time)}</div>
        </div>`;
      }).join("");
      activityHtml = `<div class="dash-section-title">Agent Activity</div>
        <div class="dash-activity-list">${rows}</div>`;
    }
  }

  const jobListHtml = jobs.filter(j => j.enabled).map(job => {
    const freq = getJobFrequencyLabel(job);
    const statusColor = job.lastStatus === "error" ? "var(--ring-error)" : job.lastStatus === "partial" ? "var(--ring-partial)" : job.lastStatus === "success" ? "var(--ring-success)" : "var(--ring-track)";
    const ago = job.lastRun ? formatTimeAgo(job.lastRun) : "never";
    const desc = job.prompt ? (job.prompt.length > 60 ? job.prompt.slice(0, 57) + "..." : job.prompt) : job.agentId;
    return `
      <div class="dash-job-item" style="border-left-color:${statusColor}">
        <div class="dash-job-header">
          <span class="dash-job-name">${escapeHtml(job.name)}</span>
          <span class="dash-job-freq">${freq}</span>
        </div>
        <div class="dash-job-meta">
          <span class="dash-job-status-dot" style="background:${statusColor}"></span>
          <span class="dash-job-ago">${ago}</span>
          <span class="dash-job-agent">${escapeHtml(job.agentId)}</span>
        </div>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="dash-health-section">
      <div class="dash-mini-rings">
        ${buildMiniRing(successRuns, totalRuns, "var(--ring-success)", "var(--ring-success-glow)", "Success")}
        ${buildMiniRing(partialRuns, totalRuns, "var(--ring-partial)", "var(--ring-partial-glow)", "Partial")}
        ${buildMiniRing(errorRuns, totalRuns, "var(--ring-error)", "var(--ring-error-glow)", "Error")}
      </div>
      <div class="dash-health-score">Health: ${weightedScore}%</div>
    </div>
    <div class="dash-counts-row">
      <div class="dash-count-pill"><span class="dash-count-num">${activeJobs}</span> Active</div>
      <div class="dash-count-pill"><span class="dash-count-num">${pendingJobs}</span> Pending</div>
      <div class="dash-count-pill"><span class="dash-count-num">${idleJobs}</span> Idle</div>
    </div>
    ${activityHtml}
    <div class="dash-section-title">Scheduled Jobs</div>
    <div class="dash-job-list">${jobListHtml || '<div class="jobs-empty">No active jobs</div>'}</div>
  `;

  animateMiniRings();
}

async function openCostOverlay() {
  let overlay = document.getElementById("cost-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "cost-overlay";
    overlay.className = "cost-overlay";
    overlay.innerHTML = `
      <div class="cost-modal">
        <div class="cost-header">
          <button class="cost-back-btn">\u2190 Back</button>
          <span class="cost-title">COST TRACKER</span>
          <button class="cost-close-btn">\u2715</button>
        </div>
        <div class="cost-body" id="cost-body">
          <div class="cost-loading">Loading...</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const closeFn = () => overlay.classList.add("hidden");
    overlay.querySelector(".cost-close-btn").addEventListener("click", closeFn);
    overlay.querySelector(".cost-back-btn").addEventListener("click", closeFn);
  }
  overlay.classList.remove("hidden");

  const body = overlay.querySelector("#cost-body");
  body.innerHTML = '<div class="cost-loading">Loading...</div>';

  try {
    const data = await fetch("/api/cost-summary").then(r => r.ok ? r.json() : null);
    if (!data) { body.innerHTML = '<div class="cost-loading">Failed to load</div>'; return; }

    const fmtTok = (n) => n > 1_000_000 ? (n / 1_000_000).toFixed(1) + "M" : n > 1000 ? Math.round(n / 1000) + "K" : String(n);

    const agentRows = (data.agents || []).map(a => {
      const m = getModelLabel(a.model);
      const badge = m ? `<span class="dash-model-badge ${m.cls}">${m.label}</span>` : "";
      const errBadge = a.errors > 0 ? `<span class="dash-err-badge">${a.errors} err</span>` : "";
      return `
        <div class="dash-agent-row">
          <div class="dash-agent-info">
            <span class="dash-agent-name">${escapeHtml(a.name)}</span>
            <span class="dash-agent-meta">${a.runs} runs ${badge} ${errBadge}</span>
          </div>
          <div class="dash-agent-cost">$${a.cost.toFixed(3)}</div>
        </div>
      `;
    }).join("");

    body.innerHTML = `
      <div class="cost-tiles-grid cost-3col">
        <div class="cost-tile">
          <div class="cost-tile-value cost-amber">$${data.daily.toFixed(2)}</div>
          <div class="cost-tile-label">Today</div>
        </div>
        <div class="cost-tile">
          <div class="cost-tile-value cost-amber">$${data.weekly.toFixed(2)}</div>
          <div class="cost-tile-label">This Week</div>
        </div>
        <div class="cost-tile">
          <div class="cost-tile-value cost-amber">$${data.monthly.toFixed(2)}</div>
          <div class="cost-tile-label">This Month</div>
        </div>
      </div>
      <div class="cost-tiles-grid cost-2col">
        <div class="cost-tile">
          <div class="cost-tile-value cost-blue">${fmtTok(data.tokensIn)}</div>
          <div class="cost-tile-label">Tokens In</div>
        </div>
        <div class="cost-tile">
          <div class="cost-tile-value cost-blue">${fmtTok(data.tokensOut)}</div>
          <div class="cost-tile-label">Tokens Out</div>
        </div>
      </div>
      <div class="dash-section-title" style="margin-top:16px">Cost by Agent</div>
      <div class="dash-agent-list">${agentRows || '<div class="jobs-empty">No cost data yet</div>'}</div>
    `;
  } catch (err) {
    body.innerHTML = '<div class="cost-loading">Failed to load cost data</div>';
  }
}

function renderJobsHistory(history) {
  const container = jobsPanel?.querySelector("#jobs-history-list");
  if (!container) return;
  container.innerHTML = "";
  if (!history || history.length === 0) {
    container.innerHTML = '<div class="jobs-empty">No job runs yet</div>';
    return;
  }
  history.forEach(entry => {
    const item = document.createElement("div");
    item.className = "jobs-history-item";
    const dotClass = entry.status === "error" ? "dot-error" : entry.status === "partial" ? "dot-partial" : "dot-success";
    const ago = formatTimeAgo(entry.created_at);
    const summary = entry.summary ? (entry.summary.length > 120 ? entry.summary.slice(0, 117) + "..." : entry.summary) : "No summary";
    const m = getModelLabel(entry.model_used);
    const modelBadge = m ? `<span class="dash-model-badge ${m.cls}">${m.label}</span>` : "";
    const cost = estimateCost(entry.model_used, entry.tokens_input, entry.tokens_output);
    const costStr = cost > 0 ? `$${cost.toFixed(3)}` : "";
    const tokenStr = entry.tokens_input ? `${Math.round((entry.tokens_input + (entry.tokens_output || 0)) / 1000)}K tok` : "";
    item.innerHTML = `
      <div class="jobs-history-row">
        <span class="jobs-history-dot ${dotClass}"></span>
        <div class="jobs-history-info">
          <span class="jobs-history-name">${escapeHtml(entry.job_name)}</span>
          <span class="jobs-history-time">${ago}${entry.duration_ms ? ' \u00B7 ' + Math.round(entry.duration_ms / 1000) + 's' : ''} ${modelBadge}</span>
        </div>
        ${costStr ? `<span class="jobs-history-cost">${costStr}</span>` : ''}
      </div>
      ${tokenStr ? `<div class="jobs-history-tokens">${tokenStr}</div>` : ''}
      <div class="jobs-history-summary">${escapeHtml(summary)}</div>
      ${entry.saved_to ? `<button class="jobs-history-report-btn" data-path="${escapeHtml(entry.saved_to)}">View Report</button>` : ''}
    `;
    const reportBtn = item.querySelector(".jobs-history-report-btn");
    if (reportBtn) {
      reportBtn.addEventListener("click", () => openJobReport(entry.saved_to, entry.job_name));
    }
    container.appendChild(item);
  });
}

async function openJobReport(path, jobName) {
  const overlay = jobsPanel?.querySelector("#jobs-report-overlay");
  const title = jobsPanel?.querySelector("#jobs-report-title");
  const body = jobsPanel?.querySelector("#jobs-report-body");
  if (!overlay || !body) return;
  title.textContent = jobName || "Report";
  body.innerHTML = '<div class="jobs-report-loading">Loading...</div>';
  overlay.classList.remove("hidden");
  try {
    const res = await fetch(`/api/kb/read?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error("Failed to load");
    const data = await res.json();
    body.innerHTML = `<pre class="jobs-report-content">${escapeHtml(data.content || data.text || JSON.stringify(data, null, 2))}</pre>`;
  } catch (err) {
    body.innerHTML = `<div class="jobs-report-loading">Failed to load report</div>`;
  }
}

function renderJobsSchedule() {
  const container = jobsPanel?.querySelector("#jobs-schedule-list");
  if (!container) return;
  container.innerHTML = "";

  if (scheduledJobsData.length > 0) {
    const ok = scheduledJobsData.filter(j => j.lastStatus === "success").length;
    const failed = scheduledJobsData.filter(j => j.lastStatus === "error").length;
    const partial = scheduledJobsData.filter(j => j.lastStatus === "partial").length;
    const notRun = scheduledJobsData.filter(j => !j.lastStatus).length;
    const parts = [`${scheduledJobsData.length} JOBS`];
    if (ok > 0) parts.push(`${ok} \u2705`);
    if (failed > 0) parts.push(`${failed} \uD83D\uDD34`);
    if (partial > 0) parts.push(`${partial} \uD83D\uDFE1`);
    if (notRun > 0) parts.push(`${notRun} \u26AA`);
    const summary = document.createElement("div");
    summary.className = "job-health-summary";
    summary.textContent = parts.join(" \u00B7 ");
    container.appendChild(summary);
  }

  scheduledJobsData.forEach(job => {
    const card = document.createElement("div");
    card.className = "job-card";
    card.dataset.id = job.id;
    const h = job.schedule.hour;
    const m = job.schedule.minute;
    let statusHtml = "";
    if (job.lastRun) {
      const ago = formatTimeAgo(job.lastRun);
      const dot = job.lastStatus === "error" ? "pri-high" : "pri-low";
      statusHtml = `<span class="job-status-badge"><span class="job-status-dot ${dot}"></span> ${ago}</span>`;
    } else {
      statusHtml = `<span class="job-status-badge"><span class="job-status-dot pri-med"></span> never run</span>`;
    }
    card.innerHTML = `
      <div class="job-card-header">
        <div class="job-card-info">
          <span class="job-card-name">${escapeHtml(job.name)}</span>
          <span class="job-card-agent">${escapeHtml(job.agentId)}</span>
        </div>
        <input type="checkbox" class="job-card-toggle" ${job.enabled ? "checked" : ""}>
      </div>
      <div class="job-card-body">
        <div class="job-card-schedule">
          <span class="job-card-schedule-label">${job.schedule.type === "daily" ? "Daily" : job.schedule.daysOfWeek ? job.schedule.daysOfWeek.map(d => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]).join("/") : "Weekly"} at</span>
          <select class="job-card-hour-select"></select>
          <span class="job-card-time-sep">:</span>
          <select class="job-card-min-select"></select>
        </div>
        <div class="job-card-actions">
          ${statusHtml}
          <button class="job-run-btn" title="Run now">Run</button>
        </div>
      </div>
      <div class="job-card-prompt-section">
        <button class="job-prompt-toggle">Prompt \u25B8</button>
        <div class="job-prompt-editor hidden">
          <textarea class="job-prompt-textarea" rows="4">${escapeHtml(job.prompt || '')}</textarea>
          <button class="job-prompt-save">Save</button>
        </div>
      </div>
      <div class="job-card-footer">
        <button class="job-delete-btn" title="Delete job">\uD83D\uDDD1 Delete</button>
      </div>
    `;
    const hourSel = card.querySelector(".job-card-hour-select");
    for (let hr = 0; hr < 24; hr++) {
      const opt = document.createElement("option");
      opt.value = hr;
      const ap = hr < 12 ? "AM" : "PM";
      const hr12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
      opt.textContent = `${hr12} ${ap}`;
      if (hr === h) opt.selected = true;
      hourSel.appendChild(opt);
    }
    const minSel = card.querySelector(".job-card-min-select");
    for (let mn = 0; mn < 60; mn += 5) {
      const opt = document.createElement("option");
      opt.value = mn;
      opt.textContent = String(mn).padStart(2, "0");
      if (mn === m) opt.selected = true;
      minSel.appendChild(opt);
    }
    hourSel.addEventListener("change", () => {
      job.schedule.hour = parseInt(hourSel.value);
      saveJobUpdate(job.id, { schedule: job.schedule }).catch(() => {});
    });
    minSel.addEventListener("change", () => {
      job.schedule.minute = parseInt(minSel.value);
      saveJobUpdate(job.id, { schedule: job.schedule }).catch(() => {});
    });
    const runBtn = card.querySelector(".job-run-btn");
    runBtn.addEventListener("click", async () => {
      runBtn.textContent = "Active";
      runBtn.disabled = true;
      try {
        const res = await fetch(`/api/scheduled-jobs/${job.id}/trigger`, { method: "POST" });
        if (!res.ok) throw new Error("trigger failed");
      } catch {
        runBtn.textContent = "Failed";
        setTimeout(() => { runBtn.textContent = "Run"; runBtn.disabled = false; }, 3000);
      }
    });
    card.querySelector(".job-card-toggle").addEventListener("change", (e) => {
      job.enabled = e.target.checked;
      saveJobUpdate(job.id, { enabled: job.enabled }).catch(() => {});
      runBtn.textContent = "Run";
      runBtn.disabled = false;
    });
    const promptToggle = card.querySelector(".job-prompt-toggle");
    const promptEditor = card.querySelector(".job-prompt-editor");
    promptToggle.addEventListener("click", () => {
      const isHidden = promptEditor.classList.contains("hidden");
      promptEditor.classList.toggle("hidden");
      promptToggle.textContent = isHidden ? "Prompt \u25BE" : "Prompt \u25B8";
    });
    card.querySelector(".job-prompt-save").addEventListener("click", async () => {
      const textarea = card.querySelector(".job-prompt-textarea");
      const saveBtn = card.querySelector(".job-prompt-save");
      const newPrompt = textarea.value.trim();
      if (!newPrompt) return;
      saveBtn.textContent = "Saving...";
      saveBtn.disabled = true;
      try {
        await saveJobUpdate(job.id, { prompt: newPrompt });
        job.prompt = newPrompt;
        saveBtn.textContent = "\u2713 Saved";
        setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.disabled = false; }, 2000);
      } catch (err) {
        saveBtn.textContent = err.message || "Failed";
        setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.disabled = false; }, 3000);
      }
    });
    card.querySelector(".job-delete-btn").addEventListener("click", async () => {
      if (!confirm(`Delete "${job.name}"? This cannot be undone.`)) return;
      try {
        const res = await fetch(`/api/scheduled-jobs/${job.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("delete failed");
        card.remove();
        scheduledJobsData = scheduledJobsData.filter(j => j.id !== job.id);
      } catch {
        alert("Failed to delete job");
      }
    });
    container.appendChild(card);
  });
}

function renderCustomJobForm() {
  const wrap = jobsPanel?.querySelector("#jobs-custom-form-wrap");
  if (!wrap || wrap.querySelector(".job-add-custom-form")) return;
  wrap.innerHTML = `
    <div class="job-add-custom-form">
      <div class="job-form-row"><label>Name</label><input type="text" class="job-form-input" id="custom-job-name" placeholder="My custom job"></div>
      <div class="job-form-row"><label>Agent</label><select class="job-form-select" id="custom-job-agent"></select></div>
      <div class="job-form-row"><label>Frequency</label><select class="job-form-select" id="custom-job-freq"><option value="daily">Daily</option><option value="weekly">Weekly</option></select></div>
      <div class="job-form-row" id="custom-job-days-row" style="display:none"><label>Days</label><div class="job-day-picker" id="custom-job-days"></div></div>
      <div class="job-form-row"><label>Time</label><select class="job-form-select" id="custom-job-hour"></select><span class="job-card-time-sep">:</span><select class="job-form-select" id="custom-job-min"></select></div>
      <div class="job-form-row"><label>Prompt</label><textarea class="job-form-textarea" id="custom-job-prompt" rows="4" placeholder="What should the agent do?"></textarea></div>
      <div class="job-form-row job-form-actions">
        <button class="job-form-submit">Add Job</button>
      </div>
    </div>
  `;
  fetch("/api/agents").then(r => r.json()).then(data => {
    const agentSel = wrap.querySelector("#custom-job-agent");
    const list = data.agents || data;
    list.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name || a.id;
      agentSel.appendChild(opt);
    });
  }).catch(() => {});
  const freqSel = wrap.querySelector("#custom-job-freq");
  const daysRow = wrap.querySelector("#custom-job-days-row");
  const daysPicker = wrap.querySelector("#custom-job-days");
  const dayLabels = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  dayLabels.forEach((label, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "job-day-btn";
    btn.textContent = label;
    btn.dataset.day = i;
    btn.addEventListener("click", () => btn.classList.toggle("active"));
    daysPicker.appendChild(btn);
  });
  freqSel.addEventListener("change", () => {
    daysRow.style.display = freqSel.value === "weekly" ? "" : "none";
  });
  const hourSel = wrap.querySelector("#custom-job-hour");
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement("option");
    opt.value = h;
    const ap = h < 12 ? "AM" : "PM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    opt.textContent = `${h12} ${ap}`;
    if (h === 8) opt.selected = true;
    hourSel.appendChild(opt);
  }
  const minSel = wrap.querySelector("#custom-job-min");
  for (let mn = 0; mn < 60; mn += 5) {
    const opt = document.createElement("option");
    opt.value = mn;
    opt.textContent = String(mn).padStart(2, "0");
    if (mn === 0) opt.selected = true;
    minSel.appendChild(opt);
  }
  wrap.querySelector(".job-form-submit").addEventListener("click", async () => {
    const name = wrap.querySelector("#custom-job-name").value.trim();
    const agentId = wrap.querySelector("#custom-job-agent").value;
    const prompt = wrap.querySelector("#custom-job-prompt").value.trim();
    const hour = parseInt(wrap.querySelector("#custom-job-hour").value);
    const minute = parseInt(wrap.querySelector("#custom-job-min").value);
    const freq = wrap.querySelector("#custom-job-freq").value;
    if (!name || !agentId || !prompt) return;
    const schedule = { type: freq, hour, minute };
    if (freq === "weekly") {
      const selected = [...daysPicker.querySelectorAll(".job-day-btn.active")].map(b => parseInt(b.dataset.day));
      if (selected.length === 0) { alert("Pick at least one day"); return; }
      schedule.daysOfWeek = selected;
    }
    try {
      const res = await fetch("/api/scheduled-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, agentId, prompt, schedule, enabled: false }),
      });
      if (res.ok) {
        wrap.innerHTML = "";
        loadJobsPanelData();
        jobsPanel.querySelector('[data-tab="schedule"]').click();
      }
    } catch (err) { console.warn("Add custom job failed:", err); }
  });
}

function renderWatchlist(items) {
  const container = settingsPanel.querySelector("#watchlist-items");
  container.innerHTML = "";
  items.forEach((item, idx) => {
    const div = document.createElement("div");
    div.className = "watchlist-item";
    div.innerHTML = `<span class="symbol">${escapeHtml(item.displaySymbol || item.symbol.toUpperCase())}</span><span class="type-badge">${item.type}</span><button class="watchlist-remove" data-idx="${idx}">\u2715</button>`;
    div.querySelector(".watchlist-remove").addEventListener("click", () => {
      items.splice(idx, 1);
      renderWatchlist(items);
      debounceSaveSettings();
    });
    container.appendChild(div);
  });
}

function addWatchlistItem() {
  const input = settingsPanel.querySelector("#watchlist-input");
  const val = input.value.trim().toUpperCase();
  if (!val) return;

  const cryptoNames = ["BTC", "ETH", "SOL", "DOGE", "ADA", "XRP", "DOT", "MATIC", "AVAX", "LINK", "BNB", "LTC", "SHIB", "UNI", "ATOM", "NEAR", "APT", "ARB", "OP", "SUI", "PEPE", "BITCOIN", "ETHEREUM", "SOLANA"];
  const isCrypto = cryptoNames.includes(val);

  const items = getCurrentWatchlist();
  if (items.find(w => (w.displaySymbol || w.symbol).toUpperCase() === val)) {
    input.value = "";
    return;
  }

  if (isCrypto) {
    const aliases = { BTC: "bitcoin", BTCUSD: "bitcoin", ETH: "ethereum", SOL: "solana", DOGE: "dogecoin", ADA: "cardano", XRP: "ripple" };
    items.push({ symbol: aliases[val] || val.toLowerCase(), type: "crypto", displaySymbol: val });
  } else {
    items.push({ symbol: val, type: "stock" });
  }

  renderWatchlist(items);
  input.value = "";
  debounceSaveSettings();
}

function getCurrentWatchlist() {
  const container = settingsPanel.querySelector("#watchlist-items");
  const items = [];
  container.querySelectorAll(".watchlist-item").forEach(el => {
    const symbol = el.querySelector(".symbol").textContent;
    const type = el.querySelector(".type-badge").textContent;
    items.push({ symbol: type === "crypto" ? symbol.toLowerCase() : symbol, type, displaySymbol: type === "crypto" ? symbol : undefined });
  });
  return items;
}

function debounceSaveSettings() {
  if (settingsDebounce) clearTimeout(settingsDebounce);
  settingsDebounce = setTimeout(saveSettings, 500);
}

async function saveSettings() {
  if (!settingsPanel) return;
  const panel = settingsPanel;

  const config = { alerts: {}, watchlist: getCurrentWatchlist(), theme: localStorage.getItem("theme") || "dark" };

  for (const key of ["calendarReminder", "stockMove", "taskDeadline", "importantEmail"]) {
    const toggle = panel.querySelector(`[data-alert="${key}"]`);
    config.alerts[key] = { enabled: toggle?.checked || false };
  }

  const mbInput = panel.querySelector('[data-alert-val="minutesBefore"]');
  if (mbInput) config.alerts.calendarReminder.minutesBefore = parseInt(mbInput.value) || 30;

  const thInput = panel.querySelector('[data-alert-val="thresholdPercent"]');
  if (thInput) config.alerts.stockMove.thresholdPercent = parseFloat(thInput.value) || 3;

  try {
    await fetch("/api/alerts/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  } catch (err) { console.warn("Save settings failed:", err); }
}

alertsSettingsBtn.addEventListener("click", toggleSettings);

const FAST_MODEL_ID = "claude-haiku-4-5-20251001";
const MAX_MODEL_ID = "claude-opus-4-6";
const MODEL_DISPLAY = {
  [FAST_MODEL_ID]: "haiku-4.5",
  [FULL_MODEL_ID]: "sonnet-4.6",
  [MAX_MODEL_ID]: "opus-4.6",
};
const MODE_TO_MODEL = {
  fast: FAST_MODEL_ID,
  full: FULL_MODEL_ID,
  max: MAX_MODEL_ID,
};

function updateModelBadge(modelId) {
  modelNameEl.textContent = MODEL_DISPLAY[modelId] || modelId;
  modelBadge.classList.toggle("model-fast", modelId === FAST_MODEL_ID);
  modelBadge.classList.toggle("model-full", modelId === FULL_MODEL_ID);
  modelBadge.classList.toggle("model-max", modelId === MAX_MODEL_ID);
}

function updateModeDisplay(mode) {
  currentModelMode = mode;
  modelModeEl.textContent = mode.toUpperCase();
  modelBadge.dataset.mode = mode;
  if (mode === "auto") {
    modelNameEl.textContent = "auto";
    modelBadge.classList.remove("model-fast", "model-full", "model-max");
  } else {
    updateModelBadge(MODE_TO_MODEL[mode]);
  }
}

modelBadge.addEventListener("click", async () => {
  const modes = ["auto", "fast", "full", "max"];
  const next = modes[(modes.indexOf(currentModelMode) + 1) % modes.length];
  updateModeDisplay(next);
  if (!sessionId) return;
  try {
    await fetch(`/api/session/${sessionId}/model-mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
  } catch (err) { console.warn("Model mode switch failed:", err); }
});

function updatePlanningModeUI(enabled) {
  planningMode = enabled;
  localStorage.setItem("planningMode", enabled ? "true" : "false");
  planToggle.classList.toggle("active", enabled);
  planBanner.classList.toggle("hidden", !enabled);
}

updatePlanningModeUI(planningMode);

planToggle.addEventListener("click", async () => {
  if (landingVisible) return;
  const newMode = !planningMode;
  updatePlanningModeUI(newMode);
  if (!sessionId) return;
  try {
    await fetch(`/api/session/${sessionId}/planning-mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: newMode }),
    });
  } catch (err) { console.warn("Planning mode switch failed:", err); }
});

generateBriefBtn.addEventListener("click", async () => {
  const hour = new Date().getHours();
  const type = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  generateBriefBtn.disabled = true;
  generateBriefBtn.classList.add("loading");
  try {
    await fetch(`/api/alerts/trigger/${type}`, { method: "POST" });
  } catch (err) { console.warn("Generate brief failed:", err); }
  generateBriefBtn.disabled = false;
  generateBriefBtn.classList.remove("loading");
});

const uploadBtn = document.getElementById("upload-btn");
const imageUpload = document.getElementById("image-upload");
uploadBtn.addEventListener("click", () => imageUpload.click());
imageUpload.addEventListener("change", () => {
  for (const file of imageUpload.files) {
    addPendingImage(file);
  }
  imageUpload.value = "";
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 100) + "px";
}
input.addEventListener("input", autoResize);

input.addEventListener("focus", () => {
  setTimeout(() => { if (!userHasScrolledUp) scrollToBottom(); }, 300);
});

input.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) addPendingImage(file);
      return;
    }
  }
});

const dropZone = document.getElementById("app");
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const file of files) {
    if (file.type.startsWith("image/")) addPendingImage(file);
  }
});

function appendBubble(role, text, timestamp) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;

  const cleanText = (role === "agent") ? stripSuggestionTag(text) : text;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "agent") {
    bubble.innerHTML = renderMarkdown(cleanText);
    bubble.dataset.rawText = cleanText;
  } else {
    bubble.textContent = text;
  }

  if (role === "agent" && text) {
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "COPY";
    copyBtn.title = "Copy to clipboard";
    copyBtn.addEventListener("click", () => {
      const raw = bubble.dataset.rawText || bubble.textContent;
      navigator.clipboard.writeText(raw).then(() => {
        copyBtn.textContent = "COPIED";
        setTimeout(() => { copyBtn.textContent = "COPY"; }, 1500);
      });
    });
    msg.appendChild(copyBtn);
  }

  msg.appendChild(bubble);

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(timestamp ? new Date(timestamp) : new Date());
  msg.appendChild(time);

  messages.insertBefore(msg, scrollAnchor);
  if (role === "user" || role === "system") {
    scrollToBottom();
  } else {
    throttledScroll();
  }
  return msg;
}

function clearMessages() {
  messages.querySelectorAll(".msg, .empty-state, .history-view-header").forEach(el => el.remove());
}

function showSystemMsg(text) {
  appendBubble("system", text);
}

function showEmptyState() {
  if (messages.querySelector(".empty-state")) return;
  const el = document.createElement("div");
  el.className = "empty-state";
  el.innerHTML = `
    <div class="pi-logo">&gt;_</div>
    <h2>[MISSION CONTROL]</h2>
    <p>connected to knowledge base. ready for input.</p>
  `;
  messages.insertBefore(el, scrollAnchor);
}

function removeEmptyState() {
  messages.querySelector(".empty-state")?.remove();
}

function showStatus(text) {
  statusText.textContent = text;
  statusBar.classList.remove("hidden");
}

function showStatusWithTimer(label) {
  if (!thinkingStartTime) return showStatus(label);
  const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
  if (elapsed >= 5) {
    showStatus(`${label} ${elapsed}s`);
  } else {
    showStatus(label);
  }
}

function startThinkingTimer() {
  thinkingStartTime = Date.now();
  if (thinkingTimerInterval) clearInterval(thinkingTimerInterval);
  thinkingTimerInterval = setInterval(() => {
    if (!isAgentRunning || !thinkingStartTime) { stopThinkingTimer(); return; }
    const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
    if (elapsed >= 5) {
      const currentLabel = statusText.textContent.replace(/\s+\d+s$/, "");
      showStatus(`${currentLabel} ${elapsed}s`);
    }
  }, 1000);
}

function stopThinkingTimer() {
  thinkingStartTime = null;
  if (thinkingTimerInterval) { clearInterval(thinkingTimerInterval); thinkingTimerInterval = null; }
}

function hideStatus() {
  if (isSyncingToCloud && !isAgentRunning && reconnectAttempts === 0) {
    showStatus("[SYNCING TO CLOUD...]");
    return;
  }
  statusBar.classList.add("hidden");
}

function buildLandingTickerCycles(d) {
  const e = escapeHtml;
  const cycles = [];

  if (d.weather) {
    const w = d.weather;
    let line = `${w.icon || "🌡️"} ${w.tempC}°C ${e(w.condition || "")}`;
    if (w.feelsLikeC !== undefined) line += ` · Feels ${w.feelsLikeC}°C`;
    cycles.push(`<span class="landing-glance-item">${line}</span>`);
    if (w.forecast && w.forecast.length > 0) {
      const fIcon = (c) => {
        const cl = c.toLowerCase();
        if (cl.includes("clear") || cl.includes("sunny")) return "☀️";
        if (cl.includes("partly")) return "⛅";
        if (cl.includes("cloud") || cl.includes("overcast")) return "☁️";
        if (cl.includes("rain") || cl.includes("drizzle") || cl.includes("shower")) return "🌧️";
        if (cl.includes("snow")) return "❄️";
        if (cl.includes("thunder")) return "⛈️";
        if (cl.includes("fog")) return "🌫️";
        return "🌡️";
      };
      const parts = w.forecast.map(f => {
        const dt = new Date(f.date + "T12:00:00");
        const day = dt.toLocaleDateString("en-US", { weekday: "short" });
        return `${fIcon(f.condition)} ${day} ${f.lowC}°–${f.highC}°C`;
      });
      cycles.push(`<span class="landing-glance-item">${parts.join(" · ")}</span>`);
    }
  }

  if (d.upcomingEvents && d.upcomingEvents.length > 0) {
    for (const ev of d.upcomingEvents.slice(0, 5)) {
      const t = (ev.time || "").replace(/^.*?,\s*/, "").replace(/:00\s*/g, " ");
      const c = (ev.calendar || "").toLowerCase();
      let who = ev.calendar || "";
      if (c.includes("rickin")) who = "Rickin";
      else if (c.includes("pooja") || c.includes("bhatt")) who = "Pooja";
      else if (c.includes("reya")) who = "Reya";
      cycles.push(`<span class="landing-glance-item">📅 ${e(who)}: ${e(ev.title)}${t ? " · " + e(t) : ""}</span>`);
    }
  }

  if (d.headlines && d.headlines.length > 0) {
    for (const h of d.headlines.slice(0, 3)) {
      const t = h.title.length > 80 ? h.title.slice(0, 77) + "..." : h.title;
      cycles.push(`<span class="landing-glance-item">📰 ${e(t)}</span>`);
    }
  }

  if (d.nextJob) cycles.push(`<span class="landing-glance-item">🤖 Next: ${e(d.nextJob.name)} · ${e(d.nextJob.time)}</span>`);

  const c3 = [];
  if (d.jobs && d.jobs.failed > 0) c3.push(`🔴 ${d.jobs.failed} job${d.jobs.failed !== 1 ? "s" : ""} failed`);
  if (d.jobs && d.jobs.partial > 0) c3.push(`🟡 ${d.jobs.partial} partial`);
  if (c3.length > 0) cycles.push(`<span class="landing-glance-item">${c3.join(" · ")}</span>`);

  return cycles;
}

function startLandingTicker(cycles) {
  stopLandingTicker();
  if (!cycles || cycles.length <= 1) return;
  ambientTickerItems = cycles;
  ambientTickerIndex = 0;
  ambientTickerTimer = setInterval(() => {
    ambientTickerIndex = (ambientTickerIndex + 1) % ambientTickerItems.length;
    const el = document.getElementById("landing-ticker");
    if (!el) { stopLandingTicker(); return; }
    el.classList.add("ticker-fade");
    setTimeout(() => {
      el.innerHTML = ambientTickerItems[ambientTickerIndex];
      el.classList.remove("ticker-fade");
    }, 600);
  }, 8000);
}

function stopLandingTicker() {
  if (ambientTickerTimer) { clearInterval(ambientTickerTimer); ambientTickerTimer = null; }
}

function showErrorWithRetry(errorText) {
  const msg = document.createElement("div");
  msg.className = "msg system retry-error";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = "ERR: " + errorText;
  msg.appendChild(bubble);

  if (lastSentMessage) {
    const retryBtn = document.createElement("button");
    retryBtn.className = "retry-btn";
    retryBtn.textContent = "RETRY";
    retryBtn.addEventListener("click", () => {
      removeLastRetryError();
      if (!lastSentMessage || !sessionId) return;
      const body = { message: lastSentMessage.text || undefined };
      if (lastSentMessage.images && lastSentMessage.images.length > 0) body.images = lastSentMessage.images;
      fetch(`/api/session/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(err => showSystemMsg("ERR: " + err.message));
    });
    msg.appendChild(retryBtn);
  }

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(new Date());
  msg.appendChild(time);

  messages.insertBefore(msg, scrollAnchor);
  scrollToBottom();
}

function removeLastRetryError() {
  messages.querySelectorAll(".retry-error").forEach(el => el.remove());
}

async function resumeConversation(conversationId) {
  if (sessionId) {
    try { await fetch(`/api/session/${sessionId}`, { method: "DELETE" }); } catch (err) { console.warn("Session delete on resume failed:", err); }
    cleanupCurrentSession();
    localStorage.removeItem("activeSession");
    sessionId = null;
  }

  showSystemMsg("RESUMING CONVERSATION...");

  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resumeConversationId: conversationId }),
    });
    if (!checkAuth(res)) return;
    const data = await res.json();
    sessionId = data.sessionId;
    localStorage.setItem("activeSession", sessionId);

    clearMessages();
    removeEmptyState();
    if (data.messages && data.messages.length > 0) {
      for (const msg of data.messages) {
        if (msg.role === "user") appendBubble("user", msg.text, msg.timestamp);
        else if (msg.role === "agent") appendBubble("agent", msg.text, msg.timestamp);
      }
      hasMessages = true;
    }

    openEventStream(sessionId);
    startSyncPolling();
    showSystemMsg("CONVERSATION RESUMED — CONTEXT LOADED");
    scrollToBottom();
    if (planningMode) {
      fetch(`/api/session/${sessionId}/planning-mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }).catch(() => {});
    }
  } catch (err) {
    showSystemMsg("ERR: Failed to resume — " + err.message);
    await startSession();
  }
}

function startSyncPolling() {
  if (syncPollTimer) return;
  syncPollTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/sync-status", { credentials: "same-origin" });
      if (!res.ok) return;
      const data = await res.json();
      const wasSync = isSyncingToCloud;
      isSyncingToCloud = data.status === "uploading" || data.status === "downloading";
      if (isSyncingToCloud && !wasSync && !isAgentRunning && reconnectAttempts === 0) {
        showStatus("[SYNCING TO CLOUD...]");
      } else if (!isSyncingToCloud && wasSync && !isAgentRunning && reconnectAttempts === 0) {
        hideStatus();
      }
    } catch (err) { console.warn("Sync poll failed:", err); }
  }, 10_000);
}

function stopSyncPolling() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
  isSyncingToCloud = false;
}

function scrollToBottom() {
  if (messages.querySelector(".interview-card:not(.interview-submitted)")) return;
  userHasScrolledUp = false;
  messages.scrollTop = messages.scrollHeight;
}

function throttledScroll() {
  if (userHasScrolledUp) return;
  if (scrollThrottleTimer) return;
  scrollThrottleTimer = setTimeout(() => {
    if (!userHasScrolledUp) scrollToBottom();
    scrollThrottleTimer = null;
  }, 100);
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

let glanceTimer = null;
let glanceCollapseTimer = null;
let glanceRefreshInterval = null;
let glanceClockInterval = null;

function getETTimeString() {
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const date = now.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
  return `${time} · ${date}`;
}

function updateGlanceClock() {
  const el = document.getElementById("glance-clock");
  if (el) el.textContent = getETTimeString();
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function updateAgentDot(state, jobName) {
  let dot = document.getElementById("agent-dot");
  if (!dot) {
    dot = document.createElement("div");
    dot.id = "agent-dot";
    dot.className = "agent-dot";
    document.body.appendChild(dot);
  }
  dot.classList.remove("running", "idle", "hidden");
  if (state === "running") {
    dot.classList.add("running");
    dot.innerHTML = `<span class="dot-pulse"></span><span class="dot-label">${escapeHtml(jobName || "Agent working...")}</span>`;
    dot.title = jobName || "Agent running";
  } else {
    dot.classList.add("hidden");
  }
}

function showJobToast(event) {
  const existing = document.querySelectorAll(".job-toast");
  existing.forEach(e => e.remove());

  const toast = document.createElement("div");
  toast.className = "job-toast" + (event.status === "error" ? " job-toast-error" : "");

  const icon = event.status === "error" ? "🔴" : event.status === "partial" ? "🟡" : "🟢";
  let html = `<div class="job-toast-header">${icon} ${escapeHtml(event.jobName || "Agent")}</div>`;

  if (event.summary) {
    const summary = event.summary.length > 150 ? event.summary.slice(0, 147) + "..." : event.summary;
    html += `<div class="job-toast-body">${escapeHtml(summary)}</div>`;
  }
  if (event.savedTo) {
    html += `<div class="job-toast-path">📁 ${escapeHtml(event.savedTo)}</div>`;
  }
  html += `<button class="job-toast-close" onclick="this.parentElement.remove()">×</button>`;

  toast.innerHTML = html;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 400);
  }, 12000);
}

async function pollAgentStatus() {
  try {
    const res = await fetch("/api/agents/status");
    if (res.ok) {
      const data = await res.json();
      if (data.job && data.job.running) {
        updateAgentDot("running", data.job.jobName);
      } else {
        updateAgentDot("idle", null);
      }
    }
  } catch(e) {}
}

pollAgentStatus();
setInterval(pollAgentStatus, 30000);

async function fetchGlance() {
  const bar = document.getElementById("glance-bar");
  const collapsed = document.getElementById("glance-collapsed");
  const expanded = document.getElementById("glance-expanded");
  if (!bar || !collapsed) return;

  bar.classList.add("loading");
  try {
    const res = await fetch("/api/glance");
    if (!res.ok) throw new Error("fetch failed");
    const d = await res.json();

    const e = escapeHtml;
    const parts = [];
    if (d.weather) parts.push(`${e(d.weather.icon)} ${e(String(d.weather.tempC))}°C`);
    if (d.emails && d.emails.unread > 0) parts.push(`${d.emails.unread} new emails`);
    if (d.tasks && d.tasks.active > 0) parts.push(`${d.tasks.active} task${d.tasks.active !== 1 ? "s" : ""}`);
    let nextEventHtml = "";
    if (d.nextEvent) {
      const t = d.nextEvent.time || "";
      const short = t.replace(/^.*?,\s*/, "").replace(/:00\s*/g, " ");
      nextEventHtml = `<div class="glance-next-row">Next: ${e(d.nextEvent.title)}${short ? " " + e(short) : ""}</div>`;
    }
    if (d.jobs) {
      if (d.jobs.failed > 0) parts.push(`🔴 ${d.jobs.failed} failed`);
      else if (d.jobs.partial > 0) parts.push(`🟡 ${d.jobs.partial} partial`);
    }
    if (parts.length === 0 && d.time) parts.push(e(d.time));
    if (parts.length === 0) parts.push("—");

    const sep = '<span class="glance-sep">·</span>';
    const clockHtml = `<span id="glance-clock" class="glance-clock">${getETTimeString()}</span>`;
    collapsed.innerHTML = clockHtml + sep + parts.join(sep) + nextEventHtml;

    const detailRows = [];
    if (d.time) detailRows.push(row("time", e(d.time)));
    if (d.weather) detailRows.push(row("weather", `${e(d.weather.icon)} ${e(String(d.weather.tempC))}°C — ${e(d.weather.condition)}`));
    if (d.emails) detailRows.push(row("email", d.emails.unread === 0 ? "Inbox clear" : `${d.emails.unread} new emails`));
    if (d.tasks) {
      if (d.tasks.active === 0) {
        detailRows.push(row("tasks", "All clear"));
      } else if (d.tasks.items && d.tasks.items.length > 0) {
        const taskList = d.tasks.items.map(t => e(t.title)).join("; ");
        detailRows.push(row("tasks", `${d.tasks.active} open — ${taskList}`));
      } else {
        detailRows.push(row("tasks", `${d.tasks.active} open`));
      }
    }
    if (d.upcomingEvents && d.upcomingEvents.length > 0) {
      const evList = d.upcomingEvents.map(ev => {
        const t = (ev.time || "").replace(/^.*?,\s*/, "");
        return `${e(ev.title)}${t ? " — " + e(t) : ""}`;
      }).join("; ");
      detailRows.push(row("calendar", evList));
    } else if (d.nextEvent) {
      detailRows.push(row("next", `${e(d.nextEvent.title)} — ${e(d.nextEvent.time || "")}`));
    }
    if (d.jobs && d.jobs.items && d.jobs.items.length > 0) {
      const jobList = d.jobs.items.map(j => {
        const icon = j.status === "error" ? "🔴" : j.status === "partial" ? "🟡" : j.status === "success" ? "🟢" : "⚪";
        const ago = j.lastRun ? timeAgo(j.lastRun) : "not run";
        return `${icon} ${e(j.name)} (${ago})`;
      }).join("; ");
      detailRows.push(row("jobs", jobList));
    }
    expanded.innerHTML = detailRows.join("");

    bar.style.display = "";

  } catch {
    collapsed.innerHTML = `<span id="glance-clock" class="glance-clock">${getETTimeString()}</span><span class="glance-sep">·</span><span style="opacity:0.3">—</span>`;
  }
  bar.classList.remove("loading");
}

function row(label, value) {
  return `<div class="glance-detail-row"><span class="glance-detail-label">${label}</span><span class="glance-detail-value">${value}</span></div>`;
}

function initGlance() {
  const bar = document.getElementById("glance-bar");
  if (!bar) return;
  bar.addEventListener("click", () => {
    const isExpanded = bar.classList.toggle("expanded");
    if (glanceCollapseTimer) clearTimeout(glanceCollapseTimer);
    if (isExpanded) {
      glanceCollapseTimer = setTimeout(() => bar.classList.remove("expanded"), 8000);
    }
  });
  fetchGlance();
  glanceRefreshInterval = setInterval(fetchGlance, 5 * 60 * 1000);
  glanceClockInterval = setInterval(updateGlanceClock, 30000);
}

initGlance();

const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
document.getElementById("messages").addEventListener("click", (e) => {
  const link = e.target.closest("a[href]");
  if (!link) return;
  const href = link.getAttribute("href");
  if (!href || href.startsWith("/") || href.startsWith("#")) return;

  e.preventDefault();
  if (isStandalone) {
    window.open(href, "_blank");
  } else {
    window.open(href, "_blank", "noopener");
  }
});

function renderMarkdown(text) {
  const codeBlocks = [];
  const inlineCodes = [];

  let escaped = escapeHtml(text);

  escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code class="${escapeHtml(lang)}">${code.trimEnd()}</code></pre>`);
    return `\x00CB${idx}\x00`;
  });

  escaped = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00IC${idx}\x00`;
  });

  const tablePlaceholders = [];
  escaped = escaped.replace(/((?:^[ \t]*\|.+\|[ \t]*$\n?){2,})/gm, (block) => {
    const lines = block.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) return block;
    const isSep = (line) => {
      const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
      return cells.every(c => /^\s*:?-{2,}:?\s*$/.test(c));
    };
    let headerEnd = -1;
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      if (isSep(lines[i])) { headerEnd = i; break; }
    }
    if (headerEnd < 1) return block;

    const renderCell = (text) => {
      let s = text;
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
        const href = url.replace(/&amp;/g, '&');
        return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
      });
      s = s.replace(/(^|[\s>])((https?:\/\/)[^\s<"'\]]+)/g, (match, prefix, url) => {
        if (match.includes('href=')) return match;
        let cleanUrl = url.replace(/[.,;:!?)]+$/, '');
        const trailing = url.slice(cleanUrl.length);
        cleanUrl = cleanUrl.replace(/&amp;/g, '&');
        return `${prefix}<a href="${cleanUrl}" target="_blank" rel="noopener">${cleanUrl}</a>${trailing}`;
      });
      return s;
    };
    const parseRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    const sepCells = parseRow(lines[headerEnd]);
    const aligns = sepCells.map(c => {
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });

    const headerRows = lines.slice(0, headerEnd);
    const dataRows = lines.slice(headerEnd + 1);

    let html = '<div class="md-table-wrap"><div class="md-table-bar"><button class="md-table-copy" onclick="copyTable(this)" title="Copy table">⧉ Copy</button></div><div class="md-table-scroll"><table class="md-table">';
    html += '<thead>';
    for (const hr of headerRows) {
      const cells = parseRow(hr);
      html += '<tr>' + cells.map((c, i) => `<th style="text-align:${aligns[i] || 'left'}">${renderCell(c)}</th>`).join('') + '</tr>';
    }
    html += '</thead><tbody>';
    for (const dr of dataRows) {
      const cells = parseRow(dr);
      html += '<tr>' + cells.map((c, i) => `<td style="text-align:${aligns[i] || 'left'}">${renderCell(c)}</td>`).join('') + '</tr>';
    }
    html += '</tbody></table></div></div>';

    const idx = tablePlaceholders.length;
    tablePlaceholders.push(html);
    return `\x00TB${idx}\x00`;
  });

  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    const href = url.replace(/&amp;/g, '&');
    return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
  });

  escaped = escaped.replace(/(^|[\s>])((https?:\/\/)[^\s<"'\]]+)/gm, (match, prefix, url) => {
    if (match.includes('href=')) return match;
    let cleanUrl = url.replace(/[.,;:!?)]+$/, '');
    const trailing = url.slice(cleanUrl.length);
    cleanUrl = cleanUrl.replace(/&amp;/g, '&');
    return `${prefix}<a href="${cleanUrl}" target="_blank" rel="noopener">${cleanUrl}</a>${trailing}`;
  });

  escaped = escaped.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="ol-item"><span class="list-num">$1.</span> $2</li>');
  escaped = escaped.replace(/^[-•]\s+(.+)$/gm, '<li class="ul-item">• $1</li>');

  escaped = escaped.replace(/((?:<li class="ol-item">.*<\/li>\n?)+)/g, '<ol class="md-list">$1</ol>');
  escaped = escaped.replace(/((?:<li class="ul-item">.*<\/li>\n?)+)/g, '<ul class="md-list">$1</ul>');

  escaped = escaped.replace(/^### (.+)$/gm, '<strong class="md-h3">$1</strong>');
  escaped = escaped.replace(/^## (.+)$/gm, '<strong class="md-h2">$1</strong>');
  escaped = escaped.replace(/^---$/gm, '<hr class="md-hr">');

  escaped = escaped.replace(/\x00TB(\d+)\x00/g, (_, idx) => tablePlaceholders[parseInt(idx)]);
  escaped = escaped.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);
  escaped = escaped.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)]);

  return escaped;
}

function copyTable(btn) {
  const wrap = btn.closest('.md-table-wrap');
  const table = wrap.querySelector('table');
  if (!table) return;
  const rows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = [];
    tr.querySelectorAll('th, td').forEach(cell => cells.push(cell.textContent.trim()));
    rows.push(cells.join('\t'));
  });
  const tsv = rows.join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = tsv;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  });
}

function formatTime(date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

(function initSwipeNavigation() {
  const SWIPE_THRESHOLD = 60;
  const SWIPE_RATIO = 1.3;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swiping = false;
  let swipeHintEl = null;

  function createSwipeHint(side) {
    removeSwipeHint();
    swipeHintEl = document.createElement("div");
    swipeHintEl.className = `swipe-hint swipe-hint-${side}`;
    document.body.appendChild(swipeHintEl);
    requestAnimationFrame(() => swipeHintEl && swipeHintEl.classList.add("visible"));
  }

  function removeSwipeHint() {
    if (swipeHintEl) {
      swipeHintEl.remove();
      swipeHintEl = null;
    }
  }

  function swipeToMissionControl() {
    if (!isAgentRunning) {
      stopSyncPolling();
      if (eventSource) { eventSource.close(); eventSource = null; }
    }
    showLanding();
    const landing = document.getElementById("landing");
    if (landing) landing.classList.add("landing-slide-in");
  }

  function swipeToChat() {
    const savedSession = localStorage.getItem("activeSession");
    if (savedSession && sessionId === savedSession) {
      hideLandingAndRun(() => {
        if (!eventSource) openEventStream(sessionId);
        startSyncPolling();
        scrollToBottom();
      }, "left");
    } else if (lastKnownConversations.length > 0) {
      hideLandingAndRun(() => resumeConversation(lastKnownConversations[0].id), "left");
    } else {
      hideLandingAndRun(async () => {
        clearMessages();
        showEmptyState();
        await startSession();
      }, "left");
    }
  }

  appEl.addEventListener("touchstart", (e) => {
    if (document.body.classList.contains("keyboard-open")) return;
    const target = e.target;
    if (target.closest && (target.closest("textarea, input, select, .input-row, pre, code, table, [contenteditable]"))) {
      swipeStartX = 0;
      return;
    }
    const t = e.touches[0];
    swipeStartX = t.clientX;
    swipeStartY = t.clientY;
    swiping = false;
  }, { passive: true });

  appEl.addEventListener("touchmove", (e) => {
    if (!swipeStartX) return;
    if (document.body.classList.contains("keyboard-open")) return;
    const t = e.touches[0];
    const dx = t.clientX - swipeStartX;
    const dy = t.clientY - swipeStartY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    if (adx < 20 && ady < 20) return;

    if (!swiping && adx > ady * SWIPE_RATIO && adx > 20) {
      swiping = true;
    }

    if (!swiping) return;

    if (landingVisible && dx < -20) {
      createSwipeHint("left");
    } else if (!landingVisible && dx > 20) {
      createSwipeHint("right");
    } else {
      removeSwipeHint();
    }
  }, { passive: true });

  appEl.addEventListener("touchend", (e) => {
    if (!swiping) {
      swipeStartX = 0;
      swipeStartY = 0;
      removeSwipeHint();
      return;
    }

    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const dx = endX - swipeStartX;
    const dy = endY - swipeStartY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    removeSwipeHint();
    swipeStartX = 0;
    swipeStartY = 0;
    swiping = false;

    if (adx < SWIPE_THRESHOLD || adx < ady * SWIPE_RATIO) return;

    if (dx > 0 && !landingVisible) {
      swipeToMissionControl();
    } else if (dx < 0 && landingVisible) {
      swipeToChat();
    }
  }, { passive: true });

  appEl.addEventListener("touchcancel", () => {
    swipeStartX = 0;
    swipeStartY = 0;
    swiping = false;
    removeSwipeHint();
  }, { passive: true });
})();
