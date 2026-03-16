export const HELPER_ORIGIN = "http://127.0.0.1:3210";

export const ACTION_TYPES = Object.freeze({
  CLICK_AT: "click_at",
  TYPE_TEXT_AT: "type_text_at",
  SCROLL: "scroll",
  WAIT: "wait",
  GO_BACK: "go_back",
  NAVIGATE: "navigate",
  FINISH: "finish",
  FAIL: "fail"
});

export const SESSION_EVENT_TYPES = Object.freeze({
  STATUS: "status",
  THOUGHT: "thought",
  ACTION_REQUEST: "action_request",
  ACTION_LOG: "action_log",
  PAUSED: "paused",
  DONE: "done",
  ERROR: "error"
});

export const SESSION_PHASES = Object.freeze({
  STARTING: "starting",
  READY: "ready",
  EXECUTING_ACTION: "executing_action",
  WAITING_FOR_NAVIGATION: "waiting_for_navigation",
  WAITING_FOR_DOM_SETTLE: "waiting_for_dom_settle",
  PAUSED_FOR_CONFIRMATION: "paused_for_confirmation",
  COMPLETED: "completed",
  FAILED: "failed",
  STOPPED: "stopped"
});

const RESTRICTED_URL_PATTERN = /^(chrome|edge|about|brave|vivaldi|opera|moz-extension|chrome-extension):/i;
const BLOCKED_ACTION_PATTERN = /\b(download|upload|sign in|log in|login|password|passcode|credit card|card number|cvv|cvc|pay now|place order|submit payment|confirm purchase)\b/i;

export function truncateText(value, maxLength = 240) {
  if (!value) {
    return "";
  }

  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

export function normalizeWhitespace(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function isRestrictedUrl(url) {
  return RESTRICTED_URL_PATTERN.test(url ?? "");
}

export function normalizeUrl(rawUrl) {
  if (!rawUrl) {
    return "";
  }

  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString().replace(/\/$/, "") || rawUrl;
  } catch {
    return rawUrl;
  }
}

export function buildPageFingerprint({ title = "", headings = [], visibleTexts = [] } = {}) {
  return [title, ...headings, ...visibleTexts]
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean)
    .slice(0, 12)
    .join(" | ");
}

export function samePage(left, right) {
  if (!left || !right) {
    return false;
  }

  return normalizeUrl(left.normalizedUrl || left.url) === normalizeUrl(right.normalizedUrl || right.url) && (left.pageFingerprint || "") === (right.pageFingerprint || "");
}

export function meaningfulPageChange(previousObservation, nextObservation) {
  return !samePage(previousObservation, nextObservation);
}

export function isBlockedAction(action) {
  const haystack = [action?.rationale, action?.text, action?.url].filter(Boolean).join(" ");
  return BLOCKED_ACTION_PATTERN.test(haystack);
}

export function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
