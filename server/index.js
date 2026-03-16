import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import {
  ACTION_RESULT_STATUS,
  ACTION_TYPES,
  HELPER_ORIGIN,
  SESSION_PHASES,
  isRestrictedUrl,
  meaningfulPageChange,
  normalizeUrl
} from "../shared/protocol.js";
import { appendFunctionResponse, chooseNextAction } from "./gemini.js";
import { inferPlannerPhase } from "./agent.js";
import {
  closePlaywrightRunner,
  collectObservation,
  createPlaywrightRunner,
  executePlaywrightAction
} from "./playwright-runtime.js";

const sessions = new Map();
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || "127.0.0.1";
const logsDir = path.join(process.cwd(), "server", "logs");
const webDir = path.join(process.cwd(), "server", "web");
const TERMINAL_PHASES = new Set([SESSION_PHASES.COMPLETED, SESSION_PHASES.FAILED, SESSION_PHASES.STOPPED]);
const MAX_HISTORY = 40;
const MAX_TOTAL_STEPS = 36;
const MAX_SUBGOAL_ATTEMPTS = 3;
const NAVIGATION_CONFIRMATION_ATTEMPTS = 2;
const GOAL_PHASES = Object.freeze({
  ORIENTING: "orienting",
  LOCATING_TARGET: "locating_target",
  PERFORMING_ACTION: "performing_action",
  VERIFYING_OUTCOME: "verifying_outcome",
  FINALIZING: "finalizing"
});
let activeRunId = null;

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, HELPER_ORIGIN);

  if (req.method === "GET" && requestUrl.pathname === "/") {
    return serveStatic(res, path.join(webDir, "index.html"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && requestUrl.pathname === "/app.js") {
    return serveStatic(res, path.join(webDir, "app.js"), "text/javascript; charset=utf-8");
  }

  if (req.method === "GET" && requestUrl.pathname === "/styles.css") {
    return serveStatic(res, path.join(webDir, "styles.css"), "text/css; charset=utf-8");
  }

  if (req.method === "GET" && /^\/runs\/[^/]+\/events$/.test(requestUrl.pathname)) {
    return handleEventStream(req, res, requestUrl.pathname.split("/")[2]);
  }

  if (req.method === "POST" && requestUrl.pathname === "/runs/start") {
    return handleStartRun(req, res);
  }

  if (req.method === "POST" && /^\/runs\/[^/]+\/stop$/.test(requestUrl.pathname)) {
    return handleStopRun(res, requestUrl.pathname.split("/")[2]);
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    return writeJson(res, 200, { ok: true, activeRunId });
  }

  return writeJson(res, 404, { error: "Not found." });
});

server.listen(port, host, async () => {
  await ensureLogsDir();
  console.log(`Local helper listening on ${HELPER_ORIGIN}`);
});

async function handleStartRun(req, res) {
  const payload = await readJsonBody(req, res);
  if (!payload) {
    return;
  }

  const prompt = `${payload.prompt || ""}`.trim();
  const startUrl = `${payload.startUrl || ""}`.trim();
  const geminiApiKey = `${payload.geminiApiKey || ""}`.trim();

  if (!prompt) {
    return writeJson(res, 400, { error: "Prompt is required." });
  }
  if (!startUrl) {
    return writeJson(res, 400, { error: "startUrl is required." });
  }
  if (isRestrictedUrl(startUrl)) {
    return writeJson(res, 400, { error: "Restricted URL cannot be automated." });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(startUrl);
  } catch {
    return writeJson(res, 400, { error: "startUrl must be a valid URL." });
  }

  if (activeRunId && !TERMINAL_PHASES.has(sessions.get(activeRunId)?.status)) {
    return writeJson(res, 409, { error: "Only one active run is supported." });
  }

  const runId = randomUUID();
  await ensureLogsDir();
  const logSequence = await getNextLogSequence();
  const session = {
    id: runId,
    prompt,
    startUrl: parsedUrl.toString(),
    status: SESSION_PHASES.STARTING,
    plannerPhase: "starting",
    createdAt: Date.now(),
    eventClients: new Set(),
    history: [],
    observations: [],
    previousObservation: null,
    lastObservation: null,
    lastModelResponse: null,
    initialUserContent: null,
    lastModelContent: null,
    lastFunctionResponseContent: null,
    repeatedActionCount: 0,
    repeatedNavigationCount: 0,
    oscillationCount: 0,
    urlTrail: [],
    stepCount: 0,
    allowedOrigin: parsedUrl.origin,
    allowedHostname: parsedUrl.hostname,
    promptTokens: extractPromptKeywords(prompt),
    goalState: createInitialGoalState(),
    geminiApiKey: geminiApiKey || null,
    stopRequested: false,
    logFile: path.join(logsDir, `${String(logSequence).padStart(4, "0")}-${runId}.jsonl`)
  };

  sessions.set(runId, session);
  activeRunId = runId;

  await logSessionEvent(session, "session_start", {
    prompt,
    startUrl: session.startUrl,
    allowedOrigin: session.allowedOrigin,
    apiKeySource: geminiApiKey ? "request" : process.env.GEMINI_API_KEY ? "env" : "missing"
  });

  writeJson(res, 200, {
    runId,
    eventsUrl: `${HELPER_ORIGIN}/runs/${runId}/events`
  });

  runSession(session).catch(async (error) => {
    await finalizeSession(session, {
      status: SESSION_PHASES.FAILED,
      reason: `Unhandled runtime error: ${error.message || "unknown"}`,
      category: "transport_error",
      sendType: "error"
    });
  });
}

