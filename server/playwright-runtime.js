import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import {
  ACTION_RESULT_STATUS,
  ACTION_TYPES,
  buildPageFingerprint,
  isSameOrigin,
  normalizeUrl
} from "../shared/protocol.js";

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const SHOW_ACTION_MARKER = process.env.COMPUTER_USE_DEBUG_OVERLAY !== "0";
const ACTION_OVERLAY_MS = 1400;
const OBSERVATION_RETRY_ATTEMPTS = 3;

export async function createPlaywrightRunner({ startUrl, allowedOrigin }) {
  const browser = await chromium.launch({
    headless: false,
    args: [`--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`]
  });
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    screen: DEFAULT_VIEWPORT
  });
  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  return {
    browser,
    context,
    page,
    allowedOrigin
  };
}

export async function closePlaywrightRunner(runner) {
  await runner?.context?.close().catch(() => {});
  await runner?.browser?.close().catch(() => {});
}

export async function collectObservation(runner, runId, step) {
  const page = runner.page;
  for (let attempt = 1; attempt <= OBSERVATION_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await settleAfterNavigation(page);
      const screenshotBuffer = await page.screenshot({ type: "png", fullPage: false });
      const pageData = await page.evaluate(() => {
        const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
        const normalizeCoord = (value, total) => {
          if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
            return 0;
          }
          return Math.max(0, Math.min(999, Math.round((value / total) * 1000)));
        };
        const isVisibleRect = (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= window.innerHeight &&
          rect.left <= window.innerWidth;
        const isPointInViewport = (x, y) =>
          Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= 999 && y <= 999;

        const headings = [...document.querySelectorAll("h1, h2, h3")]
          .map((element) => normalize(element.textContent))
          .filter(Boolean)
          .slice(0, 8);

        const visibleTexts = [...document.querySelectorAll("a, button, h1, h2, h3, [role='button'], p, span")]
          .map((element) => normalize(element.textContent))
          .filter(Boolean)
          .slice(0, 20);

        const bodyText = normalize(document.body?.innerText || "").slice(0, 1400);
        const pageSummary = [`Headings: ${headings.join(" | ")}`, `Visible text: ${bodyText}`].join("\n");

        const interactiveHints = [...document.querySelectorAll("a, button, input, textarea, select, [role='button'], [contenteditable='true']")]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            if (!isVisibleRect(rect)) {
              return null;
            }
            const text = normalize(
              element.innerText ||
                element.value ||
                element.getAttribute("aria-label") ||
                element.getAttribute("placeholder")
            );
            if (!text) {
              return null;
            }
            return {
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role") || "",
              text,
              href: element.getAttribute("href") || "",
              center: {
                x: normalizeCoord(rect.left + rect.width / 2, window.innerWidth),
                y: normalizeCoord(rect.top + rect.height / 2, window.innerHeight)
              },
              bounds: {
                x: normalizeCoord(rect.left, window.innerWidth),
                y: normalizeCoord(rect.top, window.innerHeight),
                width: normalizeCoord(rect.width, window.innerWidth),
                height: normalizeCoord(rect.height, window.innerHeight)
              }
            };
          })
          .filter((entry) => entry && isPointInViewport(entry.center.x, entry.center.y))
          .slice(0, 50);

        const modalVisible = Boolean(document.querySelector("[role='dialog'], [aria-modal='true'], dialog[open]"));
        const formCount = document.querySelectorAll("form").length;
        const errorMessages = [...document.querySelectorAll("[role='alert'], .error, [aria-invalid='true']")]
          .map((element) => normalize(element.textContent))
          .filter(Boolean)
          .slice(0, 6);

        return {
          url: location.href,
          title: document.title,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio || 1
          },
          screenshotMeta: {
            expectedPixelWidth: Math.round(window.innerWidth * (window.devicePixelRatio || 1)),
            expectedPixelHeight: Math.round(window.innerHeight * (window.devicePixelRatio || 1)),
            scrollX: Math.round(window.scrollX || 0),
            scrollY: Math.round(window.scrollY || 0),
            visualViewport: window.visualViewport
              ? {
                  width: Math.round(window.visualViewport.width),
                  height: Math.round(window.visualViewport.height),
                  offsetLeft: Math.round(window.visualViewport.offsetLeft),
                  offsetTop: Math.round(window.visualViewport.offsetTop),
                  scale: window.visualViewport.scale
                }
              : null
          },
          headings,
          visibleTexts,
          pageSummary,
          interactiveHints,
          uiSignals: {
            modalVisible,
            formCount,
            errorMessages
          }
        };
      });

      return {
        runId,
        observationId: randomUUID(),
        step,
        url: pageData.url,
        normalizedUrl: normalizeUrl(pageData.url),
        title: pageData.title,
        viewport: pageData.viewport,
        screenshotMeta: pageData.screenshotMeta,
        pageFingerprint: buildPageFingerprint({
          title: pageData.title,
          headings: pageData.headings,
          visibleTexts: pageData.visibleTexts
        }),
        pageSummary: pageData.pageSummary,
        interactiveHints: pageData.interactiveHints,
        uiSignals: pageData.uiSignals,
        screenshot: `data:image/png;base64,${screenshotBuffer.toString("base64")}`
      };
    } catch (error) {
      if (!isNavigationContextError(error) || attempt >= OBSERVATION_RETRY_ATTEMPTS) {
        throw error;
      }
      await settleAfterNavigation(page);
      await wait(250 * attempt);
    }
  }

  throw new Error("Observation collection failed after navigation retries.");
}

