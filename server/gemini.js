import {
  ACTION_RESULT_STATUS,
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

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_MODEL_SELECTION_RETRIES = 1;
const STALE_COORDINATE_RADIUS = 28;
const MAX_STALE_COORDINATE_RECOVERIES = 2;
const MIN_STEPS_BEFORE_FINISH = 6;
const MAX_NO_PROGRESS_STREAK = 5;
const MAX_EMPTY_MODEL_TURNS = 2;
const MAX_SUBGOAL_ATTEMPTS = 3;
const REGROUNDING_STATUSES = new Set([
  ACTION_RESULT_STATUS.TARGET_NOT_FOUND,
  ACTION_RESULT_STATUS.VALIDATION_ERROR,
  ACTION_RESULT_STATUS.NO_EFFECT,
  ACTION_RESULT_STATUS.LOW_PROGRESS
]);

export async function chooseNextAction(session, observation) {
  ensureGoalState(session);

  const budgetError = checkPersistenceBudget(session);
  if (budgetError) {
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: budgetError
    };
  }

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

  const geminiApiKey = resolveGeminiApiKey(session);
  if (!geminiApiKey) {
    return buildFallbackAction(session, observation);
  }

  const groundingFeedback = buildGroundingFeedback(session, observation);
  const mustChangeStrategyHint = buildMustChangeStrategyHint(session, observation);
  const combinedFeedback = [groundingFeedback, mustChangeStrategyHint].filter(Boolean).join(" ");
  const primaryRequest = buildRequestBody(session, observation, {
    includeExcludedFunctions: false,
    feedbackMessage: combinedFeedback
  });
  let requestBody = primaryRequest;
  let response;
  let responseText = "";
  try {
    response = await fetchGeminiWithRetry(requestBody, geminiApiKey);
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
    if (isFunctionTurnOrderError(response.status, responseText) && !session.turnOrderRecoveryUsed) {
      session.turnOrderRecoveryUsed = true;
      resetConversationState(session);
      return {
        actionType: ACTION_TYPES.WAIT,
        rationale: "Recovered from model turn-order mismatch; retrying with a fresh Computer Use context.",
        waitMs: 900,
        strategyKey: "recovery:wait:turn_order_reset"
      };
    }

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
  session.turnOrderRecoveryUsed = false;
  session.transientErrorCount = 0;

  const payload = safeParseJson(responseText, {});
  const candidateContent = payload?.candidates?.[0]?.content || null;
  let appendedPrimaryCandidate = false;
  if (candidateContent) {
    session.lastModelContent = structuredClone(candidateContent);
    appendedPrimaryCandidate = true;
  }
  const blockReason = payload?.promptFeedback?.blockReason || null;
  if (blockReason) {
    session.goalState.modelBlockedTurnStreak = (session.goalState.modelBlockedTurnStreak || 0) + 1;
    if (session.goalState.modelBlockedTurnStreak <= 1) {
      return {
        actionType: ACTION_TYPES.WAIT,
        rationale: `Model blocked this turn (${blockReason}); retrying with a reframed step.`,
        waitMs: 1200,
        strategyKey: "recovery:wait:model_blocked"
      };
    }
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: `Model blocked repeatedly via promptFeedback (${blockReason}).`
    };
  }
  session.goalState.modelBlockedTurnStreak = 0;

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
    session.goalState.emptyModelTurnStreak = (session.goalState.emptyModelTurnStreak || 0) + 1;
    if (session.goalState.emptyModelTurnStreak <= MAX_EMPTY_MODEL_TURNS) {
      return {
        actionType: ACTION_TYPES.WAIT,
        rationale: `Model returned no action (${session.goalState.emptyModelTurnStreak}/${MAX_EMPTY_MODEL_TURNS}); retrying with fresh state.`,
        waitMs: 1200,
        strategyKey: "recovery:wait:model_no_action"
      };
    }
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: "Gemini did not request any more browser actions after retries."
    };
  }
  session.goalState.emptyModelTurnStreak = 0;

  let action = processModelFunctionCall(functionCalls[0], session, observation);
  if (!action) {
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: "Gemini did not return a valid Computer Use action."
    };
  }
  const staleRecoveryAction = maybeBuildStaleCoordinateRecovery(action, session, observation);
  if (staleRecoveryAction) {
    return staleRecoveryAction;
  }
  if (!shouldRetryActionSelection(action)) {
    session.staleCoordinateRecoveryCount = 0;
    return action;
  }

  // This assistant turn contained functionCall(s) we are rejecting before execution.
  // Roll it back so the next model request is not sent with unresolved tool calls.
  if (appendedPrimaryCandidate) {
    rollbackLastModelContent(session);
  }

  const invalidReason = action.rationale;
  for (let attempt = 1; attempt <= MAX_MODEL_SELECTION_RETRIES; attempt += 1) {
    const retryRequest = buildRequestBody(session, observation, {
      includeExcludedFunctions: false,
      feedbackMessage: buildRetryFeedback(functionCalls[0]?.name, invalidReason, combinedFeedback)
    });
    let retryResponse;
    let retryText = "";
    try {
      retryResponse = await fetchGeminiWithRetry(retryRequest, geminiApiKey);
      retryText = await retryResponse.text();
    } catch (error) {
      break;
    }

    const retryPayload = safeParseJson(retryText, {});
    const retryCalls = extractFunctionCalls(retryPayload);
    const retryMessage = extractTextParts(retryPayload?.candidates?.[0]?.content);
    const retryCandidateContent = retryPayload?.candidates?.[0]?.content || null;
    if (retryCandidateContent) {
      session.lastModelContent = structuredClone(retryCandidateContent);
    }
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

    let retryAction = processModelFunctionCall(retryCalls[0], session, observation);
    if (!retryAction) {
      continue;
    }
    const retryStaleRecoveryAction = maybeBuildStaleCoordinateRecovery(retryAction, session, observation);
    if (retryStaleRecoveryAction) {
      return retryStaleRecoveryAction;
    }
    if (!shouldRetryActionSelection(retryAction)) {
      session.staleCoordinateRecoveryCount = 0;
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
  const plannerContext = buildPlannerContext(session, observation);

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
    contents: buildContents(session, {
      observation,
      priorSteps,
      plannerContext,
      feedbackMessage,
      screenshotPart
    }),
    generationConfig: {
      temperature: 0.1
    }
  };
}