async function handleStopRun(res, runId) {
  const session = sessions.get(runId);
  if (!session) {
    return writeJson(res, 404, { error: "Unknown run." });
  }

  session.stopRequested = true;
  if (TERMINAL_PHASES.has(session.status)) {
    return writeJson(res, 200, { ok: true, status: session.status });
  }

  sendEvent(session, {
    type: "status",
    message: "Stop requested. Waiting for current action to finish."
  });
  return writeJson(res, 200, { ok: true });
}

async function runSession(session) {
  sendEvent(session, { type: "status", message: "Launching visible Playwright browser..." });
  session.runner = await createPlaywrightRunner({
    startUrl: session.startUrl,
    allowedOrigin: session.allowedOrigin
  });
  sendEvent(session, { type: "status", message: "Browser is ready." });

  let step = 0;
  while (!session.stopRequested) {
    step += 1;
    session.stepCount = step;

    const observation = await collectObservation(session.runner, session.id, step);
    session.previousObservation = session.lastObservation;
    session.lastObservation = observation;
    session.goalState.phase = inferGoalPhase(session, observation);
    session.goalState.subgoalAttempts[session.goalState.phase] = (session.goalState.subgoalAttempts[session.goalState.phase] || 0) + 1;
    session.goalState.attemptBudgetRemaining = Math.max(0, MAX_TOTAL_STEPS - (session.history?.length || 0));
    session.plannerPhase = inferPlannerPhase(session, observation);
    session.status = SESSION_PHASES.READY;
    session.observations.push(observation);
    if (session.observations.length > MAX_HISTORY) {
      session.observations.shift();
    }

    await logSessionEvent(session, "observation", {
      observationId: observation.observationId,
      normalizedUrl: observation.normalizedUrl,
      pageFingerprint: observation.pageFingerprint,
      viewport: observation.viewport,
      screenshotMeta: observation.screenshotMeta,
      goalPhase: session.goalState.phase,
      plannerPhase: session.plannerPhase
    });

    sendEvent(session, {
      type: "thought",
      message: `Gemini is choosing step ${step}.`
    });

    const action = await chooseNextAction(session, observation);
    if (session.lastGeminiDebug) {
      await logSessionEvent(session, "gemini_debug", session.lastGeminiDebug);
    }
    await logSessionEvent(session, "planner_action", action);

    if (action.actionType === ACTION_TYPES.FAIL) {
      await finalizeSession(session, {
        status: SESSION_PHASES.FAILED,
        reason: action.rationale,
        category: categorizeFailure("planner", action.rationale),
        sendType: "error"
      });
      return;
    }

    if (action.actionType === ACTION_TYPES.FINISH) {
      await finalizeSession(session, {
        status: SESSION_PHASES.COMPLETED,
        reason: action.rationale || "Run completed.",
        category: categorizeFailure("finish", action.rationale),
        sendType: "done"
      });
      return;
    }

    const actionWithId = {
      ...action,
      id: randomUUID(),
      strategyKey: action.strategyKey || buildStrategyKey(action, observation)
    };
    session.pendingAction = actionWithId;
    session.status =
      actionWithId.actionType === ACTION_TYPES.NAVIGATE ? SESSION_PHASES.WAITING_FOR_NAVIGATION : SESSION_PHASES.EXECUTING_ACTION;
    await logSessionEvent(session, "planner_action_dispatched", actionWithId);
    sendEvent(session, {
      type: "action",
      action: actionWithId
    });

    const result = await executePlaywrightAction(session.runner, actionWithId);
    const postActionObservation = await collectConfirmedObservation({
      session,
      step,
      observationBefore: observation,
      action: actionWithId,
      result
    });
    const changedAfterAction = meaningfulPageChange(observation, postActionObservation);
    const progressSignals = computeTaskProgressSignals({
      session,
      observationBefore: observation,
      observationAfter: postActionObservation,
      action: actionWithId,
      result,
      changedAfterAction
    });
    const taskProgressChanged = progressSignals.length > 0;
    const normalizedAfterUrl = normalizeUrl(result.newUrl || session.runner.page.url());
    const isDirectInteraction = new Set([ACTION_TYPES.CLICK_AT, ACTION_TYPES.TYPE_TEXT_AT]).has(actionWithId.actionType);
    const statusWithChangeCheck =
      isDirectInteraction &&
      result.status === ACTION_RESULT_STATUS.SUCCESS &&
      !result.triggeredNavigation &&
      !changedAfterAction
        ? ACTION_RESULT_STATUS.NO_EFFECT
        : changedAfterAction &&
            !taskProgressChanged &&
            [ACTION_RESULT_STATUS.SUCCESS, ACTION_RESULT_STATUS.CHANGED_DOM].includes(result.status)
          ? ACTION_RESULT_STATUS.LOW_PROGRESS
        : result.status;
    const detailsWithChangeCheck =
      statusWithChangeCheck === ACTION_RESULT_STATUS.NO_EFFECT
        ? `${result.details} No observable page change after this action.`
        : statusWithChangeCheck === ACTION_RESULT_STATUS.LOW_PROGRESS
          ? `${result.details} Visual change occurred, but no clear task progress signal was detected.`
        : result.details;

    const actionResult = {
      runId: session.id,
      actionId: actionWithId.id,
      actionType: actionWithId.actionType,
      x: actionWithId.x,
      y: actionWithId.y,
      text: actionWithId.text,
      url: actionWithId.url,
      scrollAmount: actionWithId.scrollAmount,
      waitMs: actionWithId.waitMs,
      strategyKey: actionWithId.strategyKey,
      modelFunctionName: actionWithId.modelFunctionName || null,
      safetyDecision: actionWithId.safetyDecision || null,
      status: statusWithChangeCheck,
      details: detailsWithChangeCheck,
      debug: result.debug || null,
      newUrl: result.newUrl || session.runner.page.url(),
      normalizedNewUrl: normalizedAfterUrl,
      triggeredNavigation: Boolean(result.triggeredNavigation),
      postActionChanged: changedAfterAction,
      taskProgressChanged,
      progressSignals,
      pageFingerprint: postActionObservation.pageFingerprint,
      finishGateDecision: session.goalState.lastFinishGateDecision || { decision: "not_evaluated" }
    };
    session.history.push(actionResult);
    if (session.history.length > MAX_HISTORY) {
      session.history.shift();
    }
    session.lastNormalizedUrl = actionResult.normalizedNewUrl;
    session.pendingAction = null;
    session.lastObservation = postActionObservation;
    session.status = actionResult.triggeredNavigation ? SESSION_PHASES.WAITING_FOR_NAVIGATION : SESSION_PHASES.WAITING_FOR_DOM_SETTLE;
    updateGoalStateAfterAction(session, actionResult);
    if (actionResult.modelFunctionName) {
      appendFunctionResponse(session, actionResult, postActionObservation);
    } else {
      session.lastModelContent = null;
      session.lastFunctionResponseContent = null;
    }

    await logSessionEvent(session, "action_result", actionResult);
    sendEvent(session, {
      type: "action_result",
      result: actionResult
    });
  }

  await finalizeSession(session, {
    status: SESSION_PHASES.STOPPED,
    reason: "Run stopped by user.",
    category: "stopped",
    sendType: "done"
  });
}

