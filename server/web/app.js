const form = document.getElementById("run-form");
const apiKeyInput = document.getElementById("gemini-api-key");
const startUrlInput = document.getElementById("start-url");
const promptInput = document.getElementById("prompt");
const runButton = document.getElementById("run-btn");
const stopButton = document.getElementById("stop-btn");
const statusNode = document.getElementById("status");
const logNode = document.getElementById("log");
const STORAGE_KEYS = Object.freeze({
  geminiApiKey: "gcu.geminiApiKey",
  startUrl: "gcu.startUrl",
  prompt: "gcu.prompt"
});

let activeRunId = null;
let eventSource = null;

hydrateInputsFromStorage();
bindInputPersistence();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (activeRunId) {
    return;
  }

  const payload = {
    geminiApiKey: apiKeyInput.value.trim(),
    startUrl: startUrlInput.value.trim(),
    prompt: promptInput.value.trim()
  };
  if (!payload.startUrl || !payload.prompt) {
    return;
  }
  persistInputsToStorage();

  setStatus("Starting run...");
  appendLog("Submitting run request.");
  setRunning(true);

  try {
    const response = await fetch("/runs/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "Failed to start run.");
    }

    activeRunId = body.runId;
    attachEvents(body.eventsUrl);
    appendLog(`Run started: ${activeRunId}`);
  } catch (error) {
    appendLog(error.message || "Failed to start run.");
    setStatus("Idle");
    setRunning(false);
  }
});

stopButton.addEventListener("click", async () => {
  if (!activeRunId) {
    return;
  }
  appendLog("Stop requested.");
  try {
    await fetch(`/runs/${activeRunId}/stop`, { method: "POST" });
  } catch {
    appendLog("Failed to send stop request.");
  }
});

function attachEvents(eventsUrl) {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(eventsUrl);
  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleEvent(payload);
    } catch {
      appendLog("Malformed event payload.");
    }
  };
  eventSource.onerror = () => {
    appendLog("Event stream disconnected.");
  };
}

function handleEvent(event) {
  switch (event.type) {
    case "status":
      setStatus(event.message || "Running");
      appendLog(event.message || "Status update.");
      break;
    case "thought":
      appendLog(event.message || "Gemini is thinking.");
      break;
    case "action":
      appendLog(`Action: ${event.action?.actionType || "unknown"}`);
      break;
    case "action_result":
      appendLog(`Result: ${event.result?.actionType || "action"} -> ${event.result?.status || "unknown"}`);
      break;
    case "done":
      setStatus(event.message || "Run complete.");
      appendLog(event.message || "Run complete.");
      clearActiveRun();
      break;
    case "error":
      setStatus(event.message || "Run failed.");
      appendLog(event.message || "Run failed.");
      clearActiveRun();
      break;
    default:
      appendLog(`Event: ${event.type}`);
      break;
  }
}

function clearActiveRun() {
  activeRunId = null;
  setRunning(false);
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function setRunning(isRunning) {
  runButton.disabled = isRunning;
  stopButton.disabled = !isRunning;
  apiKeyInput.disabled = isRunning;
  startUrlInput.disabled = isRunning;
  promptInput.disabled = isRunning;
}

function setStatus(text) {
  statusNode.textContent = text;
}

function appendLog(message) {
  const row = document.createElement("div");
  row.className = "log-entry";
  const now = new Date().toLocaleTimeString();
  row.innerHTML = `<span class="log-time">${now}</span><span>${escapeHtml(message)}</span>`;
  logNode.prepend(row);
}

function escapeHtml(raw) {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function bindInputPersistence() {
  apiKeyInput.addEventListener("input", persistInputsToStorage);
  startUrlInput.addEventListener("input", persistInputsToStorage);
  promptInput.addEventListener("input", persistInputsToStorage);
}

function hydrateInputsFromStorage() {
  apiKeyInput.value = readStorage(STORAGE_KEYS.geminiApiKey);
  startUrlInput.value = readStorage(STORAGE_KEYS.startUrl);
  promptInput.value = readStorage(STORAGE_KEYS.prompt);
}

function persistInputsToStorage() {
  writeStorage(STORAGE_KEYS.geminiApiKey, apiKeyInput.value);
  writeStorage(STORAGE_KEYS.startUrl, startUrlInput.value);
  writeStorage(STORAGE_KEYS.prompt, promptInput.value);
}

function readStorage(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value ?? "");
  } catch {
    // Ignore storage failures (privacy mode, quota, policy).
  }
}
