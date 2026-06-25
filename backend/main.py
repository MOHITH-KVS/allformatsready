import os
import io
import re
import json
import base64
import threading
import time
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import fitz  # PyMuPDF
from PIL import Image

app = FastAPI(title="AllFormatsReady API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ALLOWED_TYPES = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  # docx
    "application/msword",  # doc
}

MAX_FILE_SIZE = 15 * 1024 * 1024  # 15MB

AADHAAR_PATTERN = re.compile(r'\b\d{4}\s?\d{4}\s?\d{4}\b')
PAN_PATTERN = re.compile(r'\b[A-Z]{5}[0-9]{4}[A-Z]\b')


def is_sensitive_doc(filename: str, text_content: str = "") -> bool:
    """Detect if document likely contains Aadhaar or PAN."""
    name_lower = filename.lower()
    keywords = ["aadhaar", "aadhar", "uid", "pan", "income tax"]
    for kw in keywords:
        if kw in name_lower:
            return True
    if text_content:
        if AADHAAR_PATTERN.search(text_content) or PAN_PATTERN.search(text_content):
            return True
    return False


def pdf_to_pil(pdf_bytes: bytes, dpi: int = 150) -> list[Image.Image]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    images = []
    for page in doc:
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        images.append(img)
    doc.close()
    return images


def extract_pdf_text(pdf_bytes: bytes) -> str:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    text = ""
    for page in doc:
        text += page.get_text()
    doc.close()
    return text


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
            best = buf.getvalue()
            lo = mid + 1
        else:
            hi = mid - 1
    if best is None:
        buf = io.BytesIO()
        if fmt == "JPEG":
            img.save(buf, format="JPEG", quality=10, optimize=True)
        elif fmt == "WEBP":
            img.save(buf, format="WEBP", quality=10)
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
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    txt = span["text"]
                    for m in AADHAAR_PATTERN.finditer(txt):
                        rects = page.search_for(m.group(0))
                        for rect in rects:
                            redact_rect = fitz.Rect(rect.x0, rect.y0, rect.x0 + (rect.width * 0.67), rect.y1)
                            page.add_redact_annot(redact_rect, fill=(0, 0, 0))
        page.apply_redactions()
    buf = io.BytesIO()
    doc.save(buf, garbage=4, deflate=True)
    doc.close()
    return buf.getvalue()


