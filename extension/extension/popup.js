const API_URL = "https://allformatsready.onrender.com";

// ── State ──
let selectedFile = null;
let allFiles = [];
let activePortal = null;
let currentTabUrl = "";

// ── Elements ──
const portalBanner  = document.getElementById("portalBanner");
const portalIcon    = document.getElementById("portalIcon");
const portalName    = document.getElementById("portalName");
const portalReq     = document.getElementById("portalReq");
const dropZone      = document.getElementById("dropZone");
const fileInput     = document.getElementById("fileInput");
const filePreview   = document.getElementById("filePreview");
const fpIcon        = document.getElementById("fpIcon");
const fpName        = document.getElementById("fpName");
const fpSize        = document.getElementById("fpSize");
const fpRemove      = document.getElementById("fpRemove");
const btnConvert    = document.getElementById("btnConvert");
const progressWrap  = document.getElementById("progressWrap");
const progressFill  = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const errorWrap     = document.getElementById("errorWrap");
const uploadSection = document.getElementById("uploadSection");
const resultsWrap   = document.getElementById("resultsWrap");
const resultsCount  = document.getElementById("resultsCount");
const cardsList     = document.getElementById("cardsList");
const btnZip        = document.getElementById("btnZip");
const btnAgain      = document.getElementById("btnAgain");

// ── Helpers ──
function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "pdf") return "📋";
  if (["jpg","jpeg"].includes(ext)) return "📷";
  if (ext === "png") return "🖼️";
  if (ext === "gif") return "🎞️";
  if (ext === "bmp") return "🖼️";
  if (["tiff","tif"].includes(ext)) return "🗂️";
  if (ext === "svg") return "✏️";
  if (ext === "psd") return "🎨";
  if (ext === "ico") return "🔷";
  if (ext === "webp") return "🌐";
  if (["heic","heif"].includes(ext)) return "📱";
  return "📄";
}

function fmtClass(fmt) {
  const m = {
    JPG:"fmt-jpg", PNG:"fmt-png", WEBP:"fmt-webp",
    PDF:"fmt-pdf", DOCX:"fmt-docx",
    GIF:"fmt-gif", BMP:"fmt-bmp", TIFF:"fmt-tiff", ICO:"fmt-ico"
  };
  return m[fmt.toUpperCase()] || "fmt-jpg";
}

function showError(msg) {
  errorWrap.textContent = "⚠️ " + msg;
  errorWrap.classList.add("show");
}

function hideError() {
  errorWrap.classList.remove("show");
}

// ── Detect current tab portal ──
async function detectCurrentPortal() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    currentTabUrl = tab.url;
    const portal = detectPortal(tab.url);
    if (portal) {
      activePortal = portal;
      portalIcon.textContent = portal.icon;
      portalName.textContent = "Detected: " + portal.name;
      portalReq.textContent = portal.req;
      portalBanner.classList.add("show");
      if (portal.id === "general") portalBanner.classList.add("general");
    } else {
      // Unknown site — show general suggestion
      activePortal = PORTAL_MAP.find(p => p.id === "general");
      portalIcon.textContent = "🌐";
      portalName.textContent = "All formats available";
      portalReq.textContent = "No specific portal detected — download what you need";
      portalBanner.classList.add("show","general");
    }
  } catch(e) {
    // No tab access — silent fail
  }
}

// ── File handling ──
function setFile(file) {
  if (file.size > 15 * 1024 * 1024) {
    showError("File too large. Maximum 15MB.");
    return;
  }
  selectedFile = file;
  fpIcon.textContent = getFileIcon(file.name);
  fpName.textContent = file.name;
  fpSize.textContent = formatBytes(file.size);
  filePreview.classList.add("show");
  dropZone.style.display = "none";
  btnConvert.disabled = false;
  hideError();
}

function reset() {
  selectedFile = null;
  allFiles = [];
  fileInput.value = "";
  filePreview.classList.remove("show");
  dropZone.style.display = "";
  btnConvert.disabled = true;
  progressWrap.classList.remove("show");
  resultsWrap.classList.remove("show");
  uploadSection.style.display = "";
  hideError();
  progressFill.style.width = "0%";
}

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});
fpRemove.addEventListener("click", reset);
btnAgain.addEventListener("click", reset);

dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});

// ── Smart compression (same as web app) ──
const COMPRESS_THRESHOLD = 2 * 1024 * 1024;
const TARGET_SIZE = 1.8 * 1024 * 1024;

