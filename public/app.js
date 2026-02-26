/**
 * pi-agent terminal — hacker-style chat UI
 */

let sessionId = null;
let eventSource = null;
let agentBubble = null;
let agentText = "";
let isAgentRunning = false;

const messages      = document.getElementById("messages");
const input         = document.getElementById("input");
const sendBtn       = document.getElementById("send-btn");
const statusBar     = document.getElementById("status-bar");
const statusText    = document.getElementById("status-text");
const newSessionBtn = document.getElementById("new-session-btn");
const interviewNotice = document.getElementById("interview-notice");

function checkAuth(res) {
  if (res.status === 401) {
    window.location.href = "/login.html";
    return false;
  }
  return true;
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
  messages.innerHTML = "";
  showEmptyState();
  interviewNotice.classList.add("hidden");
  await startSession();
});

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
      showSystemMsg("CONNECTION LOST. TAP + TO RECONNECT.");
    }
  });
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
        scrollToBottom();
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
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}
input.addEventListener("input", autoResize);

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
    <div class="pi-logo">&gt;_</div>
    <h2>[PI-AGENT TERMINAL]</h2>
    <p>connected to knowledge base. ready for input.</p>
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
