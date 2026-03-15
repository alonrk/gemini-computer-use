import { extractJsonObject, normalizeAction, buildFallbackAction } from "./agent.js";
import { ACTION_TYPES } from "../shared/protocol.js";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export async function chooseNextAction(session, observation) {
  if (!process.env.GEMINI_API_KEY) {
    return buildFallbackAction(session, observation);
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: buildPrompt(session, observation)
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    return {
      type: ACTION_TYPES.FAIL,
      rationale: `Gemini request failed with ${response.status}: ${body.slice(0, 200)}`
    };
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
  const parsed = extractJsonObject(text);
  return normalizeAction(parsed, session.history.length);
}

function buildPrompt(session, observation) {
  const priorSteps = session.history.map((entry, index) => ({
    step: index + 1,
    actionType: entry.actionType,
    status: entry.status,
    details: entry.details,
    newUrl: entry.newUrl ?? null
  }));

  return [
    "You are controlling a single browser tab through a safe action API.",
    "Choose the most relevant next action that helps fulfill the user prompt.",
    "Allowed action types: observe, click, type, scroll, wait, finish, fail.",
    "Stay in the current tab only. Do not attempt downloads, passwords, or browser chrome pages.",
    "Do not repeat the same action on the same target unless the page clearly changed and the repeated action is still necessary.",
    "After each action, inspect the new observation and decide what changed before choosing another step.",
    "You may continue through a checkout flow after add-to-cart, including viewing/opening the cart, clicking checkout, filling shipping/contact fields, and selecting shipping options, as long as you stop before the final payment authorization or order placement action.",
    "If the last action succeeded but the relevant UI state did not change, do not keep retrying indefinitely. Try one different diagnostic step such as observe, scroll, or a different target, then fail if the page still does not progress.",
    "Use finish when the requested outcome is already achieved on the current page, even if more clickable actions remain available.",
    "If the task is complete, return finish with a short rationale.",
    "If the task cannot be completed safely, return fail with a short rationale.",
    "When clicking or typing, target.elementId should match one of the provided interactive elements.",
    "Return JSON only with this shape:",
    JSON.stringify({
      type: "click",
      rationale: "why this helps",
      target: { elementId: "el-1" },
      value: "text for type actions",
      waitMs: 1000,
      requiresConfirmation: false
    }),
    "",
    `User prompt: ${session.prompt}`,
    `Current URL: ${observation.url}`,
    `Page title: ${observation.title}`,
    `DOM summary: ${observation.domSummary}`,
    `Interactive elements: ${JSON.stringify(observation.interactiveElements)}`,
    `Prior steps: ${JSON.stringify(priorSteps)}`
  ].join("\n");
}
