import os
import io
import re
import base64
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

fitz_mod = None
Image_cls = None
DocxDocument = None

def load_libs():
    global fitz_mod, Image_cls, DocxDocument
    if fitz_mod is None:
        import fitz as _fitz
        fitz_mod = _fitz
    if Image_cls is None:
        from PIL import Image as _Image
        Image_cls = _Image
    if DocxDocument is None:
        from docx import Document as _Doc
        DocxDocument = _Doc

@asynccontextmanager
async def lifespan(app):
    load_libs()
    yield

app = FastAPI(title="AllFormatsReady API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

MAX_FILE_SIZE = 15 * 1024 * 1024
AADHAAR_RE = re.compile(r'\b\d{4}\s?\d{4}\s?\d{4}\b')
PAN_RE = re.compile(r'\b[A-Z]{5}[0-9]{4}[A-Z]\b')
SENSITIVE_KW = ["aadhaar","aadhar","uid","pan","income","passport"]


def is_sensitive(filename, text=""):
    n = filename.lower()
    if any(k in n for k in SENSITIVE_KW): return True
    if text and (AADHAAR_RE.search(text) or PAN_RE.search(text)): return True
    return False


def pdf_page_to_pil(page, dpi=150):
    mat = fitz_mod.Matrix(dpi/72, dpi/72)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    return Image_cls.frombytes("RGB", [pix.width, pix.height], pix.samples)


def compress_to_target(img, fmt, target_kb):
    target_bytes = target_kb * 1024
    lo, hi, best = 10, 95, None
    for _ in range(10):
        mid = (lo + hi) // 2
        buf = io.BytesIO()
        if fmt == "JPEG": img.save(buf, format="JPEG", quality=mid, optimize=True)
        elif fmt == "WEBP": img.save(buf, format="WEBP", quality=mid)
        size = buf.tell()
        if size <= target_bytes: best = buf.getvalue(); lo = mid + 1
        else: hi = mid - 1
    if best is None:
        buf = io.BytesIO()
        if fmt == "JPEG": img.save(buf, format="JPEG", quality=10, optimize=True)
        elif fmt == "WEBP": img.save(buf, format="WEBP", quality=10)
        best = buf.getvalue()
    return best


def compress_pdf(pdf_bytes):
    doc = fitz_mod.open(stream=pdf_bytes, filetype="pdf")
    buf = io.BytesIO()
    doc.save(buf, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True)
    doc.close()
    return buf.getvalue()


def mask_pdf(pdf_bytes):
    doc = fitz_mod.open(stream=pdf_bytes, filetype="pdf")
    for page in doc:
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0: continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    for m in AADHAAR_RE.finditer(span["text"]):
                        for rect in page.search_for(m.group(0)):
                            r = fitz_mod.Rect(rect.x0, rect.y0, rect.x0 + rect.width*0.67, rect.y1)
                            page.add_redact_annot(r, fill=(0,0,0))
        page.apply_redactions()
    buf = io.BytesIO()
    doc.save(buf, garbage=4, deflate=True)
    doc.close()
    return buf.getvalue()


def img_bytes(img, fmt, quality=85):
    buf = io.BytesIO()
    if fmt == "JPEG": img.save(buf, format="JPEG", quality=quality, optimize=True)
    elif fmt == "PNG": img.save(buf, format="PNG", optimize=True)
    elif fmt == "WEBP": img.save(buf, format="WEBP", quality=quality)
    elif fmt == "PDF": img.save(buf, format="PDF")
    return buf.getvalue()


def pil_to_docx(img) -> bytes:
    """Embed a PIL image into a DOCX file."""
    doc = DocxDocument()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    doc.add_picture(buf, width=None)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def make_file(name, fmt, data, label, category, page=None):
    return {
        "name": name, "format": fmt, "label": label,
        "category": category, "page": page,
        "size_bytes": len(data), "size_kb": round(len(data)/1024, 1),
        "data_b64": base64.b64encode(data).decode(),
    }


def image_outputs(img, prefix="", page_num=None):
    outputs = []
    pg = f" · Page {page_num}" if page_num else ""
    p = f"p{page_num}_" if page_num else ""

    # JPG quality variants
    for q, lbl in [(90,"High Quality"),(70,"Medium Quality"),(45,"Low Quality")]:
        d = img_bytes(img, "JPEG", q)
        outputs.append(make_file(f"{p}jpg_{lbl.lower().replace(' ','_')}.jpg","JPG",d,f"JPG — {lbl}{pg}","JPG",page_num))

    # JPG size targets
    for kb in [100, 200, 500, 1024]:
        d = compress_to_target(img, "JPEG", kb)
        outputs.append(make_file(f"{p}jpg_under_{kb}kb.jpg","JPG",d,f"JPG — Under {kb}KB{pg}","JPG",page_num))

    # PNG lossless
    d = img_bytes(img, "PNG")
    outputs.append(make_file(f"{p}image.png","PNG",d,f"PNG — Lossless{pg}","PNG",page_num))

    # WebP variants
    for q, lbl in [(85,"High Quality"),(50,"Compressed")]:
        d = img_bytes(img, "WEBP", q)
        outputs.append(make_file(f"{p}webp_{lbl.lower()}.webp","WEBP",d,f"WebP — {lbl}{pg}","WebP",page_num))

    d = compress_to_target(img, "WEBP", 200)
    outputs.append(make_file(f"{p}webp_under_200kb.webp","WEBP",d,f"WebP — Under 200KB{pg}","WebP",page_num))

    # DOCX with image embedded
    d = pil_to_docx(img)
    outputs.append(make_file(f"{p}document.docx","DOCX",d,f"DOCX — Word Document{pg}","DOCX",page_num))

    return outputs


@app.get("/")
def root(): return {"status": "AllFormatsReady API is live"}

@app.get("/health")
def health(): return {"status": "ok"}


@app.post("/convert")
async def convert(file: UploadFile = File(...)):
    load_libs()
    filename = file.filename or "document"
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    file_bytes = await file.read()

    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Max 15MB allowed.")

    outputs = []
    total_pages = 1

    is_pdf = ext == "pdf" or "pdf" in (file.content_type or "")
    is_docx = ext in ["docx","doc"] or "wordprocessing" in (file.content_type or "")
    is_image = not is_pdf and not is_docx

    # ── DOCX input → convert to PDF via fitz ──
    if is_docx:
        try:
            doc = fitz_mod.open(stream=file_bytes, filetype="docx")
            buf = io.BytesIO()
            doc.save(buf)
            doc.close()
            file_bytes = buf.getvalue()
            is_pdf = True
            is_docx = False
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not process DOCX: {e}")

    if is_pdf:
        doc = fitz_mod.open(stream=file_bytes, filetype="pdf")
        total_pages = len(doc)
        text = "".join(p.get_text() for p in doc)
        sensitive = is_sensitive(filename, text)

        # Compressed PDF (whole doc)
        outputs.append(make_file("compressed.pdf","PDF",compress_pdf(file_bytes),"Compressed PDF","PDF"))

        # Masked PDF if Aadhaar/PAN detected
        if sensitive:
            try:
                outputs.append(make_file("masked_aadhaar.pdf","PDF",mask_pdf(file_bytes),"Masked Aadhaar PDF","PDF"))
            except: pass

        # Per-page image + docx outputs
        for i, page in enumerate(doc, 1):
            img = pdf_page_to_pil(page)
            pg = i if total_pages > 1 else None
            outputs.extend(image_outputs(img, f"page{i}", pg))

        doc.close()

    elif is_image:
        try:
            img = Image_cls.open(io.BytesIO(file_bytes)).convert("RGB")
        except:
            raise HTTPException(status_code=400, detail="Could not read image file.")

        outputs.extend(image_outputs(img))

        # PDF from image
        raw_pdf = img_bytes(img, "PDF")
        outputs.append(make_file("image_as_pdf.pdf","PDF",raw_pdf,"PDF — From Image","PDF"))
        outputs.append(make_file("image_as_pdf_compressed.pdf","PDF",compress_pdf(raw_pdf),"PDF — Compressed","PDF"))

    return JSONResponse(content={"files": outputs, "total": len(outputs), "total_pages": total_pages})