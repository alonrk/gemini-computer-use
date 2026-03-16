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
const GENERIC_NOISE_PATTERN = /(devtools|debug panel|site editor|renderer:|version:|extensions? panel|test harness)/i;

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

    const params = [...url.searchParams.entries()]
      .filter(([key]) => !/^utm_|^fbclid$|^gclid$|^_ga$|^_gl$/.test(key))
      .sort(([left], [right]) => left.localeCompare(right));

    url.search = "";
    for (const [key, value] of params) {
      url.searchParams.append(key, value);
    }

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

export function sameAction(left, right) {
  if (!left || !right) {
    return false;
  }

  return JSON.stringify({
    type: left.actionType || left.type,
    x: left.x,
    y: left.y,
    text: left.text,
    url: normalizeUrl(left.url),
    scrollAmount: left.scrollAmount
  }) === JSON.stringify({
    type: right.actionType || right.type,
    x: right.x,
    y: right.y,
    text: right.text,
    url: normalizeUrl(right.url),
    scrollAmount: right.scrollAmount
  });
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

export function isBlockedAction(action) {
  const haystack = [
    action?.rationale,
    action?.text,
    action?.url
  ]
    .filter(Boolean)
    .join(" ");

  return BLOCKED_ACTION_PATTERN.test(haystack);
}

export function shouldIgnoreElementText(text) {
  return GENERIC_NOISE_PATTERN.test(text ?? "");
}

export function isSameOrigin(targetUrl, origin) {
  if (!targetUrl || !origin) {
    return false;
  }

  try {
    return new URL(targetUrl, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