async function fetchGemini(requestBody, geminiApiKey) {
  return fetch(`${API_ROOT}/${DEFAULT_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey
    },
    body: JSON.stringify(requestBody)
  });
}

async function fetchGeminiWithRetry(requestBody, geminiApiKey) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastResponse = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await fetchGemini(requestBody, geminiApiKey);
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

function resolveGeminiApiKey(session) {
  const fromRun = `${session?.geminiApiKey || ""}`.trim();
  if (fromRun) {
    return fromRun;
  }

  const fromEnv = `${process.env.GEMINI_API_KEY || ""}`.trim();
  return fromEnv || null;
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
    "You are Gemini Computer Use controlling a visible Playwright browser session.",
    "Your goal is to do your best to fulfill the user prompt on the selected site by choosing concrete browser actions.",
    "Every action you request happens in the current page of this browser session.",
    "Allowed actions are: click_at, type_text_at, scroll_document, wait_5_seconds, go_back, navigate, finish_run, fail_run.",
    "Do not call open_web_browser, search, open_tab, close_tab, go_forward, drag_and_drop, download_file, or press_key.",
    "Use only visible page evidence and tool feedback. Do not assume a specific site type or workflow.",
    "After each action, verify state change using URL/title/content and tool result.",
    "If an action fails or state does not change, choose a different strategy.",
    "Avoid repeating the same action and coordinates without new evidence.",
    "Try at least two distinct strategies before failing the task.",
    "Do not call finish_run unless you can cite concrete evidence from current page state that the user goal is satisfied.",
    "After a miss, no-effect, or invalid target, re-ground from current interactive hints and choose a materially different target region.",
    "When text entry is needed, use Interactive hints to find a visible editable input/textarea and prefer its center coordinates.",
    "For typing flows, prefer click_at on the chosen input hint center first, then type_text_at at that same location.",
    "For multi-step tasks, proceed one step at a time and reassess after every result.",
    `Stay on this exact site only: origin ${session.allowedOrigin}, hostname ${session.allowedHostname}.`,
    "Never ask to open a new browser, a new tab, browser settings, downloads, or an external site.",
    "Do not interact with password fields, card fields, or irreversible financial confirmation actions unless explicitly approved by policy.",
    "Task success means best-effort completion of the user request within this site, then call finish_run with a short summary.",
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
  const repeatedStrategyError = detectRepeatedStrategyWithoutProgress(action, session, observation);
  if (repeatedStrategyError) {
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: repeatedStrategyError,
      strategyKey: action.strategyKey
    };
  }

  const forcedRotationError = detectRequiredStrategyRotation(action, session, observation);
  if (forcedRotationError) {
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: forcedRotationError,
      strategyKey: action.strategyKey
    };
  }

  const staleCoordinateError = detectStaleCoordinateReuse(action, session, observation);
  if (staleCoordinateError) {
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: staleCoordinateError,
      strategyKey: action.strategyKey
    };
  }

  if (action.actionType === ACTION_TYPES.NAVIGATE) {
    const normalizedTarget = normalizeUrl(action.url);
    if (!isSameOrigin(normalizedTarget, session.allowedOrigin)) {
      return {
        actionType: ACTION_TYPES.FAIL,
        rationale: `Blocked cross-site navigation to ${truncateText(normalizedTarget, 120)}.`,
        strategyKey: action.strategyKey
      };
    }

    if (normalizedTarget === normalizeUrl(observation.normalizedUrl || observation.url)) {
      return {
        actionType: ACTION_TYPES.FAIL,
        rationale: "Invalid action: navigation to the same page would create a loop.",
        strategyKey: action.strategyKey
      };
    }
  }

  if (getSafetyDecision(action.safetyDecision) === "require_confirmation") {
    return {
      ...action,
      rationale: [
        action.rationale,
        "Gemini requested confirmation, but local policy is to continue automatically unless the hard blocklist rejects the action."
      ]
        .filter(Boolean)
        .join(" ")
        .trim(),
      strategyKey: action.strategyKey
    };
  }

  if (isBlockedAction(action)) {
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: "Invalid action: blocked risky action involving account access, downloads, or final payment.",
      strategyKey: action.strategyKey
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

  return /unsupported action|out of scope|invalid action|cross-site navigation|stale coordinates|prior miss/i.test(action.rationale || "");
}

function buildRetryFeedback(functionName, reason, groundingFeedback = "") {
  const fallbackName = functionName || "unknown_action";
  return [
    `Your previous action (${fallbackName}) was rejected.`,
    `Reason: ${reason}`,
    groundingFeedback || "Choose one valid allowed action only, grounded in visible page elements, and avoid repeating prior target coordinates."
  ].join(" ");
}

function buildContents(session, { observation, priorSteps, plannerContext, feedbackMessage, screenshotPart }) {
  const initialUserContent =
    session.initialUserContent ||
    buildStateUserContent({ session, observation, priorSteps, plannerContext, feedbackMessage, screenshotPart });

  if (!session.initialUserContent) {
    session.initialUserContent = structuredClone(initialUserContent);
  }

  const contents = [structuredClone(initialUserContent)];
  if (session.lastModelContent && session.lastFunctionResponseContent) {
    contents.push(structuredClone(session.lastModelContent));
    contents.push(structuredClone(session.lastFunctionResponseContent));
    return contents;
  }

  if (feedbackMessage) {
    contents[0].parts[0].text = `${contents[0].parts[0].text}\nSelection feedback: ${feedbackMessage}`;
  }
  return contents;
}

function buildStateUserContent({ session, observation, priorSteps, plannerContext, feedbackMessage, screenshotPart }) {
  return {
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
          `Planner context: ${JSON.stringify(plannerContext)}`,
          feedbackMessage ? `Selection feedback: ${feedbackMessage}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      },
      ...(screenshotPart ? [screenshotPart] : [])
    ]
  };
}

