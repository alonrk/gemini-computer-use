import { HELPER_ORIGIN, actionNeedsConfirmation, isRestrictedUrl } from "./protocol.js";

const state = {
  sessionId: null,
  tabId: null,
  prompt: "",
  status: "idle",
  logs: [],
  currentAction: null,
  streamAbortController: null
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "panel:get-state") {
    sendResponse(getPublicState());
    return true;
  }

  if (message?.type === "panel:run") {
    startRun(message.prompt)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "panel:stop") {
    stopRun()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function startRun(prompt) {
  if (!prompt?.trim()) {
    throw new Error("Enter a prompt before running.");
  }

  if (state.sessionId) {
    throw new Error("Only one active run is supported at a time.");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab was available.");
  }

  if (isRestrictedUrl(tab.url)) {
    throw new Error("This page cannot be automated.");
  }

  await ensureContentScript(tab.id);

  const payload = {
    tabId: tab.id,
    url: tab.url,
    title: tab.title || "",
    prompt: prompt.trim(),
    viewport: {
      width: 0,
      height: 0
    },
    userAgent: navigator.userAgent
  };

  resetState();
  state.status = "starting";
  state.prompt = prompt.trim();
  state.tabId = tab.id;
  pushLog(`Starting run on ${tab.title || tab.url}`);

  const response = await fetch(`${HELPER_ORIGIN}/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    resetState("error");
    throw new Error("Could not reach the local helper. Start `npm start` first.");
  }

  const data = await response.json();
  state.sessionId = data.sessionId;
  state.status = "running";
  notifyPopup();

  openEventStream(data.eventsUrl);
  await collectAndSendObservation("initial");
}

async function stopRun() {
  if (!state.sessionId) {
    return;
  }

  const sessionId = state.sessionId;
  const controller = state.streamAbortController;
  resetState("stopped");
  controller?.abort();

  await fetch(`${HELPER_ORIGIN}/session/${sessionId}/stop`, {
    method: "POST"
  }).catch(() => {});
}

async function collectAndSendObservation(reason) {
  const tabId = state.tabId;
  const sessionId = state.sessionId;
  if (!tabId || !sessionId) {
    return;
  }

  const observation = await chrome.tabs.sendMessage(tabId, {
    type: "collect-observation",
    reason
  });

  await fetch(`${HELPER_ORIGIN}/session/${sessionId}/observe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      ...observation
    })
  });
}

async function executeAction(action) {
  if (!state.sessionId || !state.tabId) {
    return;
  }

  state.currentAction = action;
  pushLog(`Executing ${action.type}`);

  const tabBefore = await chrome.tabs.get(state.tabId);
  const result = await chrome.tabs.sendMessage(state.tabId, {
    type: "execute-action",
    action
  });
  const tabAfter = await chrome.tabs.get(state.tabId);

  await sendActionResult({
    actionId: action.id,
    actionType: action.type,
    status: result.status,
    details: result.details,
    newUrl: tabBefore.url !== tabAfter.url ? tabAfter.url : undefined
  });

  state.currentAction = null;
  notifyPopup();

  if (state.sessionId) {
    await collectAndSendObservation("post-action");
  }
}

async function sendActionResult(payload) {
  if (!state.sessionId) {
    return;
  }

  await fetch(`${HELPER_ORIGIN}/session/${state.sessionId}/action-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: state.sessionId,
      ...payload
    })
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"]
    });
  }
}

async function openEventStream(eventsUrl) {
  const abortController = new AbortController();
  state.streamAbortController = abortController;

  const response = await fetch(eventsUrl, {
    headers: { Accept: "text/event-stream" },
    signal: abortController.signal
  });

  if (!response.ok || !response.body) {
    throw new Error("Could not subscribe to helper events.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
      if (!line) {
        continue;
      }

      const event = JSON.parse(line.slice(6));
      await handleHelperEvent(event);
    }
  }
}

async function handleHelperEvent(event) {
  if (!state.sessionId) {
    return;
  }

  switch (event.type) {
    case "status":
    case "thought":
    case "action_log":
      pushLog(event.message);
      break;
    case "action_request": {
      const action = event.action;
      pushLog(`Gemini chose: ${action.type}`);
      if (actionNeedsConfirmation(action)) {
        pushLog("Auto-running a risky-looking action because approval prompts are disabled.");
      }
      await executeAction(action);
      break;
    }
    case "done":
      pushLog(event.message || "Run finished.");
      resetState("completed", true);
      break;
    case "error":
      pushLog(event.message || "Run failed.");
      resetState("error", true);
      break;
    default:
      break;
  }
}

function pushLog(message) {
  state.logs = [...state.logs, { id: crypto.randomUUID(), timestamp: new Date().toISOString(), message }].slice(-100);
  notifyPopup();
}

function resetState(status = "idle", preserveLogs = false) {
  state.sessionId = null;
  state.tabId = null;
  state.prompt = "";
  state.status = status;
  state.currentAction = null;
  state.streamAbortController?.abort();
  state.streamAbortController = null;
  if (!preserveLogs) {
    state.logs = [];
  }
  notifyPopup();
}

function getPublicState() {
  return {
    sessionId: state.sessionId,
    prompt: state.prompt,
    status: state.status,
    logs: state.logs,
    canRun: !state.sessionId,
    canStop: Boolean(state.sessionId)
  };
}

function notifyPopup() {
  chrome.runtime.sendMessage({
    type: "state:update",
    state: getPublicState()
  }).catch(() => {});
}