async function compressIfNeeded(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") return file;
  if (file.size <= COMPRESS_THRESHOLD) return file;

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        let w = img.width, h = img.height;
        const MAX_DIM = 2400;
        if (w > MAX_DIM || h > MAX_DIM) {
          if (w > h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
          else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);

        let lo = 0.50, hi = 0.96, bestBlob = null;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", mid));
          if (blob.size <= TARGET_SIZE) { bestBlob = blob; lo = mid; }
          else { hi = mid; }
        }
        if (!bestBlob) bestBlob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.5));
        resolve(new File([bestBlob], file.name.replace(/\.[^/.]+$/, ".jpg"), { type: "image/jpeg" }));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Convert ──
btnConvert.addEventListener("click", async () => {
  if (!selectedFile) return;
  hideError();
  btnConvert.disabled = true;
  progressWrap.classList.add("show");

  const steps = [[20,"Reading document…"],[45,"Converting formats…"],[70,"Compressing…"],[90,"Almost done…"]];
  let si = 0;
  const timer = setInterval(() => {
    if (si < steps.length) {
      progressFill.style.width = steps[si][0] + "%";
      progressLabel.textContent = steps[si][1];
      si++;
    }
  }, 800);

  try {
    const fileToSend = await compressIfNeeded(selectedFile);
    const formData = new FormData();
    formData.append("file", fileToSend);

    const res = await fetch(`${API_URL}/convert`, { method: "POST", body: formData });
    clearInterval(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Server error" }));
      throw new Error(err.detail || "Conversion failed");
    }

    const data = await res.json();
    allFiles = data.files;

    progressFill.style.width = "100%";
    progressLabel.textContent = "Done!";

    setTimeout(() => {
      progressWrap.classList.remove("show");
      btnConvert.disabled = false;
      showResults();
    }, 400);

  } catch(err) {
    clearInterval(timer);
    progressWrap.classList.remove("show");
    btnConvert.disabled = false;
    const msg = err.message || "";
    if (msg.includes("fetch") || msg.includes("Failed")) {
      showError("Server is waking up. Wait 30 seconds and try again.");
    } else {
      showError(msg || "Something went wrong. Please try again.");
    }
  }
});

// ── Show Results ──
function showResults() {
  uploadSection.style.display = "none";
  resultsWrap.classList.add("show");
  resultsCount.textContent = `${allFiles.length} files generated`;

  // Sort files: recommended first, rest below
  const recommended = [];
  const others = [];

  allFiles.forEach(f => {
    if (activePortal && activePortal.id !== "general" && activePortal.match(f)) {
      recommended.push({ ...f, isRecommended: true });
    } else {
      others.push({ ...f, isRecommended: false });
    }
  });

  cardsList.innerHTML = "";

  // Auto-fill button — shown at top of results
  const autoFillBtn = document.createElement("button");
  autoFillBtn.id = "btnAutoFill";
  autoFillBtn.style.cssText = `
    display:block;width:100%;margin-bottom:10px;padding:9px;
    background:#2563EB;color:#fff;border:none;border-radius:8px;
    font-size:.78rem;font-weight:700;cursor:pointer;
  `;
  autoFillBtn.textContent = "⬆ Auto-fill on this page";
  autoFillBtn.title = "Click to pick which converted file to inject into the portal's file input";
  autoFillBtn.addEventListener("click", () => showAutoFillPicker(recommended.length > 0 ? recommended : others));
  cardsList.appendChild(autoFillBtn);

  // Recommended section
  if (recommended.length > 0) {
    const recLabel = document.createElement("div");
    recLabel.className = "section-label recommended";
    recLabel.textContent = activePortal
      ? `⭐ Recommended for ${activePortal.name}`
      : "⭐ Recommended";
    cardsList.appendChild(recLabel);
    recommended.forEach(f => cardsList.appendChild(buildCard(f, true)));
  }

  // All other formats
  const otherLabel = document.createElement("div");
  otherLabel.className = "section-label";
  otherLabel.textContent = recommended.length > 0 ? "All other formats" : "All formats";
  cardsList.appendChild(otherLabel);
  others.forEach(f => cardsList.appendChild(buildCard(f, false)));
}

// ── Build single card ──
function buildCard(f, isRecommended) {
  const card = document.createElement("div");
  card.className = "file-card" + (isRecommended ? " recommended" : " dimmed");

  const badge = document.createElement("span");
  badge.className = "card-fmt " + fmtClass(f.format);
  badge.textContent = f.format;

  const label = document.createElement("span");
  label.className = "card-label";
  label.textContent = f.label;

  const size = document.createElement("span");
  size.className = "card-size";
  size.textContent = f.size_kb + " KB";

  const dlBtn = document.createElement("button");
  dlBtn.className = "btn-dl";
  dlBtn.textContent = "⬇";
  dlBtn.title = "Download " + f.name;
  dlBtn.addEventListener("click", () => downloadFile(f));

  card.appendChild(badge);
  card.appendChild(label);
  card.appendChild(size);
  card.appendChild(dlBtn);
  return card;
}

