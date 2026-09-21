// ── Passport Photo Tool ──
const PP_DPI = 300;
const MM_TO_PX = PP_DPI / 25.4;

let ppImage = null;
let ppSelectedPreset = { w:35, h:45, name:"Standard Passport" };
let ppBgColor = "#ffffff";
let ppCropX = 0, ppCropY = 0, ppCropW = 0, ppCropH = 0;
let ppDragging = false;
let ppDragStartX = 0, ppDragStartY = 0;
let ppCropStartX = 0, ppCropStartY = 0;
let ppCanvas = null, ppCtx = null;
let ppScale = 1;
let ppIsCustom = false;
let ppZoom = 1.0; // zoom multiplier for crop size

document.addEventListener("DOMContentLoaded", () => {
  ppCanvas = document.getElementById("ppCanvas");
  ppCtx = ppCanvas.getContext("2d");

  // ── Tab switching ──
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      if(btn.dataset.tab === "history") renderHistory();
    });
  });

  // ── Preset selection ──
  document.querySelectorAll(".pp-preset").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pp-preset").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      ppIsCustom = false;
      document.getElementById("ppCustomWrap").style.display = "none";
      ppSelectedPreset = {
        w: parseFloat(btn.dataset.w),
        h: parseFloat(btn.dataset.h),
        name: btn.dataset.name
      };
      if(ppImage){ initCropBox(); drawCropCanvas(); }
      resetResult();
    });
  });

  // ── Custom size toggle ──
  document.getElementById("ppCustomBtn").addEventListener("click", () => {
    document.querySelectorAll(".pp-preset").forEach(b => b.classList.remove("active"));
    document.getElementById("ppCustomBtn").classList.add("active");
    ppIsCustom = true;
    document.getElementById("ppCustomWrap").style.display = "flex";
    resetResult();
  });

  // ── Custom size apply ──
  document.getElementById("ppApplyCustom").addEventListener("click", () => {
    const w = parseFloat(document.getElementById("ppCustomW").value);
    const h = parseFloat(document.getElementById("ppCustomH").value);
    const unit = document.getElementById("ppCustomUnit").value;
    if(!w || !h || w <= 0 || h <= 0) {
      alert("Please enter valid width and height.");
      return;
    }
    let wMm = w, hMm = h;
    if(unit === "px") { wMm = w * 25.4 / 96; hMm = h * 25.4 / 96; }
    else if(unit === "in") { wMm = w * 25.4; hMm = h * 25.4; }
    ppSelectedPreset = { w: wMm, h: hMm, name: `Custom ${w}×${h}${unit}` };
    if(ppImage){ initCropBox(); drawCropCanvas(); }
    resetResult();
  });

  // ── Background color ──
  document.querySelectorAll(".pp-bg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pp-bg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      ppBgColor = btn.dataset.color;
      // Update canvas preview immediately
      if(ppImage) drawCropCanvas();
      resetResult();
    });
  });

  // ── Custom color picker ──
  const colorPicker = document.getElementById("ppColorPicker");
  if(colorPicker) {
    colorPicker.addEventListener("input", () => {
      document.querySelectorAll(".pp-bg-btn").forEach(b => b.classList.remove("active"));
      ppBgColor = colorPicker.value;
      if(ppImage) drawCropCanvas();
      resetResult();
    });
  }

  // ── Zoom slider ──
  const zoomSlider = document.getElementById("ppZoomSlider");
  const zoomVal = document.getElementById("ppZoomVal");
  if(zoomSlider){
    zoomSlider.addEventListener("input", () => {
      ppZoom = parseInt(zoomSlider.value) / 100;
      zoomVal.textContent = zoomSlider.value + "%";
      if(ppImage){
        // Adjust crop size based on zoom
        const imgW = ppImage.width;
        const ratio = ppSelectedPreset.w / ppSelectedPreset.h;
        ppCropW = Math.min(imgW * 0.9, imgW * 0.7 / ppZoom);
        ppCropH = ppCropW / ratio;
        // Keep crop centered
        ppCropX = Math.max(0, Math.min(ppImage.width - ppCropW, ppCropX));
        ppCropY = Math.max(0, Math.min(ppImage.height - ppCropH, ppCropY));
        drawCropCanvas();
        resetResult();
      }
    });
  }

  // ── Reset crop ──
  document.getElementById("ppResetCrop")?.addEventListener("click", () => {
    ppZoom = 1.0;
    if(zoomSlider){ zoomSlider.value = 100; zoomVal.textContent = "100%"; }
    if(ppImage){ initCropBox(); drawCropCanvas(); resetResult(); }
  });

  // ── File upload ──
  const ppFileInput = document.getElementById("ppFileInput");
  const ppDrop = document.getElementById("ppDrop");
  ppFileInput.addEventListener("change", () => { if(ppFileInput.files[0]) loadPPImage(ppFileInput.files[0]); });
  ppDrop.addEventListener("dragover", e => { e.preventDefault(); ppDrop.classList.add("dragover"); });
  ppDrop.addEventListener("dragleave", () => ppDrop.classList.remove("dragover"));
  ppDrop.addEventListener("drop", e => {
    e.preventDefault(); ppDrop.classList.remove("dragover");
    if(e.dataTransfer.files[0]) loadPPImage(e.dataTransfer.files[0]);
  });

  // ── Generate & download ──
  document.getElementById("btnPpGenerate").addEventListener("click", generatePassportPhoto);
  document.getElementById("ppDlJpg").addEventListener("click", () => downloadPP("jpg"));
  document.getElementById("ppDlPng").addEventListener("click", () => downloadPP("png"));

  // ── Canvas drag ──
  ppCanvas.addEventListener("mousedown", ppDragStart);
  ppCanvas.addEventListener("mousemove", ppDragMove);
  ppCanvas.addEventListener("mouseup", ppDragEnd);
  ppCanvas.addEventListener("mouseleave", ppDragEnd);

  // Touch support
  ppCanvas.addEventListener("touchstart", e => ppDragStart(e.touches[0]));
  ppCanvas.addEventListener("touchmove", e => { e.preventDefault(); ppDragMove(e.touches[0]); }, {passive:false});
  ppCanvas.addEventListener("touchend", ppDragEnd);

  // ── History clear ──
  document.getElementById("btnClearHistory").addEventListener("click", () => {
    chrome.storage.local.remove("conversionHistory", () => renderHistory());
  });
});