function maybeBuildStaleCoordinateRecovery(action, session, observation) {
  if (!action || action.actionType !== ACTION_TYPES.FAIL || !isStaleCoordinateFailure(action.rationale)) {
    return null;
  }

  const attempt = session.staleCoordinateRecoveryCount || 0;
  if (attempt >= MAX_STALE_COORDINATE_RECOVERIES) {
    return null;
  }

  session.staleCoordinateRecoveryCount = attempt + 1;
  const recoveryAction =
    attempt === 0
      ? {
          actionType: ACTION_TYPES.SCROLL,
          rationale: "Recovery: shift viewport to re-ground target selection after stale coordinates.",
          scrollAmount: Math.round((observation?.viewport?.height || 900) * 0.55),
          strategyKey: "recovery:scroll:stale_coordinates"
        }
      : {
          actionType: ACTION_TYPES.WAIT,
          rationale: "Recovery: pause briefly so dynamic UI settles before choosing a new target.",
          waitMs: 1200,
          strategyKey: "recovery:wait:stale_coordinates"
        };

  session.lastGeminiDebug = {
    ...(session.lastGeminiDebug || {}),
    staleCoordinateRecovery: {
      attempt: session.staleCoordinateRecoveryCount,
      reason: action.rationale,
      action: recoveryAction
    }
  };

  return recoveryAction;
}