export async function executePlaywrightAction(runner, action) {
  await showActionBanner(runner.page, action);

  switch (action.actionType) {
    case ACTION_TYPES.CLICK_AT:
      return clickAt(runner, action);
    case ACTION_TYPES.TYPE_TEXT_AT:
      return typeAt(runner, action);
    case ACTION_TYPES.SCROLL:
      return scrollDocument(runner, action.scrollAmount);
    case ACTION_TYPES.WAIT:
      return waitAction(action.waitMs);
    case ACTION_TYPES.GO_BACK:
      return goBack(runner);
    case ACTION_TYPES.NAVIGATE:
      return navigate(runner, action.url);
    default:
      return {
        status: ACTION_RESULT_STATUS.VALIDATION_ERROR,
        details: `Unsupported action type: ${action.actionType}`,
        newUrl: runner.page.url(),
        triggeredNavigation: false
      };
  }
}

async function clickAt(runner, action) {
  const page = runner.page;
  const point = await resolvePoint(page, action.x, action.y);
  await showActionMarker(page, point, "click");
  const probe = await page.evaluate(
    ({ x, y, allowedOrigin }) => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      const elementDebug = (element) => {
        if (!element) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName?.toLowerCase?.() || "",
          id: element.id || "",
          className: normalize(element.className || ""),
          role: element.getAttribute("role") || "",
          type: element.getAttribute("type") || "",
          name: element.getAttribute("name") || "",
          ariaLabel: element.getAttribute("aria-label") || "",
          text: normalize(element.textContent || "").slice(0, 180),
          bounds: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      };

      const raw = document.elementFromPoint(x, y);
      if (!raw) {
        return { status: "target_not_found", details: "No element found at that coordinate.", hitElement: null, matchedElement: null };
      }

      const target = raw.closest("button, a[href], input, textarea, select, [role='button'], [contenteditable='true']");
      if (!target) {
        return {
          status: "target_not_found",
          details: "No actionable element found at the requested coordinate.",
          hitElement: elementDebug(raw),
          matchedElement: null
        };
      }

      if (target.closest("[aria-disabled='true'], [disabled], input[type='file'], iframe, [download]")) {
        return { status: "blocked", details: "Blocked a sensitive or unsupported element.", hitElement: elementDebug(raw), matchedElement: elementDebug(target) };
      }

      const anchor = target.closest("a[href]");
      if (anchor) {
        try {
          const resolved = new URL(anchor.href, location.href).toString();
          if (new URL(resolved).origin !== new URL(allowedOrigin).origin) {
            return { status: "blocked", details: `Blocked navigation outside start domain: ${resolved}`, hitElement: elementDebug(raw), matchedElement: elementDebug(target) };
          }
        } catch {
          return { status: "blocked", details: "Blocked malformed link target.", hitElement: elementDebug(raw), matchedElement: elementDebug(target) };
        }
      }

      return {
        status: "ok",
        details: `Clicked ${normalize(target.textContent || target.tagName)}.`,
        hitElement: elementDebug(raw),
        matchedElement: elementDebug(target)
      };
    },
    { x: point.x, y: point.y, allowedOrigin: runner.allowedOrigin }
  );
  const actionDebug = buildActionDebug(action, point, probe);

  if (probe.status !== "ok") {
    return withCurrentUrl(runner, {
      status: mapStatus(probe.status),
      details: probe.details,
      debug: actionDebug,
      triggeredNavigation: false
    });
  }

  const beforeUrl = page.url();
  await page.mouse.click(point.x, point.y, { delay: 40 });
  await waitForPossibleNavigation(page, beforeUrl);
  const afterUrl = page.url();
  if (!isSameOrigin(afterUrl, runner.allowedOrigin)) {
    await safeGoBack(page);
    return withCurrentUrl(runner, {
      status: ACTION_RESULT_STATUS.BLOCKED,
      details: `Blocked navigation outside start domain: ${afterUrl}`,
      debug: actionDebug,
      triggeredNavigation: false
    });
  }

  return {
    status: beforeUrl !== afterUrl ? ACTION_RESULT_STATUS.NAVIGATION : ACTION_RESULT_STATUS.SUCCESS,
    details: probe.details,
    debug: actionDebug,
    newUrl: afterUrl,
    triggeredNavigation: beforeUrl !== afterUrl
  };
}

