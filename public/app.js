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
let currentModelMode = "auto";
const FULL_MODEL_ID = "claude-sonnet-4-6";

const TOOL_LABELS = {
  web_search: "🔍 SEARCHING THE WEB",
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

function getToolStatusLabel(toolName) {
  if (!toolName) return "🧠 THINKING...";
  return TOOL_LABELS[toolName] || `⚙️ ${toolName.toUpperCase().replace(/_/g, " ")}`;
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
          if (status.agentRunning) {
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

  landing.querySelector("#landing-settings-btn").addEventListener("click", () => {
    toggleSettings();
  });

  let convos = [];
  let glanceData = null;
  try {
    const [convRes, glanceRes] = await Promise.all([
      fetch("/api/conversations").then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("/api/glance").then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    convos = convRes;
    glanceData = glanceRes;
  } catch (err) { console.warn("Landing data fetch failed:", err); }

  if (thisInvocation !== landingInvocationId) return;

  convos.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

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
      container.appendChild(createLandingCard(convo));
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
            const role = m.role === "user" ? "you" : "rickin";
            const text = (m.text || "").slice(0, 100) + ((m.text || "").length > 100 ? "..." : "");
            return `<span class="preview-role">${role}:</span> ${escapeHtml(text)}`;
          }).join("<br>");
        }
      }
    } catch (err) { console.warn("Preview fetch failed:", err); }
    lastCardEl.innerHTML = `
      <div class="landing-last-label">Last conversation</div>
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

function createLandingCard(convo) {
  const card = document.createElement("div");
  card.className = "landing-card";
  card.innerHTML = `
    <div class="landing-card-main">
      <div class="landing-card-title">${escapeHtml(convo.title)}</div>
      <div class="landing-card-meta">${relativeTime(convo.updatedAt || convo.createdAt)} · ${convo.messageCount} msgs</div>
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

function hideLandingAndRun(fn) {
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
    landing.classList.add("landing-hidden");
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
    if (reconnectAttempts > 0) {
      catchUpSession(id);
      hideStatus();
    }
    reconnectAttempts = 0;
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

async function catchUpSession(sid) {
  if (catchUpInProgress) return;
  catchUpInProgress = true;
  try {
    const res = await fetch(`/api/session/${sid}/status`);
    if (!res.ok) { catchUpInProgress = false; return; }
    const status = await res.json();
    if (!status.alive) {
      localStorage.removeItem("activeSession");
      catchUpInProgress = false;
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

    if (status.agentRunning) {
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

function attemptReconnect() {
  if (!sessionId) return;
  if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
    reconnectAttempts = 0;
    openEventStream(sessionId);
  } else {
    const timeSinceLastEvent = Date.now() - lastEventTime;
    if (timeSinceLastEvent > 20000) {
      catchUpSession(sessionId);
    }
  }
}

let visibilityDebounce = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !sessionId) return;
  if (visibilityDebounce) clearTimeout(visibilityDebounce);
  visibilityDebounce = setTimeout(() => {
    visibilityDebounce = null;
    attemptReconnect();
  }, 500);
});

window.addEventListener("online", () => {
  attemptReconnect();
});

function handleAgentEvent(event) {
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
      const label = TOOL_LABELS[name] || `⚙️ RUNNING ${name.toUpperCase()}`;
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
      isAgentRunning = false;
      agentBubble = null;
      agentText = "";
      stopThinkingTimer();
      hideStatus();
      input.focus();
      throttledScroll();
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
        if (checked) responses.push({ id: q.id, value: checked.value });
      } else if (q.type === "multi") {
        const checked = qEl.querySelectorAll(`input[name="iv_${qid}"]:checked`);
        const vals = Array.from(checked).map(c => c.value);
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
    <div class="settings-section scheduled-jobs-section">
      <h3>// SCHEDULED AGENTS</h3>
      <div id="scheduled-jobs-list"></div>
      <button class="settings-btn" id="add-custom-job-btn">+ CUSTOM JOB</button>
      <div id="custom-job-form-wrap"></div>
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

  setupCustomJobForm();

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

  loadScheduledJobs();
}

let scheduledJobsData = [];

async function loadScheduledJobs() {
  try {
    const res = await fetch("/api/scheduled-jobs");
    if (!res.ok) return;
    scheduledJobsData = await res.json();
    renderScheduledJobs();
  } catch (err) { console.warn("Load scheduled jobs failed:", err); }
}

function renderScheduledJobs() {
  const container = settingsPanel?.querySelector("#scheduled-jobs-list");
  if (!container) return;
  container.innerHTML = "";

  if (scheduledJobsData.length > 0) {
    const ok = scheduledJobsData.filter(j => j.lastStatus === "success").length;
    const failed = scheduledJobsData.filter(j => j.lastStatus === "error").length;
    const partial = scheduledJobsData.filter(j => j.lastStatus === "partial").length;
    const notRun = scheduledJobsData.filter(j => !j.lastStatus).length;
    const parts = [`${scheduledJobsData.length} JOBS`];
    if (ok > 0) parts.push(`${ok} ✅`);
    if (failed > 0) parts.push(`${failed} 🔴`);
    if (partial > 0) parts.push(`${partial} 🟡`);
    if (notRun > 0) parts.push(`${notRun} ⚪`);
    const summary = document.createElement("div");
    summary.className = "job-health-summary";
    summary.textContent = parts.join(" · ");
    container.appendChild(summary);
  }

  scheduledJobsData.forEach(job => {
    const card = document.createElement("div");
    card.className = "job-card";
    card.dataset.id = job.id;

    const h = job.schedule.hour;
    const m = job.schedule.minute;
    const ampm = h < 12 ? "AM" : "PM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const timeStr = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;

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
          <span class="job-card-schedule-label">${job.schedule.type === "daily" ? "Daily" : "Weekly"} at</span>
          <select class="job-card-hour-select"></select>
          <span class="job-card-time-sep">:</span>
          <select class="job-card-min-select"></select>
        </div>
        <div class="job-card-actions">
          ${statusHtml}
          <button class="job-run-btn" title="Run now">Run</button>
        </div>
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
      saveJobUpdate(job.id, { schedule: job.schedule });
    });

    minSel.addEventListener("change", () => {
      job.schedule.minute = parseInt(minSel.value);
      saveJobUpdate(job.id, { schedule: job.schedule });
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
      saveJobUpdate(job.id, { enabled: job.enabled });
      runBtn.textContent = "Run";
      runBtn.disabled = false;
    });

    container.appendChild(card);
  });
}

function formatTimeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

async function saveJobUpdate(jobId, updates) {
  try {
    await fetch(`/api/scheduled-jobs/${jobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  } catch (err) { console.warn("Save job update failed:", err); }
}

function setupCustomJobForm() {
  const btn = settingsPanel?.querySelector("#add-custom-job-btn");
  const wrap = settingsPanel?.querySelector("#custom-job-form-wrap");
  if (!btn || !wrap) return;

  btn.addEventListener("click", () => {
    if (wrap.querySelector(".job-add-custom-form")) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = `
      <div class="job-add-custom-form">
        <div class="job-form-row"><label>Name</label><input type="text" class="job-form-input" id="custom-job-name" placeholder="My custom job"></div>
        <div class="job-form-row"><label>Agent</label><select class="job-form-select" id="custom-job-agent"></select></div>
        <div class="job-form-row"><label>Time</label><select class="job-form-select" id="custom-job-hour"></select><span class="job-card-time-sep">:</span><select class="job-form-select" id="custom-job-min"></select></div>
        <div class="job-form-row"><label>Prompt</label><textarea class="job-form-textarea" id="custom-job-prompt" rows="4" placeholder="What should the agent do?"></textarea></div>
        <div class="job-form-row job-form-actions">
          <button class="job-form-submit">Add Job</button>
          <button class="job-form-cancel">Cancel</button>
        </div>
      </div>
    `;

    const agentSel = wrap.querySelector("#custom-job-agent");
    fetch("/api/agents").then(r => r.json()).then(data => {
      const list = data.agents || data;
      list.forEach(a => {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = a.name || a.id;
        agentSel.appendChild(opt);
      });
    }).catch(() => {});

    const hourSel2 = wrap.querySelector("#custom-job-hour");
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement("option");
      opt.value = h;
      const ap = h < 12 ? "AM" : "PM";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      opt.textContent = `${h12} ${ap}`;
      if (h === 8) opt.selected = true;
      hourSel2.appendChild(opt);
    }
    const minSel2 = wrap.querySelector("#custom-job-min");
    for (let mn = 0; mn < 60; mn += 5) {
      const opt = document.createElement("option");
      opt.value = mn;
      opt.textContent = String(mn).padStart(2, "0");
      if (mn === 0) opt.selected = true;
      minSel2.appendChild(opt);
    }

    wrap.querySelector(".job-form-cancel").addEventListener("click", () => { wrap.innerHTML = ""; });
    wrap.querySelector(".job-form-submit").addEventListener("click", async () => {
      const name = wrap.querySelector("#custom-job-name").value.trim();
      const agentId = wrap.querySelector("#custom-job-agent").value;
      const prompt = wrap.querySelector("#custom-job-prompt").value.trim();
      const hour = parseInt(wrap.querySelector("#custom-job-hour").value);
      const minute = parseInt(wrap.querySelector("#custom-job-min").value);
      if (!name || !agentId || !prompt) return;
      try {
        const res = await fetch("/api/scheduled-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, agentId, prompt, schedule: { type: "daily", hour, minute }, enabled: false }),
        });
        if (res.ok) {
          wrap.innerHTML = "";
          loadScheduledJobs();
        }
      } catch (err) { console.warn("Add custom job failed:", err); }
    });
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

  const c1 = [];
  if (d.weather) c1.push(`${d.weather.icon || "🌡️"} ${e(d.weather.tempC + "°C " + (d.weather.condition || ""))}`);
  if (d.emails) c1.push(`📧 ${d.emails.unread} new email${d.emails.unread !== 1 ? "s" : ""}`);
  if (d.tasks) c1.push(`✅ ${d.tasks.active} task${d.tasks.active !== 1 ? "s" : ""}`);
  if (c1.length > 0) cycles.push(`<span class="landing-glance-item">${c1.join(" · ")}</span>`);

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

  if (d.nextJob) cycles.push(`<span class="landing-glance-item">⏰ Next: ${e(d.nextJob.name)} · ${e(d.nextJob.time)}</span>`);

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