function processModelFunctionCall(functionCall, session, observation) {
  if (!functionCall) {
    return null;
  }
  let action = normalizeModelAction(functionCall, session, observation);
  action.strategyKey = buildActionStrategyKey(action, observation);
  action.modelFunctionName = functionCall.name;
  action.modelCallId = functionCall.id || null;
  action = enforcePolicy(action, session, observation);
  action = applyFinishGate(action, session, observation);
  return action;
}

function buildGroundingFeedback(session, observation) {
  const last = (session.history || []).at(-1);
  if (!last || !REGROUNDING_STATUSES.has(last.status)) {
    return "";
  }

  const currentUrl = normalizeUrl(observation?.normalizedUrl || observation?.url);
  const previousUrl = normalizeUrl(last.normalizedNewUrl || last.newUrl);
  const samePage = currentUrl && previousUrl && currentUrl === previousUrl;
  const hint = "Re-ground from the current Interactive hints list only: choose a specific visible target center and do not reuse prior miss coordinates.";
  if (!samePage) {
    return hint;
  }

  const x = Number(last.x);
  const y = Number(last.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return `${hint} Prior miss was near (${Math.round(x)}, ${Math.round(y)}), so choose a materially different coordinate.`;
  }
  return hint;
}

function detectStaleCoordinateReuse(action, session, observation) {
  if (!action || ![ACTION_TYPES.CLICK_AT, ACTION_TYPES.TYPE_TEXT_AT].includes(action.actionType)) {
    return null;
  }

  const actionX = Number(action.x);
  const actionY = Number(action.y);
  if (!Number.isFinite(actionX) || !Number.isFinite(actionY)) {
    return null;
  }

  const history = session.history || [];
  const currentUrl = normalizeUrl(observation?.normalizedUrl || observation?.url);
  const lastProblematicAction = [...history]
    .reverse()
    .find((entry) => {
      if (!entry || !REGROUNDING_STATUSES.has(entry.status)) {
        return false;
      }
      if (![ACTION_TYPES.CLICK_AT, ACTION_TYPES.TYPE_TEXT_AT].includes(entry.actionType)) {
        return false;
      }
      const previousX = Number(entry.x);
      const previousY = Number(entry.y);
      if (!Number.isFinite(previousX) || !Number.isFinite(previousY)) {
        return false;
      }
      const entryUrl = normalizeUrl(entry.normalizedNewUrl || entry.newUrl);
      return entryUrl === currentUrl;
    });

  if (!lastProblematicAction) {
    return null;
  }

  const previousX = Number(lastProblematicAction.x);
  const previousY = Number(lastProblematicAction.y);
  const dx = Math.abs(previousX - actionX);
  const dy = Math.abs(previousY - actionY);
  if (dx <= STALE_COORDINATE_RADIUS && dy <= STALE_COORDINATE_RADIUS) {
    return `Invalid action: reused stale coordinates near a prior miss at (${Math.round(previousX)}, ${Math.round(previousY)}). Choose a different target from current Interactive hints.`;
  }

  return null;
}

function isStaleCoordinateFailure(reason) {
  return /stale coordinates|prior miss/i.test(`${reason || ""}`);
}

function checkPersistenceBudget(session) {
  const remaining = Number(session?.goalState?.attemptBudgetRemaining ?? 1);
  if (remaining <= 0) {
    return "Persistence budget exhausted before task completion.";
  }
  const noProgress = Number(session?.goalState?.noProgressStreak || 0);
  if (noProgress >= MAX_NO_PROGRESS_STREAK) {
    return "Persistence budget exhausted: too many consecutive no-progress steps.";
  }
  return null;
}

function buildMustChangeStrategyHint(session, observation) {
  const goalState = session.goalState || {};
  const phase = goalState.phase || "unknown";
  const attempts = Number(goalState.subgoalAttempts?.[phase] || 0);
  if (attempts <= MAX_SUBGOAL_ATTEMPTS) {
    return "";
  }
  return `Must-change strategy now: phase ${phase} exceeded ${MAX_SUBGOAL_ATTEMPTS} attempts on this subgoal. Choose a different action class or page region.`;
}

