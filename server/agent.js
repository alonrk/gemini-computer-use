import {
  ACTION_TYPES,
  meaningfulPageChange,
  normalizeUrl,
  sameAction
} from "../shared/protocol.js";

const MAX_STEPS = 24;
const MAX_REPEAT_COUNT = 3;
const MAX_STAGNANT_STEPS = 8;
const MAX_OSCILLATION = 3;
const MAX_SAME_TARGET_ATTEMPTS = 3;

export function extractTextParts(content) {
  return content?.parts?.map((part) => part.text || "").filter(Boolean).join("\n").trim() || "";
}

export function extractFunctionCalls(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.functionCall)
    .filter(Boolean);
}

export function buildFallbackAction(session, observation) {
  return {
    actionType: ACTION_TYPES.FAIL,
    rationale: "No Gemini API key was available. Start the helper with GEMINI_API_KEY to run Computer Use."
  };
}

export function detectLoop(session, observation) {
  if ((session.history?.length || 0) >= MAX_STEPS) {
    return "Stopped after reaching the maximum number of browser steps for this run.";
  }

  const history = session.history || [];
  const normalizedUrl = normalizeUrl(observation?.normalizedUrl || observation?.url);
  session.urlTrail = [...(session.urlTrail || []), normalizedUrl].slice(-8);

  const lastAction = history.at(-1);
  const previousAction = history.at(-2);
  if (lastAction && previousAction && sameAction(lastAction, previousAction) && !meaningfulPageChange(session.previousObservation, observation)) {
    session.repeatedActionCount = (session.repeatedActionCount || 0) + 1;
  } else {
    session.repeatedActionCount = 0;
  }

  if (session.repeatedActionCount >= MAX_REPEAT_COUNT) {
    return "Loop detected: Gemini kept selecting the same action without changing the page.";
  }

  const lastExecutedActionType = history.at(-1)?.actionType || "";
  const actionCanStagnate = new Set([ACTION_TYPES.WAIT, ACTION_TYPES.SCROLL, ACTION_TYPES.GO_BACK]).has(lastExecutedActionType);
  if (actionCanStagnate && session.lastNormalizedUrl === normalizedUrl && !meaningfulPageChange(session.previousObservation, observation)) {
    session.repeatedNavigationCount = (session.repeatedNavigationCount || 0) + 1;
  } else {
    session.repeatedNavigationCount = 0;
  }

  if (session.repeatedNavigationCount >= MAX_STAGNANT_STEPS) {
    return "Loop detected: repeated non-progress actions did not change the page state.";
  }

  if (sameTargetRepeats(history) >= MAX_SAME_TARGET_ATTEMPTS) {
    return "Loop detected: repeated clicks or types on the same target without progress.";
  }

  if (detectOscillation(session.urlTrail)) {
    session.oscillationCount = (session.oscillationCount || 0) + 1;
  } else {
    session.oscillationCount = 0;
  }

  if (session.oscillationCount >= MAX_OSCILLATION) {
    return "Loop detected: page is oscillating between the same URLs.";
  }

  return null;
}

export function buildLoopRecoveryAction(session, observation) {
  const lastAction = (session.history || []).at(-1);
  if (lastAction?.actionType !== ACTION_TYPES.WAIT) {
    return {
      actionType: ACTION_TYPES.WAIT,
      rationale: "Loop recovery: pause briefly to allow dynamic content to settle.",
      waitMs: 1200
    };
  }

  if (lastAction?.actionType !== ACTION_TYPES.SCROLL) {
    return {
      actionType: ACTION_TYPES.SCROLL,
      rationale: "Loop recovery: perform a single scroll to change visible context.",
      scrollAmount: Math.round((observation?.viewport?.height || 800) * 0.7)
    };
  }

  return {
    actionType: ACTION_TYPES.GO_BACK,
    rationale: "Loop recovery: go back once to attempt a different navigation path."
  };
}

