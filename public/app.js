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
let pendingImages = [];
let reconnectAttempts = 0;
let reconnectTimer = null;
let catchUpInProgress = false;
let syncPollTimer = null;
let isSyncingToCloud = false;
let textOffsetAfterCatchUp = 0;

const messages      = document.getElementById("messages");
const scrollAnchor  = document.getElementById("scroll-anchor");
const input         = document.getElementById("input");
const sendBtn       = document.getElementById("send-btn");
const statusBar     = document.getElementById("status-bar");
const statusText    = document.getElementById("status-text");
const newSessionBtn = document.getElementById("new-session-btn");
const historyBtn    = document.getElementById("history-btn");
const statusDot     = document.getElementById("status-dot");
const kbBadge       = document.getElementById("kb-badge");
const kbDot         = document.getElementById("kb-dot");
const appEl         = document.getElementById("app");
const historyPanel  = document.getElementById("history-panel");
const historyList   = document.getElementById("history-list");
const historyCloseBtn = document.getElementById("history-close-btn");
const confirmModal  = document.getElementById("confirm-modal");
const modalConfirm  = document.getElementById("modal-confirm");
const modalCancel   = document.getElementById("modal-cancel");
const alertsSettingsBtn = document.getElementById("alerts-settings-btn");
const generateBriefBtn = document.getElementById("generate-brief-btn");
const modelBadge    = document.getElementById("model-badge");
const modelModeEl   = document.getElementById("model-mode");
const modelNameEl   = document.getElementById("model-name");
let currentModelMode = "auto";
const FULL_MODEL_ID = "claude-sonnet-4-6";

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
  showEmptyState();
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
            showStatus("[PROCESSING...]");
          }
          openEventStream(sessionId);
          startSyncPolling();
          scrollToBottom();
          showSystemMsg("SESSION RESUMED.");
          return;
        }
      }
    } catch {}
    localStorage.removeItem("activeSession");
  }
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
    }).catch(() => {});
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
  stopSyncPolling();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (sessionId) await fetch(`/api/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
  sessionId = null;
  agentBubble = null;
  agentText = "";
  isAgentRunning = false;
  hasMessages = false;
  viewingHistory = false;
  reconnectAttempts = 0;
  localStorage.removeItem("activeSession");
  clearMessages();
  showEmptyState();
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
      const bubble = appendBubble(msg.role, msg.text, msg.timestamp);
      if (msg.images && msg.images.length > 0) {
        const imgRow = document.createElement("div");
        imgRow.className = "msg-images";
        for (const img of msg.images) {
          const el = document.createElement("img");
          el.src = `data:${img.mimeType};base64,${img.data}`;
          imgRow.appendChild(el);
        }
        bubble.querySelector(".bubble").prepend(imgRow);
      }
    }
    scrollToBottom();
  } catch (err) {
    showSystemMsg("ERR: " + err.message);
  }
}

function exitHistoryView() {
  viewingHistory = false;
  input.disabled = false;
  sendBtn.disabled = false;
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
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/session/${id}/stream`);

  eventSource.addEventListener("open", () => {
    setConnected(true);
    if (reconnectAttempts > 0) {
      catchUpSession(id);
      hideStatus();
    }
    reconnectAttempts = 0;
  });

  eventSource.addEventListener("message", (e) => {
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
    showStatus("[RECONNECTING...]");
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

    if (serverMessages.length > domCount || (!status.agentRunning && isAgentRunning)) {
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
      showStatus(status.pendingCount > 0 ? `[PROCESSING... ${status.pendingCount} QUEUED]` : "[PROCESSING...]");
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

let visibilityDebounce = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !sessionId) return;
  if (visibilityDebounce) clearTimeout(visibilityDebounce);
  visibilityDebounce = setTimeout(() => {
    visibilityDebounce = null;
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      reconnectAttempts = 0;
      openEventStream(sessionId);
    } else {
      catchUpSession(sessionId);
    }
  }, 500);
});

window.addEventListener("online", () => {
  if (!sessionId) return;
  if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
    reconnectAttempts = 0;
    openEventStream(sessionId);
  }
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
      showStatus("[PROCESSING...]");
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
      showStatus(`[RUNNING ${name.toUpperCase()}...]`);
      break;
    }

    case "tool_execution_end": {
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
          agentBubble.appendChild(copyBtn);
        }
        renderSuggestionChipsFromText(rawForChips);
      }
      isAgentRunning = false;
      agentBubble = null;
      agentText = "";
      hideStatus();
      input.focus();
      throttledScroll();
      break;

    case "error":
      showSystemMsg("ERR: " + event.error);
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
  } catch {}
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

