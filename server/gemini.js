import {
  ACTION_TYPES,
  isBlockedAction,
  isSameOrigin,
  normalizeUrl,
  truncateText
} from "../shared/protocol.js";
import {
  buildLoopRecoveryAction,
  buildFallbackAction,
  detectLoop,
  extractFunctionCalls,
  extractTextParts,
  normalizeModelAction
} from "./agent.js";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-computer-use-preview-10-2025";
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_MODEL_SELECTION_RETRIES = 1;

export async function chooseNextAction(session, observation) {
  const loopError = detectLoop(session, observation);
  if (loopError) {
    if ((session.loopRecoveryAttempts || 0) < 2) {
      const recoveryAction = buildLoopRecoveryAction(session, observation);
      if (recoveryAction) {
        session.loopRecoveryAttempts = (session.loopRecoveryAttempts || 0) + 1;
        session.lastGeminiDebug = {
          request: null,
          responseStatus: null,
          responseBody: null,
          retryUsed: false,
          responseParsed: true,
          assistantText: "",
          functionCalls: [],
          loopRecovery: {
            attempt: session.loopRecoveryAttempts,
            reason: loopError,
            action: recoveryAction
          }
        };
        return recoveryAction;
      }
    }

    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: loopError
    };
  }
  session.loopRecoveryAttempts = 0;

  if (!process.env.GEMINI_API_KEY) {
    return buildFallbackAction(session, observation);
  }

  const primaryRequest = buildRequestBody(session, observation, { includeExcludedFunctions: false });
  let requestBody = primaryRequest;
  let response;
  let responseText = "";
  try {
    response = await fetchGeminiWithRetry(requestBody);
    responseText = await response.text();
  } catch (error) {
    session.transientErrorCount = (session.transientErrorCount || 0) + 1;
    if (session.transientErrorCount <= 2) {
      return {
        actionType: ACTION_TYPES.WAIT,
        rationale: "Gemini network error; waiting briefly before retrying.",
        waitMs: 1500
      };
    }
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: `Gemini request error: ${error.message || "unknown transport failure"}`
    };
  }

  session.lastGeminiDebug = {
    request: redactRequestForLogs(requestBody),
    responseStatus: response.status,
    responseBody: truncateText(responseText, 5000),
    retryUsed: false
  };

  if (!response.ok) {
    if (isTransientGeminiStatus(response.status)) {
      session.transientErrorCount = (session.transientErrorCount || 0) + 1;
      if (session.transientErrorCount <= 2) {
        return {
          actionType: ACTION_TYPES.WAIT,
          rationale: `Gemini returned transient ${response.status}; waiting briefly before retrying.`,
          waitMs: 1500
        };
      }
    }

    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: `Gemini request failed with ${response.status}: ${responseText.slice(0, 200)}`
    };
  }
  session.transientErrorCount = 0;

  const payload = safeParseJson(responseText, {});
  const functionCalls = extractFunctionCalls(payload);
  const textResponse = extractTextParts(payload?.candidates?.[0]?.content);

  session.lastModelResponse = payload?.candidates?.[0]?.content || null;
  session.lastGeminiDebug = {
    ...session.lastGeminiDebug,
    responseParsed: true,
    assistantText: truncateText(textResponse, 2000),
    functionCalls
  };

  if (!functionCalls.length) {
    return {
      actionType: ACTION_TYPES.FINISH,
      rationale: textResponse || "Gemini did not request any more browser actions."
    };
  }

  let action = normalizeModelAction(functionCalls[0], session, observation);
  action = enforcePolicy(action, session, observation);
  if (!shouldRetryActionSelection(action)) {
    return action;
  }

  const invalidReason = action.rationale;
  for (let attempt = 1; attempt <= MAX_MODEL_SELECTION_RETRIES; attempt += 1) {
    const retryRequest = buildRequestBody(session, observation, {
      includeExcludedFunctions: false,
      feedbackMessage: buildRetryFeedback(functionCalls[0]?.name, invalidReason)
    });
    let retryResponse;
    let retryText = "";
    try {
      retryResponse = await fetchGeminiWithRetry(retryRequest);
      retryText = await retryResponse.text();
    } catch (error) {
      break;
    }

    const retryPayload = safeParseJson(retryText, {});
    const retryCalls = extractFunctionCalls(retryPayload);
    const retryMessage = extractTextParts(retryPayload?.candidates?.[0]?.content);
    session.lastGeminiDebug = {
      ...session.lastGeminiDebug,
      selectionRetry: {
        attempt,
        reason: invalidReason,
        request: redactRequestForLogs(retryRequest),
        responseStatus: retryResponse.status,
        responseBody: truncateText(retryText, 5000),
        functionCalls: retryCalls,
        assistantText: truncateText(retryMessage, 2000)
      }
    };

    if (!retryResponse.ok || !retryCalls.length) {
      continue;
    }

    let retryAction = normalizeModelAction(retryCalls[0], session, observation);
    retryAction = enforcePolicy(retryAction, session, observation);
    if (!shouldRetryActionSelection(retryAction)) {
      return retryAction;
    }
  }

  return action;
}