export function normalizeModelAction(functionCall, session, observation) {
  if (!functionCall?.name) {
    return {
      actionType: ACTION_TYPES.FAIL,
      rationale: "Gemini did not return a callable Computer Use action."
    };
  }

  const args = normalizeArgs(functionCall.args);
  const safetyDecision = args.safety_decision || args.safetyDecision || null;
  const rationale = args.rationale || args.reason || `Gemini chose ${functionCall.name}.`;

  switch (functionCall.name) {
    case "click_at":
      return {
        actionType: ACTION_TYPES.CLICK_AT,
        rationale,
        x: coerceCoordinate(args.x),
        y: coerceCoordinate(args.y),
        safetyDecision
      };
    case "type_text_at":
      return {
        actionType: ACTION_TYPES.TYPE_TEXT_AT,
        rationale,
        x: coerceCoordinate(args.x),
        y: coerceCoordinate(args.y),
        text: typeof args.text === "string" ? args.text : "",
        pressEnter: Boolean(args.press_enter ?? args.pressEnter),
        safetyDecision
      };
    case "scroll":
    case "scroll_document":
      return {
        actionType: ACTION_TYPES.SCROLL,
        rationale,
        scrollAmount: coerceScrollAmount(args, observation),
        safetyDecision
      };
    case "wait":
    case "wait_5_seconds":
      return {
        actionType: ACTION_TYPES.WAIT,
        rationale,
        waitMs: 5000,
        safetyDecision
      };
    case "go_back":
      return {
        actionType: ACTION_TYPES.GO_BACK,
        rationale,
        safetyDecision
      };
    case "navigate_current_tab":
      return {
        actionType: ACTION_TYPES.NAVIGATE,
        rationale,
        url: args.url,
        safetyDecision
      };
    case "finish_run":
      return {
        actionType: ACTION_TYPES.FINISH,
        rationale: args.summary || rationale
      };
    case "fail_run":
      return {
        actionType: ACTION_TYPES.FAIL,
        rationale: args.reason || rationale
      };
    case "open_web_browser":
    case "search":
    case "open_tab":
    case "close_tab":
    case "go_forward":
    case "download_file":
    case "drag_and_drop":
    case "press_key":
      return {
        actionType: ACTION_TYPES.FAIL,
        rationale: `Gemini requested unsupported action ${functionCall.name}. Choose an allowed in-tab action.`
      };
    default:
      return {
        actionType: ACTION_TYPES.FAIL,
        rationale: `Gemini returned an unsupported action: ${functionCall.name}.`
      };
  }
}

function normalizeArgs(rawArgs) {
  if (!rawArgs) {
    return {};
  }

  if (typeof rawArgs === "string") {
    try {
      return JSON.parse(rawArgs);
    } catch {
      return {};
    }
  }

  return rawArgs;
}

function coerceCoordinate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, numeric);
}

function coerceScrollAmount(args, observation) {
  if (Number.isFinite(args.amount)) {
    return Number(args.amount);
  }

  const direction = `${args.direction || "down"}`.toLowerCase();
  const base = Math.round((observation?.viewport?.height || 800) * 0.8);
  return direction === "up" ? -base : base;
}


function sameTargetRepeats(history) {
  if (!Array.isArray(history) || history.length < 3) {
    return 0;
  }

  const recent = history.slice(-5);
  let streak = 1;
  for (let index = recent.length - 1; index > 0; index -= 1) {
    const current = recent[index];
    const previous = recent[index - 1];
    if (!isSameTargetAction(current, previous)) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function isSameTargetAction(left, right) {
  if (!left || !right) {
    return false;
  }

  const validTypes = new Set([ACTION_TYPES.CLICK_AT, ACTION_TYPES.TYPE_TEXT_AT]);
  if (!validTypes.has(left.actionType) || !validTypes.has(right.actionType)) {
    return false;
  }

  const leftX = Math.round(Number(left.x) || -1);
  const leftY = Math.round(Number(left.y) || -1);
  const rightX = Math.round(Number(right.x) || -1);
  const rightY = Math.round(Number(right.y) || -1);
  return leftX === rightX && leftY === rightY;
}

function detectOscillation(urlTrail) {
  if (!Array.isArray(urlTrail) || urlTrail.length < 4) {
    return false;
  }

  const [a, b, c, d] = urlTrail.slice(-4);
  return Boolean(a && b && a === c && b === d && a !== b);
}

export function inferPlannerPhase(session, observation) {
  const history = session.history || [];
  const lastAction = history.at(-1);
  const text = `${observation?.pageSummary || ""} ${(observation?.uiSignals?.errorMessages || []).join(" ")}`.toLowerCase();

  if (!lastAction) {
    return "exploring";
  }
  if (/(error|invalid|required|failed|not found|try again)/.test(text)) {
    return "verifying";
  }
  if (lastAction.triggeredNavigation || lastAction.actionType === ACTION_TYPES.NAVIGATE) {
    return "exploring";
  }
  if ([ACTION_TYPES.CLICK_AT, ACTION_TYPES.TYPE_TEXT_AT].includes(lastAction.actionType)) {
    return "acting";
  }
  return "verifying";
}
