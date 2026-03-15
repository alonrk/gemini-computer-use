import test from "node:test";
import assert from "node:assert/strict";
import { actionNeedsConfirmation, isRestrictedUrl, isSensitiveField } from "../shared/protocol.js";
import { extractJsonObject, normalizeAction } from "../server/agent.js";

test("restricted URLs are detected", () => {
  assert.equal(isRestrictedUrl("chrome://settings"), true);
  assert.equal(isRestrictedUrl("https://example.com"), false);
});

test("sensitive fields are detected", () => {
  assert.equal(isSensitiveField({ type: "password" }), true);
  assert.equal(isSensitiveField({ autocomplete: "email" }), false);
  assert.equal(isSensitiveField({ name: "creditCardNumber" }), true);
});

test("dangerous actions require confirmation", () => {
  assert.equal(actionNeedsConfirmation({ rationale: "Click the delete account button" }), true);
  assert.equal(actionNeedsConfirmation({ rationale: "Open the pricing page" }), false);
});

test("extractJsonObject parses fenced JSON", () => {
  const parsed = extractJsonObject('```json\n{"type":"click","rationale":"Open details"}\n```');
  assert.deepEqual(parsed, { type: "click", rationale: "Open details" });
});

test("normalizeAction rejects unsupported actions", () => {
  const action = normalizeAction({ type: "teleport" }, 0);
  assert.equal(action.type, "fail");
});