def img_to_bytes(img: Image.Image, fmt: str, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    if fmt == "JPEG":
        img.save(buf, format="JPEG", quality=quality, optimize=True)
    elif fmt == "PNG":
        img.save(buf, format="PNG", optimize=True)
    elif fmt == "WEBP":
        img.save(buf, format="WEBP", quality=quality)
    elif fmt == "PDF":
        img.save(buf, format="PDF")
    return buf.getvalue()


def make_output(name: str, fmt: str, data: bytes, label: str, category: str) -> dict:
    return {
        "name": name,
        "format": fmt,
        "label": label,
        "category": category,
        "size_bytes": len(data),
        "size_kb": round(len(data) / 1024, 1),
        "data_b64": base64.b64encode(data).decode(),
    }


@app.get("/")
def root():
    return {"status": "AllFormatsReady API is live"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/convert")
async def convert(file: UploadFile = File(...)):
    # Be lenient with content_type — check extension too
    filename = file.filename or ""
    ext = filename.lower().split(".")[-1] if "." in filename else ""

    file_bytes = await file.read()

    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Max 15MB allowed.")

    outputs = []

    is_pdf = file.content_type == "application/pdf" or ext == "pdf"
    is_docx = ext in ["docx", "doc"] or "wordprocessing" in (file.content_type or "")
    is_image = not is_pdf and not is_docx

    # ── DOCX → convert to PDF first via fitz ──────────────────────────
    if is_docx:
        # Render DOCX pages as images using fitz
        try:
            doc = fitz.open(stream=file_bytes, filetype="docx")
            pdf_buf = io.BytesIO()
            doc.save(pdf_buf)
            doc.close()
            file_bytes = pdf_buf.getvalue()
            is_pdf = True
            is_docx = False
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not process DOCX: {str(e)}")

    if is_pdf:
        # Extract text for sensitive doc detection
        text = extract_pdf_text(file_bytes)
        sensitive = is_sensitive_doc(filename, text)

        # 1. Compressed PDF
        compressed = compress_pdf(file_bytes)
        outputs.append(make_output("compressed.pdf", "PDF", compressed, "Compressed PDF", "PDF"))

        # 2. Masked PDF (only if Aadhaar/PAN detected)
        if sensitive:
            try:
                masked = mask_sensitive_pdf(file_bytes)
                outputs.append(make_output("masked_aadhaar.pdf", "PDF", masked, "Masked Aadhaar PDF", "PDF"))
            except Exception:
                pass

        # Convert first page to image
        images = pdf_to_pil(file_bytes)
        if images:
            img = images[0]

            # JPG quality variants
            for quality, label in [(90, "High Quality"), (70, "Medium Quality"), (45, "Low Quality")]:
                data = img_to_bytes(img, "JPEG", quality)
                outputs.append(make_output(f"jpg_{label.lower().replace(' ','_')}.jpg", "JPG", data, f"JPG — {label}", "JPG"))

            # JPG size targets
            for kb in [100, 200, 500, 1024]:
                data = compress_to_target(img, "JPEG", kb)
                outputs.append(make_output(f"jpg_under_{kb}kb.jpg", "JPG", data, f"JPG — Under {kb}KB", "JPG"))

            # PNG
            data = img_to_bytes(img, "PNG")
            outputs.append(make_output("image.png", "PNG", data, "PNG — Lossless", "PNG"))

            # WebP
            for quality, label in [(85, "High Quality"), (50, "Compressed")]:
                data = img_to_bytes(img, "WEBP", quality)
                outputs.append(make_output(f"webp_{label.lower()}.webp", "WEBP", data, f"WebP — {label}", "WebP"))

            # WebP size target
            data = compress_to_target(img, "WEBP", 200)
            outputs.append(make_output("webp_under_200kb.webp", "WEBP", data, "WebP — Under 200KB", "WebP"))

    elif is_image:
        try:
            img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        except Exception:
            raise HTTPException(status_code=400, detail="Could not read image file.")

        sensitive = is_sensitive_doc(filename)

        # JPG quality variants
        for quality, label in [(90, "High Quality"), (70, "Medium Quality"), (45, "Low Quality")]:
            data = img_to_bytes(img, "JPEG", quality)
            outputs.append(make_output(f"jpg_{label.lower().replace(' ','_')}.jpg", "JPG", data, f"JPG — {label}", "JPG"))

        # JPG size targets
        for kb in [100, 200, 500, 1024]:
            data = compress_to_target(img, "JPEG", kb)
            outputs.append(make_output(f"jpg_under_{kb}kb.jpg", "JPG", data, f"JPG — Under {kb}KB", "JPG"))

        # PNG
        data = img_to_bytes(img, "PNG")
        outputs.append(make_output("image.png", "PNG", data, "PNG — Lossless", "PNG"))

        # WebP
        for quality, label in [(85, "High Quality"), (50, "Compressed")]:
            data = img_to_bytes(img, "WEBP", quality)
            outputs.append(make_output(f"webp_{label.lower()}.webp", "WEBP", data, f"WebP — {label}", "WebP"))

        data = compress_to_target(img, "WEBP", 200)
        outputs.append(make_output("webp_under_200kb.webp", "WEBP", data, "WebP — Under 200KB", "WebP"))

        # PDF from image
        data = img_to_bytes(img, "PDF")
        outputs.append(make_output("image_as_pdf.pdf", "PDF", data, "PDF — From Image", "PDF"))

        compressed = compress_pdf(data)
        outputs.append(make_output("image_as_pdf_compressed.pdf", "PDF", compressed, "PDF — Compressed", "PDF"))

    return JSONResponse(content={"files": outputs, "total": len(outputs)})
