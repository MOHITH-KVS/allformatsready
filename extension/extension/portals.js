// ── Portal Detection Database ──
const PORTAL_MAP = [
  // Government Portals
  { id:"epfo",       name:"EPFO",              icon:"🏢", domains:["epfindia.gov.in","unifiedportal-mem.epfindia.gov.in"],         req:"PDF or JPG · Max 500KB",    match: f => (f.format==="PDF"&&!f.label.includes("Masked"))||(f.format==="JPG"&&(f.label.includes("500")||f.label.includes("200"))) },
  { id:"uidai",      name:"UIDAI / Aadhaar",   icon:"🪪", domains:["uidai.gov.in","myaadhaar.uidai.gov.in","resident.uidai.gov.in"], req:"PDF · Masked preferred",   match: f => f.format==="PDF" },
  { id:"incometax",  name:"Income Tax",         icon:"📊", domains:["incometax.gov.in","eportal.incometax.gov.in"],                 req:"PDF compressed · Max 1MB", match: f => f.format==="PDF"&&!f.label.includes("Masked") },
  { id:"passport",   name:"Passport Seva",      icon:"✈️", domains:["passportindia.gov.in","portal2.passportindia.gov.in"],          req:"JPG under 1MB · PDF",      match: f => (f.format==="JPG"&&f.label.includes("1024"))||(f.format==="PDF"&&!f.label.includes("Masked")) },
  { id:"gst",        name:"GST Portal",         icon:"🧾", domains:["gst.gov.in","services.gst.gov.in"],                            req:"PDF or JPG · Max 1MB",     match: f => f.format==="PDF"||(f.format==="JPG"&&f.label.includes("1024")) },
  { id:"nsp",        name:"Scholarship (NSP)",  icon:"📝", domains:["scholarships.gov.in","nsp.gov.in"],                            req:"JPG under 200KB · PDF",    match: f => (f.format==="JPG"&&f.label.includes("200"))||f.format==="PDF" },
  { id:"parivahan",  name:"Parivahan / RTO",    icon:"🚗", domains:["parivahan.gov.in","sarathi.parivahan.gov.in"],                 req:"JPG under 100KB",          match: f => f.format==="JPG"&&f.label.includes("100") },
  { id:"digilocker", name:"DigiLocker",         icon:"📱", domains:["digilocker.gov.in","api.digitallocker.gov.in"],                req:"PDF · Any size",           match: f => f.format==="PDF" },
  { id:"nha",        name:"Ayushman / NHA",     icon:"💉", domains:["abdm.gov.in","healthid.ndhm.gov.in","pmjay.gov.in"],           req:"JPG under 200KB · PDF",    match: f => (f.format==="JPG"&&f.label.includes("200"))||f.format==="PDF" },
  { id:"cowin",      name:"CoWIN",              icon:"💊", domains:["cowin.gov.in","selfregistration.cowin.gov.in"],                req:"JPG under 200KB",          match: f => f.format==="JPG"&&f.label.includes("200") },

  // Banking
  { id:"hdfc",       name:"HDFC Bank",          icon:"🏦", domains:["hdfcbank.com","netbanking.hdfcbank.com"],                      req:"JPG under 200KB",          match: f => f.format==="JPG"&&f.label.includes("200") },
  { id:"sbi",        name:"SBI",                icon:"🏦", domains:["sbi.co.in","onlinesbi.sbi","retail.onlinesbi.com"],            req:"JPG under 200KB · PDF",    match: f => (f.format==="JPG"&&f.label.includes("200"))||f.format==="PDF" },
  { id:"icici",      name:"ICICI Bank",         icon:"🏦", domains:["icicibank.com","internetbanking.icicibank.com"],               req:"JPG under 200KB",          match: f => f.format==="JPG"&&f.label.includes("200") },
  { id:"axis",       name:"Axis Bank",          icon:"🏦", domains:["axisbank.com","omni.axisbank.com"],                            req:"JPG under 200KB",          match: f => f.format==="JPG"&&f.label.includes("200") },
  { id:"kotak",      name:"Kotak Bank",         icon:"🏦", domains:["kotak.com","netbanking.kotak.com"],                            req:"JPG under 200KB",          match: f => f.format==="JPG"&&f.label.includes("200") },

  // Job Portals
  { id:"naukri",     name:"Naukri",             icon:"💼", domains:["naukri.com","recruiter.naukri.com"],                           req:"PDF · Max 2MB",            match: f => f.format==="PDF"&&!f.label.includes("Masked") },
  { id:"linkedin",   name:"LinkedIn",           icon:"💼", domains:["linkedin.com","www.linkedin.com"],                             req:"PDF · Max 2MB",            match: f => f.format==="PDF"&&!f.label.includes("Masked") },
  { id:"indeed",     name:"Indeed",             icon:"💼", domains:["indeed.com","in.indeed.com"],                                  req:"PDF · Max 2MB",            match: f => f.format==="PDF"&&!f.label.includes("Masked") },
  { id:"shine",      name:"Shine",              icon:"💼", domains:["shine.com","www.shine.com"],                                   req:"PDF · Max 2MB",            match: f => f.format==="PDF"&&!f.label.includes("Masked") },

  // Education
  { id:"collegeadm", name:"College Admission",  icon:"🎓", domains:["ugc.ac.in","aicte-india.org","admission.net","collegedunia.com","shiksha.com"], req:"JPG under 500KB · PDF", match: f => (f.format==="JPG"&&(f.label.includes("500")||f.label.includes("200")))||(f.format==="PDF"&&!f.label.includes("Masked")) },
  { id:"jee",        name:"JEE / NTA Portal",   icon:"📚", domains:["jeemain.nta.nic.in","nta.ac.in","exams.nta.ac.in"],            req:"JPG under 200KB",          match: f => f.format==="JPG"&&f.label.includes("200") },
  { id:"neet",       name:"NEET Portal",        icon:"🏥", domains:["neet.nta.nic.in","ntaexam.net"],                               req:"JPG under 200KB",          match: f => f.format==="JPG"&&f.label.includes("200") },

  // Default fallback
  { id:"general",    name:"General Use",        icon:"📄", domains:[],                                                              req:"All formats available",    match: f => true }
];

// ── Detect portal from current tab URL ──
function detectPortal(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    for (const portal of PORTAL_MAP) {
      if (portal.id === "general") continue;
      for (const domain of portal.domains) {
        if (hostname === domain || hostname.endsWith("." + domain) || domain.endsWith("." + hostname) || hostname.includes(domain.split(".")[0])) {
          return portal;
        }
      }
    }
  } catch(e) {}
  return null; // no match — will show general
}

// ── Export for use in popup.js ──
if (typeof module !== "undefined") {
  module.exports = { PORTAL_MAP, detectPortal };
}