async function finalizeSession(session, { status, reason, category, sendType }) {
  if (TERMINAL_PHASES.has(session.status)) {
    return;
  }

  session.status = status;
  const summary = {
    status,
    reason,
    plannerPhase: session.plannerPhase,
    failureCategory: category,
    terminationCategory: category,
    goalPhase: session.goalState?.phase,
    verificationSignals: session.goalState?.verificationSignals || [],
    counters: currentCounters(session)
  };

  await logSessionEvent(session, "session_end", summary);
  await logSessionEvent(session, "diagnostic_summary", summary);

  sendEvent(session, {
    type: sendType,
    message: reason
  });

  await closePlaywrightRunner(session.runner);
  session.runner = null;
  if (activeRunId === session.id) {
    activeRunId = null;
  }
}

async function collectConfirmedObservation({ session, step, observationBefore, action, result }) {
  let observationAfter = await collectObservation(session.runner, session.id, step);

  if (!shouldConfirmNavigation(action, result)) {
    return observationAfter;
  }

  let attempt = 0;
  while (attempt < NAVIGATION_CONFIRMATION_ATTEMPTS) {
    if (isConfirmedNewPage(observationBefore, observationAfter)) {
      return observationAfter;
    }

    attempt += 1;
    session.status = SESSION_PHASES.WAITING_FOR_NAVIGATION;
    await logSessionEvent(session, "navigation_confirmation_wait", {
      attempt,
      reason: "Post-navigation observation not yet coherent; waiting for a fresher page state.",
      beforeUrl: observationBefore?.normalizedUrl || observationBefore?.url || "",
      currentUrl: observationAfter?.normalizedUrl || observationAfter?.url || "",
      beforeFingerprint: observationBefore?.pageFingerprint || "",
      currentFingerprint: observationAfter?.pageFingerprint || ""
    });

    await wait(900);
    observationAfter = await collectObservation(session.runner, session.id, step);
  }

  return observationAfter;
}

