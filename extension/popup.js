const API_URL = "https://allformatsready.onrender.com";
const ALLOWED_FORMATS = ["JPG","PNG","WEBP","PDF","DOCX"];
const CONVERT_TIMEOUT_MS = 120000;
const CONVERT_MAX_BYTES = 10 * 1024 * 1024;

let selectedFile = null;
let allFiles = [];
let conversionNotice = "";
let activePortal = null;
let activeFilter = "ALL";
let convertStartTime = 0;
let retryTimer = null;
let convertInFlight = false;

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
const resultsTime   = document.getElementById("resultsTime");
const cardsList     = document.getElementById("cardsList");
const filterBar     = document.getElementById("filterBar");
const btnZip        = document.getElementById("btnZip");
const btnAgain      = document.getElementById("btnAgain");
const serverStatus  = document.getElementById("serverStatus");

// ── Helpers ──
function formatBytes(b){
  if(b<1024) return b+" B";
  if(b<1048576) return (b/1024).toFixed(1)+" KB";
  return (b/1048576).toFixed(1)+" MB";
}
function getFileIcon(name){
  const ext=(name||"").split(".").pop().toLowerCase();
  if(ext==="pdf") return "📋";
  if(["jpg","jpeg"].includes(ext)) return "📷";
  if(ext==="png") return "🖼️";
  if(["heic","heif"].includes(ext)) return "📸";
  if(ext==="docx") return "📝";
  return "📄";
}
function fmtClass(fmt){
  const m={JPG:"fmt-jpg",PNG:"fmt-png",WEBP:"fmt-webp",PDF:"fmt-pdf",DOCX:"fmt-docx"};
  return m[(fmt||"").toUpperCase()]||"fmt-jpg";
}
function apiErrorMessage(payload, fallback){
  const detail = payload && payload.detail;
  if(typeof detail === "string" && detail.trim()) return detail;
  if(Array.isArray(detail)){
    const first = detail.find(item => item && (item.msg || item.message));
    if(first) return first.msg || first.message;
  }
  return fallback;
}
function isRetryableNetworkError(err){
  if(!err) return false;
  const msg = String(err.message || "");
  return err.name === "TypeError" && /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
}
function showError(msg, showRetry=false){
  errorWrap.replaceChildren(document.createTextNode("⚠️ " + msg));
  if(showRetry){
    const retry = document.createElement("button");
    retry.className = "btn-retry-inline";
    retry.id = "btnRetryInline";
    retry.textContent = "Retry now →";
    retry.addEventListener("click", () => { hideError(); doConvert(); });
    errorWrap.append(" ", retry);
  }
  errorWrap.classList.add("show");
}
function hideError(){
  errorWrap.replaceChildren();
  errorWrap.classList.remove("show");
  if(retryTimer){ clearInterval(retryTimer); retryTimer=null; }
}

// ── Server status ──
async function checkServer(){
  try{
    serverStatus.textContent="⏳";
    serverStatus.style.color="#D97706";
    const r=await fetch(`${API_URL}/ping`,{signal:AbortSignal.timeout(8000)});
    if(r.ok){ serverStatus.textContent="🟢 Ready"; serverStatus.style.color="#16A34A"; }
  }catch(e){
    serverStatus.textContent="🔴 Waking…";
    serverStatus.style.color="#DC2626";
    setTimeout(checkServer,15000);
  }
}

// ── Portal detection ──
async function detectCurrentPortal(){
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab||!tab.url) return;

    // PDF page count badge
    const ext=(tab.title||"").split(".").pop().toLowerCase();

    const portal=detectPortal(tab.url);
    activePortal=portal||PORTAL_MAP.find(p=>p.id==="general");
    portalIcon.textContent=activePortal.icon;
    portalBanner.classList.add("show");
    if(!portal||portal.id==="general"){
      portalName.textContent="No specific portal detected";
      portalReq.textContent="All formats shown equally";
      portalBanner.classList.add("general");
    }else{
      portalName.textContent="✅ "+portal.name;
      portalReq.textContent="Suggestion: "+portal.req;
    }
  }catch(e){}
}

// ── File handling ──
function setFile(file){
  if(!file) return;
  if(!file.size){
    selectedFile=null;
    fileInput.value="";
    filePreview.classList.remove("show");
    dropZone.style.display="";
    btnConvert.disabled=true;
    showError("The selected file is empty.");
    return;
  }
  if(file.size>CONVERT_MAX_BYTES){
    selectedFile=null;
    fileInput.value="";
    filePreview.classList.remove("show");
    dropZone.style.display="";
    btnConvert.disabled=true;
    showError("File too large. Max 10MB for conversion.");
    return;
  }
  const ext=file.name.split(".").pop().toLowerCase();
  const allowed=["pdf","docx","jpg","jpeg","png","webp","heic","heif"];
  if(!allowed.includes(ext)){
    selectedFile=null;
    fileInput.value="";
    filePreview.classList.remove("show");
    dropZone.style.display="";
    btnConvert.disabled=true;
    showError(ext==="doc" ? "Legacy .doc is not supported. Save it as .docx or PDF in Word first." : `Format .${ext} not supported. Use PDF, DOCX, JPG, PNG, WebP or HEIC.`);
    return;
  }
  selectedFile=file;
  fpIcon.textContent=getFileIcon(file.name);
  fpName.textContent=file.name;
  fpSize.textContent=formatBytes(file.size);
  filePreview.classList.add("show");
  dropZone.style.display="none";
  btnConvert.disabled=false;
  hideError();
}

function reset(){
  hideError();
  selectedFile=null; allFiles=[]; conversionNotice="";
  fileInput.value="";
  filePreview.classList.remove("show");
  dropZone.style.display="";
  btnConvert.disabled=true;
  progressWrap.classList.remove("show");
  resultsWrap.classList.remove("show");
  uploadSection.style.display="";
  hideError();
  progressFill.style.width="0%";
  cardsList.innerHTML="";
  filterBar.innerHTML="";
  activeFilter="ALL";
}

