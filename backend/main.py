import os
import io
import re
import base64
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Heavy libraries — imported at module level but after FastAPI starts
fitz = None
Image = None

def load_libs():
    global fitz, Image
    if fitz is None:
        import fitz as _fitz
        fitz = _fitz
    if Image is None:
        from PIL import Image as _Image
        Image = _Image

@asynccontextmanager
async def lifespan(app):
    load_libs()  # pre-load on startup so first request is fast
    yield

app = FastAPI(title="AllFormatsReady API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

MAX_FILE_SIZE = 15 * 1024 * 1024
AADHAAR_PATTERN = re.compile(r'\b\d{4}\s?\d{4}\s?\d{4}\b')
PAN_PATTERN = re.compile(r'\b[A-Z]{5}[0-9]{4}[A-Z]\b')
SENSITIVE_KEYWORDS = ["aadhaar", "aadhar", "uid", "pan", "income", "passport"]


def is_sensitive(filename: str, text: str = "") -> bool:
    name = filename.lower()
    if any(k in name for k in SENSITIVE_KEYWORDS): return True
    if text and (AADHAAR_PATTERN.search(text) or PAN_PATTERN.search(text)): return True
    return False


def pdf_page_to_pil(page, dpi=150) -> Image.Image:
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    return Image.frombytes("RGB", [pix.width, pix.height], pix.samples)


def compress_to_target(img: Image.Image, fmt: str, target_kb: int) -> bytes:
    target_bytes = target_kb * 1024
    lo, hi = 10, 95
    best = None
    for _ in range(10):
        mid = (lo + hi) // 2
        buf = io.BytesIO()
        if fmt == "JPEG":
            img.save(buf, format="JPEG", quality=mid, optimize=True)
        elif fmt == "WEBP":
            img.save(buf, format="WEBP", quality=mid)
        size = buf.tell()
        if size <= target_bytes:
            best = buf.getvalue(); lo = mid + 1
        else:
            hi = mid - 1
    if best is None:
        buf = io.BytesIO()
        if fmt == "JPEG": img.save(buf, format="JPEG", quality=10, optimize=True)
        elif fmt == "WEBP": img.save(buf, format="WEBP", quality=10)
        best = buf.getvalue()
    return best


def compress_pdf(pdf_bytes: bytes) -> bytes:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    buf = io.BytesIO()
    doc.save(buf, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True)
    doc.close()
    return buf.getvalue()


def mask_sensitive_pdf(pdf_bytes: bytes) -> bytes:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    for page in doc:
        blocks = page.get_text("dict")["blocks"]
        for block in blocks:
            if block.get("type") != 0: continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    for m in AADHAAR_PATTERN.finditer(span["text"]):
                        for rect in page.search_for(m.group(0)):
                            redact = fitz.Rect(rect.x0, rect.y0, rect.x0 + rect.width * 0.67, rect.y1)
                            page.add_redact_annot(redact, fill=(0, 0, 0))
        page.apply_redactions()
    buf = io.BytesIO()
    doc.save(buf, garbage=4, deflate=True)
    doc.close()
    return buf.getvalue()


def img_bytes(img: Image.Image, fmt: str, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    if fmt == "JPEG": img.save(buf, format="JPEG", quality=quality, optimize=True)
    elif fmt == "PNG": img.save(buf, format="PNG", optimize=True)
    elif fmt == "WEBP": img.save(buf, format="WEBP", quality=quality)
    elif fmt == "PDF": img.save(buf, format="PDF")
    return buf.getvalue()


def make_file(name, fmt, data, label, category, page=None):
    return {
        "name": name, "format": fmt, "label": label,
        "category": category, "page": page,
        "size_bytes": len(data), "size_kb": round(len(data) / 1024, 1),
        "data_b64": base64.b64encode(data).decode(),
    }


def image_outputs(img: Image.Image, prefix: str, page_num: int = None) -> list:
    """Generate all image format variants for a single PIL image."""
    outputs = []
    page_label = f" · Page {page_num}" if page_num else ""
    p = f"p{page_num}_" if page_num else ""

    # JPG quality variants
    for quality, label in [(90, "High Quality"), (70, "Medium Quality"), (45, "Low Quality")]:
        data = img_bytes(img, "JPEG", quality)
        outputs.append(make_file(f"{p}jpg_{label.lower().replace(' ','_')}.jpg", "JPG", data, f"JPG — {label}{page_label}", "JPG", page_num))

    # JPG size targets
    for kb in [100, 200, 500, 1024]:
        data = compress_to_target(img, "JPEG", kb)
        outputs.append(make_file(f"{p}jpg_under_{kb}kb.jpg", "JPG", data, f"JPG — Under {kb}KB{page_label}", "JPG", page_num))

    # PNG
    data = img_bytes(img, "PNG")
    outputs.append(make_file(f"{p}image.png", "PNG", data, f"PNG — Lossless{page_label}", "PNG", page_num))

    # WebP
    for quality, label in [(85, "High Quality"), (50, "Compressed")]:
        data = img_bytes(img, "WEBP", quality)
        outputs.append(make_file(f"{p}webp_{label.lower()}.webp", "WEBP", data, f"WebP — {label}{page_label}", "WebP", page_num))

    data = compress_to_target(img, "WEBP", 200)
    outputs.append(make_file(f"{p}webp_under_200kb.webp", "WEBP", data, f"WebP — Under 200KB{page_label}", "WebP", page_num))

    return outputs


@app.get("/")
def root(): return {"status": "AllFormatsReady API is live"}

@app.get("/health")
def health(): return {"status": "ok"}


@app.post("/convert")
async def convert(file: UploadFile = File(...)):
    load_libs()  # ensure libs are loaded
    filename = file.filename or "document"
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    file_bytes = await file.read()

    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Max 15MB allowed.")

    outputs = []
    total_pages = 1

    is_pdf = ext == "pdf" or (file.content_type or "").startswith("application/pdf")
    is_docx = ext in ["docx", "doc"] or "wordprocessing" in (file.content_type or "")
    is_image = not is_pdf and not is_docx

    # DOCX → PDF via fitz
    if is_docx:
        try:
            doc = fitz.open(stream=file_bytes, filetype="docx")
            buf = io.BytesIO(); doc.save(buf); doc.close()
            file_bytes = buf.getvalue()
            is_pdf = True; is_docx = False
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not process DOCX: {e}")

    if is_pdf:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        total_pages = len(doc)
        text = "".join(page.get_text() for page in doc)
        sensitive = is_sensitive(filename, text)

        # Compressed PDF (whole document)
        compressed = compress_pdf(file_bytes)
        outputs.append(make_file("compressed.pdf", "PDF", compressed, "Compressed PDF", "PDF"))

        # Masked PDF (only if sensitive)
        if sensitive:
            try:
                masked = mask_sensitive_pdf(file_bytes)
                outputs.append(make_file("masked_aadhaar.pdf", "PDF", masked, "Masked Aadhaar PDF", "PDF"))
            except Exception:
                pass

        # Per-page image conversions
        for page_num, page in enumerate(doc, start=1):
            img = pdf_page_to_pil(page)
            page_label = page_num if total_pages > 1 else None
            outputs.extend(image_outputs(img, f"page{page_num}", page_label))

        doc.close()

    elif is_image:
        try:
            img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        except Exception:
            raise HTTPException(status_code=400, detail="Could not read image file.")

        outputs.extend(image_outputs(img, "img"))

        # PDF from image
        data = img_bytes(img, "PDF")
        outputs.append(make_file("image_as_pdf.pdf", "PDF", data, "PDF — From Image", "PDF"))
        outputs.append(make_file("image_as_pdf_compressed.pdf", "PDF", compress_pdf(data), "PDF — Compressed", "PDF"))

    return JSONResponse(content={"files": outputs, "total": len(outputs), "total_pages": total_pages})