function shouldConfirmNavigation(action, result) {
  return Boolean(
    result?.triggeredNavigation ||
      action?.actionType === ACTION_TYPES.NAVIGATE ||
      action?.actionType === ACTION_TYPES.GO_BACK
  );
}

function isConfirmedNewPage(previousObservation, nextObservation) {
  const beforeUrl = normalizeUrl(previousObservation?.normalizedUrl || previousObservation?.url);
  const afterUrl = normalizeUrl(nextObservation?.normalizedUrl || nextObservation?.url);
  if (!beforeUrl || !afterUrl || beforeUrl === afterUrl) {
    return false;
  }

  const titleChanged = `${previousObservation?.title || ""}` !== `${nextObservation?.title || ""}`;
  const fingerprintChanged = meaningfulPageChange(previousObservation, nextObservation);
  const hintCountShift = Math.abs((previousObservation?.interactiveHints?.length || 0) - (nextObservation?.interactiveHints?.length || 0)) >= 3;
  const summaryChanged = `${previousObservation?.pageSummary || ""}` !== `${nextObservation?.pageSummary || ""}`;

  return titleChanged || fingerprintChanged || hintCountShift || summaryChanged;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handleEventStream(req, res, runId) {
  const session = sessions.get(runId);
  if (!session) {
    writeJson(res, 404, { error: "Unknown run." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  res.write(`data: ${JSON.stringify({ type: "status", message: "Connected to run stream." })}\n\n`);
  session.eventClients.add(res);
  req.on("close", () => {
    session.eventClients.delete(res);
  });
}

function sendEvent(session, payload) {
  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of session.eventClients) {
    client.write(serialized);
  }
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

async function readJsonBody(req, res) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    writeJson(res, 400, { error: "Invalid JSON body." });
    return null;
  }
}

async function serveStatic(res, filePath, contentType) {
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  } catch {
    writeJson(res, 404, { error: "Static asset not found." });
  }
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function ensureLogsDir() {
  await fs.mkdir(logsDir, { recursive: true });
}

async function getNextLogSequence() {
  const files = await fs.readdir(logsDir).catch(() => []);
  let max = 0;
  for (const file of files) {
    const match = /^(\d+)-.+\.jsonl$/i.exec(file);
    if (!match) {
      continue;
    }
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }
  return max + 1;
}

async function logSessionEvent(session, type, payload) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    runId: session.id,
    type,
    phase: session.status,
    plannerPhase: session.plannerPhase,
    payload
  });
  await fs.appendFile(session.logFile, `${entry}\n`, "utf8");
}

