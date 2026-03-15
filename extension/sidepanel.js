const promptField = document.getElementById("prompt");
const statusField = document.getElementById("status");
const logList = document.getElementById("logList");
const runButton = document.getElementById("runButton");
const stopButton = document.getElementById("stopButton");

runButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "panel:run",
    prompt: promptField.value
  });

  if (!response?.ok) {
    renderError(response?.error || "Unable to start the run.");
  }
});

stopButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "panel:stop" });
  if (!response?.ok) {
    renderError(response?.error || "Unable to stop the run.");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "state:update") {
    renderState(message.state);
  }
});

initialize();

async function initialize() {
  const state = await chrome.runtime.sendMessage({ type: "panel:get-state" });
  renderState(state);
}

function renderState(state) {
  statusField.textContent = prettifyStatus(state.status);
  runButton.disabled = !state.canRun;
  stopButton.disabled = !state.canStop;

  if (!promptField.value && state.prompt) {
    promptField.value = state.prompt;
  }

  logList.replaceChildren(
    ...(state.logs?.length
      ? state.logs
          .slice()
          .reverse()
          .map((entry) => {
            const item = document.createElement("li");
            const time = document.createElement("time");
            const message = document.createElement("div");
            time.textContent = new Date(entry.timestamp).toLocaleTimeString();
            message.textContent = entry.message;
            item.append(time, message);
            return item;
          })
      : [emptyLogNode()])
  );
}

function emptyLogNode() {
  const item = document.createElement("li");
  item.textContent = "No activity yet.";
  return item;
}

function renderError(message) {
  logList.prepend(createTransientLog(message));
}

function createTransientLog(message) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  item.append(time, document.createTextNode(message));
  return item;
}

function prettifyStatus(status) {
  return `${status || "idle"}`.replace(/_/g, " ").replace(/^\w/, (char) => char.toUpperCase());
}