function resetResult() {
  document.getElementById("ppResultWrap").classList.remove("show");
  window._ppOutCanvas = null;
}

function loadPPImage(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      ppImage = img;
      document.getElementById("ppDrop").style.display = "none";
      document.getElementById("ppCropWrap").classList.add("show");
      document.getElementById("ppZoomRow").style.display = "flex";
      document.getElementById("btnPpGenerate").disabled = false;
      ppZoom = 1.0;
      const zs = document.getElementById("ppZoomSlider");
      const zv = document.getElementById("ppZoomVal");
      if(zs){ zs.value = 100; }
      if(zv){ zv.textContent = "100%"; }
      resetResult();
      initCropBox();
      drawCropCanvas();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function initCropBox() {
  if(!ppImage) return;
  const imgW = ppImage.width;
  const imgH = ppImage.height;
  const ratio = ppSelectedPreset.w / ppSelectedPreset.h;

  // Start crop at 70% of image width, centered
  ppCropW = imgW * 0.7;
  ppCropH = ppCropW / ratio;
  if(ppCropH > imgH * 0.9){ ppCropH = imgH * 0.9; ppCropW = ppCropH * ratio; }
  ppCropX = (imgW - ppCropW) / 2;
  ppCropY = imgH * 0.03;
}

function drawCropCanvas() {
  if(!ppImage) return;

  const maxW = 340, maxH = 200;
  const imgRatio = ppImage.width / ppImage.height;
  let dW = maxW, dH = maxW / imgRatio;
  if(dH > maxH){ dH = maxH; dW = maxH * imgRatio; }

  ppCanvas.width = dW;
  ppCanvas.height = dH;
  ppScale = dW / ppImage.width;

  // Draw original image
  ppCtx.drawImage(ppImage, 0, 0, dW, dH);

  // Dark overlay everywhere
  ppCtx.fillStyle = "rgba(0,0,0,0.6)";
  ppCtx.fillRect(0, 0, dW, dH);

  // Crop position in display coords
  const cx = ppCropX * ppScale;
  const cy = ppCropY * ppScale;
  const cw = ppCropW * ppScale;
  const ch = ppCropH * ppScale;

  // Show actual image in crop area
  ppCtx.save();
  ppCtx.beginPath();
  ppCtx.rect(cx, cy, cw, ch);
  ppCtx.clip();

  // Fill background color in crop area FIRST
  ppCtx.fillStyle = ppBgColor;
  ppCtx.fillRect(cx, cy, cw, ch);

  // Draw image on top
  ppCtx.drawImage(ppImage, 0, 0, dW, dH);
  ppCtx.restore();

  // White border
  ppCtx.strokeStyle = "#fff";
  ppCtx.lineWidth = 2;
  ppCtx.strokeRect(cx, cy, cw, ch);

  // Corner handles
  const hs = 8;
  ppCtx.fillStyle = "#fff";
  [[cx,cy],[cx+cw-hs,cy],[cx,cy+ch-hs],[cx+cw-hs,cy+ch-hs]].forEach(([hx,hy]) => {
    ppCtx.fillRect(hx, hy, hs, hs);
  });

  // Rule of thirds
  ppCtx.strokeStyle = "rgba(255,255,255,0.25)";
  ppCtx.lineWidth = 0.5;
  ppCtx.beginPath();
  ppCtx.moveTo(cx+cw/3,cy); ppCtx.lineTo(cx+cw/3,cy+ch);
  ppCtx.moveTo(cx+cw*2/3,cy); ppCtx.lineTo(cx+cw*2/3,cy+ch);
  ppCtx.moveTo(cx,cy+ch/3); ppCtx.lineTo(cx+cw,cy+ch/3);
  ppCtx.moveTo(cx,cy+ch*2/3); ppCtx.lineTo(cx+cw,cy+ch*2/3);
  ppCtx.stroke();

  // Size label
  ppCtx.fillStyle = "rgba(0,0,0,0.5)";
  ppCtx.fillRect(cx, cy+ch-16, cw, 16);
  ppCtx.fillStyle = "#fff";
  ppCtx.font = "9px Arial";
  ppCtx.textAlign = "center";
  ppCtx.fillText(`${ppSelectedPreset.w}×${ppSelectedPreset.h}mm`, cx+cw/2, cy+ch-4);
  ppCtx.textAlign = "left";
}

// ── Drag ──
function ppDragStart(e) {
  ppDragging = true;
  const rect = ppCanvas.getBoundingClientRect();
  ppDragStartX = (e.clientX || e.pageX) - rect.left;
  ppDragStartY = (e.clientY || e.pageY) - rect.top;
  ppCropStartX = ppCropX;
  ppCropStartY = ppCropY;
}

function ppDragMove(e) {
  if(!ppDragging) return;
  const rect = ppCanvas.getBoundingClientRect();
  const mx = (e.clientX || e.pageX) - rect.left;
  const my = (e.clientY || e.pageY) - rect.top;
  const dx = (mx - ppDragStartX) / ppScale;
  const dy = (my - ppDragStartY) / ppScale;
  ppCropX = Math.max(0, Math.min(ppImage.width - ppCropW, ppCropStartX + dx));
  ppCropY = Math.max(0, Math.min(ppImage.height - ppCropH, ppCropStartY + dy));
  drawCropCanvas();
}

function ppDragEnd() { ppDragging = false; }

// ── Generate ──
function generatePassportPhoto() {
  if(!ppImage) return;
  const outW = Math.round(ppSelectedPreset.w * MM_TO_PX);
  const outH = Math.round(ppSelectedPreset.h * MM_TO_PX);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext("2d");

  // Fill background color
  outCtx.fillStyle = ppBgColor;
  outCtx.fillRect(0, 0, outW, outH);

  // Draw only the cropped portion scaled to output size
  outCtx.drawImage(ppImage, ppCropX, ppCropY, ppCropW, ppCropH, 0, 0, outW, outH);

  const previewDataUrl = outCanvas.toDataURL("image/jpeg", 0.92);
  document.getElementById("ppResultImg").src = previewDataUrl;
  document.getElementById("ppResultTitle").textContent = ppSelectedPreset.name;
  document.getElementById("ppResultSize").textContent =
    `${ppSelectedPreset.w.toFixed(1)}×${ppSelectedPreset.h.toFixed(1)}mm · ${outW}×${outH}px · 300 DPI`;
  document.getElementById("ppResultWrap").classList.add("show");
  window._ppOutCanvas = outCanvas;
}

function downloadPP(fmt) {
  if(!window._ppOutCanvas) return;
  const mime = fmt==="png" ? "image/png" : "image/jpeg";
  const dataUrl = window._ppOutCanvas.toDataURL(mime, fmt==="png"?1:0.95);
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `passport_photo_${ppSelectedPreset.w.toFixed(0)}x${ppSelectedPreset.h.toFixed(0)}mm.${fmt}`;
  a.click();
}

// ── History ──
function saveToHistory(filename, fileCount) {
  chrome.storage.local.get("conversionHistory", data => {
    const history = data.conversionHistory || [];
    history.unshift({ filename, fileCount, timestamp: Date.now() });
    chrome.storage.local.set({ conversionHistory: history.slice(0, 10) });
  });
}

function renderHistory() {
  const list = document.getElementById("historyList");
  const clearBtn = document.getElementById("btnClearHistory");
  list.innerHTML = "";
  chrome.storage.local.get("conversionHistory", data => {
    const history = data.conversionHistory || [];
    if(history.length === 0) {
      list.innerHTML = `<div class="history-empty"><span>📂</span>No conversions yet.</div>`;
      clearBtn.style.display = "none";
      return;
    }
    clearBtn.style.display = "block";
    history.forEach(item => {
      const div = document.createElement("div");
      div.className = "history-item";
      const time = new Date(item.timestamp);
      const timeStr = time.toLocaleDateString("en-IN")+" "+time.toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"});
      const ext=(item.filename||"").split(".").pop().toLowerCase();
      const icon=ext==="pdf"?"📋":["jpg","jpeg"].includes(ext)?"📷":ext==="png"?"🖼️":"📄";
      div.innerHTML=`<span class="hi-icon">${icon}</span><div class="hi-info"><div class="hi-name">${item.filename}</div><div class="hi-meta">${timeStr}</div></div><span class="hi-count">${item.fileCount} files</span>`;
      list.appendChild(div);
    });
  });
}

window.ppSaveToHistory = saveToHistory;
