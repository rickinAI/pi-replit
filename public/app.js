/**
 * pi-replit frontend — mobile-first chat UI
 * Talks to the Express server via REST + SSE
 */

// ── State ─────────────────────────────────────────────────────────────────
let sessionId = null;
let eventSource = null;
let agentBubble = null;   // currently streaming bubble
let agentText = "";       // accumulated text for current turn
let isAgentRunning = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
const messages      = document.getElementById("messages");
const input         = document.getElementById("input");
const sendBtn       = document.getElementById("send-btn");
const statusBar     = document.getElementById("status-bar");
const statusText    = document.getElementById("status-text");
const newSessionBtn = document.getElementById("new-session-btn");
const interviewNotice = document.getElementById("interview-notice");

// ── Init ───────────────────────────────────────────────────────────────────
(async () => {
  showEmptyState();
  await startSession();
})();

// ── Session management ─────────────────────────────────────────────────────
async function startSession() {
  try {
    showStatus("Starting session…");
    const res = await fetch("/api/session", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    const { sessionId: id } = await res.json();
    sessionId = id;
    openEventStream(id);
    hideStatus();
  } catch (err) {
    showSystemMsg(`Failed to start session: ${err.message}`);
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
  messages.innerHTML = "";
  showEmptyState();
  interviewNotice.classList.add("hidden");
  await startSession();
});

// ── SSE event stream ───────────────────────────────────────────────────────
function openEventStream(id) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/session/${id}/stream`);

  eventSource.addEventListener("message", (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    handleAgentEvent(event);
  });

  eventSource.addEventListener("error", () => {
    if (eventSource.readyState === EventSource.CLOSED) {
      showSystemMsg("Connection lost. Tap + to start a new session.");
    }
  });
}

// ── Agent event handling ───────────────────────────────────────────────────
function handleAgentEvent(event) {
  switch (event.type) {
    case "agent_start":
      isAgentRunning = true;
      agentBubble = null;
      agentText = "";
      showStatus("Agent is thinking…");
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
        scrollToBottom();
      }
      break;
    }

    case "tool_execution_start": {
      const name = event.toolName ?? "tool";
      showStatus(`Running ${name}…`);

      // Show interview notice if the interview tool is invoked
      if (name === "interview") {
        interviewNotice.classList.remove("hidden");
        document.getElementById("interview-link").href = "/interview";
      }

      // Show a tool pill under the current agent bubble
      if (agentBubble) {
        const pill = document.createElement("div");
        pill.className = "tool-pill";
        pill.innerHTML = `<span class="dot"></span><span>${name}</span>`;
        agentBubble.appendChild(pill);
      }
      break;
    }

    case "tool_execution_end": {
      // Remove spinner dots from pills
      agentBubble?.querySelectorAll(".tool-pill .dot").forEach(d => d.remove());
      // Hide interview notice once tool finishes
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
      break;

    case "error":
      showSystemMsg(`Error: ${event.error}`);
      isAgentRunning = false;
      hideStatus();
      sendBtn.disabled = false;
      break;
  }
}

// ── Send message ───────────────────────────────────────────────────────────
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
    if (!res.ok) throw new Error(await res.text());
  } catch (err) {
    showSystemMsg(`Send failed: ${err.message}`);
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

// ── Textarea auto-resize ───────────────────────────────────────────────────
function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}
input.addEventListener("input", autoResize);

// ── UI helpers ─────────────────────────────────────────────────────────────
function appendBubble(role, text) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  msg.appendChild(bubble);
  messages.appendChild(msg);
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
    <div class="pi-logo">π</div>
    <h2>pi coding agent</h2>
    <p>Ask me to read, edit, write, or run anything in your project.</p>
  `;
  messages.appendChild(el);
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
  messages.scrollTop = messages.scrollHeight;
}
