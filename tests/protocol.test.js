import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_RESULT_STATUS,
  buildPageFingerprint,
  isRestrictedUrl,
  isSensitiveField,
  normalizeUrl,
  samePage
} from "../shared/protocol.js";
import {
  detectLoop,
  extractFunctionCalls,
  inferPlannerPhase,
  normalizeModelAction
} from "../server/agent.js";

test("restricted URLs are detected", () => {
  assert.equal(isRestrictedUrl("chrome://settings"), true);
  assert.equal(isRestrictedUrl("https://example.com"), false);
});

test("action result statuses include low_progress and no_effect", () => {
  assert.equal(ACTION_RESULT_STATUS.NO_EFFECT, "no_effect");
  assert.equal(ACTION_RESULT_STATUS.LOW_PROGRESS, "low_progress");
});

test("sensitive fields are detected", () => {
  assert.equal(isSensitiveField({ type: "password" }), true);
  assert.equal(isSensitiveField({ autocomplete: "email" }), false);
  assert.equal(isSensitiveField({ name: "creditCardNumber" }), true);
});

test("normalizeUrl strips hashes and tracking parameters", () => {
  assert.equal(
    normalizeUrl("https://example.com/shop?utm_source=test&a=1#section"),
    "https://example.com/shop?a=1"
  );
});

test("buildPageFingerprint is stable for visible content", () => {
  const fingerprint = buildPageFingerprint({
    title: "Shop",
    headings: ["Dice"],
    visibleTexts: ["Add to cart"]
  });
  assert.equal(fingerprint, "shop | dice | add to cart");
});

test("samePage compares normalized URL and fingerprint", () => {
  assert.equal(
    samePage(
      { url: "https://example.com?a=1#x", pageFingerprint: "same" },
      { url: "https://example.com?a=1", pageFingerprint: "same" }
    ),
    true
  );
});

test("extractFunctionCalls returns model tool calls", () => {
  const functionCalls = extractFunctionCalls({
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                name: "click_at",
                args: { x: 10, y: 20 }
              }
            }
          ]
        }
      }
    ]
  });
  assert.deepEqual(functionCalls, [{ name: "click_at", args: { x: 10, y: 20 } }]);
});

test("normalizeModelAction translates Computer Use calls", () => {
  const action = normalizeModelAction(
    { name: "type_text_at", args: { x: 10, y: 20, text: "Necron dice" } },
    {},
    { viewport: { height: 900 } }
  );

  assert.equal(action.actionType, "type_text_at");
  assert.equal(action.text, "Necron dice");
});

test("normalizeModelAction maps press_enter for typing actions", () => {
  const action = normalizeModelAction(
    { name: "type_text_at", args: { x: 10, y: 20, text: "Necron dice", press_enter: true } },
    {},
    { viewport: { height: 900 } }
  );

  assert.equal(action.actionType, "type_text_at");
  assert.equal(action.pressEnter, true);
});

test("normalizeModelAction rejects unsupported predefined actions", () => {
  const action = normalizeModelAction(
    { name: "open_web_browser", args: {} },
    {},
    {
      interactiveHints: [
        {
          tag: "a",
          text: "Continue Browsing",
          center: { x: 560, y: 450 }
        }
      ]
    }
  );

  assert.equal(action.actionType, "fail");
  assert.match(action.rationale, /unsupported action/i);
});

test("detectLoop fails repeated identical steps on the same page", () => {
  const session = {
    history: [
      { actionType: "click_at", x: 10, y: 10 },
      { actionType: "click_at", x: 10, y: 10 }
    ],
    previousObservation: { url: "https://example.com", pageFingerprint: "same" },
    lastNormalizedUrl: "https://example.com",
    repeatedActionCount: 2,
    repeatedNavigationCount: 0
  };

  const loopError = detectLoop(session, {
    url: "https://example.com",
    pageFingerprint: "same"
  });

  assert.match(loopError, /Loop detected/);
});

test("detectLoop fails URL oscillation loops", () => {
  const session = {
    history: [{ actionType: "go_back" }],
    previousObservation: { url: "https://example.com/a", pageFingerprint: "same" },
    lastNormalizedUrl: "https://example.com/b",
    urlTrail: ["https://example.com/a", "https://example.com/b", "https://example.com/a", "https://example.com/b"],
    repeatedActionCount: 0,
    repeatedNavigationCount: 0,
    oscillationCount: 2
  };

  const loopError = detectLoop(session, {
    url: "https://example.com/a",
    pageFingerprint: "same"
  });

  assert.match(loopError, /oscillating/);
});

test("detectLoop fails when repeatedly targeting the same coordinates", () => {
  const session = {
    history: [
      { actionType: "click_at", x: 120, y: 260 },
      { actionType: "click_at", x: 120, y: 260 },
      { actionType: "click_at", x: 120, y: 260 }
    ],
    previousObservation: { url: "https://example.com", pageFingerprint: "same" },
    lastNormalizedUrl: "https://example.com",
    repeatedActionCount: 0,
    repeatedNavigationCount: 0
  };

  const loopError = detectLoop(session, {
    url: "https://example.com",
    pageFingerprint: "same"
  });

  assert.match(loopError, /same target/i);
});

test("detectLoop fails repeated validation errors even with recovery waits", () => {
  const session = {
    history: [
      { actionType: "type_text_at", x: 587, y: 43, text: "Destroyer Cult Dice", status: "validation_error", normalizedNewUrl: "https://example.com" },
      { actionType: "wait", status: "success", normalizedNewUrl: "https://example.com" },
      { actionType: "type_text_at", x: 591, y: 43, text: "Destroyer Cult Dice", status: "validation_error", normalizedNewUrl: "https://example.com" },
      { actionType: "wait", status: "success", normalizedNewUrl: "https://example.com" },
      { actionType: "type_text_at", x: 590, y: 43, text: "Destroyer Cult Dice", status: "validation_error", normalizedNewUrl: "https://example.com" },
      { actionType: "type_text_at", x: 587, y: 43, text: "Destroyer Cult Dice", status: "validation_error", normalizedNewUrl: "https://example.com" }
    ],
    previousObservation: { url: "https://example.com", pageFingerprint: "same" },
    lastNormalizedUrl: "https://example.com",
    repeatedActionCount: 0,
    repeatedNavigationCount: 0
  };

  const loopError = detectLoop(session, {
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    pageFingerprint: "same"
  });

  assert.match(loopError, /repeated invalid interactions/i);
});

test("detectLoop ignores transport recovery waits for stagnation accounting", () => {
  const session = {
    history: [{ actionType: "wait", skipPersistenceAccounting: true }],
    previousObservation: { url: "https://example.com", pageFingerprint: "same" },
    lastNormalizedUrl: "https://example.com",
    repeatedActionCount: 0,
    repeatedNavigationCount: 7
  };

  const loopError = detectLoop(session, {
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    pageFingerprint: "same"
  });

  assert.equal(loopError, null);
  assert.equal(session.repeatedNavigationCount, 0);
});

test("inferPlannerPhase returns acting after direct action steps", () => {
  const phase = inferPlannerPhase(
    {
      history: [{ actionType: "click_at", triggeredNavigation: false }]
    },
    {
      pageSummary: "Main dashboard",
      uiSignals: { errorMessages: [] }
    }
  );

  assert.equal(phase, "acting");
});