async function typeAt(runner, action) {
  const page = runner.page;
  if (typeof action.text !== "string") {
    return withCurrentUrl(runner, {
      status: ACTION_RESULT_STATUS.VALIDATION_ERROR,
      details: "Type action requires text.",
      triggeredNavigation: false
    });
  }

  const point = await resolvePoint(page, action.x, action.y);
  await showActionMarker(page, point, "type");
  const probe = await page.evaluate(({ x, y }) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const elementDebug = (element) => {
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName?.toLowerCase?.() || "",
        id: element.id || "",
        className: normalize(element.className || ""),
        role: element.getAttribute("role") || "",
        type: element.getAttribute("type") || "",
        name: element.getAttribute("name") || "",
        placeholder: element.getAttribute("placeholder") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        text: normalize(element.textContent || "").slice(0, 180),
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    };

    const raw = document.elementFromPoint(x, y);
    if (!raw) {
      return { status: "target_not_found", details: "No element found at that coordinate.", hitElement: null, matchedElement: null };
    }

    const target = raw.closest("input, textarea, [contenteditable='true'], [role='textbox']") || raw;
    const isEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable ||
      target.getAttribute("role") === "textbox";

    if (!isEditable) {
      return {
        status: "validation_error",
        details: "The selected element is not text-editable.",
        hitElement: elementDebug(raw),
        matchedElement: elementDebug(target)
      };
    }

    const attrs = [target.getAttribute("type"), target.getAttribute("autocomplete"), target.getAttribute("name"), target.getAttribute("id")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/(password|credit|card|cvc|cvv|otp|one-time-code|ssn)/.test(attrs)) {
      return { status: "blocked", details: "Blocked typing into a sensitive field.", hitElement: elementDebug(raw), matchedElement: elementDebug(target) };
    }

    return { status: "ok", hitElement: elementDebug(raw), matchedElement: elementDebug(target) };
  }, { x: point.x, y: point.y });
  const actionDebug = buildActionDebug(action, point, probe);

  if (probe.status !== "ok") {
    return withCurrentUrl(runner, {
      status: mapStatus(probe.status),
      details: probe.details,
      debug: actionDebug,
      triggeredNavigation: false
    });
  }

  const beforeUrl = page.url();
  await page.mouse.click(point.x, point.y, { delay: 25 });
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await page.keyboard.press(selectAllShortcut);
  await page.keyboard.press("Backspace");
  if (action.text.length) {
    await page.keyboard.type(action.text, { delay: 20 });
  }
  if (action.pressEnter) {
    await page.keyboard.press("Enter");
  }

  await waitForPossibleNavigation(page, beforeUrl);
  const afterUrl = page.url();
  if (!isSameOrigin(afterUrl, runner.allowedOrigin)) {
    await safeGoBack(page);
    return withCurrentUrl(runner, {
      status: ACTION_RESULT_STATUS.BLOCKED,
      details: `Blocked navigation outside start domain: ${afterUrl}`,
      debug: actionDebug,
      triggeredNavigation: false
    });
  }

  const navigated = beforeUrl !== afterUrl;
  return {
    status: navigated ? ACTION_RESULT_STATUS.NAVIGATION : ACTION_RESULT_STATUS.CHANGED_DOM,
    details: action.pressEnter ? "Typed text and pressed Enter." : "Typed text.",
    debug: actionDebug,
    newUrl: afterUrl,
    triggeredNavigation: navigated
  };
}

async function scrollDocument(runner, scrollAmount) {
  const page = runner.page;
  const delta = Number.isFinite(scrollAmount) ? Number(scrollAmount) : Math.round(DEFAULT_VIEWPORT.height * 0.8);
  await page.mouse.wheel(0, delta);
  await wait(450);
  return withCurrentUrl(runner, {
    status: ACTION_RESULT_STATUS.CHANGED_DOM,
    details: `Scrolled by ${delta}px.`,
    triggeredNavigation: false
  });
}

