import {
  ACTION_TYPES,
  HELPER_ORIGIN,
  SESSION_EVENT_TYPES,
  SESSION_PHASES,
  isBlockedAction,
  isRestrictedUrl,
  meaningfulPageChange,
  normalizeUrl
} from "./protocol.js";

const state = {
  sessionId: null,
  tabId: null,
  windowId: null,
  prompt: "",
  status: "idle",
  logs: [],
  streamAbortController: null,
  lastObservation: null,
  pendingNavigationActionId: null,
  runToken: null
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) {
    pushLog("The controlled tab was closed.");
    resetState("stopped", true);
  }
});

async function startRun(prompt) {
  if (!prompt?.trim()) {
    throw new Error("Enter a prompt before running.");
  }

  if (state.sessionId) {
    throw new Error("Only one active run is supported at a time.");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !tab.windowId) {
    throw new Error("No active tab was available.");
  }

  if (isRestrictedUrl(tab.url)) {
    throw new Error("This page cannot be automated.");
  }

  await ensureContentScript(tab.id);

  resetState();
  state.runToken = crypto.randomUUID();
  state.status = SESSION_PHASES.STARTING;
  state.prompt = prompt.trim();
  state.tabId = tab.id;
  state.windowId = tab.windowId;
  pushLog(`Starting run on ${tab.title || tab.url}`);

  const viewport = await collectViewport(tab.id);
  const payload = {
    tabId: tab.id,
    url: tab.url,
    title: tab.title || "",
    prompt: prompt.trim(),
    viewport,
    userAgent: navigator.userAgent
  };

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
  state.status = SESSION_PHASES.READY;
  notifyPanel();

  openEventStream(data.eventsUrl).catch((error) => {
    if (state.sessionId) {
      pushLog(error.message || "Helper stream disconnected.");
      resetState("error", true);
    }
  });

  await collectAndSendObservation("initial", state.runToken);
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

async function collectAndSendObservation(reason, runToken = state.runToken) {
  if (!state.tabId || !state.sessionId || !state.windowId) {
    return null;
  }
  if (!runToken || runToken !== state.runToken) {
    return null;
  }

  const observationId = crypto.randomUUID();
  const observation = await chrome.tabs.sendMessage(state.tabId, {
    type: "collect-observation",
    observationId,
    reason
  });
  const screenshot = await chrome.tabs.captureVisibleTab(state.windowId, { format: "png" });
  const combinedObservation = {
    sessionId: state.sessionId,
    ...observation,
    screenshot
  };

  state.lastObservation = combinedObservation;
  if (runToken !== state.runToken) {
    return null;
  }
  await fetch(`${HELPER_ORIGIN}/session/${state.sessionId}/observe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(combinedObservation)
  });

  return combinedObservation;
}

async function executeAction(action) {
  if (!state.sessionId || !state.tabId) {
    return;
  }
  const runToken = state.runToken;

  state.status = SESSION_PHASES.EXECUTING_ACTION;
  notifyPanel();
  pushLog(`Executing ${action.actionType}`);

  const tabBefore = await chrome.tabs.get(state.tabId);
  if (runToken !== state.runToken) {
    return;
  }
  const result = await chrome.tabs.sendMessage(state.tabId, {
    type: "execute-action",
    action
  });
  if (runToken !== state.runToken) {
    return;
  }

  const actionResult = {
    sessionId: state.sessionId,
    actionId: action.id,
    actionType: action.actionType,
    status: result.status,
    details: result.details,
    newUrl: (await chrome.tabs.get(state.tabId)).url,
    triggeredNavigation: result.status === "navigation"
  };

  await sendActionResult(actionResult);
  if (runToken !== state.runToken) {
    return;
  }

  if (result.status === "navigation") {
    state.pendingNavigationActionId = action.id;
    state.status = SESSION_PHASES.WAITING_FOR_NAVIGATION;
    notifyPanel();
    await waitForNavigationAndObserve(tabBefore.url, runToken);
  } else {
    state.status = SESSION_PHASES.WAITING_FOR_DOM_SETTLE;
    notifyPanel();
    await delay(450);
    await collectAndSendObservation("post-action", runToken);
    state.status = SESSION_PHASES.READY;
    notifyPanel();
  }
}

async function waitForNavigationAndObserve(previousUrl, runToken = state.runToken) {
  if (!state.tabId) {
    return;
  }

  const previousObservation = state.lastObservation;
  await waitForTabComplete(state.tabId);
  if (runToken !== state.runToken) {
    return;
  }
  await ensureContentScript(state.tabId);
  await delay(500);

  let latestObservation = await collectAndSendObservation("post-navigation", runToken);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!latestObservation || !previousObservation) {
      break;
    }

    const urlChanged = normalizeUrl(previousUrl) !== normalizeUrl(latestObservation.url);
    const fingerprintChanged = previousObservation.pageFingerprint !== latestObservation.pageFingerprint;
    if (!urlChanged || fingerprintChanged) {
      break;
    }

    await delay(450);
    latestObservation = await collectAndSendObservation("post-navigation-refresh", runToken);
  }

  if (state.lastObservation && normalizeUrl(previousUrl) === normalizeUrl(state.lastObservation.url)) {
    pushLog("Navigation finished, but the URL did not change.");
  }

  state.pendingNavigationActionId = null;
  state.status = SESSION_PHASES.READY;
  notifyPanel();
}

async function sendActionResult(payload) {
  if (!state.sessionId) {
    return;
  }

  await fetch(`${HELPER_ORIGIN}/session/${state.sessionId}/action-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function collectViewport(tabId) {
  const observation = await chrome.tabs.sendMessage(tabId, {
    type: "collect-observation",
    observationId: crypto.randomUUID(),
    reason: "viewport"
  });

  return observation.viewport;
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
    case SESSION_EVENT_TYPES.STATUS:
    case SESSION_EVENT_TYPES.THOUGHT:
    case SESSION_EVENT_TYPES.ACTION_LOG:
      pushLog(event.message);
      break;
    case SESSION_EVENT_TYPES.PAUSED:
      pushLog(event.message || "Run paused for confirmation.");
      state.status = SESSION_PHASES.PAUSED_FOR_CONFIRMATION;
      notifyPanel();
      break;
    case SESSION_EVENT_TYPES.ACTION_REQUEST:
      pushLog(`Gemini chose: ${event.action.actionType}`);
      if (isBlockedAction(event.action)) {
        pushLog("Blocked a risky action and requesting an alternative step.");
        await sendActionResult({
          sessionId: state.sessionId,
          actionId: event.action.id,
          actionType: event.action.actionType,
          status: "blocked",
          details: "Client policy blocked this action."
        });
        await collectAndSendObservation("blocked-action");
      } else {
        await executeAction(event.action);
      }
      break;
    case SESSION_EVENT_TYPES.DONE:
      pushLog(event.message || "Run finished.");
      resetState("completed", true);
      break;
    case SESSION_EVENT_TYPES.ERROR:
      pushLog(event.message || "Run failed.");
      resetState("error", true);
      break;
    default:
      break;
  }
}

function pushLog(message) {
  state.logs = [...state.logs, { id: crypto.randomUUID(), timestamp: new Date().toISOString(), message }].slice(-150);
  notifyPanel();
}

function resetState(status = "idle", preserveLogs = false) {
  state.sessionId = null;
  state.tabId = null;
  state.windowId = null;
  state.prompt = "";
  state.status = status;
  state.streamAbortController?.abort();
  state.streamAbortController = null;
  state.lastObservation = null;
  state.pendingNavigationActionId = null;
  state.runToken = null;
  if (!preserveLogs) {
    state.logs = [];
  }
  notifyPanel();
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

function notifyPanel() {
  chrome.runtime.sendMessage({
    type: "state:update",
    state: getPublicState()
  }).catch(() => {});
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (!done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        finish();
      }
    }).catch(finish);

    setTimeout(finish, 8000);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
