export const HELPER_ORIGIN = "http://127.0.0.1:3210";

export function isRestrictedUrl(url) {
  return /^(chrome|edge|about|brave|vivaldi|opera|moz-extension|chrome-extension):/i.test(url ?? "");
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
