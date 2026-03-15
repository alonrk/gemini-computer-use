(function bootstrap() {
  const overlayId = "__gemini_browser_use_highlight__";
  let lastElementMap = new Map();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ping") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "collect-observation") {
      sendResponse(collectObservation());
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

  function collectObservation() {
    const interactiveElements = listInteractiveElements();
    lastElementMap = new Map(interactiveElements.map((entry) => [entry.elementId, entry.element]));

    return {
      url: location.href,
      title: document.title,
      domSummary: buildDomSummary(interactiveElements),
      interactiveElements: interactiveElements.map(stripElementReference)
    };
  }

  async function executeAction(action) {
    switch (action.type) {
      case "click":
        return clickTarget(action.target?.elementId);
      case "type":
        return typeIntoTarget(action.target?.elementId, action.value);
      case "scroll":
        return scrollTarget(action.target?.elementId);
      case "wait":
        await wait(action.waitMs || 1000);
        return { status: "success", details: `Waited ${action.waitMs || 1000}ms.` };
      default:
        return { status: "validation_error", details: `Unsupported action: ${action.type}` };
    }
  }

  function listInteractiveElements() {
    const candidates = [...document.querySelectorAll("a, button, input, textarea, select, [role='button'], [contenteditable='true']")];
    let visibleIndex = 0;

    return candidates
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0;
        if (!visible) {
          return null;
        }

        visibleIndex += 1;
        return {
          elementId: buildElementId(element, visibleIndex),
          element,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || "",
          text: normalize(element.innerText || element.value || ""),
          ariaLabel: element.getAttribute("aria-label") || "",
          placeholder: element.getAttribute("placeholder") || "",
          href: element.getAttribute("href") || "",
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          visible: true,
          enabled: !element.disabled
        };
      })
      .filter(Boolean)
      .slice(0, 50);
  }

  function buildDomSummary(interactiveElements) {
    const headings = [...document.querySelectorAll("h1, h2, h3")]
      .map((element) => normalize(element.textContent))
      .filter(Boolean)
      .slice(0, 6);
    const bodyText = normalize(document.body?.innerText || "").slice(0, 1000);
    const interactiveSummary = interactiveElements
      .slice(0, 20)
      .map((element) => `${element.elementId}: ${element.tag} ${element.text || element.ariaLabel || element.placeholder}`.trim())
      .join(" | ");

    return [`Headings: ${headings.join(" | ")}`, `Visible text: ${bodyText}`, `Interactive: ${interactiveSummary}`].join("\n");
  }

  async function clickTarget(elementId) {
    const element = getTargetElement(elementId);
    if (!element) {
      return { status: "target_not_found", details: `Target ${elementId} is no longer available.` };
    }
    if (isBlockedElement(element)) {
      return { status: "blocked", details: "Blocked a sensitive or disabled element." };
    }

    highlightElement(element);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await wait(150);
    const beforeUrl = location.href;
    element.click();
    await wait(500);

    return {
      status: beforeUrl !== location.href ? "navigation" : "success",
      details: `Clicked ${describeElement(element)}.`
    };
  }

  async function typeIntoTarget(elementId, value) {
    const element = getTargetElement(elementId);
    if (!element) {
      return { status: "target_not_found", details: `Target ${elementId} is no longer available.` };
    }
    if (isBlockedElement(element) || isSensitiveInput(element)) {
      return { status: "blocked", details: "Blocked typing into a sensitive or disabled field." };
    }
    if (typeof value !== "string") {
      return { status: "validation_error", details: "Type actions require a string value." };
    }

    highlightElement(element);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await wait(150);
    element.focus();

    if (isTextEntryElement(element)) {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (element.isContentEditable) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    } else {
      return { status: "validation_error", details: "Target element is not text-editable." };
    }

    return {
      status: "changed_dom",
      details: `Typed into ${describeElement(element)}.`
    };
  }

  async function scrollTarget(elementId) {
    if (elementId) {
      const element = getTargetElement(elementId);
      if (!element) {
        return { status: "target_not_found", details: `Target ${elementId} is no longer available.` };
      }

      highlightElement(element);
      element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    } else {
      window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: "smooth" });
    }

    await wait(400);
    return { status: "changed_dom", details: "Scrolled the page." };
  }

  function getTargetElement(elementId) {
    return lastElementMap.get(elementId) || null;
  }

  function buildElementId(element, index) {
    const parts = [
      element.tagName.toLowerCase(),
      normalize(element.getAttribute("aria-label")),
      normalize(element.getAttribute("placeholder")),
      normalize(element.innerText).slice(0, 30)
    ]
      .filter(Boolean)
      .join("-");

    return `el-${index}-${slugify(parts || element.tagName.toLowerCase())}`;
  }

  function stripElementReference(entry) {
    const { element, ...rest } = entry;
    return rest;
  }

  function isBlockedElement(element) {
    return element.disabled || element.closest("[aria-disabled='true']") || isSensitiveInput(element);
  }

  function isSensitiveInput(element) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return false;
    }

    const combined = [element.type, element.autocomplete, element.name, element.id].join(" ").toLowerCase();
    return /(password|credit|card|cvc|cvv|otp|one-time-code|ssn)/.test(combined);
  }

  function isTextEntryElement(element) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  }

  function describeElement(element) {
    return normalize(element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.tagName.toLowerCase());
  }

  function highlightElement(element) {
    let overlay = document.getElementById(overlayId);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = overlayId;
      overlay.style.position = "fixed";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "2147483647";
      overlay.style.border = "2px solid #ff6b35";
      overlay.style.boxShadow = "0 0 0 9999px rgba(255, 107, 53, 0.08)";
      overlay.style.borderRadius = "10px";
      document.documentElement.appendChild(overlay);
    }

    const rect = element.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    clearTimeout(highlightElement._timeoutId);
    highlightElement._timeoutId = setTimeout(() => {
      overlay?.remove();
    }, 1200);
  }

  function normalize(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function slugify(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