// ── Download file ──
function downloadFile(f) {
  const ext = f.name.split(".").pop().toLowerCase();
  const mimeMap = {
    jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",
    webp:"image/webp",pdf:"application/pdf",
    docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  };
  const mime = mimeMap[ext] || "application/octet-stream";
  const byteChars = atob(f.data_b64);
  const byteArr = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
  const blob = new Blob([byteArr], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = f.name; a.click();
  URL.revokeObjectURL(url);
}

// ── ZIP download ──
btnZip.addEventListener("click", async () => {
  // Load JSZip dynamically
  if (!window.JSZip) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "jszip.min.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const zip = new JSZip();
  allFiles.forEach(f => {
    const byteChars = atob(f.data_b64);
    const byteArr = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
    zip.file(`allformatsready/${f.category}/${f.name}`, byteArr);
  });
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "allformatsready.zip"; a.click();
  URL.revokeObjectURL(url);
});

// ── Auto-fill picker ──
function showAutoFillPicker(files) {
  // Remove existing picker if any
  const existing = document.getElementById("autoFillPicker");
  if (existing) { existing.remove(); return; }

  const picker = document.createElement("div");
  picker.id = "autoFillPicker";
  picker.style.cssText = `
    background:#F9FAFB;border:1.5px solid #BFDBFE;border-radius:8px;
    padding:10px;margin-bottom:8px;
  `;

  const title = document.createElement("div");
  title.style.cssText = "font-size:.72rem;font-weight:700;color:#1D4ED8;margin-bottom:8px;";
  title.textContent = "Select file to auto-fill on this page:";
  picker.appendChild(title);

  // Show top 5 files to keep picker compact
  const topFiles = files.slice(0, 5);
  topFiles.forEach(f => {
    const btn = document.createElement("button");
    btn.style.cssText = `
      display:block;width:100%;text-align:left;padding:6px 8px;margin-bottom:4px;
      background:#fff;border:1px solid #E5E7EB;border-radius:6px;
      font-size:.72rem;font-weight:600;color:#1F2937;cursor:pointer;
    `;
    btn.textContent = `${f.format} — ${f.label} (${f.size_kb}KB)`;
    btn.addEventListener("mouseenter", () => btn.style.background = "#EFF6FF");
    btn.addEventListener("mouseleave", () => btn.style.background = "#fff");
    btn.addEventListener("click", async () => {
      picker.remove();

      // Get mime type
      const mimeMap = {
        jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png",
        webp:"image/webp", pdf:"application/pdf",
        docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        gif:"image/gif", bmp:"image/bmp", tiff:"image/tiff", ico:"image/x-icon"
      };
      const ext = f.name.split(".").pop().toLowerCase();
      const mime = mimeMap[ext] || "application/octet-stream";

      // Send to content script
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.tabs.sendMessage(tab.id, {
        action: "INJECT_FILE",
        file: { name: f.name, data_b64: f.data_b64, format: f.format, mime }
      }, (res) => {
        if (chrome.runtime.lastError || !res) {
          // Content script not ready on this page
          alert("⚠️ Cannot auto-fill on this page. Please download the file and upload manually.");
          return;
        }
        if (res.count === 0) {
          alert("⚠️ No file upload fields found on this page.");
        }
      });
    });
    picker.appendChild(btn);
  });

  const cancel = document.createElement("button");
  cancel.style.cssText = `
    display:block;width:100%;padding:5px;margin-top:4px;
    background:none;border:none;font-size:.7rem;color:#6B7280;cursor:pointer;
  `;
  cancel.textContent = "✕ Cancel";
  cancel.addEventListener("click", () => picker.remove());
  picker.appendChild(cancel);

  // Insert picker above the auto-fill button
  const autoFillBtn = document.getElementById("btnAutoFill");
  cardsList.insertBefore(picker, autoFillBtn);
}

// ── Init ──
// Listen for fill success from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "FILL_SUCCESS") {
    const btn = document.getElementById("btnAutoFill");
    if (btn) {
      btn.textContent = "✅ File injected successfully!";
      btn.style.background = "#16A34A";
      setTimeout(() => {
        btn.textContent = "⬆ Auto-fill on this page";
        btn.style.background = "#2563EB";
      }, 3000);
    }
  }
});
detectCurrentPortal();
// Keep backend awake
fetch(API_URL + "/ping").catch(() => {});
