let sessionId = null;
let eventSource = null;
let agentBubble = null;
let agentText = "";
let isAgentRunning = false;
let scrollThrottleTimer = null;
let userHasScrolledUp = false;
let hasMessages = false;
let viewingHistory = false;
let savedSessionNodes = null;

const messages      = document.getElementById("messages");
const scrollAnchor  = document.getElementById("scroll-anchor");
const input         = document.getElementById("input");
const sendBtn       = document.getElementById("send-btn");
const statusBar     = document.getElementById("status-bar");
const statusText    = document.getElementById("status-text");
const newSessionBtn = document.getElementById("new-session-btn");
const historyBtn    = document.getElementById("history-btn");
const interviewNotice = document.getElementById("interview-notice");
const statusDot     = document.getElementById("status-dot");
const appEl         = document.getElementById("app");
const historyPanel  = document.getElementById("history-panel");
const historyList   = document.getElementById("history-list");
const historyCloseBtn = document.getElementById("history-close-btn");
const confirmModal  = document.getElementById("confirm-modal");
const modalConfirm  = document.getElementById("modal-confirm");
const modalCancel   = document.getElementById("modal-cancel");

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
});

if (window.visualViewport) {
  const vv = window.visualViewport;
  function onViewportResize() {
    appEl.style.height = vv.height + "px";
    requestAnimationFrame(() => {
      if (!userHasScrolledUp) scrollToBottom();
    });
  }
  vv.addEventListener("resize", onViewportResize);
}

(async () => {
  showEmptyState();
  await startSession();
})();

async function startSession() {
  try {
    showStatus("[INITIALIZING...]");
    const res = await fetch("/api/session", { method: "POST" });
    if (!checkAuth(res)) return;
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    sessionId = data.sessionId;
    hasMessages = false;
    viewingHistory = false;
    openEventStream(sessionId);
    hideStatus();
  } catch (err) {
    showSystemMsg("ERR: " + err.message);
    hideStatus();
  }
}

newSessionBtn.addEventListener("click", () => {
  if (!hasMessages) {
    doNewSession();
    return;
  }
  confirmModal.classList.remove("hidden");
});

modalConfirm.addEventListener("click", () => {
  confirmModal.classList.add("hidden");
  doNewSession();
});

modalCancel.addEventListener("click", () => {
  confirmModal.classList.add("hidden");
});

confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) confirmModal.classList.add("hidden");
});

async function doNewSession() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (sessionId) await fetch(`/api/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
  sessionId = null;
  agentBubble = null;
  agentText = "";
  isAgentRunning = false;
  hasMessages = false;
  viewingHistory = false;
  clearMessages();
  showEmptyState();
  interviewNotice.classList.add("hidden");
  setConnected(false);
  input.disabled = false;
  sendBtn.disabled = false;
  await startSession();
}

historyBtn.addEventListener("click", async () => {
  historyPanel.classList.toggle("hidden");
  if (!historyPanel.classList.contains("hidden")) {
    await loadHistory();
  }
});

historyCloseBtn.addEventListener("click", () => {
  historyPanel.classList.add("hidden");
});

async function loadHistory() {
  historyList.innerHTML = '<div class="history-loading">[LOADING...]</div>';
  try {
    const res = await fetch("/api/conversations");
    if (!checkAuth(res)) return;
    const convos = await res.json();
    if (convos.length === 0) {
      historyList.innerHTML = '<div class="history-empty">No saved conversations.</div>';
      return;
    }
    historyList.innerHTML = "";
    for (const c of convos) {
      const item = document.createElement("div");
      item.className = "history-item";
      const date = new Date(c.createdAt);
      const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const timeStr = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      item.innerHTML = `
        <div class="history-item-main">
          <div class="history-title">${escapeHtml(c.title)}</div>
          <div class="history-meta">${dateStr} ${timeStr} · ${c.messageCount} msgs</div>
        </div>
        <button class="history-delete" title="Delete">×</button>
      `;
      item.querySelector(".history-item-main").addEventListener("click", () => viewConversation(c.id));
      item.querySelector(".history-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteConversation(c.id, item);
      });
      historyList.appendChild(item);
    }
  } catch (err) {
    historyList.innerHTML = `<div class="history-empty">ERR: ${err.message}</div>`;
  }
}

async function viewConversation(id) {
  try {
    const res = await fetch(`/api/conversations/${id}`);
    if (!checkAuth(res)) return;
    const conv = await res.json();
    historyPanel.classList.add("hidden");

    savedSessionNodes = [];
    messages.querySelectorAll(".msg, .empty-state").forEach(el => {
      savedSessionNodes.push(el);
      el.remove();
    });

    viewingHistory = true;
    input.disabled = true;
    sendBtn.disabled = true;

    const header = document.createElement("div");
    header.className = "history-view-header";
    header.innerHTML = `
      <span class="history-view-title">[VIEWING: ${escapeHtml(conv.title)}]</span>
      <button class="history-view-back" id="history-back-btn">[BACK TO CHAT]</button>
    `;
    messages.insertBefore(header, scrollAnchor);
    document.getElementById("history-back-btn").addEventListener("click", exitHistoryView);

    for (const msg of conv.messages) {
      appendBubble(msg.role, msg.text);
    }
    scrollToBottom();
  } catch (err) {
    showSystemMsg("ERR: " + err.message);
  }
}

function exitHistoryView() {
  viewingHistory = false;
  input.disabled = false;
  sendBtn.disabled = isAgentRunning;
  clearMessages();

  if (savedSessionNodes && savedSessionNodes.length > 0) {
    for (const node of savedSessionNodes) {
      messages.insertBefore(node, scrollAnchor);
    }
  } else {
    showEmptyState();
  }
  savedSessionNodes = null;
  scrollToBottom();
}

async function deleteConversation(id, el) {
  try {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    el.remove();
    if (historyList.children.length === 0) {
      historyList.innerHTML = '<div class="history-empty">No saved conversations.</div>';
    }
  } catch {}
}

function openEventStream(id) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/session/${id}/stream`);

  eventSource.addEventListener("open", () => setConnected(true));

  eventSource.addEventListener("message", (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    handleAgentEvent(event);
  });

  eventSource.addEventListener("error", () => {
    setConnected(false);
    if (eventSource.readyState === EventSource.CLOSED) {
      showSystemMsg("CONNECTION LOST. TAP + TO RECONNECT.");
    }
  });
}

