(function bootstrap() {
  const highlightId = "__gemini_computer_use_highlight__";
  const bannerId = "__gemini_computer_use_banner__";
  let pageVersion = 0;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ping") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "collect-observation") {
      sendResponse(collectObservation(message.observationId || crypto.randomUUID()));
      return false;
    }

    if (message?.type === "execute-action") {
      executeAction(message.action)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ status: "validation_error", details: error.message }));
      return true;
    }

    return false;
  });

  function collectObservation(observationId) {
    pageVersion += 1;

    const headings = [...document.querySelectorAll("h1, h2, h3")]
      .map((element) => normalize(element.textContent))
      .filter(Boolean)
      .slice(0, 8);
    const visibleTexts = [...document.querySelectorAll("a, button, h1, h2, h3, [role='button'], p, span")]
      .map((element) => normalize(element.textContent))
      .filter(Boolean)
      .slice(0, 20);
    const pageSummary = buildPageSummary(headings);

    return {
      observationId,
      pageVersion,
      url: location.href,
      normalizedUrl: normalizeUrl(location.href),
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      pageFingerprint: buildPageFingerprint({
        title: document.title,
        headings,
        visibleTexts
      }),
      pageSummary,
      interactiveHints: listInteractiveHints(),
      uiSignals: collectUiSignals()
    };
  }

  async function executeAction(action) {
    const actionType = action?.actionType;
    showBanner(action?.rationale || actionType || "Working");

    switch (actionType) {
      case "click_at":
        return clickAt(action.x, action.y);
      case "type_text_at":
        return typeAt(action.x, action.y, action.text, action.pressEnter);
      case "scroll":
        return scrollDocument(action.scrollAmount);
      case "wait":
        await wait(action.waitMs || 5000);
        return { status: "success", details: `Waited ${action.waitMs || 5000}ms.` };
      case "go_back":
        history.back();
        return { status: "navigation", details: "Went back in history." };
      case "navigate":
        return navigateCurrentTab(action.url);
      default:
        return { status: "validation_error", details: `Unsupported action: ${actionType}` };
    }
  }

  function buildPageSummary(headings) {
    const bodyText = normalize(document.body?.innerText || "").slice(0, 1200);
    return [`Headings: ${headings.join(" | ")}`, `Visible text: ${bodyText}`].join("\n");
  }

  function listInteractiveHints() {
    const candidates = [...document.querySelectorAll("a, button, input, textarea, select, [role='button'], [contenteditable='true']")];

    return candidates
      .map((element) => {
        const rect = element.getBoundingClientRect();
        if (!isVisibleRect(rect)) {
          return null;
        }

        const text = normalize(element.innerText || element.value || element.getAttribute("aria-label") || element.getAttribute("placeholder"));
        if (!text || shouldIgnoreText(text) || shouldIgnoreElement(element)) {
          return null;
        }

        const hint = {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || "",
          text,
          href: element.getAttribute("href") || "",
          center: {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          },
          bounds: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
        hint.score = scoreHintCandidate(hint, element);
        return hint;
      })
      .filter((entry) => entry && isPointInViewport(entry.center.x, entry.center.y))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map(({ score, ...entry }) => entry)
      .filter(Boolean)
      .slice(0, 40);
  }

  function collectUiSignals() {
    const modalVisible = Boolean(document.querySelector("[role='dialog'], [aria-modal='true'], dialog[open]"));
    const formCount = document.querySelectorAll("form").length;
    const errorText = [...document.querySelectorAll("[role='alert'], .error, [aria-invalid='true']")]
      .map((element) => normalize(element.textContent))
      .filter(Boolean)
      .slice(0, 5);

    return {
      modalVisible,
      formCount,
      errorMessages: errorText
    };
  }

  async function clickAt(x, y) {
    const point = denormalizeCoordinates(x, y);
    const rawElement = document.elementFromPoint(point.x, point.y);
    if (!rawElement) {
      return { status: "target_not_found", details: "No element was found at that position." };
    }
    const element = resolveClickableTarget(rawElement);
    if (isBlockedElement(element)) {
      return { status: "blocked", details: "Blocked a sensitive or unsupported element." };
    }

    highlightPoint(point.x, point.y, element);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await wait(250);

    const anchor = element.closest("a[href]");
    if (anchor) {
      const href = anchor.href;
      if (!isSameOrigin(href, location.href)) {
        return { status: "blocked", details: `Blocked navigation outside the current site: ${href}` };
      }
    }

    const beforeUrl = location.href;
    dispatchClick(element, point.x, point.y);
    await wait(600);

    return {
      status: beforeUrl !== location.href ? "navigation" : "success",
      details: `Clicked ${describeElement(element)} at (${point.x}, ${point.y}).`
    };
  }

  async function typeAt(x, y, text, pressEnter = false) {
    if (typeof text !== "string") {
      return { status: "validation_error", details: "Type actions require text." };
    }

    const point = denormalizeCoordinates(x, y);
    const element = document.elementFromPoint(point.x, point.y);
    if (!element) {
      return { status: "target_not_found", details: "No text field was found at that position." };
    }
    if (isBlockedElement(element) || isSensitiveInput(element)) {
      return { status: "blocked", details: "Blocked typing into a sensitive or unsupported field." };
    }

    const field = findTextEntryTarget(element);
    if (!field) {
      return { status: "validation_error", details: "The selected element is not text-editable." };
    }

    highlightPoint(point.x, point.y, field);
    field.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await wait(250);
    field.focus();

    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      field.value = "";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (field.isContentEditable) {
      field.textContent = text;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }

    if (pressEnter) {
      dispatchEnterKey(field);
      await wait(500);
      return { status: "navigation", details: `Typed into ${describeElement(field)} and pressed Enter.` };
    }

    await wait(200);
    return { status: "changed_dom", details: `Typed into ${describeElement(field)}.` };
  }

  async function scrollDocument(scrollAmount) {
    const delta = Number.isFinite(scrollAmount) ? scrollAmount : Math.round(window.innerHeight * 0.8);
    window.scrollBy({ top: delta, behavior: "smooth" });
    highlightPoint(window.innerWidth / 2, Math.max(24, Math.min(window.innerHeight - 24, window.innerHeight / 2)));
    await wait(500);
    return { status: "changed_dom", details: `Scrolled by ${delta}px.` };
  }

  function navigateCurrentTab(rawUrl) {
    if (!rawUrl) {
      return { status: "validation_error", details: "Navigate actions require a URL." };
    }

    const targetUrl = new URL(rawUrl, location.href).toString();
    if (!isSameOrigin(targetUrl, location.href)) {
      return { status: "blocked", details: `Blocked navigation outside the current site: ${targetUrl}` };
    }

    location.href = targetUrl;
    return { status: "navigation", details: `Navigating to ${targetUrl}.` };
  }

  function dispatchClick(element, x, y) {
    const clientX = Math.round(x);
    const clientY = Math.round(y);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      element.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          view: window
        })
      );
    }
  }

  function resolveClickableTarget(element) {
    if (!(element instanceof Element)) {
      return element;
    }

    const actionable = element.closest("button, a[href], input, textarea, select, [role='button'], [contenteditable='true']");
    if (actionable) {
      return actionable;
    }

    const childActionable = element.querySelector?.("button, a[href], [role='button'], input, textarea, select");
    return childActionable || element;
  }

  function dispatchEnterKey(element) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      element.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        })
      );
    }
    if (typeof element.form?.requestSubmit === "function") {
      element.form.requestSubmit();
    }
  }

  function denormalizeCoordinates(x, y) {
    const px = x <= 1 ? Math.round(x * window.innerWidth) : Math.round(x);
    const py = y <= 1 ? Math.round(y * window.innerHeight) : Math.round(y);
    return {
      x: Math.max(1, Math.min(window.innerWidth - 1, px)),
      y: Math.max(1, Math.min(window.innerHeight - 1, py))
    };
  }

  function findTextEntryTarget(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) {
      return element;
    }

    return element.closest("input, textarea, [contenteditable='true']");
  }

  function isBlockedElement(element) {
    if (!(element instanceof Element)) {
      return true;
    }

    return Boolean(
      element.closest("[aria-disabled='true'], [disabled]") ||
        element.closest("input[type='file']") ||
        element.closest("iframe") ||
        element.closest("[data-testid*='download'], [href$='.pdf'], [download]")
    );
  }

  function isSensitiveInput(element) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return false;
    }

    const combined = [element.type, element.autocomplete, element.name, element.id].join(" ").toLowerCase();
    return /(password|credit|card|cvc|cvv|otp|one-time-code|ssn)/.test(combined);
  }

  function scoreHintCandidate(hint, element) {
    const text = (hint.text || "").toLowerCase();
    if (!text) {
      return 0;
    }

    let score = 1;
    if (hint.tag === "button") {
      score += 4;
    } else if (hint.tag === "a") {
      score += 3;
    } else if (hint.tag === "input" || hint.tag === "textarea" || hint.tag === "select") {
      score += 4;
    }
    if (hint.role === "button") {
      score += 2;
    }
    if (hint.href && !hint.href.startsWith("#")) {
      score += 2;
    }
    if (/submit|continue|search|find|open|details|next|apply|start|go|add/.test(text)) {
      score += 3;
    }
    if (/share|wishlist|favorite|newsletter|cookie|privacy|terms|facebook|instagram|twitter|youtube/.test(text)) {
      score -= 4;
    }
    if (element.closest("header, footer, nav") && !/search|menu|cart|checkout/.test(text)) {
      score -= 2;
    }
    if (hint.bounds.width < 24 || hint.bounds.height < 14) {
      score -= 2;
    }

    return score;
  }

  function isVisibleRect(rect) {
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth
    );
  }

  function isPointInViewport(x, y) {
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
  }

  function shouldIgnoreText(text) {
    return /(site editor|debug panel|renderer:|version:|leave feedback)/i.test(text);
  }

  function shouldIgnoreElement(element) {
    const href = element.getAttribute("href") || "";
    if (/^(javascript:|mailto:|tel:)/i.test(href)) {
      return true;
    }
    if (/chrome-extension:|moz-extension:/i.test(href)) {
      return true;
    }

    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    return rect.right < 0 || rect.bottom < 0 || styles.display === "none" || styles.visibility === "hidden" || element.getAttribute("aria-hidden") === "true";
  }

  function describeElement(element) {
    return normalize(element.textContent || element.getAttribute?.("aria-label") || element.getAttribute?.("placeholder") || element.tagName || "element").slice(0, 120);
  }

  function highlightPoint(x, y, element) {
    let overlay = document.getElementById(highlightId);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = highlightId;
      overlay.style.position = "fixed";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "2147483647";
      overlay.style.border = "2px solid #ff6b35";
      overlay.style.borderRadius = "12px";
      overlay.style.boxShadow = "0 0 0 9999px rgba(255, 107, 53, 0.08)";
      document.documentElement.appendChild(overlay);
    }

    const rect = element?.getBoundingClientRect?.() || {
      left: x - 16,
      top: y - 16,
      width: 32,
      height: 32
    };

    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    clearTimeout(highlightPoint.timeoutId);
    highlightPoint.timeoutId = setTimeout(() => overlay?.remove(), 1400);
  }

  function showBanner(message) {
    let banner = document.getElementById(bannerId);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = bannerId;
      banner.style.position = "fixed";
      banner.style.top = "16px";
      banner.style.right = "16px";
      banner.style.zIndex = "2147483647";
      banner.style.padding = "10px 14px";
      banner.style.maxWidth = "360px";
      banner.style.borderRadius = "14px";
      banner.style.background = "rgba(25, 25, 25, 0.92)";
      banner.style.color = "#fff";
      banner.style.pointerEvents = "none";
      banner.style.font = "600 13px/1.4 ui-sans-serif, system-ui, sans-serif";
      banner.style.boxShadow = "0 18px 45px rgba(0, 0, 0, 0.22)";
      document.documentElement.appendChild(banner);
    }

    banner.textContent = message;
    clearTimeout(showBanner.timeoutId);
    showBanner.timeoutId = setTimeout(() => banner?.remove(), 2200);
  }

  function normalize(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      url.hash = "";
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  function buildPageFingerprint({ title = "", headings = [], visibleTexts = [] } = {}) {
    return [title, ...headings, ...visibleTexts]
      .map((value) => normalize(value).toLowerCase())
      .filter(Boolean)
      .slice(0, 12)
      .join(" | ");
  }

  function isSameOrigin(targetUrl, origin) {
    try {
      return new URL(targetUrl, origin).origin === new URL(origin).origin;
    } catch {
      return false;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