function currentCounters(session) {
  return {
    repeatedActionCount: session.repeatedActionCount || 0,
    repeatedNavigationCount: session.repeatedNavigationCount || 0,
    oscillationCount: session.oscillationCount || 0,
    staleCoordinateRecoveryCount: session.staleCoordinateRecoveryCount || 0,
    loopRecoveryAttempts: session.loopRecoveryAttempts || 0,
    strategySwitchCount: session.goalState?.strategySwitchCount || 0,
    noProgressStreak: session.goalState?.noProgressStreak || 0,
    emptyModelTurnStreak: session.goalState?.emptyModelTurnStreak || 0
  };
}

function categorizeFailure(kind, reason = "") {
  if (kind === "finish" && /did not request any more browser actions/i.test(reason)) {
    return "model_no_action";
  }
  const lower = `${reason}`.toLowerCase();
  if (lower.includes("model blocked") || lower.includes("promptfeedback")) {
    return "model_blocked";
  }
  if (lower.includes("persistence budget exhausted")) {
    return "persistence_exhausted";
  }
  if (lower.includes("loop")) {
    return "loop";
  }
  if (lower.includes("blocked")) {
    return "blocked";
  }
  if (lower.includes("stale")) {
    return "stale";
  }
  if (kind === "finish") {
    return "completed_with_evidence";
  }
  return "transport_error";
}

function createInitialGoalState() {
  return {
    phase: GOAL_PHASES.ORIENTING,
    attemptBudgetRemaining: MAX_TOTAL_STEPS,
    subgoalAttempts: {
      [GOAL_PHASES.ORIENTING]: 0,
      [GOAL_PHASES.LOCATING_TARGET]: 0,
      [GOAL_PHASES.PERFORMING_ACTION]: 0,
      [GOAL_PHASES.VERIFYING_OUTCOME]: 0,
      [GOAL_PHASES.FINALIZING]: 0
    },
    noProgressStreak: 0,
    emptyModelTurnStreak: 0,
    modelBlockedTurnStreak: 0,
    recentStrategyKeys: [],
    verificationSignals: [],
    strategySwitchCount: 0,
    lastFinishGateDecision: { decision: "not_evaluated" }
  };
}

function inferGoalPhase(session, observation) {
  const history = session.history || [];
  const last = history.at(-1);
  const noProgress = session.goalState?.noProgressStreak || 0;

  if (!history.length) {
    return GOAL_PHASES.ORIENTING;
  }
  if (session.goalState?.verificationSignals?.length && history.length >= 4) {
    return GOAL_PHASES.FINALIZING;
  }
  if (!last?.taskProgressChanged && noProgress >= 2) {
    return GOAL_PHASES.LOCATING_TARGET;
  }
  if ([ACTION_TYPES.CLICK_AT, ACTION_TYPES.TYPE_TEXT_AT].includes(last?.actionType)) {
    return last.taskProgressChanged ? GOAL_PHASES.VERIFYING_OUTCOME : GOAL_PHASES.PERFORMING_ACTION;
  }
  if (last?.actionType === ACTION_TYPES.NAVIGATE) {
    return GOAL_PHASES.LOCATING_TARGET;
  }

  return GOAL_PHASES.VERIFYING_OUTCOME;
}

function updateGoalStateAfterAction(session, actionResult) {
  if (!session.goalState) {
    return;
  }

  session.goalState.attemptBudgetRemaining = Math.max(0, session.goalState.attemptBudgetRemaining - 1);
  session.goalState.verificationSignals = actionResult.progressSignals || [];
  session.goalState.lastFinishGateDecision = { decision: "not_evaluated" };

  if (actionResult.taskProgressChanged) {
    session.goalState.noProgressStreak = 0;
    session.goalState.emptyModelTurnStreak = 0;
    const phase = session.goalState.phase;
    if (phase) {
      session.goalState.subgoalAttempts[phase] = 0;
    }
  } else {
    session.goalState.noProgressStreak = (session.goalState.noProgressStreak || 0) + 1;
  }

  const lastStrategy = session.goalState.recentStrategyKeys.at(-1)?.strategyKey;
  if (lastStrategy && actionResult.strategyKey && lastStrategy !== actionResult.strategyKey) {
    session.goalState.strategySwitchCount = (session.goalState.strategySwitchCount || 0) + 1;
  }

  if (actionResult.strategyKey) {
    session.goalState.recentStrategyKeys = [
      ...(session.goalState.recentStrategyKeys || []),
      {
        strategyKey: actionResult.strategyKey,
        outcome: actionResult.status,
        pageFingerprint: actionResult.pageFingerprint || "",
        taskProgressChanged: Boolean(actionResult.taskProgressChanged)
      }
    ].slice(-8);
  }
}

