export const HELPER_ORIGIN = "http://127.0.0.1:3210";

export const ACTION_TYPES = Object.freeze({
  OBSERVE: "observe",
  CLICK: "click",
  TYPE: "type",
  SCROLL: "scroll",
  WAIT: "wait",
  FINISH: "finish",
  FAIL: "fail"
});

export const ACTION_RESULT_STATUS = Object.freeze({
  SUCCESS: "success",
  TARGET_NOT_FOUND: "target_not_found",
  BLOCKED: "blocked",
  NAVIGATION: "navigation",
  CHANGED_DOM: "changed_dom",
  VALIDATION_ERROR: "validation_error"
});

export const SESSION_EVENT_TYPES = Object.freeze({
  STATUS: "status",
  THOUGHT: "thought",
  ACTION_REQUEST: "action_request",
  ACTION_LOG: "action_log",
  DONE: "done",
  ERROR: "error"
});

export const MAX_VISIBLE_TEXT = 240;

export function truncateText(value, maxLength = MAX_VISIBLE_TEXT) {
  if (!value) {
    return "";
  }

  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

export function normalizeWhitespace(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function isRestrictedUrl(url) {
  return /^(chrome|edge|about|brave|vivaldi|opera|moz-extension|chrome-extension):/i.test(url ?? "");
}

export function isSensitiveField(field) {
  if (!field) {
    return false;
  }

  const type = `${field.type ?? ""}`.toLowerCase();
  const autocomplete = `${field.autocomplete ?? ""}`.toLowerCase();
  const name = `${field.name ?? ""}`.toLowerCase();
  const identifier = `${field.id ?? ""}`.toLowerCase();

  if (type === "password") {
    return true;
  }

  const combined = `${autocomplete} ${name} ${identifier}`;
  return /(cc-|credit|cardnumber|cvc|cvv|password|passcode|one-time-code|otp|ssn|social-security)/i.test(combined);
}

export function actionNeedsConfirmation(action) {
  const haystack = [
    action?.rationale,
    action?.target?.text,
    action?.target?.ariaLabel,
    action?.target?.selectorHint,
    action?.value
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (action?.requiresConfirmation) {
    return true;
  }

  return /\b(submit|delete|remove|purchase|buy|pay|confirm|place order|book|send|transfer)\b/.test(haystack);
}

export function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