function addPendingImage(file) {
  if (!file.type.startsWith("image/")) return;
  if (pendingImages.length >= 5) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = dataUrl.split(",")[1];
    pendingImages.push({ mimeType: file.type, data: base64, preview: dataUrl });
    renderImagePreviews();
  };
  reader.readAsDataURL(file);
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
  const text = input.value.trim();
  const images = pendingImages.map(i => ({ mimeType: i.mimeType, data: i.data }));
  if ((!text && images.length === 0) || !sessionId || viewingHistory) return;

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
      <h3>// SCHEDULED BRIEFS</h3>
      <div class="settings-row"><label>Morning Brief</label><input type="checkbox" class="settings-toggle" data-brief="morning"></div>
      <div class="settings-row"><label>Time</label><select class="settings-select" data-brief-time="morning"></select></div>
      <div class="settings-row"><label>Afternoon Brief</label><input type="checkbox" class="settings-toggle" data-brief="afternoon"></div>
      <div class="settings-row"><label>Time</label><select class="settings-select" data-brief-time="afternoon"></select></div>
      <div class="settings-row"><label>Evening Brief</label><input type="checkbox" class="settings-toggle" data-brief="evening"></div>
      <div class="settings-row"><label>Time</label><select class="settings-select" data-brief-time="evening"></select></div>
    </div>
    <div class="settings-section">
      <h3>// WATCHLIST</h3>
      <div class="watchlist-items" id="watchlist-items"></div>
      <div class="watchlist-add-row">
        <input type="text" class="watchlist-add-input" id="watchlist-input" placeholder="TICKER (e.g. AAPL, BTC)">
        <button class="settings-btn" id="watchlist-add-btn">ADD</button>
      </div>
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

  const timeSelects = panel.querySelectorAll("[data-brief-time]");
  timeSelects.forEach(sel => {
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement("option");
      opt.value = h;
      const ampm = h < 12 ? "AM" : "PM";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      opt.textContent = `${h12}:00 ${ampm}`;
      sel.appendChild(opt);
    }
  });

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

    for (const type of ["morning", "afternoon", "evening"]) {
      const toggle = panel.querySelector(`[data-brief="${type}"]`);
      const timeSel = panel.querySelector(`[data-brief-time="${type}"]`);
      if (toggle && cfg.briefs?.[type]) toggle.checked = cfg.briefs[type].enabled;
      if (timeSel && cfg.briefs?.[type]) timeSel.value = cfg.briefs[type].hour;
    }

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
  } catch {}
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

  const config = { briefs: {}, alerts: {}, watchlist: getCurrentWatchlist(), theme: localStorage.getItem("theme") || "dark" };

  for (const type of ["morning", "afternoon", "evening"]) {
    const toggle = panel.querySelector(`[data-brief="${type}"]`);
    const timeSel = panel.querySelector(`[data-brief-time="${type}"]`);
    config.briefs[type] = {
      enabled: toggle?.checked || false,
      hour: parseInt(timeSel?.value || "8"),
      minute: 0,
    };
  }

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
  } catch {}
}

alertsSettingsBtn.addEventListener("click", toggleSettings);

const FAST_MODEL_ID = "claude-haiku-4-5";
const MODEL_DISPLAY = {
  [FAST_MODEL_ID]: "haiku-4.5",
  [FULL_MODEL_ID]: "sonnet-4.6",
};
const MODE_TO_MODEL = {
  fast: FAST_MODEL_ID,
  full: FULL_MODEL_ID,
};

function updateModelBadge(modelId) {
  modelNameEl.textContent = MODEL_DISPLAY[modelId] || modelId;
  modelBadge.classList.toggle("model-fast", modelId === FAST_MODEL_ID);
  modelBadge.classList.toggle("model-full", modelId === FULL_MODEL_ID);
}

function updateModeDisplay(mode) {
  currentModelMode = mode;
  modelModeEl.textContent = mode.toUpperCase();
  modelBadge.dataset.mode = mode;
  if (mode === "auto") {
    modelNameEl.textContent = "auto";
    modelBadge.classList.remove("model-fast", "model-full");
  } else {
    updateModelBadge(MODE_TO_MODEL[mode]);
  }
}