function buildStrategyKey(action, observation) {
  const zone = zoneBucket(action, observation);
  const targetClass = inferTargetClass(action);
  return `${action?.actionType || "unknown"}:${zone}:${targetClass}`;
}

function zoneBucket(action, observation) {
  const x = Number(action?.x);
  const y = Number(action?.y);
  const width = Number(observation?.viewport?.width || 0);
  const height = Number(observation?.viewport?.height || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) {
    return "na";
  }

  const h = x < width / 3 ? "left" : x < (2 * width) / 3 ? "center" : "right";
  const v = y < height / 3 ? "top" : y < (2 * height) / 3 ? "mid" : "bottom";
  return `${v}-${h}`;
}

function inferTargetClass(action) {
  if (action?.actionType === ACTION_TYPES.TYPE_TEXT_AT) {
    return "text_entry";
  }
  if (action?.actionType === ACTION_TYPES.NAVIGATE) {
    return "navigation";
  }
  if (action?.actionType === ACTION_TYPES.CLICK_AT) {
    return "pointer";
  }
  if (action?.actionType === ACTION_TYPES.SCROLL) {
    return "viewport_shift";
  }
  if (action?.actionType === ACTION_TYPES.WAIT) {
    return "timing";
  }
  return "generic";
}

function computeTaskProgressSignals({ session, observationBefore, observationAfter, action, result, changedAfterAction }) {
  const signals = new Set();
  const beforeUrl = normalizeUrl(observationBefore?.normalizedUrl || observationBefore?.url);
  const afterUrl = normalizeUrl(observationAfter?.normalizedUrl || observationAfter?.url);

  if (beforeUrl !== afterUrl) {
    signals.add("url_changed");
    if (includesPromptKeywordInUrl(afterUrl, beforeUrl, session.promptTokens || [])) {
      signals.add("url_matches_prompt_token");
    }
  }

  const beforeModal = Boolean(observationBefore?.uiSignals?.modalVisible);
  const afterModal = Boolean(observationAfter?.uiSignals?.modalVisible);
  if (beforeModal !== afterModal) {
    signals.add("modal_state_changed");
  }

  const beforeForms = Number(observationBefore?.uiSignals?.formCount || 0);
  const afterForms = Number(observationAfter?.uiSignals?.formCount || 0);
  if (beforeForms !== afterForms) {
    signals.add("form_count_changed");
  }

  const beforeHints = observationBefore?.interactiveHints?.length || 0;
  const afterHints = observationAfter?.interactiveHints?.length || 0;
  if (afterHints > beforeHints + 3) {
    signals.add("new_interactive_controls_visible");
  }

  if (result?.triggeredNavigation) {
    signals.add("navigation_completed");
  }

  if (action?.actionType === ACTION_TYPES.TYPE_TEXT_AT && changedAfterAction) {
    signals.add("input_applied");
  }

  if (detectVerificationText(observationAfter?.pageSummary || "")) {
    signals.add("confirmation_text_detected");
  }

  if (!changedAfterAction) {
    signals.delete("new_interactive_controls_visible");
    signals.delete("confirmation_text_detected");
    signals.delete("input_applied");
  }

  return [...signals];
}

function includesPromptKeywordInUrl(afterUrl, beforeUrl, promptTokens) {
  const after = `${afterUrl || ""}`.toLowerCase();
  const before = `${beforeUrl || ""}`.toLowerCase();
  for (const token of promptTokens || []) {
    if (token.length < 4) {
      continue;
    }
    if (after.includes(token) && !before.includes(token)) {
      return true;
    }
  }
  return false;
}

function detectVerificationText(summary) {
  return /\b(success|added|complete|completed|saved|thank you|checkout|results|confirmed)\b/i.test(`${summary || ""}`);
}

function extractPromptKeywords(prompt) {
  const stopwords = new Set(["with", "from", "that", "this", "want", "into", "about", "only", "site", "current", "tab", "page", "then", "until", "have", "will", "your", "what", "where", "when"]);
  return `${prompt || ""}`
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length >= 4 && !stopwords.has(value))
    .slice(0, 24);
}