function setConnected(connected) {
  if (connected) {
    statusDot.classList.remove("disconnected");
    statusDot.title = "Connected";
  } else {
    statusDot.classList.add("disconnected");
    statusDot.title = "Disconnected";
  }
}

function handleAgentEvent(event) {
  switch (event.type) {
    case "agent_start":
      isAgentRunning = true;
      agentBubble = null;
      agentText = "";
      showStatus("[PROCESSING...]");
      break;

    case "message_update": {
      const ae = event.assistantMessageEvent;
      if (!ae) break;

      if (ae.type === "text_delta") {
        removeEmptyState();
        if (!agentBubble) {
          agentBubble = appendBubble("agent", "");
        }
        agentText += ae.delta;
        agentBubble.querySelector(".bubble").textContent = agentText;
        throttledScroll();
      }
      break;
    }

    case "tool_execution_start": {
      const name = event.toolName ?? "tool";
      showStatus(`[RUNNING ${name.toUpperCase()}...]`);

      if (name === "interview") {
        interviewNotice.classList.remove("hidden");
        document.getElementById("interview-link").href = "/interview";
      }

      if (agentBubble) {
        const pill = document.createElement("div");
        pill.className = "tool-pill";
        const dot = document.createElement("span");
        dot.className = "dot";
        const label = document.createElement("span");
        label.textContent = name;
        pill.appendChild(dot);
        pill.appendChild(label);
        agentBubble.appendChild(pill);
      }
      break;
    }

    case "tool_execution_end": {
      agentBubble?.querySelectorAll(".tool-pill .dot").forEach(d => d.remove());
      interviewNotice.classList.add("hidden");
      break;
    }

    case "agent_end":
      isAgentRunning = false;
      agentBubble = null;
      agentText = "";
      hideStatus();
      sendBtn.disabled = false;
      input.focus();
      scrollToBottom();
      break;

    case "error":
      showSystemMsg("ERR: " + event.error);
      isAgentRunning = false;
      hideStatus();
      sendBtn.disabled = false;
      break;
  }
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || !sessionId || isAgentRunning || viewingHistory) return;

  removeEmptyState();
  hasMessages = true;
  appendBubble("user", text);
  input.value = "";
  autoResize();
  sendBtn.disabled = true;
  scrollToBottom();

  try {
    const res = await fetch(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!checkAuth(res)) return;
    if (res.status === 404) {
      showSystemMsg("SESSION EXPIRED. RECONNECTING...");
      await startSession();
      const retry = await fetch(`/api/session/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!checkAuth(retry)) return;
      if (!retry.ok) throw new Error(await retry.text());
      return;
    }
    if (!res.ok) throw new Error(await res.text());
  } catch (err) {
    showSystemMsg("ERR: " + err.message);
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener("click", sendMessage);
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
  setTimeout(() => scrollToBottom(), 300);
});

function appendBubble(role, text) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  msg.appendChild(bubble);
  messages.insertBefore(msg, scrollAnchor);
  scrollToBottom();
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

function hideStatus() {
  statusBar.classList.add("hidden");
}

function scrollToBottom() {
  userHasScrolledUp = false;
  scrollAnchor.scrollIntoView({ behavior: "auto", block: "end" });
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