modelBadge.addEventListener("click", async () => {
  const modes = ["auto", "fast", "full"];
  const next = modes[(modes.indexOf(currentModelMode) + 1) % modes.length];
  updateModeDisplay(next);
  if (!sessionId) return;
  try {
    await fetch(`/api/session/${sessionId}/model-mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
  } catch {}
});

generateBriefBtn.addEventListener("click", async () => {
  const hour = new Date().getHours();
  const type = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  generateBriefBtn.disabled = true;
  generateBriefBtn.classList.add("loading");
  try {
    await fetch(`/api/alerts/trigger/${type}`, { method: "POST" });
  } catch {}
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

  msg.appendChild(bubble);

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

function hideStatus() {
  if (isSyncingToCloud && !isAgentRunning && reconnectAttempts === 0) {
    showStatus("[SYNCING TO CLOUD...]");
    return;
  }
  statusBar.classList.add("hidden");
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
    } catch {}
  }, 10_000);
}

function stopSyncPolling() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
  isSyncingToCloud = false;
}

function scrollToBottom() {
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
    if (d.emails && d.emails.unread > 0) parts.push(`${d.emails.unread} new today`);
    if (d.tasks && d.tasks.active > 0) parts.push(`${d.tasks.active} task${d.tasks.active !== 1 ? "s" : ""}`);
    if (d.nextEvent) {
      const t = d.nextEvent.time || "";
      const short = t.replace(/^.*?,\s*/, "").replace(/:00\s*/g, " ");
      parts.push(`Next: ${e(d.nextEvent.title)}${short ? " " + e(short) : ""}`);
    }
    if (parts.length === 0 && d.time) parts.push(e(d.time));
    if (parts.length === 0) parts.push("—");

    const sep = '<span class="glance-sep">·</span>';
    const clockHtml = `<span id="glance-clock" class="glance-clock">${getETTimeString()}</span>`;
    collapsed.innerHTML = clockHtml + sep + parts.join(sep);

    const detailRows = [];
    if (d.time) detailRows.push(row("time", e(d.time)));
    if (d.weather) detailRows.push(row("weather", `${e(d.weather.icon)} ${e(String(d.weather.tempC))}°C — ${e(d.weather.condition)}`));
    if (d.emails) detailRows.push(row("email", d.emails.unread === 0 ? "Inbox clear" : `${d.emails.unread} unread today`));
    if (d.tasks) detailRows.push(row("tasks", d.tasks.active === 0 ? "All clear" : `${d.tasks.active} open`));
    if (d.upcomingEvents && d.upcomingEvents.length > 0) {
      const evList = d.upcomingEvents.map(ev => {
        const t = (ev.time || "").replace(/^.*?,\s*/, "");
        return `${e(ev.title)}${t ? " — " + e(t) : ""}`;
      }).join("; ");
      detailRows.push(row("calendar", evList));
    } else if (d.nextEvent) {
      detailRows.push(row("next", `${e(d.nextEvent.title)} — ${e(d.nextEvent.time || "")}`));
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

  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });

  escaped = escaped.replace(/(^|[\s>])((https?:\/\/)[^\s<"')\]]+)/gm, (match, prefix, url) => {
    if (match.includes('href=')) return match;
    return `${prefix}<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
  });

  escaped = escaped.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="ol-item"><span class="list-num">$1.</span> $2</li>');
  escaped = escaped.replace(/^[-•]\s+(.+)$/gm, '<li class="ul-item">• $1</li>');

  escaped = escaped.replace(/((?:<li class="ol-item">.*<\/li>\n?)+)/g, '<ol class="md-list">$1</ol>');
  escaped = escaped.replace(/((?:<li class="ul-item">.*<\/li>\n?)+)/g, '<ul class="md-list">$1</ul>');

  escaped = escaped.replace(/^### (.+)$/gm, '<strong class="md-h3">$1</strong>');
  escaped = escaped.replace(/^## (.+)$/gm, '<strong class="md-h2">$1</strong>');
  escaped = escaped.replace(/^---$/gm, '<hr class="md-hr">');

  escaped = escaped.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);
  escaped = escaped.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)]);

  return escaped;
}

function formatTime(date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