async function waitAction(waitMs) {
  const timeout = Number.isFinite(waitMs) ? Math.max(200, Math.min(15000, Number(waitMs))) : 5000;
  await wait(timeout);
  return {
    status: ACTION_RESULT_STATUS.SUCCESS,
    details: `Waited ${timeout}ms.`,
    newUrl: undefined,
    triggeredNavigation: false
  };
}

async function goBack(runner) {
  const page = runner.page;
  const beforeUrl = page.url();
  await safeGoBack(page);
  const afterUrl = page.url();
  if (!isSameOrigin(afterUrl, runner.allowedOrigin)) {
    await safeGoBack(page);
    return withCurrentUrl(runner, {
      status: ACTION_RESULT_STATUS.BLOCKED,
      details: "Blocked back navigation outside start domain.",
      triggeredNavigation: false
    });
  }

  const navigated = beforeUrl !== afterUrl;
  return {
    status: navigated ? ACTION_RESULT_STATUS.NAVIGATION : ACTION_RESULT_STATUS.SUCCESS,
    details: navigated ? "Went back in history." : "No browser history to go back.",
    newUrl: afterUrl,
    triggeredNavigation: navigated
  };
}

async function navigate(runner, rawUrl) {
  const page = runner.page;
  if (!rawUrl) {
    return withCurrentUrl(runner, {
      status: ACTION_RESULT_STATUS.VALIDATION_ERROR,
      details: "Navigate action requires a URL.",
      triggeredNavigation: false
    });
  }

  let resolvedUrl;
  try {
    resolvedUrl = new URL(rawUrl, page.url()).toString();
  } catch {
    return withCurrentUrl(runner, {
      status: ACTION_RESULT_STATUS.VALIDATION_ERROR,
      details: "Navigate action URL is invalid.",
      triggeredNavigation: false
    });
  }

  if (!isSameOrigin(resolvedUrl, runner.allowedOrigin)) {
    return withCurrentUrl(runner, {
      status: ACTION_RESULT_STATUS.BLOCKED,
      details: `Blocked navigation outside start domain: ${resolvedUrl}`,
      triggeredNavigation: false
    });
  }

  const beforeUrl = page.url();
  await page.goto(resolvedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const afterUrl = page.url();
  return {
    status: beforeUrl !== afterUrl ? ACTION_RESULT_STATUS.NAVIGATION : ACTION_RESULT_STATUS.SUCCESS,
    details: `Navigated to ${resolvedUrl}.`,
    newUrl: afterUrl,
    triggeredNavigation: beforeUrl !== afterUrl
  };
}

async function resolvePoint(page, x, y) {
  const viewport = page.viewportSize() || DEFAULT_VIEWPORT;
  const rawX = Number(x);
  const rawY = Number(y);
  const px =
    Number.isFinite(rawX) && rawX >= 0 && rawX <= 999
      ? Math.round((rawX / 1000) * viewport.width)
      : Number(rawX) <= 1
        ? Math.round(Number(rawX) * viewport.width)
        : Math.round(Number(rawX));
  const py =
    Number.isFinite(rawY) && rawY >= 0 && rawY <= 999
      ? Math.round((rawY / 1000) * viewport.height)
      : Number(rawY) <= 1
        ? Math.round(Number(rawY) * viewport.height)
        : Math.round(Number(rawY));
  return {
    x: Math.max(1, Math.min(viewport.width - 1, Number.isFinite(px) ? px : Math.round(viewport.width / 2))),
    y: Math.max(1, Math.min(viewport.height - 1, Number.isFinite(py) ? py : Math.round(viewport.height / 2)))
  };
}

async function waitForPossibleNavigation(page, beforeUrl = page.url()) {
  const navigationStarted = await Promise.race([
    page
      .waitForEvent("framenavigated", {
        timeout: 1500,
        predicate: (frame) => frame === page.mainFrame()
      })
      .then(() => true)
      .catch(() => false),
    wait(300).then(() => false)
  ]);

  const urlChanged = normalizeUrl(page.url()) !== normalizeUrl(beforeUrl);
  if (navigationStarted || urlChanged) {
    await settleAfterNavigation(page);
    return;
  }

  await Promise.race([
    page.waitForLoadState("domcontentloaded", { timeout: 1200 }).catch(() => {}),
    wait(500)
  ]);
}

async function settleAfterNavigation(page) {
  await Promise.race([
    page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {}),
    wait(700)
  ]);
  await wait(200);
}

function isNavigationContextError(error) {
  const message = `${error?.message || error || ""}`.toLowerCase();
  return (
    message.includes("execution context was destroyed") ||
    message.includes("most likely because of a navigation") ||
    message.includes("cannot find context with specified id")
  );
}