function buildRequestBody(session, observation, options = {}) {
  const includeExcludedFunctions = options.includeExcludedFunctions !== false;
  const feedbackMessage = options.feedbackMessage;
  const screenshotPart = buildScreenshotPart(observation.screenshot);
  const priorSteps = (session.history || []).slice(-8).map((entry, index) => ({
    step: index + 1,
    actionType: entry.actionType,
    status: entry.status,
    details: truncateText(entry.details || "", 180),
    newUrl: entry.newUrl || null
  }));

  return {
    systemInstruction: {
      parts: [{ text: buildSystemInstruction(session) }]
    },
    tools: [
      {
        computerUse: includeExcludedFunctions
          ? {
              environment: "ENVIRONMENT_BROWSER",
              excludedPredefinedFunctions: configuredExcludedFunctions()
            }
          : {
              environment: "ENVIRONMENT_BROWSER"
            }
      },
      {
        functionDeclarations: [
          {
            name: "navigate_current_tab",
            description: "Navigate the current tab to another page on the same site.",
            parameters: {
              type: "OBJECT",
              properties: {
                url: { type: "STRING" },
                rationale: { type: "STRING" }
              },
              required: ["url"]
            }
          },
          {
            name: "finish_run",
            description: "Finish when the user request is complete or no further useful in-scope actions remain.",
            parameters: {
              type: "OBJECT",
              properties: {
                summary: { type: "STRING" }
              },
              required: ["summary"]
            }
          },
          {
            name: "fail_run",
            description: "Fail when the task cannot be completed safely or within the current site.",
            parameters: {
              type: "OBJECT",
              properties: {
                reason: { type: "STRING" }
              },
              required: ["reason"]
            }
          }
        ]
      }
    ],
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              `User prompt: ${session.prompt}`,
              `Current URL: ${observation.url}`,
              `Normalized URL: ${observation.normalizedUrl}`,
              `Page title: ${observation.title}`,
              `Page fingerprint: ${observation.pageFingerprint}`,
              `Viewport: ${JSON.stringify(observation.viewport)}`,
              `Page summary: ${observation.pageSummary}`,
              `Interactive hints: ${JSON.stringify(observation.interactiveHints || [])}`,
              `UI signals: ${JSON.stringify(observation.uiSignals || {})}`,
              `Previous steps: ${JSON.stringify(priorSteps)}`,
              feedbackMessage ? `Selection feedback: ${feedbackMessage}` : ""
            ].join("\n")
          },
          ...(screenshotPart ? [screenshotPart] : [])
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1
    }
  };
}

