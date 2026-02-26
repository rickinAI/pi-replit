let sessionId = null;
let eventSource = null;
let agentBubble = null;
let agentText = "";
let isAgentRunning = false;
let scrollThrottleTimer = null;
let userHasScrolledUp = false;

const messages      = document.getElementById("messages");
const scrollAnchor  = document.getElementById("scroll-anchor");
const input         = document.getElementById("input");
const sendBtn       = document.getElementById("send-btn");
const statusBar     = document.getElementById("status-bar");
const statusText    = document.getElementById("status-text");
const newSessionBtn = document.getElementById("new-session-btn");
const interviewNotice = document.getElementById("interview-notice");
const statusDot     = document.getElementById("status-dot");
const appEl         = document.getElementById("app");

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
    const { sessionId: id } = await res.json();
    sessionId = id;
    openEventStream(id);
    hideStatus();
  } catch (err) {
    showSystemMsg("ERR: " + err.message);
    hideStatus();
  }
}

newSessionBtn.addEventListener("click", async () => {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (sessionId) await fetch(`/api/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
  sessionId = null;
  agentBubble = null;
  agentText = "";
  isAgentRunning = false;
  messages.querySelectorAll(".msg, .empty-state").forEach(el => el.remove());
  showEmptyState();
  interviewNotice.classList.add("hidden");
  setConnected(false);
  await startSession();
});

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
  if (!text || !sessionId || isAgentRunning) return;

  removeEmptyState();
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
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
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

function showSystemMsg(text) {
  appendBubble("system", text);
}

function showEmptyState() {
  if (messages.querySelector(".empty-state")) return;
  const el = document.createElement("div");
  el.className = "empty-state";
  el.innerHTML = `
    <div class="pi-logo">&gt;_</div>
    <h2>[RICKIN TERMINAL]</h2>
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