async function safeGoBack(page) {
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null);
}

function mapStatus(status) {
  switch (status) {
    case "target_not_found":
      return ACTION_RESULT_STATUS.TARGET_NOT_FOUND;
    case "blocked":
      return ACTION_RESULT_STATUS.BLOCKED;
    case "validation_error":
      return ACTION_RESULT_STATUS.VALIDATION_ERROR;
    default:
      return ACTION_RESULT_STATUS.VALIDATION_ERROR;
  }
}

function withCurrentUrl(runner, payload) {
  return {
    ...payload,
    newUrl: runner.page.url()
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function showActionMarker(page, point, label) {
  if (!SHOW_ACTION_MARKER) {
    return;
  }

  await page
    .evaluate(
      ({ x, y, labelText }) => {
        const existing = document.getElementById("__gcu_action_marker");
        if (existing) {
          existing.remove();
        }

        const marker = document.createElement("div");
        marker.id = "__gcu_action_marker";
        marker.style.position = "fixed";
        marker.style.left = `${x - 14}px`;
        marker.style.top = `${y - 14}px`;
        marker.style.width = "28px";
        marker.style.height = "28px";
        marker.style.border = "2px solid #ff3b30";
        marker.style.borderRadius = "999px";
        marker.style.background = "rgba(255, 59, 48, 0.15)";
        marker.style.pointerEvents = "none";
        marker.style.zIndex = "2147483647";
        marker.style.boxShadow = "0 0 0 1px rgba(255,255,255,0.95)";

        const text = document.createElement("div");
        text.textContent = `${labelText} @ ${x},${y}`;
        text.style.position = "absolute";
        text.style.left = "20px";
        text.style.top = "-22px";
        text.style.padding = "2px 6px";
        text.style.font = "11px monospace";
        text.style.color = "#fff";
        text.style.background = "rgba(0,0,0,0.8)";
        text.style.borderRadius = "4px";
        marker.appendChild(text);

        document.body.appendChild(marker);
        setTimeout(() => {
          marker.remove();
        }, ACTION_OVERLAY_MS);
      },
      { x: point.x, y: point.y, labelText: label || "action" }
    )
    .catch(() => {});
}

function buildActionDebug(action, point, probe) {
  return {
    requested: {
      x: action.x,
      y: action.y
    },
    resolved: {
      x: point.x,
      y: point.y
    },
    hitElement: probe?.hitElement || null,
    matchedElement: probe?.matchedElement || null
  };
}

async function showActionBanner(page, action) {
  if (!SHOW_ACTION_MARKER) {
    return;
  }

  const parts = [action?.actionType || "action"];
  if (Number.isFinite(action?.x) && Number.isFinite(action?.y)) {
    parts.push(`(${Math.round(action.x)}, ${Math.round(action.y)})`);
  }
  if (typeof action?.text === "string" && action.text.trim()) {
    parts.push(`"${truncate(action.text, 40)}"`);
  }
  if (typeof action?.url === "string" && action.url.trim()) {
    parts.push(truncate(action.url, 60));
  }
  if (Number.isFinite(action?.scrollAmount)) {
    parts.push(`delta=${Math.round(action.scrollAmount)}`);
  }
  if (Number.isFinite(action?.waitMs)) {
    parts.push(`wait=${Math.round(action.waitMs)}ms`);
  }
  const message = parts.join(" ");

  await page
    .evaluate(
      ({ text, ttl }) => {
        const id = "__gcu_action_banner";
        const existing = document.getElementById(id);
        if (existing) {
          existing.remove();
        }

        const banner = document.createElement("div");
        banner.id = id;
        banner.textContent = text;
        banner.style.position = "fixed";
        banner.style.top = "12px";
        banner.style.right = "12px";
        banner.style.maxWidth = "72vw";
        banner.style.padding = "8px 10px";
        banner.style.font = "12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace";
        banner.style.color = "#fff";
        banner.style.background = "rgba(17, 24, 39, 0.88)";
        banner.style.border = "1px solid rgba(255,255,255,0.25)";
        banner.style.borderRadius = "8px";
        banner.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
        banner.style.pointerEvents = "none";
        banner.style.zIndex = "2147483647";
        document.body.appendChild(banner);

        setTimeout(() => {
          banner.remove();
        }, ttl);
      },
      { text: message, ttl: ACTION_OVERLAY_MS }
    )
    .catch(() => {});
}

function truncate(value, maxLength) {
  const text = `${value || ""}`.trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}