function applyFinishGate(action, session, observation) {
  if (!action || action.actionType !== ACTION_TYPES.FINISH) {
    session.goalState.lastFinishGateDecision = { decision: "not_evaluated" };
    return action;
  }

  const steps = session.history?.length || 0;
  const lastOutcome = session.history?.at(-1);
  const hasMinimumSteps = steps >= MIN_STEPS_BEFORE_FINISH;
  const latestOutcomeAllowed =
    !lastOutcome ||
    ![ACTION_RESULT_STATUS.TARGET_NOT_FOUND, ACTION_RESULT_STATUS.VALIDATION_ERROR, ACTION_RESULT_STATUS.NO_EFFECT].includes(
      lastOutcome.status
    );
  const hasVerificationSignals = hasRecentVerificationSignals(session);

  const decision = {
    decision: "blocked",
    hasMinimumSteps,
    latestOutcomeAllowed,
    hasVerificationSignals,
    stepCount: steps
  };
  if (hasMinimumSteps && latestOutcomeAllowed && hasVerificationSignals) {
    session.goalState.lastFinishGateDecision = { ...decision, decision: "allowed" };
    return action;
  }

  const reasons = [];
  if (!hasMinimumSteps) {
    reasons.push(`minimum step count not met (${steps}/${MIN_STEPS_BEFORE_FINISH})`);
  }
  if (!latestOutcomeAllowed) {
    reasons.push(`latest outcome was ${lastOutcome?.status}`);
  }
  if (!hasVerificationSignals) {
    reasons.push("no verification signals detected");
  }
  session.goalState.lastFinishGateDecision = { ...decision, reasons };
  return {
    actionType: ACTION_TYPES.WAIT,
    rationale: `Finish gate blocked: ${reasons.join("; ")}. Continue with another strategy.`,
    waitMs: 1200,
    strategyKey: "recovery:wait:finish_gate"
  };
}

function hasRecentVerificationSignals(session) {
  const goalSignals = session?.goalState?.verificationSignals || [];
  if (goalSignals.length > 0) {
    return true;
  }
  const recent = (session.history || []).slice(-4);
  return recent.some((entry) => Array.isArray(entry.progressSignals) && entry.progressSignals.length > 0);
}

function buildActionStrategyKey(action, observation) {
  const zone = strategyZoneBucket(action, observation);
  const targetClass = actionTargetClass(action);
  return `${action?.actionType || "unknown"}:${zone}:${targetClass}`;
}

function strategyZoneBucket(action, observation) {
  const x = Number(action?.x);
  const y = Number(action?.y);
  const width = Number(observation?.viewport?.width || 0);
  const height = Number(observation?.viewport?.height || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) {
    return "na";
  }

  const horizontal = x < width / 3 ? "left" : x < (2 * width) / 3 ? "center" : "right";
  const vertical = y < height / 3 ? "top" : y < (2 * height) / 3 ? "mid" : "bottom";
  return `${vertical}-${horizontal}`;
}

function actionTargetClass(action) {
  if (action?.actionType === ACTION_TYPES.TYPE_TEXT_AT) {
    return "text_entry";
  }
  if (action?.actionType === ACTION_TYPES.CLICK_AT) {
    return "pointer";
  }
  if (action?.actionType === ACTION_TYPES.NAVIGATE) {
    return "navigation";
  }
  if (action?.actionType === ACTION_TYPES.SCROLL) {
    return "viewport_shift";
  }
  if (action?.actionType === ACTION_TYPES.WAIT) {
    return "timing";
  }
  return "generic";
}

function detectRepeatedStrategyWithoutProgress(action, session, observation) {
  if (!action?.strategyKey) {
    return null;
  }
  const last = (session.history || []).at(-1);
  if (!last) {
    return null;
  }
  const samePage = normalizeUrl(last.normalizedNewUrl || last.newUrl) === normalizeUrl(observation?.normalizedUrl || observation?.url);
  if (!samePage) {
    return null;
  }
  if (last.strategyKey === action.strategyKey && !last.taskProgressChanged) {
    return `Invalid action: repeated strategy (${action.strategyKey}) on the same page without task progress. Choose a different strategy.`;
  }
  return null;
}

