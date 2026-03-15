import { ACTION_TYPES } from "../shared/protocol.js";

const MAX_STEPS = 8;

export function extractJsonObject(rawText) {
  if (!rawText) {
    return null;
  }

  const trimmed = rawText.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/(\{[\s\S]*\})/);
    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
}

export function normalizeAction(candidate, stepCount = 0) {
  if (!candidate || typeof candidate !== "object") {
    return {
      type: ACTION_TYPES.FAIL,
      rationale: "Gemini did not return a valid action object."
    };
  }

  if (stepCount >= MAX_STEPS) {
    return {
      type: ACTION_TYPES.FAIL,
      rationale: "Stopped after reaching the maximum number of browser steps for this run."
    };
  }

  const type = `${candidate.type ?? ""}`.toLowerCase();
  const allowedTypes = new Set(Object.values(ACTION_TYPES));

  if (!allowedTypes.has(type)) {
    return {
      type: ACTION_TYPES.FAIL,
      rationale: `Gemini returned an unsupported action type: ${type || "unknown"}.`
    };
  }

  return {
    id: candidate.id,
    type,
    rationale: candidate.rationale || "No rationale provided.",
    target: candidate.target ?? null,
    value: candidate.value ?? null,
    waitMs: Number.isFinite(candidate.waitMs) ? Math.max(0, Math.min(candidate.waitMs, 15000)) : undefined,
    requiresConfirmation: Boolean(candidate.requiresConfirmation)
  };
}

export function buildFallbackAction(session, observation) {
  const prompt = `${session.prompt ?? ""}`.toLowerCase();
  const elements = observation?.interactiveElements ?? [];

  const clickMatch = prompt.match(/click\s+(.+)/i);
  if (clickMatch) {
    const query = clickMatch[1].trim();
    const element = findElementByHint(elements, query);
    if (element) {
      return {
        type: ACTION_TYPES.CLICK,
        rationale: `Fallback matched a click target for "${query}".`,
        target: {
          elementId: element.elementId,
          text: element.text,
          ariaLabel: element.ariaLabel
        }
      };
    }
  }

  const typeMatch = prompt.match(/type\s+["“]?(.+?)["”]?\s+(?:into|in)\s+(.+)/i);
  if (typeMatch) {
    const value = typeMatch[1].trim();
    const query = typeMatch[2].trim();
    const element = findElementByHint(elements, query);
    if (element) {
      return {
        type: ACTION_TYPES.TYPE,
        rationale: `Fallback matched a typing target for "${query}".`,
        value,
        target: {
          elementId: element.elementId,
          text: element.text,
          ariaLabel: element.ariaLabel,
          placeholder: element.placeholder
        }
      };
    }
  }

  return {
    type: ACTION_TYPES.FAIL,
    rationale: "No Gemini API key was available, and the local fallback could not infer a safe action from the prompt."
  };
}

function findElementByHint(elements, query) {
  const normalizedQuery = query.toLowerCase();

  return elements.find((element) => {
    const haystack = [
      element.text,
      element.ariaLabel,
      element.placeholder,
      element.role,
      element.tag,
      element.href
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}
