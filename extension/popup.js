const API_URL = "https://allformatsready.onrender.com";
const ALLOWED_FORMATS = ["JPG","PNG","WEBP","PDF","DOCX"];

let selectedFile = null;
let allFiles = [];
let activePortal = null;
let activeFilter = "ALL";
let convertStartTime = 0;
let retryTimer = null;

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
  return "📄";
}
function fmtClass(fmt){
  const m={JPG:"fmt-jpg",PNG:"fmt-png",WEBP:"fmt-webp",PDF:"fmt-pdf",DOCX:"fmt-docx"};
  return m[(fmt||"").toUpperCase()]||"fmt-jpg";
}
function showError(msg, showRetry=false){
  let html = "⚠️ " + msg;
  if(showRetry) html += ' <button class="btn-retry-inline" id="btnRetryInline">Retry now →</button>';
  errorWrap.innerHTML = html;
  errorWrap.classList.add("show");
  if(showRetry){
    document.getElementById("btnRetryInline")?.addEventListener("click", () => {
      hideError();
      doConvert();
    });
  }
}
function hideError(){
  errorWrap.innerHTML="";
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
      portalReq.textContent=portal.req;
    }
  }catch(e){}
}

// ── File handling ──
function setFile(file){
  if(!file) return;
  if(file.size>15*1024*1024){ showError("File too large. Max 15MB."); return; }
  const ext=file.name.split(".").pop().toLowerCase();
  const allowed=["pdf","jpg","jpeg","png","webp","heic","heif"];
  if(!allowed.includes(ext)){
    showError(`Format .${ext} not supported. Use PDF, JPG, PNG, WebP or HEIC.`);
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
  selectedFile=null; allFiles=[];
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
  return new Promise(resolve=>{
    const reader=new FileReader();
    reader.onload=e=>{
      const img=new Image();
      img.onload=async()=>{
        let w=img.width,h=img.height;
        if(w>2400||h>2400){
          if(w>h){h=Math.round(h*2400/w);w=2400;}
          else{w=Math.round(w*2400/h);h=2400;}
        }
        const canvas=document.createElement("canvas");
        canvas.width=w; canvas.height=h;
        canvas.getContext("2d").drawImage(img,0,0,w,h);
        let lo=0.5,hi=0.96,best=null;
        for(let i=0;i<8;i++){
          const mid=(lo+hi)/2;
          const blob=await new Promise(r=>canvas.toBlob(r,"image/jpeg",mid));
          if(blob.size<=1.8*1024*1024){best=blob;lo=mid;}else{hi=mid;}
        }
        if(!best) best=await new Promise(r=>canvas.toBlob(r,"image/jpeg",0.5));
        resolve(new File([best],file.name.replace(/\.[^/.]+$/,".jpg"),{type:"image/jpeg"}));
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Convert ──
btnConvert.addEventListener("click", doConvert);

async function doConvert(){
  if(!selectedFile) return;
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

  try{
    const f=await compressIfNeeded(selectedFile);
    const fd=new FormData();
    fd.append("file",f);
    const res=await fetch(`${API_URL}/convert`,{method:"POST",body:fd});
    clearInterval(timer);
    if(!res.ok){
      const err=await res.json().catch(()=>({detail:"Server error"}));
      throw new Error(err.detail||"Conversion failed");
    }
    const data=await res.json();
    allFiles=(data.files||[]).filter(f=>ALLOWED_FORMATS.includes((f.format||"").toUpperCase()));

    // Save to history
    if(window.ppSaveToHistory) window.ppSaveToHistory(selectedFile.name, allFiles.length);

    progressFill.style.width="100%";
    progressLabel.textContent="✅ Done!";
    setTimeout(()=>{
      progressWrap.classList.remove("show");
      btnConvert.disabled=false;
      showResults();
    },400);
  }catch(err){
    clearInterval(timer);
    progressWrap.classList.remove("show");
    uploadSection.style.display="";
    btnConvert.disabled=false;
    const m=err.message||"";
    if(m.includes("fetch")||m.includes("Failed")||m.includes("network")){
      // Auto-retry countdown
      let countdown=30;
      showError(`Server waking up. Auto-retrying in ${countdown}s…`, false);
      retryTimer=setInterval(()=>{
        countdown--;
        if(countdown<=0){
          clearInterval(retryTimer); retryTimer=null;
          hideError();
          doConvert();
        } else {
          errorWrap.innerHTML=`⏳ Server waking up. Auto-retrying in <strong>${countdown}s</strong>… <button class="btn-retry-inline" id="btnRetryNow">Retry now →</button>`;
          document.getElementById("btnRetryNow")?.addEventListener("click",()=>{
            clearInterval(retryTimer); retryTimer=null;
            hideError(); doConvert();
          });
        }
      },1000);
      serverStatus.textContent="🔴 Waking…";
      serverStatus.style.color="#DC2626";
    }else{
      showError(m||"Something went wrong.", true);
    }
  }
}

// ── Show Results ──
function showResults(){
  resultsWrap.classList.add("show");
  const elapsed=((Date.now()-convertStartTime)/1000).toFixed(1);
  resultsCount.textContent=`${allFiles.length} files generated`;
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
    lbl.innerHTML=`⭐ Best for <strong>${activePortal.name}</strong>`;
    cardsList.appendChild(lbl);
    recommended.forEach(f=>cardsList.appendChild(buildCard(f,true)));
  }
  if(others.length>0){
    const lbl2=document.createElement("div");
    lbl2.className="section-label";
    lbl2.textContent=recommended.length>0?"Other formats":"All formats";
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
  }catch(e){ showError("Download failed. Try again."); }
}

// ── ZIP ──
btnZip.addEventListener("click",async()=>{
  if(!window.JSZip){
    try{
      await new Promise((res,rej)=>{
        const s=document.createElement("script");
        s.src="jszip.min.js"; s.onload=res; s.onerror=rej;
        document.head.appendChild(s);
      });
    }catch(e){ showError("ZIP not available. Download individually."); return; }
  }
  const zip=new JSZip();
  allFiles.forEach(f=>{
    try{
      const bc=atob(f.data_b64);
      const ba=new Uint8Array(bc.length);
      for(let i=0;i<bc.length;i++) ba[i]=bc.charCodeAt(i);
      zip.file(`allformatsready/${f.category||"files"}/${f.name}`,ba);
    }catch(e){}
  });
  const blob=await zip.generateAsync({type:"blob"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download="allformatsready.zip"; a.click();
  URL.revokeObjectURL(url);
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

// ── Init ──
detectCurrentPortal();
checkServer();
initOnboarding();
