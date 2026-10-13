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
let ppZoom = 1.0;

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
      ppSelectedPreset = { w:parseFloat(btn.dataset.w), h:parseFloat(btn.dataset.h), name:btn.dataset.name };
      if(ppImage){ initCropBox(); drawCropCanvas(); }
      resetResult();
    });
  });

  // ── Custom size ──
  document.getElementById("ppCustomBtn").addEventListener("click", () => {
    document.querySelectorAll(".pp-preset").forEach(b => b.classList.remove("active"));
    document.getElementById("ppCustomBtn").classList.add("active");
    ppIsCustom = true;
    document.getElementById("ppCustomWrap").style.display = "flex";
    resetResult();
  });
  document.getElementById("ppApplyCustom").addEventListener("click", () => {
    const w = parseFloat(document.getElementById("ppCustomW").value);
    const h = parseFloat(document.getElementById("ppCustomH").value);
    const unit = document.getElementById("ppCustomUnit").value;
    if(!w||!h||w<=0||h<=0){ alert("Enter valid size."); return; }
    let wMm=w, hMm=h;
    if(unit==="px"){ wMm=w*25.4/96; hMm=h*25.4/96; }
    else if(unit==="in"){ wMm=w*25.4; hMm=h*25.4; }
    ppSelectedPreset={w:wMm,h:hMm,name:`Custom ${w}×${h}${unit}`};
    if(ppImage){ initCropBox(); drawCropCanvas(); }
    resetResult();
  });

  // ── Background ──
  document.querySelectorAll(".pp-bg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pp-bg-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      ppBgColor = btn.dataset.color;
      if(ppImage){ drawCropCanvas(); resetResult(); }
    });
  });
  document.getElementById("ppColorPicker")?.addEventListener("input", e => {
    document.querySelectorAll(".pp-bg-btn").forEach(b=>b.classList.remove("active"));
    ppBgColor = e.target.value;
    if(ppImage){ drawCropCanvas(); resetResult(); }
  });

  // ── Zoom ──
  document.getElementById("ppZoomSlider")?.addEventListener("input", e => {
    ppZoom = parseInt(e.target.value)/100;
    document.getElementById("ppZoomVal").textContent = e.target.value+"%";
    if(ppImage){ updateCropSize(); drawCropCanvas(); resetResult(); }
  });
  document.getElementById("ppResetCrop")?.addEventListener("click", () => {
    ppZoom=1.0;
    const zs=document.getElementById("ppZoomSlider");
    const zv=document.getElementById("ppZoomVal");
    if(zs) zs.value=100;
    if(zv) zv.textContent="100%";
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
  ppCanvas.addEventListener("mousedown", ds);
  ppCanvas.addEventListener("mousemove", dm);
  ppCanvas.addEventListener("mouseup", de);
  ppCanvas.addEventListener("mouseleave", de);
  ppCanvas.addEventListener("touchstart", e=>ds(e.touches[0]));
  ppCanvas.addEventListener("touchmove", e=>{e.preventDefault();dm(e.touches[0]);},{passive:false});
  ppCanvas.addEventListener("touchend", de);

  // ── History clear ──
  document.getElementById("btnClearHistory").addEventListener("click", () => {
    chrome.storage.local.remove(["conversionHistory","conversionFiles"], () => renderHistory());
  });

  // Init history on load
  cleanExpiredHistory();
});

function resetResult(){ document.getElementById("ppResultWrap").classList.remove("show"); window._ppOutCanvas=null; }

