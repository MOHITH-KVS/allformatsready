// ── Portal Detection Database ──
function portalFormat(file){
  return String(file?.format || "").toUpperCase();
}

function portalSizeAtMost(file, maxBytes){
  return typeof file?.size_bytes === "number" && Number.isFinite(file.size_bytes) && file.size_bytes >= 0 && file.size_bytes <= maxBytes;
}

function portalJpgUnder(file, kb){
  return portalFormat(file) === "JPG" && portalSizeAtMost(file, kb * 1024);
}

function portalPdfUnder(file, mb){
  return portalFormat(file) === "PDF" && portalSizeAtMost(file, mb * 1024 * 1024);
}

function portalIsPdf(file){
  return portalFormat(file) === "PDF";
}

function portalIsMaskedPdf(file){
  return portalIsPdf(file) && String(file.label || "").startsWith("Masked ");
}

function portalIsUnmaskedPdf(file){
  return portalIsPdf(file) && !portalIsMaskedPdf(file);
}

const PORTAL_MAP = [
  // Government Portals
  {
    id:"epfo", name:"EPFO", icon:"🏢",
    domains:["epfindia.gov.in","unifiedportal-mem.epfindia.gov.in","unifiedportal-emp.epfindia.gov.in","passbook.epfindia.gov.in"],
    req:"PDF or JPG · Max 500KB",
    match: f => portalPdfUnder(f, 0.5) || portalJpgUnder(f, 500)
  },
  {
    id:"uidai", name:"UIDAI / Aadhaar", icon:"🪪",
    domains:["uidai.gov.in","myaadhaar.uidai.gov.in","resident.uidai.gov.in","ssup.uidai.gov.in"],
    req:"PDF · Masked preferred",
    match: f => portalIsPdf(f)
  },
  {
    id:"incometax", name:"Income Tax", icon:"📊",
    domains:["incometax.gov.in","eportal.incometax.gov.in","efiling.incometax.gov.in"],
    req:"PDF compressed · Max 1MB",
    match: f => portalPdfUnder(f, 1) && portalIsUnmaskedPdf(f)
  },
  {
    id:"passport", name:"Passport Seva", icon:"✈️",
    domains:["passportindia.gov.in","portal2.passportindia.gov.in","passportsevanks.gov.in"],
    req:"JPG under 500KB target · PDF",
    match: f => portalJpgUnder(f, 500) || portalIsUnmaskedPdf(f)
  },
  {
    id:"gst", name:"GST Portal", icon:"🧾",
    domains:["gst.gov.in","services.gst.gov.in","cbic-gst.gov.in"],
    req:"PDF or JPG · Max 1MB",
    match: f => portalPdfUnder(f, 1) || portalJpgUnder(f, 500)
  },
  {
    id:"nsp", name:"Scholarship (NSP)", icon:"📝",
    domains:["scholarships.gov.in","nsp.gov.in"],
    req:"JPG under 200KB · PDF",
    match: f => portalJpgUnder(f, 200) || portalIsUnmaskedPdf(f)
  },
  {
    id:"parivahan", name:"Parivahan / RTO", icon:"🚗",
    domains:["parivahan.gov.in","sarathi.parivahan.gov.in","vahan.parivahan.gov.in"],
    req:"JPG under 100KB",
    match: f => portalJpgUnder(f, 100)
  },
  {
    id:"digilocker", name:"DigiLocker", icon:"📱",
    domains:["digilocker.gov.in","api.digitallocker.gov.in","www.digilocker.gov.in"],
    req:"PDF · Any size",
    match: f => portalIsPdf(f)
  },
  {
    id:"nha", name:"Ayushman / NHA", icon:"💉",
    domains:["abdm.gov.in","healthid.ndhm.gov.in","pmjay.gov.in","bis.pmjay.gov.in"],
    req:"JPG under 200KB · PDF",
    match: f => portalJpgUnder(f, 200) || portalIsPdf(f)
  },
  {
    id:"cowin", name:"CoWIN", icon:"💊",
    domains:["cowin.gov.in","selfregistration.cowin.gov.in","prod-cdn.cowin.gov.in"],
    req:"JPG under 200KB",
    match: f => portalJpgUnder(f, 200)
  },
  {
    id:"epds", name:"Ration Card / EPDS", icon:"🌾",
    domains:["epds.gov.in","nfsa.gov.in","annavitran.nic.in"],
    req:"JPG under 200KB · PDF",
    match: f => portalJpgUnder(f, 200) || portalIsPdf(f)
  },
  {
    id:"umang", name:"UMANG Portal", icon:"📲",
    domains:["web.umang.gov.in","umang.gov.in"],
    req:"JPG under 200KB · PDF",
    match: f => portalJpgUnder(f, 200) || portalIsPdf(f)
  },

  // Banking
  {
    id:"hdfc", name:"HDFC Bank", icon:"🏦",
    domains:["hdfcbank.com","netbanking.hdfcbank.com","v2.hdfcbank.com","mobilebanking.hdfcbank.com"],
    req:"JPG under 200KB",
    match: f => portalJpgUnder(f, 200)
  },
  {
    id:"sbi", name:"SBI", icon:"🏦",
    domains:["sbi.co.in","onlinesbi.sbi","retail.onlinesbi.com","corporate.onlinesbi.com","yonomail.sbi.co.in"],
    req:"JPG under 200KB · PDF",
    match: f => portalJpgUnder(f, 200) || portalIsPdf(f)
  },
  {
    id:"icici", name:"ICICI Bank", icon:"🏦",
    domains:["icicibank.com","internetbanking.icicibank.com","imobile.icicibank.com"],
    req:"JPG under 200KB",
    match: f => portalJpgUnder(f, 200)
  },
  {
    id:"axis", name:"Axis Bank", icon:"🏦",
    domains:["axisbank.com","omni.axisbank.com","axismobile.axisbank.com"],
    req:"JPG under 200KB",
    match: f => portalJpgUnder(f, 200)
  },
  {
    id:"kotak", name:"Kotak Bank", icon:"🏦",
    domains:["kotak.com","netbanking.kotak.com","www.kotak.com"],
    req:"JPG under 200KB",
    match: f => portalJpgUnder(f, 200)
  },
  {
    id:"pnb", name:"PNB", icon:"🏦",
    domains:["pnbindia.in","netpnb.com","www.pnbindia.in"],
    req:"JPG under 200KB · PDF",
    match: f => portalJpgUnder(f, 200) || portalIsPdf(f)
  },
  {
    id:"bob", name:"Bank of Baroda", icon:"🏦",
    domains:["bankofbaroda.in","bobibanking.bankofbaroda.in"],
    req:"JPG under 200KB · PDF",
    match: f => portalJpgUnder(f, 200) || portalIsPdf(f)
  },

  // Job Portals
  {
    id:"naukri", name:"Naukri", icon:"💼",
    domains:["naukri.com","recruiter.naukri.com","www.naukri.com"],
    req:"PDF · Max 2MB",
    match: f => portalPdfUnder(f, 2) && portalIsUnmaskedPdf(f)
  },
  {
    id:"linkedin", name:"LinkedIn", icon:"💼",
    domains:["linkedin.com","www.linkedin.com","in.linkedin.com"],
    req:"PDF · Max 2MB",
    match: f => portalPdfUnder(f, 2) && portalIsUnmaskedPdf(f)
  },
  {
    id:"indeed", name:"Indeed", icon:"💼",
    domains:["indeed.com","in.indeed.com","www.indeed.com"],
    req:"PDF · Max 2MB",
    match: f => portalPdfUnder(f, 2) && portalIsUnmaskedPdf(f)
  },
  {
    id:"shine", name:"Shine", icon:"💼",
    domains:["shine.com","www.shine.com"],
    req:"PDF · Max 2MB",
    match: f => portalPdfUnder(f, 2) && portalIsUnmaskedPdf(f)
  },
  {
    id:"monster", name:"Monster India", icon:"💼",
    domains:["monster.com","monsterindia.com","www.monsterindia.com"],
    req:"PDF · Max 2MB",
    match: f => portalPdfUnder(f, 2) && portalIsUnmaskedPdf(f)
  },
  {
    id:"iimjobs", name:"IIMJobs / Hirist", icon:"💼",
    domains:["iimjobs.com","hirist.com","www.iimjobs.com"],
    req:"PDF · Max 2MB",
    match: f => portalPdfUnder(f, 2) && portalIsUnmaskedPdf(f)
  },
  {
    id:"internshala", name:"Internshala", icon:"🎓",
    domains:["internshala.com","www.internshala.com"],
    req:"PDF · Max 1MB",
    match: f => portalPdfUnder(f, 1) && portalIsUnmaskedPdf(f)
  },

  // Education
  {
    id:"nta", name:"JEE / NTA Portal", icon:"📚",
    domains:["jeemain.nta.nic.in","nta.ac.in","exams.nta.ac.in","ntaexam.net","jeeadv.ac.in","josaa.nic.in"],
    req:"JPG under 200KB",
    match: f => portalJpgUnder(f, 200)
  },
  {
    id:"neet", name:"NEET Portal", icon:"🏥",
    domains:["neet.nta.nic.in","neetug.ntaonline.in"],
    req:"JPG under 200KB",
    match: f => portalJpgUnder(f, 200)
  },
  {
    id:"du", name:"DU Admission", icon:"🎓",
    domains:["admission.uod.ac.in","du.ac.in","ugadmission.uod.ac.in"],
    req:"JPG under 200KB · PDF",
    match: f => portalJpgUnder(f, 200) || portalIsUnmaskedPdf(f)
  },
  {
    id:"collegeadm", name:"College Admission", icon:"🎓",
    domains:["ugc.ac.in","aicte-india.org","collegedunia.com","shiksha.com","careers360.com"],
    req:"JPG under 500KB · PDF",
    match: f => portalJpgUnder(f, 500) || portalIsUnmaskedPdf(f)
  },

  // Default fallback
  {
    id:"general", name:"General Use", icon:"📄",
    domains:[],
    req:"All formats available",
    match: f => true
  }
];

// ── Accurate portal detection — strict domain matching only ──
function detectPortal(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    for (const portal of PORTAL_MAP) {
      if (portal.id === "general") continue;
      for (const domain of portal.domains) {
        const cleanDomain = domain.toLowerCase().replace(/^www\./, "");
        // Exact match OR subdomain match only — no loose substring matching
        if (hostname === cleanDomain || hostname.endsWith("." + cleanDomain)) {
          return portal;
        }
      }
    }
  } catch(e) {}
  return null;
}

if (typeof module !== "undefined") {
  module.exports = { PORTAL_MAP, detectPortal };
}
