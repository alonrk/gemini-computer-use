import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import {
  ACTION_TYPES,
  HELPER_ORIGIN,
  SESSION_EVENT_TYPES,
  SESSION_PHASES,
  normalizeUrl
} from "../shared/protocol.js";
import { chooseNextAction } from "./gemini.js";
import { inferPlannerPhase } from "./agent.js";

const sessions = new Map();
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || "127.0.0.1";
const logsDir = path.join(process.cwd(), "server", "logs");
const TERMINAL_PHASES = new Set([SESSION_PHASES.COMPLETED, SESSION_PHASES.FAILED, SESSION_PHASES.STOPPED]);

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, HELPER_ORIGIN);

  if (req.method === "GET" && /^\/session\/[^/]+\/events$/.test(requestUrl.pathname)) {
    handleEventStream(req, res, requestUrl.pathname.split("/")[2]);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/session/start") {
    const payload = await readJsonBody(req, res);
    if (!payload) {
      return;
    }

    const sessionId = randomUUID();
    const allowedOrigin = new URL(payload.url).origin;
    const session = {
      id: sessionId,
      prompt: payload.prompt,
      status: SESSION_PHASES.STARTING,
      createdAt: Date.now(),
      meta: payload,
      observations: [],
      history: [],
      eventClients: new Set(),
      allowedOrigin,
      allowedHostname: new URL(payload.url).hostname,
      lastObservation: null,
      previousObservation: null,
      lastModelResponse: null,
      repeatedActionCount: 0,
      repeatedNavigationCount: 0,
      oscillationCount: 0,
      plannerPhase: "starting",
      urlTrail: [],
      logFile: path.join(logsDir, `${sessionId}.jsonl`)
    };
    sessions.set(sessionId, session);
    await ensureLogsDir();
    await logSessionEvent(session, "session_start", {
      prompt: payload.prompt,
      url: payload.url,
      title: payload.title
    });

    sendEvent(session, {
      type: SESSION_EVENT_TYPES.STATUS,
      message: "Session started."
    });

    writeJson(res, 200, {
      sessionId,
      eventsUrl: `${HELPER_ORIGIN}/session/${sessionId}/events`
    });
    return;
  }

  if (req.method === "POST" && /^\/session\/[^/]+\/observe$/.test(requestUrl.pathname)) {
    const sessionId = requestUrl.pathname.split("/")[2];
    const session = sessions.get(sessionId);
    if (!session) {
      writeJson(res, 404, { error: "Unknown session." });
      return;
    }

    const payload = await readJsonBody(req, res);
    if (!payload) {
      return;
    }
    if (TERMINAL_PHASES.has(session.status)) {
      await logSessionEvent(session, "observation_ignored_terminal", {
        observationId: payload.observationId,
        status: session.status
      });
      return writeJson(res, 200, { ok: true });
    }

    if (payload.observationId && payload.observationId === session.lastObservationId) {
      await logSessionEvent(session, "stale_observation_ignored", {
        observationId: payload.observationId,
        normalizedUrl: payload.normalizedUrl
      });
      return writeJson(res, 200, { ok: true });
    }

    session.previousObservation = session.lastObservation;
    session.lastObservation = payload;
    session.lastObservationId = payload.observationId || null;
    session.plannerPhase = inferPlannerPhase(session, payload);
    session.observations.push(payload);
    if (session.observations.length > 40) {
      session.observations.shift();
    }
    session.status = SESSION_PHASES.READY;

    await logSessionEvent(session, "observation", {
      observationId: payload.observationId,
      normalizedUrl: payload.normalizedUrl,
      pageFingerprint: payload.pageFingerprint,
      plannerPhase: session.plannerPhase
    });

    sendEvent(session, {
      type: SESSION_EVENT_TYPES.THOUGHT,
      message: "Gemini is reviewing the current tab."
    });

    const action = await chooseNextAction(session, payload);
    if (session.lastGeminiDebug) {
      await logSessionEvent(session, "gemini_debug", session.lastGeminiDebug);
    }
    await logSessionEvent(session, "planner_action", action);

    if (action.actionType === ACTION_TYPES.FAIL) {
      session.status = SESSION_PHASES.FAILED;
      const summary = {
        status: session.status,
        reason: action.rationale,
        plannerPhase: session.plannerPhase,
        counters: currentCounters(session)
      };
      await logSessionEvent(session, "session_end", summary);
      await logSessionEvent(session, "diagnostic_summary", summary);
      sendEvent(session, {
        type: SESSION_EVENT_TYPES.ERROR,
        message: action.rationale
      });
      return writeJson(res, 200, { ok: true });
    }

    if (action.actionType === ACTION_TYPES.FINISH) {
      session.status = SESSION_PHASES.COMPLETED;
      const summary = {
        status: session.status,
        reason: action.rationale,
        plannerPhase: session.plannerPhase,
        counters: currentCounters(session)
      };
      await logSessionEvent(session, "session_end", summary);
      await logSessionEvent(session, "diagnostic_summary", summary);
      sendEvent(session, {
        type: SESSION_EVENT_TYPES.DONE,
        message: action.rationale || "Run complete."
      });
      return writeJson(res, 200, { ok: true });
    }

    const actionWithId = {
      ...action,
      id: randomUUID()
    };
    await logSessionEvent(session, "planner_action_dispatched", actionWithId);
    session.status = actionWithId.actionType === ACTION_TYPES.NAVIGATE ? SESSION_PHASES.WAITING_FOR_NAVIGATION : SESSION_PHASES.EXECUTING_ACTION;
    session.pendingAction = actionWithId;

    sendEvent(session, {
      type: SESSION_EVENT_TYPES.ACTION_REQUEST,
      action: actionWithId
    });

    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && /^\/session\/[^/]+\/action-result$/.test(requestUrl.pathname)) {
    const sessionId = requestUrl.pathname.split("/")[2];
    const session = sessions.get(sessionId);
    if (!session) {
      writeJson(res, 404, { error: "Unknown session." });
      return;
    }

    const payload = await readJsonBody(req, res);
    if (!payload) {
      return;
    }
    if (TERMINAL_PHASES.has(session.status)) {
      await logSessionEvent(session, "action_result_ignored_terminal", {
        actionId: payload.actionId,
        status: session.status
      });
      return writeJson(res, 200, { ok: true });
    }

    if (session.pendingAction?.id && payload.actionId && session.pendingAction.id !== payload.actionId) {
      await logSessionEvent(session, "action_result_mismatch", {
        expectedActionId: session.pendingAction.id,
        receivedActionId: payload.actionId
      });
    }

    session.history.push(payload);
    if (session.history.length > 40) {
      session.history.shift();
    }

    session.lastNormalizedUrl = normalizeUrl(payload.normalizedNewUrl || payload.newUrl || session.lastObservation?.normalizedUrl || session.lastObservation?.url);
    session.status = payload.triggeredNavigation ? SESSION_PHASES.WAITING_FOR_NAVIGATION : SESSION_PHASES.WAITING_FOR_DOM_SETTLE;

    await logSessionEvent(session, "action_result", payload);
    session.pendingAction = null;
    sendEvent(session, {
      type: SESSION_EVENT_TYPES.ACTION_LOG,
      message: `${payload.actionType}: ${payload.status}`
    });

    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && /^\/session\/[^/]+\/stop$/.test(requestUrl.pathname)) {
    const sessionId = requestUrl.pathname.split("/")[2];
    const session = sessions.get(sessionId);
    if (!session) {
      writeJson(res, 404, { error: "Unknown session." });
      return;
    }

    session.status = SESSION_PHASES.STOPPED;
    const summary = {
      status: session.status,
      reason: "Run stopped by the user."
    };
    await logSessionEvent(session, "session_end", summary);
    await logSessionEvent(session, "diagnostic_summary", summary);
    sendEvent(session, {
      type: SESSION_EVENT_TYPES.DONE,
      message: "Run stopped."
    });

    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "Not found." });
});

server.listen(port, host, async () => {
  await ensureLogsDir();
  console.log(`Local helper listening on ${HELPER_ORIGIN}`);
});

function handleEventStream(req, res, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    writeJson(res, 404, { error: "Unknown session." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  res.write(`data: ${JSON.stringify({ type: SESSION_EVENT_TYPES.STATUS, message: "Connected to helper stream." })}\n\n`);
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

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function ensureLogsDir() {
  await fs.mkdir(logsDir, { recursive: true });
}

async function logSessionEvent(session, type, payload) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionId: session.id,
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
    oscillationCount: session.oscillationCount || 0
  };
}