fileInput.addEventListener("change",()=>{ if(fileInput.files[0]) setFile(fileInput.files[0]); });
fpRemove.addEventListener("click",reset);
btnAgain.addEventListener("click",reset);
dropZone.addEventListener("dragover",e=>{ e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave",()=>dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop",e=>{
  e.preventDefault(); dropZone.classList.remove("dragover");
  if(e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});

// ── Keyboard shortcut: Enter to convert ──
document.addEventListener("keydown", e => {
  if(e.key==="Enter" && !btnConvert.disabled && uploadSection.style.display!=="none"){
    doConvert();
  }
});

// ── Compression ──
async function compressIfNeeded(file){
  const ext=(file.name||"").split(".").pop().toLowerCase();
  if(ext==="pdf"||file.size<=2*1024*1024) return file;
  if(!["jpg","jpeg","png","webp","gif","bmp"].includes(ext)) return file;
  return new Promise(resolve=>{
    let settled=false;
    const finish=result=>{
      if(settled) return;
      settled=true;
      clearTimeout(watchdog);
      resolve(result||file);
    };
    const watchdog=setTimeout(()=>finish(file),15000);
    const reader=new FileReader();
    reader.onerror=()=>finish(file);
    reader.onload=e=>{
      const img=new Image();
      img.onerror=()=>finish(file);
      img.onload=async()=>{
        try{
          let w=img.width,h=img.height;
          if(!w||!h){ finish(file); return; }
          if(w>2400||h>2400){
            if(w>h){h=Math.round(h*2400/w);w=2400;}
            else{w=Math.round(w*2400/h);h=2400;}
          }
          const canvas=document.createElement("canvas");
          canvas.width=w; canvas.height=h;
          const ctx=canvas.getContext("2d");
          if(!ctx){ finish(file); return; }
          ctx.drawImage(img,0,0,w,h);
          let lo=0.5,hi=0.96,best=null;
          for(let i=0;i<8;i++){
            const mid=(lo+hi)/2;
            const blob=await new Promise(r=>canvas.toBlob(r,"image/jpeg",mid));
            if(blob && blob.size<=1.8*1024*1024){best=blob;lo=mid;}else{hi=mid;}
          }
          if(!best) best=await new Promise(r=>canvas.toBlob(r,"image/jpeg",0.5));
          if(!best){ finish(file); return; }
          finish(new File([best],file.name.replace(/\.[^/.]+$/,".jpg"),{type:"image/jpeg"}));
        }catch(e){
          finish(file);
        }
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Convert ──
btnConvert.addEventListener("click", doConvert);

async function doConvert(){
  if(!selectedFile || convertInFlight) return;
  convertInFlight=true;
  hideError();
  btnConvert.disabled=true;
  uploadSection.style.display="none";
  progressWrap.classList.add("show");
  progressFill.style.width="0%";
  convertStartTime = Date.now();

  const steps=[
    [15,"Reading document…"],
    [40,"Converting formats…"],
    [65,"Compressing to sizes…"],
    [85,"Generating masked version…"],
    [95,"Almost done…"]
  ];
  let si=0;
  const timer=setInterval(()=>{
    if(si<steps.length){progressFill.style.width=steps[si][0]+"%";progressLabel.textContent=steps[si][1];si++;}
  },1100);
  const controller=new AbortController();
  const abortTimer=setTimeout(()=>controller.abort(), CONVERT_TIMEOUT_MS);

  try{
    const f=await compressIfNeeded(selectedFile);
    const fd=new FormData();
    fd.append("file",f);
    const res=await fetch(`${API_URL}/convert`,{method:"POST",body:fd,signal:controller.signal});
    if(!res.ok){
      const err=await res.json().catch(()=>({}));
      const httpErr=new Error(apiErrorMessage(err, res.status>=500 ? "Server error. Please try again." : "Conversion failed"));
      httpErr.status=res.status;
      throw httpErr;
    }
    const data=await res.json().catch(()=>null);
    if(!data || !Array.isArray(data.files)) throw new Error("Server returned an invalid conversion response.");
    allFiles=data.files.filter(f=>f && ALLOWED_FORMATS.includes((f.format||"").toUpperCase()) && typeof f.data_b64==="string" && f.data_b64.length>0);
    if(allFiles.length===0) throw new Error("No downloadable files were returned. Please try again.");
    conversionNotice=typeof data.conversion_notice==="string" ? data.conversion_notice : "";

    if(window.saveConversionToHistory) window.saveConversionToHistory(selectedFile.name, allFiles);

    progressFill.style.width="100%";
    progressLabel.textContent="✅ Done!";
    setTimeout(()=>{
      progressWrap.classList.remove("show");
      btnConvert.disabled=false;
      showResults();
    },400);
  }catch(err){
    progressWrap.classList.remove("show");
    uploadSection.style.display="";
    btnConvert.disabled=false;
    const timedOut=err && err.name==="AbortError";
    const m=timedOut ? "The conversion timed out. The server may be busy — please try again." : (err.message||"");
    if(isRetryableNetworkError(err)){
      hideError();
      let countdown=30;
      let fired=false;
      const fireRetry=()=>{
        if(fired) return;
        fired=true;
        hideError();
        if(!convertInFlight) doConvert();
      };
      showError(`Server unavailable. Auto-retrying in ${countdown}s…`, false);
      retryTimer=setInterval(()=>{
        countdown--;
        if(countdown<=0){
          fireRetry();
        } else {
          errorWrap.replaceChildren(document.createTextNode(`⏳ Server unavailable. Auto-retrying in ${countdown}s… `));
          const retryNow = document.createElement("button");
          retryNow.className = "btn-retry-inline";
          retryNow.id = "btnRetryNow";
          retryNow.textContent = "Retry now →";
          retryNow.addEventListener("click", fireRetry);
          errorWrap.appendChild(retryNow);
        }
      },1000);
      serverStatus.textContent="🔴 Waking…";
      serverStatus.style.color="#DC2626";
    }else{
      showError(m||"Something went wrong.", true);
    }
  } finally {
    clearInterval(timer);
    clearTimeout(abortTimer);
    convertInFlight=false;
  }
}

// ── Show Results ──
function showResults(){
  resultsWrap.classList.add("show");
  const noticeEl=document.getElementById("convNotice");
  if(noticeEl){ noticeEl.textContent=conversionNotice ? "⚠️ "+conversionNotice : ""; noticeEl.classList.toggle("show",!!conversionNotice); }
  const elapsed=((Date.now()-convertStartTime)/1000).toFixed(1);
  afrCountUp(resultsCount,allFiles.length," files generated");
  if(resultsTime) resultsTime.textContent=`in ${elapsed}s`;

  // Build filter chips
  buildFilterBar();
  renderCards();
}

function buildFilterBar(){
  filterBar.innerHTML="";
  const formats=["ALL",...new Set(allFiles.map(f=>(f.format||"").toUpperCase()))];
  formats.forEach(fmt=>{
    const chip=document.createElement("button");
    chip.className="filter-chip"+(fmt==="ALL"?" active":"");
    chip.dataset.fmt=fmt;
    const count=fmt==="ALL"?allFiles.length:allFiles.filter(f=>(f.format||"").toUpperCase()===fmt).length;
    chip.textContent=`${fmt} (${count})`;
    chip.addEventListener("click",()=>{
      activeFilter=fmt;
      document.querySelectorAll(".filter-chip").forEach(c=>c.classList.toggle("active",c.dataset.fmt===fmt));
      renderCards();
    });
    filterBar.appendChild(chip);
  });
}

function renderCards(){
  cardsList.innerHTML="";
  const filtered=activeFilter==="ALL"?allFiles:allFiles.filter(f=>(f.format||"").toUpperCase()===activeFilter);

  const recommended=[];
  const others=[];
  filtered.forEach(f=>{
    const isRec=activePortal&&activePortal.id!=="general"&&typeof activePortal.match==="function"&&activePortal.match(f);
    if(isRec) recommended.push(f);
    else others.push(f);
  });

  if(recommended.length>0){
    const lbl=document.createElement("div");
    lbl.className="section-label recommended";
    lbl.append(document.createTextNode("⭐ Best for "));
    const portalNameEl = document.createElement("strong");
    portalNameEl.textContent = activePortal.name;
    lbl.appendChild(portalNameEl);
    cardsList.appendChild(lbl);
    recommended.forEach(f=>cardsList.appendChild(buildCard(f,true)));
  }
  if(others.length>0){
    const lbl2=document.createElement("div");
    lbl2.className="section-label";
    lbl2.textContent=recommended.length>0
      ? "Other formats"
      : (activePortal&&activePortal.id!=="general" ? "No generated file meets this suggestion" : "All formats");
    cardsList.appendChild(lbl2);
    others.forEach(f=>cardsList.appendChild(buildCard(f,false)));
  }
}

// ── Build card with copy button ──
function buildCard(f,isRec){
  const card=document.createElement("div");
  card.className="file-card"+(isRec?" recommended":" dimmed");
  const fmt=(f.format||"").toUpperCase();
  const isImg=["JPG","PNG","WEBP"].includes(fmt);

  // Thumbnail
  if(isImg&&f.data_b64){
    const thumb=document.createElement("img");
    thumb.className="card-thumb";
    const mime=fmt==="JPG"?"image/jpeg":`image/${fmt.toLowerCase()}`;
    thumb.src=`data:${mime};base64,${f.data_b64}`;
    thumb.loading="lazy";
    card.appendChild(thumb);
  }else{
    const ic=document.createElement("div");
    ic.className="card-icon-thumb "+(fmt==="PDF"?"icon-pdf":"icon-docx");
    ic.textContent=fmt==="PDF"?(f.label.includes("Masked")?"🔐":"📋"):"📝";
    card.appendChild(ic);
  }

  // Content
  const content=document.createElement("div");
  content.className="card-content";
  const topRow=document.createElement("div");
  topRow.className="card-top-row";
  const badge=document.createElement("span");
  badge.className="card-fmt "+fmtClass(fmt);
  badge.textContent=fmt;
  const label=document.createElement("span");
  label.className="card-label";
  label.textContent=f.label||f.name;
  label.title=f.label||f.name;
  topRow.appendChild(badge);
  topRow.appendChild(label);
  const sizeEl=document.createElement("span");
  sizeEl.className="card-size";
  sizeEl.textContent=(f.size_kb||0)+" KB";
  content.appendChild(topRow);
  content.appendChild(sizeEl);
  card.appendChild(content);

  // Action buttons
  const actions=document.createElement("div");
  actions.className="card-actions";

  // Copy to clipboard (images only)
  if(isImg&&f.data_b64){
    const copyBtn=document.createElement("button");
    copyBtn.className="btn-copy";
    copyBtn.title="Copy to clipboard";
    copyBtn.textContent="📋";
    copyBtn.addEventListener("click",async()=>{
      try{
        const mime=fmt==="JPG"?"image/jpeg":`image/${fmt.toLowerCase()}`;
        const bc=atob(f.data_b64);
        const ba=new Uint8Array(bc.length);
        for(let i=0;i<bc.length;i++) ba[i]=bc.charCodeAt(i);
        const blob=new Blob([ba],{type:mime});
        await navigator.clipboard.write([new ClipboardItem({[mime]:blob})]);
        copyBtn.textContent="✅";
        afrToast("📋 Image copied to clipboard");
        setTimeout(()=>copyBtn.textContent="📋",1500);
      }catch(e){
        copyBtn.textContent="❌";
        setTimeout(()=>copyBtn.textContent="📋",1500);
      }
    });
    actions.appendChild(copyBtn);
  }

  // Download
  const dl=document.createElement("button");
  dl.className="btn-dl";
  dl.textContent="⬇";
  dl.title="Download "+f.name;
  dl.addEventListener("click",()=>downloadFile(f));
  actions.appendChild(dl);
  card.appendChild(actions);
  return card;
}

// ── Download ──
function downloadFile(f){
  try{
    const ext=(f.name||"file").split(".").pop().toLowerCase();
    const mimeMap={jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",pdf:"application/pdf",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"};
    const mime=mimeMap[ext]||"application/octet-stream";
    const bc=atob(f.data_b64);
    const ba=new Uint8Array(bc.length);
    for(let i=0;i<bc.length;i++) ba[i]=bc.charCodeAt(i);
    const blob=new Blob([ba],{type:mime});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=f.name||"download"; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    afrToast("⬇ Saved "+(f.name||"file"));
  }catch(e){ showError("Download failed. Try again."); }
}

// ── ZIP ──
btnZip.addEventListener("click",async()=>{
  btnZip.disabled = true;
  try{
    if(!window.JSZip){
    try{
      await new Promise((res,rej)=>{
        const s=document.createElement("script");
        s.src="jszip.min.js"; s.onload=res; s.onerror=rej;
        document.head.appendChild(s);
      });
    }catch(e){ showError("ZIP not available. Download individually."); return; }
    }
    if(typeof window.JSZip !== "function") throw new Error("ZIP dependency did not load correctly.");
    const zip=new window.JSZip();
    allFiles.forEach(f=>{
      const bc=atob(f.data_b64);
      const ba=new Uint8Array(bc.length);
      for(let i=0;i<bc.length;i++) ba[i]=bc.charCodeAt(i);
      zip.file(`allformatsready/${f.category||"files"}/${f.name||"download"}`,ba);
    });
    const blob=await zip.generateAsync({type:"blob"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download="allformatsready.zip"; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){ showError("ZIP creation failed. Download files individually."); }
  finally{ btnZip.disabled = false; }
});


// ── Onboarding — show only on first use ──
function initOnboarding(){
  chrome.storage.local.get("onboardingDone", data => {
    if(!data.onboardingDone){
      // First time — show onboarding, hide main UI
      document.getElementById("onboardWrap").style.display = "block";
      document.querySelector(".tab-bar").style.display = "none";
      document.querySelectorAll(".tab-panel").forEach(p => p.style.display = "none");
      document.querySelector(".ext-footer").style.display = "none";
    }
  });

  document.getElementById("btnOnboardStart")?.addEventListener("click", finishOnboarding);
  document.getElementById("onboardSkip")?.addEventListener("click", finishOnboarding);
}

function finishOnboarding(){
  chrome.storage.local.set({ onboardingDone: true });
  document.getElementById("onboardWrap").style.display = "none";
  document.querySelector(".tab-bar").style.display = "flex";
  document.querySelectorAll(".tab-panel").forEach((p,i) => {
    p.style.display = "";
    if(i === 0) p.classList.add("active");
  });
  document.querySelector(".ext-footer").style.display = "";
}

// ── Micro-interaction helpers (toast, ripple, count-up, paste-to-convert) ──
let afrToastTimer=null;
function afrToast(msg,type){
  const el=document.getElementById("afrToast");
  if(!el) return;
  el.textContent=msg;
  el.className="afr-toast"+(type?" "+type:""); void el.offsetWidth; el.classList.add("show");
  clearTimeout(afrToastTimer);
  afrToastTimer=setTimeout(()=>el.classList.remove("show"),1800);
}
function afrCountUp(el,target,suffix){
  if(!el) return;
  if(window.matchMedia("(prefers-reduced-motion: reduce)").matches || target<2){ el.textContent=target+suffix; return; }
  const start=performance.now(), dur=450;
  const tick=now=>{
    const t=Math.min((now-start)/dur,1);
    el.textContent=Math.round(target*(1-Math.pow(1-t,3)))+suffix;
    if(t<1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
document.addEventListener("click",e=>{
  const btn=e.target.closest(".btn-convert,.btn-tool-ext,.btn-pp-generate,.btn-zip,.btn-again,.btn-onboard-start,.btn-dl,.btn-copy,.btn-copy-ext");
  if(!btn||btn.disabled) return;
  const r=btn.getBoundingClientRect(), dot=document.createElement("span");
  dot.className="afr-ripple";
  dot.style.left=(e.clientX-r.left)+"px"; dot.style.top=(e.clientY-r.top)+"px";
  btn.appendChild(dot);
  setTimeout(()=>dot.remove(),520);
});
// Paste a screenshot or file (Ctrl+V) straight into the Convert tab
document.addEventListener("paste",e=>{
  const convertTab=document.getElementById("tab-convert");
  if(!convertTab||!convertTab.classList.contains("active")||uploadSection.style.display==="none") return;
  const file=e.clipboardData&&e.clipboardData.files&&e.clipboardData.files[0];
  if(!file) return;
  e.preventDefault();
  setFile(file);
  if(selectedFile===file) afrToast("📋 Pasted "+(file.name||"image"));
});

// ── Custom-size compressor (Convert tab) + sliding tab indicator ──
(function(){
  const $ = id => document.getElementById(id);
  const kbEl = $("csKb"), wEl = $("csW"), hEl = $("csH"), btn = $("btnCompress"), msg = $("csMsg"), dlBtn = $("btnCsDl");
  if(!kbEl || !btn) return;
  let outBlob = null, outName = "";

  function say(text, kind){ msg.textContent = text; msg.className = "cs-msg show " + kind; }
  function clearOut(){ outBlob = null; dlBtn.classList.remove("show"); msg.className = "cs-msg"; }
  function loadImg(file){
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Could not read this image.")); };
      img.src = url;
    });
  }
  const jpeg = (c, q) => new Promise(r => c.toBlob(b => r(b), "image/jpeg", q));
  function drawTo(src, w, h, crop){
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.imageSmoothingQuality = "high";
    const sw = src.width, sh = src.height;
    if(crop){
      const sr = sw / sh, dr = w / h; let cw, ch, cx, cy;
      if(sr > dr){ ch = sh; cw = ch * dr; cx = (sw - cw) / 2; cy = 0; } else { cw = sw; ch = cw / dr; cx = 0; cy = (sh - ch) / 2; }
      x.drawImage(src, cx, cy, cw, ch, 0, 0, w, h);
    } else { x.drawImage(src, 0, 0, w, h); }
    return c;
  }
  async function fitToMax(c, maxBytes){
    const top = await jpeg(c, 0.95); if(top.size <= maxBytes) return {blob: top, fits: true};
    let lo = 0.05, hi = 0.95, best = null;
    for(let i = 0; i < 8; i++){ const mid = (lo + hi) / 2, b = await jpeg(c, mid); if(b.size <= maxBytes){ best = b; lo = mid; } else hi = mid; }
    if(best) return {blob: best, fits: true};
    const floor = await jpeg(c, 0.05); return {blob: floor, fits: floor.size <= maxBytes};
  }
  function setBusy(on){ btn.classList.toggle("is-loading", on); btn.disabled = on; btn.textContent = on ? "Compressing…" : "Compress to custom size →"; }
  const base = n => (n || "file").replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "_") || "file";

  $("csChips").addEventListener("click", e => {
    const chip = e.target.closest(".cs-chip"); if(!chip) return;
    kbEl.value = chip.dataset.kb;
    document.querySelectorAll(".cs-chip").forEach(c => c.classList.toggle("on", c === chip));
  });
  kbEl.addEventListener("input", () => document.querySelectorAll(".cs-chip").forEach(c => c.classList.toggle("on", c.dataset.kb === kbEl.value)));

  btn.addEventListener("click", async () => {
    clearOut();
    if(!selectedFile){ say("Choose a file above first.", "err"); return; }
    const kb = Math.round(+kbEl.value) || 0, w = Math.round(+wEl.value) || 0, h = Math.round(+hEl.value) || 0;
    if(!kb && !(w && h)){ say("Enter a max size in KB, or both width and height.", "err"); return; }
    if(kb && (kb < 5 || kb > 10240)){ say("Max size must be between 5 and 10240 KB.", "err"); return; }
    if((w && !h) || (!w && h)){ say("Enter both width and height, or leave both empty.", "err"); return; }
    if(w > 5000 || h > 5000){ say("Maximum dimension is 5000 px.", "err"); return; }
    const ext = selectedFile.name.split(".").pop().toLowerCase();
    setBusy(true);
    try{
      if(["jpg","jpeg","png","webp"].includes(ext)){
        const img = await loadImg(selectedFile);
        const fixed = w && h;
        let c = fixed ? drawTo(img, w, h, true)
                      : (s => drawTo(img, Math.round(img.width * s), Math.round(img.height * s), false))(Math.min(1, 2400 / Math.max(img.width, img.height)));
        let res = kb ? await fitToMax(c, kb * 1024) : {blob: await jpeg(c, 0.92), fits: true};
        while(kb && !res.fits && !fixed && Math.min(c.width, c.height) > 60){
          c = drawTo(c, Math.round(c.width * 0.85), Math.round(c.height * 0.85), false);
          res = await fitToMax(c, kb * 1024);
        }
        outBlob = res.blob; outName = base(selectedFile.name) + "_compressed.jpg";
        const size = (outBlob.size / 1024).toFixed(1);
        if(res.fits) say(`✅ ${c.width}×${c.height} px · ${size} KB`, "ok");
        else say(`Could not get under ${kb} KB at ${c.width}×${c.height} px (got ${size} KB). Try a simpler image or larger pixel size.`, "err");
      } else if(ext === "pdf"){
        if(!kb){ say("For PDFs, enter a max size in KB.", "err"); return; }
        const fd = new FormData();
        fd.append("file", selectedFile); fd.append("pages", ""); fd.append("rotate", "0"); fd.append("target_kb", String(kb));
        const r = await fetch(`${API_URL}/organize-pdf`, {method: "POST", body: fd});
        if(!r.ok){ const e = await r.json().catch(() => ({})); throw new Error(typeof e.detail === "string" ? e.detail : "Could not compress this PDF."); }
        const d = await r.json();
        const bin = atob(d.pdf), bytes = new Uint8Array(bin.length);
        for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        outBlob = new Blob([bytes], {type: "application/pdf"}); outName = base(selectedFile.name) + "_compressed.pdf";
        say(`✅ ${d.pages} page${d.pages === 1 ? "" : "s"} · ${d.size_kb} KB` + (d.notice ? ` — ${d.notice}` : ""), d.notice ? "err" : "ok");
      } else {
        say("Custom size works with JPG, PNG, WebP and PDF. For DOCX or HEIC, run Generate All Formats first.", "err");
        return;
      }
      if(outBlob){ dlBtn.classList.add("show"); }
    } catch(err){ say(err.message || "Something went wrong. Try again.", "err"); }
    finally{ setBusy(false); }
  });
  dlBtn.addEventListener("click", () => {
    if(!outBlob) return;
    const url = URL.createObjectURL(outBlob), a = document.createElement("a");
    a.href = url; a.download = outName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    afrToast("⬇ Saved " + outName);
  });
  fileInput.addEventListener("change", clearOut);

  // Sliding tab indicator
  const bar = $("tabBar"), ind = $("tabInd");
  function moveInd(){
    let active = bar && bar.querySelector(".tab-btn.active");
    if(!active || !ind) return;
    const parent = bar.querySelector('.tab-btn[data-tab="tools"]');
    bar.querySelectorAll(".active-parent").forEach(b => b.classList.remove("active-parent"));
    if(active.classList.contains("sub") && parent){ parent.classList.add("active-parent"); active = parent; }
    ind.style.width = active.offsetWidth + "px";
    ind.style.transform = `translateX(${active.offsetLeft}px)`;
  }
  if(bar){ bar.addEventListener("click", () => requestAnimationFrame(moveInd)); window.addEventListener("resize", moveInd); requestAnimationFrame(moveInd); setTimeout(moveInd, 250); }
})();

// ── Success celebration (confetti burst) ──
function afrCelebrate(){
  if(window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors=["#2563EB","#16A34A","#F59E0B","#EC4899","#8B5CF6","#06B6D4"];
  const cx=window.innerWidth/2, cy=110;
  for(let i=0;i<18;i++){
    const p=document.createElement("span"); p.className="afr-confetti";
    const a=Math.random()*Math.PI*2, d=60+Math.random()*90;
    p.style.left=cx+"px"; p.style.top=cy+"px"; p.style.background=colors[i%colors.length];
    p.style.setProperty("--dx",Math.cos(a)*d+"px"); p.style.setProperty("--dy",(Math.sin(a)*d+40)+"px"); p.style.setProperty("--rot",(Math.random()*540-270)+"deg");
    document.body.appendChild(p); setTimeout(()=>p.remove(),1000);
  }
}

// ── Tools hub, PDF Organizer, Photo & Signature Resizer, Mask ──
(function(){
  const $=id=>document.getElementById(id);
  const MAXB=10*1024*1024;
  const go=tab=>{ const b=document.querySelector('.tab-btn[data-tab="'+tab+'"]'); if(b) b.click(); };
  const base=n=>(n||"file").replace(/\.[^.]+$/,"").replace(/[^\w\-]+/g,"_")||"file";
  const isImg=f=>/^image\/(jpeg|png|webp)$/.test(f.type)||/\.(jpe?g|png|webp)$/i.test(f.name);
  const say=(el,text,kind)=>{ el.textContent=text; el.className="cs-msg show "+kind; };
  function save(blob,name){ const u=URL.createObjectURL(blob),a=document.createElement("a"); a.href=u; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),1000); afrToast("⬇ Saved "+name,"ok"); }
  function loadImg(file){ return new Promise((res,rej)=>{ const u=URL.createObjectURL(file),i=new Image(); i.onload=()=>{URL.revokeObjectURL(u);res(i)}; i.onerror=()=>{URL.revokeObjectURL(u);rej(new Error("Could not read this image."))}; i.src=u; }); }
  const jpeg=(c,q)=>new Promise(r=>c.toBlob(b=>r(b),"image/jpeg",q));

  // Tiles and back buttons
  document.querySelectorAll(".tl-tile").forEach(t=>t.addEventListener("click",()=>go(t.dataset.go)));
  ["merge","textex","organizer","resizer","mask"].forEach(id=>{
    const p=$("tab-"+id); if(!p) return;
    const b=document.createElement("button"); b.type="button"; b.className="tool-back"; b.textContent="← All tools";
    b.addEventListener("click",()=>go("tools")); p.insertBefore(b,p.firstChild);
  });

  // ───── PDF Organizer (server) ─────
  const orgIn=$("orgInExt"), btnOrg=$("btnOrgExt"), orgMsg=$("orgMsgExt"), orgDl=$("btnOrgDlExt");
  let orgFile=null, orgBlob=null, orgName="organized";
  orgIn.addEventListener("change",()=>{
    const f=orgIn.files[0]; orgBlob=null; orgDl.classList.remove("show"); orgMsg.className="cs-msg"; btnOrg.disabled=true; orgFile=null;
    if(!f) return;
    if(!/\.pdf$/i.test(f.name)&&f.type!=="application/pdf"){ say(orgMsg,"Please choose a PDF file.","err"); orgIn.value=""; return; }
    if(f.size>MAXB){ say(orgMsg,"File is larger than 10MB.","err"); orgIn.value=""; return; }
    orgFile=f; orgName=base(f.name); $("orgDropTextExt").textContent="📄 "+f.name; btnOrg.disabled=false;
  });
  btnOrg.addEventListener("click",async()=>{
    if(!orgFile) return;
    const kb=Math.round(+$("orgKbExt").value)||0;
    if(kb&&(kb<20||kb>10240)){ say(orgMsg,"Max size must be between 20 and 10240 KB.","err"); return; }
    orgDl.classList.remove("show"); orgMsg.className="cs-msg"; btnOrg.disabled=true; btnOrg.classList.add("is-loading"); btnOrg.textContent="Working…";
    try{
      const fd=new FormData(); fd.append("file",orgFile); fd.append("pages",$("orgPagesExt").value.trim()); fd.append("rotate",$("orgRotExt").value); fd.append("target_kb",String(kb));
      const r=await fetch(`${API_URL}/organize-pdf`,{method:"POST",body:fd});
      if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(typeof e.detail==="string"?e.detail:"Could not process this PDF."); }
      const d=await r.json(); const bin=atob(d.pdf), bytes=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      orgBlob=new Blob([bytes],{type:"application/pdf"});
      say(orgMsg,`✅ ${d.pages} page${d.pages===1?"":"s"} · ${d.size_kb} KB`+(d.notice?` — ${d.notice}`:""),d.notice?"err":"ok");
      orgDl.classList.add("show"); afrToast("✅ PDF ready","ok"); afrCelebrate();
    }catch(err){ say(orgMsg,err.message||"Could not process this PDF. Try again.","err"); }
    finally{ btnOrg.disabled=false; btnOrg.classList.remove("is-loading"); btnOrg.textContent="Create PDF →"; }
  });
  orgDl.addEventListener("click",()=>{ if(orgBlob) save(orgBlob,orgName+"_organized.pdf"); });

  // ───── Photo & Signature Resizer (on device) ─────
  const PRES=[["Custom size",0,0,0,0],["SSC — Photo",100,120,20,50],["SSC — Signature",140,60,10,20],["IBPS / SBI — Photo",200,230,20,50],["IBPS / SBI — Signature",140,60,10,20],["IBPS — Left thumb",240,240,20,50],["IBPS — Declaration",800,400,50,100],["NEET / JEE — Photo (size only)",0,0,10,200],["NEET / JEE — Signature (size only)",0,0,4,30]];
  const rsIn=$("rsInExt"), rsPreset=$("rsPresetExt"), rsW=$("rsWExt"), rsH=$("rsHExt"), rsMin=$("rsMinExt"), rsMax=$("rsMaxExt"), rsFit=$("rsFitExt"),
        rsMsg=$("rsMsgExt"), rsPrev=$("rsPrevExt"), btnRs=$("btnRsExt"), rsDl=$("btnRsDlExt");
  let rsImg=null, rsName="image", rsBlob=null, rsUrl=null;
  PRES.forEach((p,i)=>{ const o=document.createElement("option"); o.value=i; o.textContent=p[0]; rsPreset.appendChild(o); });
  rsPreset.addEventListener("change",()=>{ const p=PRES[+rsPreset.value]; rsW.value=p[1]||""; rsH.value=p[2]||""; rsMin.value=p[3]||""; rsMax.value=p[4]||""; });
  [rsW,rsH,rsMin,rsMax].forEach(el=>el.addEventListener("input",()=>{ rsPreset.value="0"; }));
  rsIn.addEventListener("change",async()=>{
    const f=rsIn.files[0]; rsBlob=null; rsDl.classList.remove("show"); rsPrev.classList.remove("show"); rsMsg.className="cs-msg"; btnRs.disabled=true; rsImg=null;
    if(!f) return;
    if(!isImg(f)){ say(rsMsg,"Please choose a JPG, PNG or WebP image.","err"); rsIn.value=""; return; }
    if(f.size>MAXB){ say(rsMsg,"File is larger than 10MB.","err"); rsIn.value=""; return; }
    try{ rsImg=await loadImg(f); rsName=base(f.name); $("rsDropTextExt").textContent="🖼️ "+f.name; btnRs.disabled=false; }catch(e){ say(rsMsg,e.message,"err"); }
  });
  function drawTo(src,w,h,crop){
    const c=document.createElement("canvas"); c.width=w; c.height=h; const x=c.getContext("2d"); x.fillStyle="#fff"; x.fillRect(0,0,w,h); x.imageSmoothingQuality="high";
    const sw=src.width, sh=src.height;
    if(crop){ const sr=sw/sh, dr=w/h; let cw,ch,cx,cy; if(sr>dr){ch=sh;cw=ch*dr;cx=(sw-cw)/2;cy=0}else{cw=sw;ch=cw/dr;cx=0;cy=(sh-ch)/2} x.drawImage(src,cx,cy,cw,ch,0,0,w,h); }
    else{ const s=Math.min(w/sw,h/sh), dw=sw*s, dh=sh*s; x.drawImage(src,0,0,sw,sh,(w-dw)/2,(h-dh)/2,dw,dh); }
    return c;
  }
  async function fitToMax(c,maxBytes){
    const top=await jpeg(c,0.95); if(top.size<=maxBytes) return {blob:top,fits:true};
    let lo=0.05,hi=0.95,best=null;
    for(let i=0;i<8;i++){ const mid=(lo+hi)/2, b=await jpeg(c,mid); if(b.size<=maxBytes){best=b;lo=mid}else hi=mid; }
    if(best) return {blob:best,fits:true};
    const floor=await jpeg(c,0.05); return {blob:floor,fits:floor.size<=maxBytes};
  }
  async function padJpeg(blob,target){
    const src=new Uint8Array(await blob.arrayBuffer()); let need=target-src.length;
    if(need<=4||src[0]!==0xFF||src[1]!==0xD8) return blob;
    let pos=2; if(src[2]===0xFF&&src[3]===0xE0) pos=4+((src[4]<<8)|src[5]);
    const parts=[src.subarray(0,pos)];
    while(need>4){ const n=Math.min(need-4,65533), seg=new Uint8Array(n+4).fill(0x20); seg[0]=0xFF; seg[1]=0xFE; seg[2]=((n+2)>>8)&255; seg[3]=(n+2)&255; parts.push(seg); need-=n+4; }
    parts.push(src.subarray(pos)); return new Blob(parts,{type:"image/jpeg"});
  }
  btnRs.addEventListener("click",async()=>{
    if(!rsImg) return;
    const w=Math.round(+rsW.value)||0, h=Math.round(+rsH.value)||0, minKB=+rsMin.value||0, maxKB=+rsMax.value||0;
    rsMsg.className="cs-msg"; rsDl.classList.remove("show"); rsPrev.classList.remove("show");
    if((w&&!h)||(!w&&h)){ say(rsMsg,"Enter both width and height, or leave both empty.","err"); return; }
    if(w>5000||h>5000){ say(rsMsg,"Maximum dimension is 5000 px.","err"); return; }
    if(minKB&&maxKB&&minKB>maxKB){ say(rsMsg,"Minimum size cannot be larger than maximum.","err"); return; }
    btnRs.disabled=true; btnRs.classList.add("is-loading"); btnRs.textContent="Working…";
    try{
      const fixed=w&&h; let c;
      if(fixed) c=drawTo(rsImg,w,h,rsFit.value==="crop");
      else{ const s=Math.min(1,2400/Math.max(rsImg.width,rsImg.height)); c=drawTo(rsImg,Math.round(rsImg.width*s),Math.round(rsImg.height*s),false); }
      let res=maxKB?await fitToMax(c,maxKB*1024):{blob:await jpeg(c,0.92),fits:true};
      while(maxKB&&!res.fits&&!fixed&&Math.min(c.width,c.height)>60){ c=drawTo(c,Math.round(c.width*.85),Math.round(c.height*.85),false); res=await fitToMax(c,maxKB*1024); }
      let padded=false;
      if(res.fits&&minKB&&res.blob.size<minKB*1024){ const goal=Math.min(minKB*1024+512,maxKB?maxKB*1024:Infinity); if(goal>=minKB*1024){ res.blob=await padJpeg(res.blob,goal); padded=true; } }
      rsBlob=res.blob; if(rsUrl) URL.revokeObjectURL(rsUrl); rsUrl=URL.createObjectURL(rsBlob); rsPrev.src=rsUrl; rsPrev.classList.add("show");
      const kb=rsBlob.size/1024;
      if(!res.fits) say(rsMsg,`Could not get under ${maxKB} KB at ${c.width}×${c.height} px (got ${kb.toFixed(1)} KB).`,"err");
      else if(minKB&&kb<minKB) say(rsMsg,`File is ${kb.toFixed(1)} KB, below the ${minKB} KB minimum.`,"err");
      else { say(rsMsg,`✅ ${c.width}×${c.height} px · ${kb.toFixed(1)} KB`+(padded?" (padded with harmless metadata to meet the minimum)":""),"ok"); afrToast("✅ Resized to "+kb.toFixed(1)+" KB","ok"); afrCelebrate(); }
      rsDl.classList.add("show");
    }catch(err){ say(rsMsg,err.message||"Could not process this image.","err"); }
    finally{ btnRs.disabled=false; btnRs.classList.remove("is-loading"); btnRs.textContent="Resize & compress →"; }
  });
  rsDl.addEventListener("click",()=>{ if(rsBlob) save(rsBlob,rsName+"_resized.jpg"); });

  // ───── Mask Sensitive Info (manual, on device) ─────
  const mkIn=$("mkInExt"), mkC=$("mkCanvasExt"), mkX=mkC.getContext("2d"), mkStage=$("mkStageExt"), mkHint=$("mkHintExt"),
        mkMode=$("mkModeExt"), btnUndo=$("btnMkUndoExt"), btnClear=$("btnMkClearExt"), btnMkDl=$("btnMkDlExt");
  let mkBase=null, mkRects=[], mkDrag=null, mkStart=null, mkName="image";
  function apply(r){
    if(r.mode==="box"){ mkX.fillStyle="#000"; mkX.fillRect(r.x,r.y,r.w,r.h); return; }
    const blk=Math.max(10,Math.round(Math.max(mkC.width,mkC.height)/60)), sw=Math.max(1,Math.ceil(r.w/blk)), sh=Math.max(1,Math.ceil(r.h/blk));
    const t=document.createElement("canvas"); t.width=sw; t.height=sh; t.getContext("2d").drawImage(mkBase,r.x,r.y,r.w,r.h,0,0,sw,sh);
    mkX.imageSmoothingEnabled=false; mkX.drawImage(t,0,0,sw,sh,r.x,r.y,r.w,r.h); mkX.imageSmoothingEnabled=true;
  }
  function draw(){
    if(!mkBase) return;
    mkX.drawImage(mkBase,0,0); mkRects.forEach(apply);
    if(mkDrag){ mkX.save(); mkX.strokeStyle="#2563EB"; mkX.lineWidth=Math.max(2,mkC.width/300); mkX.setLineDash([8,6]); mkX.strokeRect(mkDrag.x,mkDrag.y,mkDrag.w,mkDrag.h); mkX.restore(); }
    btnUndo.disabled=btnClear.disabled=mkRects.length===0; btnMkDl.disabled=mkRects.length===0;
    btnMkDl.title=mkRects.length?"":"Cover at least one area first";
    if(mkRects.length){ mkHint.className="cs-msg show ok"; mkHint.textContent=`✅ ${mkRects.length} area${mkRects.length>1?"s":""} hidden. Check the preview, then download.`; }
    else { mkHint.className="cs-msg show todo"; mkHint.textContent="👆 Nothing hidden yet. Drag over the PAN or Aadhaar number. Download unlocks after you cover one area."; }
  }
  mkIn.addEventListener("change",async()=>{
    const f=mkIn.files[0]; if(!f) return;
    if(!isImg(f)){ say(mkHint,"Please choose a JPG, PNG or WebP image.","err"); mkIn.value=""; return; }
    if(f.size>MAXB){ say(mkHint,"File is larger than 10MB.","err"); mkIn.value=""; return; }
    try{
      const img=await loadImg(f), s=Math.min(1,2000/Math.max(img.width,img.height));
      mkBase=document.createElement("canvas"); mkBase.width=mkC.width=Math.round(img.width*s); mkBase.height=mkC.height=Math.round(img.height*s);
      mkBase.getContext("2d").drawImage(img,0,0,mkBase.width,mkBase.height);
      mkRects=[]; mkDrag=null; mkName=base(f.name); $("mkDropTextExt").textContent="🛡️ "+f.name; mkStage.classList.add("show"); draw();
    }catch(e){ say(mkHint,e.message,"err"); }
  });
  const pt=e=>{ const r=mkC.getBoundingClientRect(); return {x:Math.min(Math.max((e.clientX-r.left)*mkC.width/r.width,0),mkC.width), y:Math.min(Math.max((e.clientY-r.top)*mkC.height/r.height,0),mkC.height)}; };
  mkC.addEventListener("pointerdown",e=>{ if(!mkBase) return; mkStart=pt(e); mkDrag={x:mkStart.x,y:mkStart.y,w:0,h:0}; mkC.setPointerCapture(e.pointerId); e.preventDefault(); });
  mkC.addEventListener("pointermove",e=>{ if(!mkStart) return; const p=pt(e); mkDrag={x:Math.min(mkStart.x,p.x),y:Math.min(mkStart.y,p.y),w:Math.abs(p.x-mkStart.x),h:Math.abs(p.y-mkStart.y)}; draw(); });
  function finish(commit){
    if(!mkStart) return; const min=Math.max(6,mkC.width/150);
    if(commit&&mkDrag&&mkDrag.w>=min&&mkDrag.h>=min){ mkRects.push({x:Math.round(mkDrag.x),y:Math.round(mkDrag.y),w:Math.round(mkDrag.w),h:Math.round(mkDrag.h),mode:mkMode.value}); afrToast("🛡️ Area hidden","ok"); }
    mkStart=null; mkDrag=null; draw();
  }
  mkC.addEventListener("pointerup",()=>finish(true)); mkC.addEventListener("pointercancel",()=>finish(false));
  btnUndo.addEventListener("click",()=>{ mkRects.pop(); draw(); }); btnClear.addEventListener("click",()=>{ mkRects=[]; draw(); });
  btnMkDl.addEventListener("click",async()=>{ if(!mkBase||!mkRects.length) return; mkDrag=null; draw(); const b=await jpeg(mkC,0.92); if(b){ save(b,mkName+"_masked.jpg"); afrCelebrate(); } });

  // ───── Success feedback for every result panel ─────
  function watch(el,fn){ if(!el) return; let on=el.classList.contains("show"); new MutationObserver(()=>{ const now=el.classList.contains("show"); if(now&&!on) fn(el); on=now; }).observe(el,{attributes:true,attributeFilter:["class"]}); }
  document.querySelectorAll(".tool-result-ext").forEach(el=>watch(el,e=>{ afrToast(((e.querySelector(".tool-result-title")||{}).textContent||"✅ Done").trim(),"ok"); afrCelebrate(); }));
  watch($("resultsWrap"),()=>{ afrToast("🎉 "+allFiles.length+" formats ready. Pick what you need.","ok"); afrCelebrate(); });
  watch($("btnCsDl"),()=>afrToast("✅ Compressed. Tap download.","ok"));
  document.addEventListener("change",e=>{ const i=e.target; if(i&&i.type==="file"&&i.files&&i.files.length&&i.id!=="fileInput") afrToast(i.files.length>1?`✅ ${i.files.length} files added`:`✅ ${i.files[0].name} added`,"ok"); });
})();

// ── Init ──
detectCurrentPortal();
checkServer();
initOnboarding();

// ══════════════════════════════════════════
// PDF MERGE TAB
// ══════════════════════════════════════════
(function(){
  let mergeFiles = [];
  let mergedB64 = null;

  const mergeInput   = document.getElementById("mergeInputExt");
  const mergeDropExt = document.getElementById("mergeDropExt");
  const mergeChips   = document.getElementById("mergeChipsExt");
  const btnMerge     = document.getElementById("btnMergeExt");
  const mergeProg    = document.getElementById("mergeProgExt");
  const mergeFill    = document.getElementById("mergeFillExt");
  const mergeLabel   = document.getElementById("mergeLabelExt");
  const mergeResult  = document.getElementById("mergeResultExt");
  const mergeMeta    = document.getElementById("mergeMetaExt");
  const btnMergeDl   = document.getElementById("btnMergeDlExt");

  if(!mergeInput) return;

  function addFiles(files){
    Array.from(files).forEach(f => {
      if(!f.name.toLowerCase().endsWith(".pdf")) return;
      if(mergeFiles.length >= 10) return;
      mergeFiles.push(f);
    });
    renderChips();
    btnMerge.disabled = mergeFiles.length < 2;
  }

  function renderChips(){
    mergeChips.innerHTML = "";
    mergeFiles.forEach((f, i) => {
      const chip = document.createElement("div");
      chip.className = "tool-chip-ext";
      chip.append(document.createTextNode(`📄 ${f.name.length > 18 ? f.name.slice(0,18)+"…" : f.name} `));
      const remove = document.createElement("button");
      remove.className = "chip-rm";
      remove.dataset.i = String(i);
      remove.textContent = "✕";
      chip.appendChild(remove);
      mergeChips.appendChild(chip);
    });
    mergeChips.querySelectorAll(".chip-rm").forEach(btn => {
      btn.addEventListener("click", () => {
        mergeFiles.splice(parseInt(btn.dataset.i), 1);
        renderChips();
        btnMerge.disabled = mergeFiles.length < 2;
        mergeResult.classList.remove("show");
      });
    });
  }

  mergeInput.addEventListener("change", () => addFiles(mergeInput.files));

  mergeDropExt.addEventListener("dragover", e => { e.preventDefault(); mergeDropExt.classList.add("dragover"); });
  mergeDropExt.addEventListener("dragleave", () => mergeDropExt.classList.remove("dragover"));
  mergeDropExt.addEventListener("drop", e => {
    e.preventDefault(); mergeDropExt.classList.remove("dragover");
    addFiles(e.dataTransfer.files);
  });

  btnMerge.addEventListener("click", async () => {
    if(mergeFiles.length < 2) return;
    const totalSize = mergeFiles.reduce((sum, file) => sum + file.size, 0);
    if(totalSize > 30 * 1024 * 1024){
      showError("Merge files are too large. Max 30MB total.");
      return;
    }
    btnMerge.disabled = true;
    mergeResult.classList.remove("show");
    mergeProg.classList.add("show");
    mergeFill.style.width = "20%";
    mergeLabel.textContent = `Merging ${mergeFiles.length} PDFs…`;

    try {
      const fd = new FormData();
      mergeFiles.forEach(f => fd.append("files", f));
      mergeFill.style.width = "60%";
      mergeLabel.textContent = "Processing…";

      const res = await fetch(`${API_URL}/merge-pdf`, { method:"POST", body:fd });
      mergeFill.style.width = "90%";

      if(!res.ok){
        const err = await res.json().catch(()=>({}));
        throw new Error(apiErrorMessage(err, "Merge failed"));
      }

      const data = await res.json();
      if(!data || typeof data.merged_pdf !== "string") throw new Error("Server returned an invalid merge response.");
      mergedB64 = data.merged_pdf;
      mergeFill.style.width = "100%";
      mergeLabel.textContent = "Done!";

      setTimeout(() => {
        mergeProg.classList.remove("show");
        mergeMeta.textContent = `${data.files_merged} PDFs · ${data.pages} pages · ${data.size_kb} KB`;
        mergeResult.classList.add("show");
        btnMerge.disabled = false;
      }, 400);

    } catch(err) {
      mergeProg.classList.remove("show");
      btnMerge.disabled = false;
      const msg = isRetryableNetworkError(err)
        ? "Server is unavailable. Please try merge again in a moment."
        : (err.message || "Merge failed. Try again.");
      alert("⚠️ " + msg);
    }
  });

  btnMergeDl.addEventListener("click", () => {
    if(!mergedB64) return;
    const bc = atob(mergedB64);
    const ba = new Uint8Array(bc.length);
    for(let i=0;i<bc.length;i++) ba[i]=bc.charCodeAt(i);
    const blob = new Blob([ba], {type:"application/pdf"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href=url; a.download="merged_allformatsready.pdf"; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  });
})();


// ══════════════════════════════════════════
// PDF TO TEXT TAB
// ══════════════════════════════════════════
(function(){
  let txtB64 = null;
  let textFile = null;

  const textDropExt  = document.getElementById("textDropExt");
  const textInputExt = document.getElementById("textInputExt");
  const btnTextExt   = document.getElementById("btnTextExt");
  const textProgExt  = document.getElementById("textProgExt");
  const textFillExt  = document.getElementById("textFillExt");
  const textLabelExt = document.getElementById("textLabelExt");
  const textWarnExt  = document.getElementById("textWarnExt");
  const textAreaExt  = document.getElementById("textAreaExt");
  const textActionsExt = document.getElementById("textActionsExt");
  const btnCopyExt   = document.getElementById("btnCopyExt");
  const btnDlTxtExt  = document.getElementById("btnDlTxtExt");

  if(!textDropExt) return;

  function setFile(file){
    const ext = file.name.split(".").pop().toLowerCase();
    const allowed = ["pdf","jpg","jpeg","png","webp","heic","docx"];
    if(!allowed.includes(ext)){
      alert(`Format .${ext} not supported. Use PDF, JPG, PNG, WebP, HEIC or DOCX.`);
      return;
    }
    if(file.size > 10 * 1024 * 1024){
      alert("File too large. Max 10MB for text extraction.");
      return;
    }
    textFile = file;
    btnTextExt.disabled = false;
    btnTextExt.textContent = `Extract from "${file.name.length > 20 ? file.name.slice(0,20)+"…" : file.name}" →`;
    // Reset result
    textAreaExt.style.display = "none";
    textActionsExt.style.display = "none";
    textWarnExt.classList.remove("show");
    txtB64 = null;
  }

  textInputExt.addEventListener("change", () => { if(textInputExt.files[0]) setFile(textInputExt.files[0]); });
  textDropExt.addEventListener("dragover", e => { e.preventDefault(); textDropExt.classList.add("dragover"); });
  textDropExt.addEventListener("dragleave", () => textDropExt.classList.remove("dragover"));
  textDropExt.addEventListener("drop", e => {
    e.preventDefault(); textDropExt.classList.remove("dragover");
    if(e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  btnTextExt.addEventListener("click", async () => {
    if(!textFile) return;
    btnTextExt.disabled = true;
    textWarnExt.classList.remove("show");
    textAreaExt.style.display = "none";
    textActionsExt.style.display = "none";
    textProgExt.classList.add("show");
    textFillExt.style.width = "20%";
    textLabelExt.textContent = "Reading document…";

    try {
      const fd = new FormData();
      fd.append("file", textFile);
      textFillExt.style.width = "60%";
      textLabelExt.textContent = "Extracting text…";

      const res = await fetch(`${API_URL}/extract-text`, { method:"POST", body:fd });
      textFillExt.style.width = "90%";

      if(!res.ok){
        const err = await res.json().catch(()=>({}));
        throw new Error(apiErrorMessage(err, "Extraction failed"));
      }

      const data = await res.json();
      if(!data || typeof data.full_text !== "string" || typeof data.txt_b64 !== "string") throw new Error("Server returned an invalid text response.");
      txtB64 = data.txt_b64;
      textFillExt.style.width = "100%";
      textLabelExt.textContent = "Done!";

      setTimeout(() => {
        textProgExt.classList.remove("show");
        btnTextExt.disabled = false;

        if(!data.has_text){
          textWarnExt.classList.add("show");
        } else {
          textAreaExt.value = data.full_text;
          textAreaExt.style.display = "block";
          textActionsExt.style.display = "flex";
          btnTextExt.textContent = `✅ ${data.total_pages} pages · ${data.total_chars.toLocaleString()} chars`;
        }
      }, 400);

    } catch(err) {
      textProgExt.classList.remove("show");
      btnTextExt.disabled = false;
      btnTextExt.textContent = "Extract Text →";
      const msg = isRetryableNetworkError(err)
        ? "Server is unavailable. Please try extraction again in a moment."
        : (err.message || "Extraction failed. Try again.");
      alert("⚠️ " + msg);
    }
  });

  btnCopyExt.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(textAreaExt.value);
      btnCopyExt.textContent = "✅ Copied!";
      afrToast("📋 Text copied to clipboard");
      setTimeout(() => btnCopyExt.textContent = "📋 Copy", 1500);
    } catch(e) {
      textAreaExt.select();
      document.execCommand("copy");
    }
  });

  btnDlTxtExt.addEventListener("click", () => {
    if(!txtB64) return;
    const bc=atob(txtB64); const ba=new Uint8Array(bc.length);
    for(let i=0;i<bc.length;i++) ba[i]=bc.charCodeAt(i);
    const blob=new Blob([ba],{type:"text/plain"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download="extracted_text.txt"; a.click();
    URL.revokeObjectURL(url);
  });
})();
