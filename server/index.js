import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { chooseNextAction } from "./gemini.js";
import { HELPER_ORIGIN, SESSION_EVENT_TYPES } from "../shared/protocol.js";

const sessions = new Map();
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || "127.0.0.1";

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
    const session = {
      id: sessionId,
      prompt: payload.prompt,
      status: "running",
      createdAt: Date.now(),
      meta: payload,
      observations: [],
      history: [],
      eventClients: new Set()
    };
    sessions.set(sessionId, session);

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

    session.observations.push(payload);
    sendEvent(session, {
      type: SESSION_EVENT_TYPES.THOUGHT,
      message: "Gemini is choosing the next browser action."
    });

    const action = await chooseNextAction(session, payload);

    if (action.type === "fail") {
      session.status = "failed";
      sendEvent(session, {
        type: SESSION_EVENT_TYPES.ERROR,
        message: action.rationale
      });
      sendEvent(session, {
        type: SESSION_EVENT_TYPES.DONE,
        message: "Run finished with an error."
      });
    } else if (action.type === "finish") {
      session.status = "completed";
      sendEvent(session, {
        type: SESSION_EVENT_TYPES.DONE,
        message: action.rationale || "Run complete."
      });
    } else {
      sendEvent(session, {
        type: SESSION_EVENT_TYPES.ACTION_REQUEST,
        action: {
          ...action,
          id: action.id || randomUUID()
        }
      });
    }

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

    session.history.push(payload);
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

    session.status = "stopped";
    sendEvent(session, {
      type: SESSION_EVENT_TYPES.DONE,
      message: "Run stopped."
    });

    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "Not found." });
});

server.listen(port, host, () => {
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