function detectRequiredStrategyRotation(action, session, observation) {
  const last = (session.history || []).at(-1);
  if (!last || !REGROUNDING_STATUSES.has(last.status)) {
    return null;
  }
  const samePage = normalizeUrl(last.normalizedNewUrl || last.newUrl) === normalizeUrl(observation?.normalizedUrl || observation?.url);
  if (!samePage) {
    return null;
  }

  if (last.actionType === ACTION_TYPES.TYPE_TEXT_AT && action.actionType === ACTION_TYPES.TYPE_TEXT_AT) {
    return "Invalid action: previous typing attempt failed. Click an editable input hint center before typing again.";
  }
  if (last.actionType === ACTION_TYPES.CLICK_AT && action.actionType === ACTION_TYPES.CLICK_AT && last.strategyKey === action.strategyKey) {
    return "Invalid action: repeated click strategy after a miss/no-effect. Change action class or target region.";
  }
  return null;
}

function buildPlannerContext(session, observation) {
  const recentStrategies = (session.goalState?.recentStrategyKeys || [])
    .slice(-3)
    .map((entry) => ({
      strategyKey: entry.strategyKey,
      outcome: entry.outcome,
      progress: Boolean(entry.taskProgressChanged)
    }));
  const phase = session.goalState?.phase || "unknown";
  const attempts = Number(session.goalState?.subgoalAttempts?.[phase] || 0);
  return {
    phase,
    noProgressStreak: Number(session.goalState?.noProgressStreak || 0),
    attemptBudgetRemaining: Number(session.goalState?.attemptBudgetRemaining || 0),
    currentPhaseAttempts: attempts,
    mustChangeStrategy: attempts > MAX_SUBGOAL_ATTEMPTS || Number(session.goalState?.noProgressStreak || 0) >= 2,
    last3Strategies: recentStrategies,
    latestVerificationSignals: session.goalState?.verificationSignals || [],
    pageFingerprint: observation?.pageFingerprint || ""
  };
}

function ensureGoalState(session) {
  if (session.goalState) {
    return;
  }
  session.goalState = {
    phase: "orienting",
    attemptBudgetRemaining: 36,
    subgoalAttempts: {},
    noProgressStreak: 0,
    emptyModelTurnStreak: 0,
    modelBlockedTurnStreak: 0,
    recentStrategyKeys: [],
    verificationSignals: [],
    lastFinishGateDecision: { decision: "not_evaluated" }
  };
}

function rollbackLastModelContent(session) {
  session.lastModelContent = null;
}

function resetConversationState(session) {
  session.initialUserContent = null;
  session.lastModelContent = null;
  session.lastFunctionResponseContent = null;
}

export function appendFunctionResponse(session, actionResult, observationAfter) {
  const inlineData = toInlineData(observationAfter?.screenshot);
  const functionName = actionResult?.modelFunctionName || actionTypeToFunctionName(actionResult?.actionType);
  if (!functionName) {
    return;
  }

  const safetyDecision = getSafetyDecision(actionResult?.safetyDecision);

  const responsePayload = {
    url: observationAfter?.url || actionResult?.newUrl || "",
    status: actionResult?.status,
    details: actionResult?.details,
    triggered_navigation: Boolean(actionResult?.triggeredNavigation),
    task_progress_changed: Boolean(actionResult?.taskProgressChanged),
    progress_signals: actionResult?.progressSignals || [],
    strategy_key: actionResult?.strategyKey || ""
  };
  if (safetyDecision === "require_confirmation") {
    responsePayload.safety_acknowledgement = "true";
  }

  const parts = [
    {
      functionResponse: {
        name: functionName,
        response: responsePayload
      }
    },
    ...(inlineData ? [{ inlineData }] : [])
  ];

  session.lastFunctionResponseContent = {
    role: "user",
    parts
  };
}

function actionTypeToFunctionName(actionType) {
  switch (actionType) {
    case ACTION_TYPES.CLICK_AT:
      return "click_at";
    case ACTION_TYPES.TYPE_TEXT_AT:
      return "type_text_at";
    case ACTION_TYPES.SCROLL:
      return "scroll_document";
    case ACTION_TYPES.WAIT:
      return "wait_5_seconds";
    case ACTION_TYPES.GO_BACK:
      return "go_back";
    case ACTION_TYPES.NAVIGATE:
      return "navigate";
    default:
      return null;
  }
}

function toInlineData(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    return null;
  }
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1],
    data: match[2]
  };
}

function isFunctionTurnOrderError(status, responseText) {
  if (status !== 400) {
    return false;
  }
  return /function call turn comes immediately after a user turn or after a function response turn/i.test(
    `${responseText || ""}`
  );
}