async function fetchGemini(requestBody) {
  return fetch(`${API_ROOT}/${DEFAULT_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY
    },
    body: JSON.stringify(requestBody)
  });
}

async function fetchGeminiWithRetry(requestBody) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastResponse = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await fetchGemini(requestBody);
      if (!isTransientGeminiStatus(response.status) || attempt >= maxAttempts) {
        return response;
      }
      lastResponse = response;
    } catch {
      if (attempt >= maxAttempts) {
        throw new Error("Gemini request failed after retries.");
      }
    }

    await delay(250 * attempt);
  }

  return lastResponse;
}

function configuredExcludedFunctions() {
  const defaults = [];

  const raw = process.env.GEMINI_EXCLUDED_FUNCTIONS;
  if (!raw) {
    return defaults;
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function redactRequestForLogs(requestBody) {
  const clone = structuredClone(requestBody);
  for (const content of clone.contents || []) {
    for (const part of content.parts || []) {
      if (part.inlineData?.data) {
        const byteLength = part.inlineData.data.length;
        part.inlineData.data = `[omitted base64 screenshot, length=${byteLength}]`;
      }
    }
  }
  return clone;
}

function safeParseJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function isTransientGeminiStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSystemInstruction(session) {
  return [
    "You are Gemini Computer Use controlling the user's current browser tab through an extension bridge.",
    "Your goal is to do your best to fulfill the user prompt on the selected site by choosing concrete browser actions.",
    "Every action you request happens on the real current tab only. You do not own another browser instance.",
    "Allowed actions are: click_at, type_text_at, scroll_document, wait_5_seconds, go_back, navigate_current_tab, finish_run, fail_run.",
    "Do not call open_web_browser, search, open_tab, close_tab, go_forward, drag_and_drop, download_file, or press_key.",
    "Use only visible page evidence and tool feedback. Do not assume a specific site type or workflow.",
    "After each action, verify state change using URL/title/content and tool result.",
    "If an action fails or state does not change, choose a different strategy.",
    "Avoid repeating the same action and coordinates without new evidence.",
    "For multi-step tasks, proceed one step at a time and reassess after every result.",
    `Stay on this exact site only: origin ${session.allowedOrigin}, hostname ${session.allowedHostname}.`,
    "Never ask to open a new browser, a new tab, browser settings, downloads, or an external site.",
    "Do not interact with password fields, card fields, or irreversible financial confirmation actions unless explicitly approved by policy.",
    "Task success means best-effort completion of the user request within this tab/site, then call finish_run with a short summary.",
    "If blocked after trying multiple distinct strategies, call fail_run with a concise blocker reason.",
    "Keep rationale short and concrete."
  ].join("\n");
}

function buildScreenshotPart(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    return null;
  }

  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    inlineData: {
      mimeType: match[1],
      data: match[2]
    }
  };
}

function enforcePolicy(action, session, observation) {
  if (action.actionType === ACTION_TYPES.NAVIGATE) {
    const normalizedTarget = normalizeUrl(action.url);
    if (!isSameOrigin(normalizedTarget, session.allowedOrigin)) {
      return {
        actionType: ACTION_TYPES.FAIL,
        rationale: `Blocked cross-site navigation to ${truncateText(normalizedTarget, 120)}.`
      };
    }

    if (normalizedTarget === normalizeUrl(observation.normalizedUrl || observation.url)) {
      return {
        actionType: ACTION_TYPES.FAIL,
        rationale: "Invalid action: navigation to the same page would create a loop."
      };
    }
  }

  if (getSafetyDecision(action.safetyDecision) === "require_confirmation") {
    return {
      ...action,
      actionType: ACTION_TYPES.FAIL,
      rationale: "Invalid action: Gemini marked the next action as requiring confirmation."
    };
  }

  if (isBlockedAction(action)) {
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: "Invalid action: blocked risky action involving account access, downloads, or final payment."
    };
  }

  return action;
}

function getSafetyDecision(safetyDecision) {
  if (!safetyDecision) {
    return null;
  }
  if (typeof safetyDecision === "string") {
    return safetyDecision;
  }
  if (typeof safetyDecision === "object") {
    return safetyDecision.decision || safetyDecision.value || null;
  }
  return null;
}

function shouldRetryActionSelection(action) {
  if (!action || action.actionType !== ACTION_TYPES.FAIL) {
    return false;
  }

  return /unsupported action|out of scope|invalid action|cross-site navigation/i.test(action.rationale || "");
}

function buildRetryFeedback(functionName, reason) {
  const fallbackName = functionName || "unknown_action";
  return [
    `Your previous action (${fallbackName}) was rejected.`,
    `Reason: ${reason}`,
    "Choose one valid allowed action only, grounded in visible page elements, and avoid repeating prior target coordinates."
  ].join(" ");
}