function loadPPImage(file){
  const reader=new FileReader();
  reader.onload=e=>{
    const img=new Image();
    img.onload=()=>{
      ppImage=img; ppZoom=1.0;
      const zs=document.getElementById("ppZoomSlider");
      const zv=document.getElementById("ppZoomVal");
      if(zs) zs.value=100; if(zv) zv.textContent="100%";
      document.getElementById("ppDrop").style.display="none";
      document.getElementById("ppCropWrap").classList.add("show");
      document.getElementById("ppZoomRow").style.display="flex";
      document.getElementById("btnPpGenerate").disabled=false;
      resetResult(); initCropBox(); drawCropCanvas();
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}

function initCropBox(){
  if(!ppImage) return;
  const ratio=ppSelectedPreset.w/ppSelectedPreset.h;
  ppCropW=ppImage.width*0.7/ppZoom;
  ppCropH=ppCropW/ratio;
  if(ppCropH>ppImage.height*0.9){ppCropH=ppImage.height*0.9;ppCropW=ppCropH*ratio;}
  ppCropX=(ppImage.width-ppCropW)/2;
  ppCropY=ppImage.height*0.03;
}

function updateCropSize(){
  if(!ppImage) return;
  const ratio=ppSelectedPreset.w/ppSelectedPreset.h;
  const cx=ppCropX+ppCropW/2, cy=ppCropY+ppCropH/2;
  ppCropW=ppImage.width*0.7/ppZoom;
  ppCropH=ppCropW/ratio;
  ppCropX=Math.max(0,Math.min(ppImage.width-ppCropW,cx-ppCropW/2));
  ppCropY=Math.max(0,Math.min(ppImage.height-ppCropH,cy-ppCropH/2));
}

function drawCropCanvas(){
  if(!ppImage) return;
  const maxW=340,maxH=200,ir=ppImage.width/ppImage.height;
  let dW=maxW,dH=maxW/ir;
  if(dH>maxH){dH=maxH;dW=maxH*ir;}
  ppCanvas.width=dW; ppCanvas.height=dH; ppScale=dW/ppImage.width;
  ppCtx.drawImage(ppImage,0,0,dW,dH);
  ppCtx.fillStyle="rgba(0,0,0,0.6)"; ppCtx.fillRect(0,0,dW,dH);
  const cx=ppCropX*ppScale,cy=ppCropY*ppScale,cw=ppCropW*ppScale,ch=ppCropH*ppScale;
  ppCtx.save();
  ppCtx.beginPath(); ppCtx.rect(cx,cy,cw,ch); ppCtx.clip();
  ppCtx.fillStyle=ppBgColor; ppCtx.fillRect(cx,cy,cw,ch);
  ppCtx.drawImage(ppImage,0,0,dW,dH);
  // Face oval guide
  ppCtx.strokeStyle="rgba(255,255,0,0.6)";
  ppCtx.lineWidth=1.5; ppCtx.setLineDash([4,3]);
  ppCtx.beginPath();
  ppCtx.ellipse(cx+cw/2,cy+ch*0.38,cw*0.28,ch*0.32,0,0,Math.PI*2);
  ppCtx.stroke(); ppCtx.setLineDash([]);
  ppCtx.restore();
  ppCtx.strokeStyle="#fff"; ppCtx.lineWidth=2; ppCtx.strokeRect(cx,cy,cw,ch);
  const hs=8; ppCtx.fillStyle="#fff";
  [[cx,cy],[cx+cw-hs,cy],[cx,cy+ch-hs],[cx+cw-hs,cy+ch-hs]].forEach(([hx,hy])=>ppCtx.fillRect(hx,hy,hs,hs));
  ppCtx.strokeStyle="rgba(255,255,255,0.2)"; ppCtx.lineWidth=0.5;
  ppCtx.beginPath();
  ppCtx.moveTo(cx+cw/3,cy);ppCtx.lineTo(cx+cw/3,cy+ch);
  ppCtx.moveTo(cx+cw*2/3,cy);ppCtx.lineTo(cx+cw*2/3,cy+ch);
  ppCtx.moveTo(cx,cy+ch/3);ppCtx.lineTo(cx+cw,cy+ch/3);
  ppCtx.moveTo(cx,cy+ch*2/3);ppCtx.lineTo(cx+cw,cy+ch*2/3);
  ppCtx.stroke();
  ppCtx.fillStyle="rgba(0,0,0,0.5)"; ppCtx.fillRect(cx,cy+ch-16,cw,16);
  ppCtx.fillStyle="#fff"; ppCtx.font="9px Arial"; ppCtx.textAlign="center";
  ppCtx.fillText(`${ppSelectedPreset.w}×${ppSelectedPreset.h}mm`,cx+cw/2,cy+ch-4);
  ppCtx.textAlign="left";
}

function ds(e){ ppDragging=true; const r=ppCanvas.getBoundingClientRect(); ppDragStartX=(e.clientX||e.pageX)-r.left; ppDragStartY=(e.clientY||e.pageY)-r.top; ppCropStartX=ppCropX; ppCropStartY=ppCropY; }
function dm(e){ if(!ppDragging) return; const r=ppCanvas.getBoundingClientRect(); const mx=(e.clientX||e.pageX)-r.left,my=(e.clientY||e.pageY)-r.top; ppCropX=Math.max(0,Math.min(ppImage.width-ppCropW,ppCropStartX+(mx-ppDragStartX)/ppScale)); ppCropY=Math.max(0,Math.min(ppImage.height-ppCropH,ppCropStartY+(my-ppDragStartY)/ppScale)); drawCropCanvas(); }
function de(){ ppDragging=false; }

function generatePassportPhoto(){
  if(!ppImage) return;
  const outW=Math.round(ppSelectedPreset.w*MM_TO_PX),outH=Math.round(ppSelectedPreset.h*MM_TO_PX);
  const oc=document.createElement("canvas"); oc.width=outW; oc.height=outH;
  const ctx=oc.getContext("2d");
  ctx.fillStyle=ppBgColor; ctx.fillRect(0,0,outW,outH);
  ctx.drawImage(ppImage,ppCropX,ppCropY,ppCropW,ppCropH,0,0,outW,outH);
  document.getElementById("ppResultImg").src=oc.toDataURL("image/jpeg",0.92);
  document.getElementById("ppResultTitle").textContent=ppSelectedPreset.name;
  document.getElementById("ppResultSize").textContent=`${ppSelectedPreset.w.toFixed(1)}×${ppSelectedPreset.h.toFixed(1)}mm · ${outW}×${outH}px · 300 DPI`;
  document.getElementById("ppResultWrap").classList.add("show");
  window._ppOutCanvas=oc;
}

function downloadPP(fmt){
  if(!window._ppOutCanvas) return;
  const mime=fmt==="png"?"image/png":"image/jpeg";
  const a=document.createElement("a");
  a.href=window._ppOutCanvas.toDataURL(mime,fmt==="png"?1:0.95);
  a.download=`passport_${ppSelectedPreset.w.toFixed(0)}x${ppSelectedPreset.h.toFixed(0)}mm.${fmt}`;
  a.click();
}

// ══════════════════════════════════════════
// 24-HOUR HISTORY SYSTEM
// ══════════════════════════════════════════
const HISTORY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_HISTORY_ITEMS = 3; // Keep last 3 conversions due to 5MB storage limit

function cleanExpiredHistory(){
  chrome.storage.local.get(["conversionHistory","conversionFiles"], data => {
    const history = data.conversionHistory || [];
    const files = data.conversionFiles || {};
    const now = Date.now();
    // Remove expired entries
    const fresh = history.filter(h => (now - h.timestamp) < HISTORY_EXPIRY_MS);
    // Remove orphaned file data
    const freshIds = new Set(fresh.map(h => h.id));
    Object.keys(files).forEach(id => { if(!freshIds.has(id)) delete files[id]; });
    chrome.storage.local.set({ conversionHistory: fresh, conversionFiles: files });
  });
}

function saveConversionToHistory(filename, allFiles){
  chrome.storage.local.get(["conversionHistory","conversionFiles"], data => {
    const history = data.conversionHistory || [];
    const files = data.conversionFiles || {};
    const id = `conv_${Date.now()}`;
    const now = Date.now();

    // Store metadata
    history.unshift({
      id, filename, timestamp: now,
      fileCount: allFiles.length,
      expiresAt: now + HISTORY_EXPIRY_MS
    });

    // Store only essential files to save space
    // Priority: recommended formats only + PDF compressed
    const essentialFormats = ["PDF","JPG","PNG","WEBP","DOCX"];
    const essentialFiles = allFiles
      .filter(f => essentialFormats.includes((f.format||"").toUpperCase()))
      .slice(0, 8); // Max 8 files per conversion

    files[id] = essentialFiles.map(f => ({
      name: f.name,
      format: f.format,
      label: f.label,
      size_kb: f.size_kb,
      category: f.category,
      data_b64: f.data_b64
    }));

    // Keep only last MAX_HISTORY_ITEMS
    const trimmed = history.slice(0, MAX_HISTORY_ITEMS);
    // Remove file data for trimmed items
    const keepIds = new Set(trimmed.map(h => h.id));
    Object.keys(files).forEach(id => { if(!keepIds.has(id)) delete files[id]; });

    chrome.storage.local.set({
      conversionHistory: trimmed,
      conversionFiles: files
    }, () => {
      if(chrome.runtime.lastError){
        // Storage full — clear old data and try again with fewer files
        chrome.storage.local.set({
          conversionHistory: [trimmed[0]],
          conversionFiles: { [id]: files[id].slice(0,4) }
        });
      }
    });
  });
}

function renderHistory(){
  const list = document.getElementById("historyList");
  const clearBtn = document.getElementById("btnClearHistory");
  list.innerHTML = "";
  cleanExpiredHistory();

  chrome.storage.local.get(["conversionHistory","conversionFiles"], data => {
    const history = data.conversionHistory || [];
    const files = data.conversionFiles || {};
    const now = Date.now();

    if(history.length === 0){
      const empty = document.createElement("div");
      empty.className = "history-empty";
      const icon = document.createElement("span");
      icon.textContent = "📂";
      empty.append(icon, document.createTextNode("No conversions yet."), document.createElement("br"), document.createTextNode("Files stored here for 24 hours."));
      list.appendChild(empty);
      clearBtn.style.display = "none";
      return;
    }
    clearBtn.style.display = "block";

    history.forEach(item => {
      const timeLeft = item.expiresAt - now;
      const hoursLeft = Math.max(0, Math.floor(timeLeft / 3600000));
      const minsLeft = Math.max(0, Math.floor((timeLeft % 3600000) / 60000));
      const timeStr = new Date(item.timestamp).toLocaleTimeString("en-IN", {hour:"2-digit",minute:"2-digit"});
      const dateStr = new Date(item.timestamp).toLocaleDateString("en-IN");
      const ext = (item.filename||"").split(".").pop().toLowerCase();
      const icon = ext==="pdf"?"📋":["jpg","jpeg"].includes(ext)?"📷":ext==="png"?"🖼️":"📄";
      const itemFiles = files[item.id] || [];

      const div = document.createElement("div");
      div.className = "history-item";
      div.style.cssText = "cursor:default;margin-bottom:8px";

      // Header row
      const header = document.createElement("div");
      header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px";
      const iconEl = document.createElement("span");
      iconEl.className = "hi-icon";
      iconEl.textContent = icon;
      const info = document.createElement("div");
      info.className = "hi-info";
      const name = document.createElement("div");
      name.className = "hi-name";
      name.textContent = item.filename || "Unnamed file";
      const meta = document.createElement("div");
      meta.className = "hi-meta";
      meta.textContent = `${dateStr} ${timeStr} · ⏳ ${hoursLeft}h ${minsLeft}m left`;
      info.append(name, meta);
      const count = document.createElement("span");
      count.className = "hi-count";
      count.textContent = `${item.fileCount} files`;
      header.append(iconEl, info, count);
      div.appendChild(header);

      // File download buttons
      if(itemFiles.length > 0){
        const btnWrap = document.createElement("div");
        btnWrap.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";
        itemFiles.forEach(f => {
          const btn = document.createElement("button");
          btn.style.cssText = "background:var(--brand-light);color:var(--brand);border:1px solid #BFDBFE;border-radius:4px;padding:3px 7px;font-size:.64rem;font-weight:700;cursor:pointer";
          btn.textContent = `⬇ ${f.format} ${f.size_kb}KB`;
          btn.title = f.label;
          btn.addEventListener("click", () => redownloadFile(f));
          btnWrap.appendChild(btn);
        });
        div.appendChild(btnWrap);
      } else {
        const note = document.createElement("div");
        note.style.cssText = "font-size:.66rem;color:var(--gray-400);padding:2px 0";
        note.textContent = "Files not available — storage limit reached";
        div.appendChild(note);
      }

      list.appendChild(div);
    });
  });
}

function redownloadFile(f){
  try{
    const ext=(f.name||"file").split(".").pop().toLowerCase();
    const mimeMap={jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",pdf:"application/pdf",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"};
    const mime=mimeMap[ext]||"application/octet-stream";
    const bc=atob(f.data_b64); const ba=new Uint8Array(bc.length);
    for(let i=0;i<bc.length;i++) ba[i]=bc.charCodeAt(i);
    const blob=new Blob([ba],{type:mime});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=f.name; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){ alert("Download failed. File may have expired."); }
}

// ── Expose globally ──
window.ppSaveToHistory = (filename, count) => {}; // legacy no-op
window.saveConversionToHistory = saveConversionToHistory;
