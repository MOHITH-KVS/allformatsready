// ── Passport Photo Tool ──
const PP_DPI = 300;
const MM_TO_PX = PP_DPI / 25.4;

let ppImage = null;
let ppSelectedPreset = { w:35, h:45, name:"Standard Passport" };
let ppBgColor = "#ffffff";
let ppCropX = 0, ppCropY = 0, ppCropW = 0, ppCropH = 0;
let ppDragging = false;
let ppDragX0 = 0, ppDragY0 = 0, ppCropX0 = 0, ppCropY0 = 0;
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

  document.getElementById("ppFillFrame")?.addEventListener("click", () => { if(ppImage){ ppFillFrame(); drawCropCanvas(); resetResult(); } });

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
  const ext=(file.name||"").split(".").pop().toLowerCase();
  if(["heic","heif"].includes(ext)){
    alert("HEIC/HEIF photos cannot be decoded in the extension photo tool. Convert the photo to JPG or PNG first, then upload.");
    return;
  }
  const reader=new FileReader();
  reader.onerror=()=>alert("Could not read this image. Use JPG, PNG or WebP.");
  reader.onload=e=>{
    const img=new Image();
    img.onerror=()=>alert("Could not read this image. Use JPG, PNG or WebP.");
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

function ppContain(){
  const ratio=ppSelectedPreset.w/ppSelectedPreset.h, ir=ppImage.width/ppImage.height;
  return ir>=ratio ? {w:ppImage.width,h:ppImage.width/ratio} : {w:ppImage.height*ratio,h:ppImage.height};
}
function ppCoverZoom(){
  const c=ppContain(), ratio=ppSelectedPreset.w/ppSelectedPreset.h;
  return c.w/Math.min(ppImage.width,ppImage.height*ratio);
}
function ppClamp(){
  // Axes where the frame is larger than the photo stay centred (the photo is never cut there)
  if(ppCropW>=ppImage.width) ppCropX=(ppImage.width-ppCropW)/2; else ppCropX=Math.max(0,Math.min(ppImage.width-ppCropW,ppCropX));
  if(ppCropH>=ppImage.height) ppCropY=(ppImage.height-ppCropH)/2; else ppCropY=Math.max(0,Math.min(ppImage.height-ppCropH,ppCropY));
}
function ppSyncZoom(){
  const zs=document.getElementById("ppZoomSlider"), zv=document.getElementById("ppZoomVal");
  if(zs){ zs.min=100; zs.max=Math.max(300,Math.ceil(ppCoverZoom()*100)+60); zs.value=Math.round(ppZoom*100); }
  if(zv) zv.textContent=Math.round(ppZoom*100)+"%";
}
function initCropBox(){
  if(!ppImage) return;
  // Auto-fit: the WHOLE photo fits inside the chosen size. Nothing is cut.
  ppZoom=1; const c=ppContain();
  ppCropW=c.w; ppCropH=c.h; ppCropX=(ppImage.width-ppCropW)/2; ppCropY=(ppImage.height-ppCropH)/2;
  ppClamp(); ppSyncZoom();
}
function ppFillFrame(){
  if(!ppImage) return;
  // Fill the frame (crop to the shape), keeping the head area: biased towards the top
  const z=ppCoverZoom(), c=ppContain(); ppZoom=z;
  ppCropW=c.w/z; ppCropH=c.h/z; ppCropX=(ppImage.width-ppCropW)/2; ppCropY=(ppImage.height-ppCropH)*0.15;
  ppClamp(); ppSyncZoom();
}
function updateCropSize(){
  if(!ppImage) return;
  const c=ppContain(), cx=ppCropX+ppCropW/2, cy=ppCropY+ppCropH/2;
  ppCropW=c.w/ppZoom; ppCropH=c.h/ppZoom; ppCropX=cx-ppCropW/2; ppCropY=cy-ppCropH/2; ppClamp();
}
function drawCropCanvas(){
  if(!ppImage||!ppCanvas) return;
  // Canvas shows the photo plus any empty frame area around it
  const bx0=Math.min(0,ppCropX), by0=Math.min(0,ppCropY), bx1=Math.max(ppImage.width,ppCropX+ppCropW), by1=Math.max(ppImage.height,ppCropY+ppCropH);
  const bw=bx1-bx0, bh=by1-by0, maxW=340, maxH=200, br=bw/bh;
  let dW=maxW, dH=maxW/br; if(dH>maxH){dH=maxH;dW=maxH*br;}
  ppCanvas.width=dW; ppCanvas.height=dH; ppScale=dW/bw;
  const ix=(0-bx0)*ppScale, iy=(0-by0)*ppScale, iw=ppImage.width*ppScale, ih=ppImage.height*ppScale;
  ppCtx.fillStyle="#D1D5DB"; ppCtx.fillRect(0,0,dW,dH);
  ppCtx.drawImage(ppImage,ix,iy,iw,ih);
  ppCtx.fillStyle="rgba(0,0,0,0.55)"; ppCtx.fillRect(0,0,dW,dH);
  const cx=(ppCropX-bx0)*ppScale, cy=(ppCropY-by0)*ppScale, cw=ppCropW*ppScale, ch=ppCropH*ppScale;
  ppCtx.save(); ppCtx.beginPath(); ppCtx.rect(cx,cy,cw,ch); ppCtx.clip();
  ppCtx.fillStyle=ppBgColor; ppCtx.fillRect(cx,cy,cw,ch);
  ppCtx.drawImage(ppImage,ix,iy,iw,ih);
  ppCtx.strokeStyle="rgba(255,255,0,0.5)"; ppCtx.lineWidth=1.5; ppCtx.setLineDash([4,3]);
  ppCtx.beginPath(); ppCtx.ellipse(cx+cw/2,cy+ch*0.38,cw*0.28,ch*0.32,0,0,Math.PI*2); ppCtx.stroke(); ppCtx.setLineDash([]);
  ppCtx.restore();
  ppCtx.strokeStyle="#fff"; ppCtx.lineWidth=2; ppCtx.strokeRect(cx,cy,cw,ch);
  const hs=8; ppCtx.fillStyle="#fff";
  [[cx,cy],[cx+cw-hs,cy],[cx,cy+ch-hs],[cx+cw-hs,cy+ch-hs]].forEach(([hx,hy])=>ppCtx.fillRect(hx,hy,hs,hs));
  ppCtx.strokeStyle="rgba(255,255,255,0.2)"; ppCtx.lineWidth=0.5; ppCtx.beginPath();
  ppCtx.moveTo(cx+cw/3,cy);ppCtx.lineTo(cx+cw/3,cy+ch); ppCtx.moveTo(cx+cw*2/3,cy);ppCtx.lineTo(cx+cw*2/3,cy+ch);
  ppCtx.moveTo(cx,cy+ch/3);ppCtx.lineTo(cx+cw,cy+ch/3); ppCtx.moveTo(cx,cy+ch*2/3);ppCtx.lineTo(cx+cw,cy+ch*2/3); ppCtx.stroke();
  ppCtx.fillStyle="rgba(0,0,0,0.5)"; ppCtx.fillRect(cx,cy+ch-16,cw,16);
  ppCtx.fillStyle="#fff"; ppCtx.font="9px Arial"; ppCtx.textAlign="center";
  ppCtx.fillText(`${ppSelectedPreset.w}×${ppSelectedPreset.h}mm`,cx+cw/2,cy+ch-4); ppCtx.textAlign="left";
}
function ds(e){
  ppDragging=true; const r=ppCanvas.getBoundingClientRect();
  ppDragX0=(e.clientX||e.pageX)-r.left; ppDragY0=(e.clientY||e.pageY)-r.top; ppCropX0=ppCropX; ppCropY0=ppCropY;
}
function dm(e){
  if(!ppDragging) return;
  const r=ppCanvas.getBoundingClientRect(), mx=(e.clientX||e.pageX)-r.left, my=(e.clientY||e.pageY)-r.top;
  ppCropX=ppCropX0+(mx-ppDragX0)/ppScale; ppCropY=ppCropY0+(my-ppDragY0)/ppScale; ppClamp(); drawCropCanvas();
}
function de(){ ppDragging=false; }


function generatePassportPhoto(){
  if(!ppImage) return;
  const outW=Math.round(ppSelectedPreset.w*MM_TO_PX),outH=Math.round(ppSelectedPreset.h*MM_TO_PX);
  const oc=document.createElement("canvas"); oc.width=outW; oc.height=outH;
  const ctx=oc.getContext("2d");
  ctx.fillStyle=ppBgColor; ctx.fillRect(0,0,outW,outH);
  const sx=outW/ppCropW, sy=outH/ppCropH;
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high";
  ctx.drawImage(ppImage,0,0,ppImage.width,ppImage.height,(0-ppCropX)*sx,(0-ppCropY)*sy,ppImage.width*sx,ppImage.height*sy);
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

  function ago(ts){
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if(m < 1) return "Just now";
    if(m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : new Date(ts).toLocaleDateString("en-IN");
  }

  chrome.storage.local.get(["conversionHistory","conversionFiles"], data => {
    const history = data.conversionHistory || [];
    const files = data.conversionFiles || {};
    const now = Date.now();

    if(history.length === 0){
      const empty = document.createElement("div");
      empty.className = "history-empty";
      const icon = document.createElement("span");
      icon.textContent = "📂";
      const go = document.createElement("button");
      go.className = "btn-go"; go.type = "button"; go.textContent = "Convert a file →";
      go.addEventListener("click", () => { const t = document.querySelector('.tab-btn[data-tab="convert"]'); if(t) t.click(); });
      empty.append(icon, document.createTextNode("No conversions yet."), document.createElement("br"),
                   document.createTextNode("Converted files appear here for 24 hours."), document.createElement("br"), go);
      list.appendChild(empty);
      clearBtn.style.display = "none";
      return;
    }
    clearBtn.style.display = "block";

    history.forEach((item, idx) => {
      const timeLeft = Math.max(0, item.expiresAt - now);
      const hoursLeft = Math.floor(timeLeft / 3600000);
      const minsLeft = Math.floor((timeLeft % 3600000) / 60000);
      const pct = Math.max(2, Math.min(100, (timeLeft / HISTORY_EXPIRY_MS) * 100));
      const ext = (item.filename||"").split(".").pop().toLowerCase();
      const icon = ext==="pdf"?"📋":["jpg","jpeg"].includes(ext)?"📷":ext==="png"?"🖼️":ext==="docx"?"📝":"📄";
      const itemFiles = files[item.id] || [];

      const card = document.createElement("div");
      card.className = "hi-card";
      card.style.animationDelay = (idx * 0.05) + "s";

      const top = document.createElement("div"); top.className = "hi-top";
      const iconEl = document.createElement("span"); iconEl.className = "hi-icon"; iconEl.textContent = icon;
      const info = document.createElement("div"); info.className = "hi-info";
      const name = document.createElement("div"); name.className = "hi-name"; name.textContent = item.filename || "Unnamed file"; name.title = item.filename || "";
      const meta = document.createElement("div"); meta.className = "hi-meta";
      meta.textContent = `${ago(item.timestamp)} · ${item.fileCount} files`;
      info.append(name, meta);
      const del = document.createElement("button");
      del.className = "hi-del"; del.type = "button"; del.title = "Delete this entry"; del.setAttribute("aria-label", "Delete this entry"); del.textContent = "✕";
      del.addEventListener("click", () => {
        card.style.transition = "opacity .2s, transform .2s"; card.style.opacity = "0"; card.style.transform = "translateX(12px)";
        setTimeout(() => {
          chrome.storage.local.get(["conversionHistory","conversionFiles"], d => {
            const h = (d.conversionHistory || []).filter(x => x.id !== item.id);
            const f = d.conversionFiles || {}; delete f[item.id];
            chrome.storage.local.set({ conversionHistory: h, conversionFiles: f }, () => renderHistory());
          });
        }, 190);
      });
      top.append(iconEl, info, del);
      card.appendChild(top);

      const bar = document.createElement("div"); bar.className = "hi-bar"; bar.title = `Deleted in ${hoursLeft}h ${minsLeft}m`;
      const fill = document.createElement("span"); fill.style.width = pct + "%"; bar.appendChild(fill);
      card.appendChild(bar);

      if(itemFiles.length > 0){
        const wrap = document.createElement("div"); wrap.className = "hi-files";
        itemFiles.forEach(f => {
          const btn = document.createElement("button");
          btn.className = "hi-dl"; btn.type = "button";
          btn.dataset.fmt = (f.format || "").toUpperCase();
          btn.textContent = `⬇ ${f.format} · ${f.size_kb} KB`;
          btn.title = f.label || f.name;
          btn.addEventListener("click", () => redownloadFile(f));
          wrap.appendChild(btn);
        });
        card.appendChild(wrap);
      } else {
        const note = document.createElement("div"); note.className = "hi-nofiles";
        note.textContent = "Files not available — storage limit reached";
        card.appendChild(note);
      }
      list.appendChild(card);
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
    if(typeof afrToast==="function") afrToast("⬇ Saved "+f.name);
  }catch(e){ alert("Download failed. File may have expired."); }
}

// ── Expose globally ──
window.ppSaveToHistory = (filename, count) => {}; // legacy no-op
window.saveConversionToHistory = saveConversionToHistory;
