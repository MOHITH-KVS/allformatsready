// AllFormatsReady — Content Script
// Handles file injection into portal file inputs

let highlightedInputs = [];
let overlays = [];
let injectedFile = null;

// ── Listen for messages from popup ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === "HIGHLIGHT_INPUTS") {
    // Find all file inputs on the page
    highlightInputs();
    sendResponse({ count: highlightedInputs.length });
    return true;
  }

  if (msg.action === "INJECT_FILE") {
    // Store file data sent from popup
    injectedFile = msg.file; // { name, data_b64, format, mime }
    highlightInputs(true); // highlight with "click to fill" mode
    sendResponse({ count: highlightedInputs.length });
    return true;
  }

  if (msg.action === "CLEAR_HIGHLIGHTS") {
    clearHighlights();
    sendResponse({ ok: true });
    return true;
  }

});

// ── Find and highlight all file inputs ──
function highlightInputs(fillMode = false) {
  clearHighlights();
  highlightedInputs = Array.from(document.querySelectorAll('input[type="file"]'))
    .filter(el => el.offsetParent !== null); // only visible ones

  highlightedInputs.forEach((input, idx) => {
    const rect = input.getBoundingClientRect();

    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed;
      top: ${rect.top + window.scrollY}px;
      left: ${rect.left}px;
      width: ${Math.max(rect.width, 120)}px;
      height: ${Math.max(rect.height, 36)}px;
      background: ${fillMode ? "rgba(37,99,235,0.15)" : "rgba(37,99,235,0.08)"};
      border: 2px solid #2563EB;
      border-radius: 6px;
      z-index: 999999;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: sans-serif;
      font-size: 12px;
      font-weight: 700;
      color: #1D4ED8;
      pointer-events: all;
      box-shadow: 0 2px 8px rgba(37,99,235,0.2);
      transition: background 0.15s;
    `;

    overlay.textContent = fillMode
      ? `⬆ Fill with converted file`
      : `📎 File input #${idx + 1}`;

    overlay.addEventListener("mouseenter", () => {
      overlay.style.background = "rgba(37,99,235,0.25)";
    });
    overlay.addEventListener("mouseleave", () => {
      overlay.style.background = fillMode
        ? "rgba(37,99,235,0.15)"
        : "rgba(37,99,235,0.08)";
    });

    if (fillMode && injectedFile) {
      overlay.addEventListener("click", () => {
        injectFileIntoInput(input, injectedFile);
        clearHighlights();
        // Notify popup that fill was successful
        chrome.runtime.sendMessage({
          action: "FILL_SUCCESS",
          inputIndex: idx
        });
      });
    }

    // Position relative to document scroll
    overlay.style.position = "absolute";
    overlay.style.top = (rect.top + window.scrollY) + "px";
    overlay.style.left = (rect.left + window.scrollX) + "px";

    document.body.appendChild(overlay);
    overlays.push(overlay);
  });

  // Auto-clear highlights after 10 seconds
  setTimeout(clearHighlights, 10000);
}

// ── Inject file into input element ──
function injectFileIntoInput(inputEl, fileData) {
  try {
    // Decode base64 to bytes
    const byteChars = atob(fileData.data_b64);
    const byteArr = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteArr[i] = byteChars.charCodeAt(i);
    }

    const blob = new Blob([byteArr], { type: fileData.mime });
    const file = new File([blob], fileData.name, { type: fileData.mime });

    // Inject using DataTransfer API
    const dt = new DataTransfer();
    dt.items.add(file);
    inputEl.files = dt.files;

    // Trigger change event so portal JS picks it up
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));

    // Visual success feedback
    showToast(`✅ File injected: ${fileData.name}`);
  } catch (e) {
    showToast("⚠️ Could not auto-fill this field. Please upload manually.");
  }
}

// ── Clear all overlays ──
function clearHighlights() {
  overlays.forEach(o => o.remove());
  overlays = [];
  highlightedInputs = [];
}

// ── Toast notification ──
function showToast(message) {
  const existing = document.getElementById("afr-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "afr-toast";
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #1F2937;
    color: #fff;
    padding: 12px 18px;
    border-radius: 10px;
    font-family: sans-serif;
    font-size: 13px;
    font-weight: 600;
    z-index: 9999999;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    animation: afrSlideIn 0.2s ease;
  `;
  toast.textContent = message;

  const style = document.createElement("style");
  style.textContent = `
    @keyframes afrSlideIn {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
