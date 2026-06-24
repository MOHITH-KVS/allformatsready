import os
import io
import zipfile
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
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
}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB


def delete_after_delay(path: str, delay: int = 60):
    """Delete temp file after delay seconds for privacy."""
    def _delete():
        time.sleep(delay)
        try:
            os.remove(path)
        except Exception:
            pass
    threading.Thread(target=_delete, daemon=True).start()


def pdf_to_pil_images(pdf_bytes: bytes) -> list[Image.Image]:
    """Convert each page of a PDF to a PIL Image at 150 DPI."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    images = []
    for page in doc:
        mat = fitz.Matrix(150 / 72, 150 / 72)  # 150 DPI
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        images.append(img)
    doc.close()
    return images


def compress_to_target(img: Image.Image, fmt: str, target_kb: int) -> bytes:
    """Binary-search compress image to hit a target file size in KB."""
    target_bytes = target_kb * 1024
    lo, hi = 10, 95
    best = None
    for _ in range(8):  # max 8 iterations
        mid = (lo + hi) // 2
        buf = io.BytesIO()
        if fmt == "JPEG":
            img.save(buf, format="JPEG", quality=mid, optimize=True)
        elif fmt == "WEBP":
            img.save(buf, format="WEBP", quality=mid)
        else:
            img.save(buf, format=fmt)
        size = buf.tell()
        if size <= target_bytes:
            best = buf.getvalue()
            lo = mid + 1
        else:
            hi = mid - 1
    if best is None:
        # Even at lowest quality, still over target — return minimum
        buf = io.BytesIO()
        if fmt == "JPEG":
            img.save(buf, format="JPEG", quality=10, optimize=True)
        elif fmt == "WEBP":
            img.save(buf, format="WEBP", quality=10)
        best = buf.getvalue()
    return best


def compress_pdf(pdf_bytes: bytes, target_kb: Optional[int] = None) -> bytes:
    """Compress PDF using PyMuPDF's garbage collection and deflate."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    buf = io.BytesIO()
    doc.save(
        buf,
        garbage=4,
        deflate=True,
        deflate_images=True,
        deflate_fonts=True,
        clean=True,
    )
    doc.close()
    return buf.getvalue()


def mask_aadhaar_pdf(pdf_bytes: bytes) -> bytes:
    """Redact first 8 digits of any 12-digit Aadhaar number in PDF."""
    import re
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pattern = re.compile(r'\b(\d{4})\s?(\d{4})\s?(\d{4})\b')
    for page in doc:
        text_instances = page.search_for(" ")  # trigger layout
        blocks = page.get_text("dict")["blocks"]
        for block in blocks:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    txt = span["text"]
                    matches = list(pattern.finditer(txt))
                    for m in matches:
                        # Redact first 8 digits (groups 1 and 2)
                        rects = page.search_for(m.group(0))
                        for rect in rects:
                            # Black out left 2/3 of match rect
                            redact_rect = fitz.Rect(
                                rect.x0, rect.y0,
                                rect.x0 + (rect.width * 0.67), rect.y1
                            )
                            page.add_redact_annot(redact_rect, fill=(0, 0, 0))
        page.apply_redactions()
    buf = io.BytesIO()
    doc.save(buf, garbage=4, deflate=True)
    doc.close()
    return buf.getvalue()


@app.get("/")
def root():
    return {"status": "AllFormatsReady API is live"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/convert")
async def convert(file: UploadFile = File(...)):
    # Validate file type
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {file.content_type}. Upload PDF, JPG, PNG, or WebP."
        )

    file_bytes = await file.read()

    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Max 10MB allowed.")

    zip_buffer = io.BytesIO()

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:

        is_pdf = file.content_type == "application/pdf"

        if is_pdf:
            # ── PDF input ──────────────────────────────────────────────
            images = pdf_to_pil_images(file_bytes)
            first_img = images[0] if images else None

            # 1. Compressed PDF (full document)
            compressed_pdf = compress_pdf(file_bytes)
            zf.writestr("allformatsready/PDF/compressed.pdf", compressed_pdf)

            # 2. Masked Aadhaar PDF
            try:
                masked = mask_aadhaar_pdf(file_bytes)
                zf.writestr("allformatsready/PDF/masked_aadhaar.pdf", masked)
            except Exception:
                pass  # skip if masking fails

            if first_img:
                # 3. JPG versions
                for quality, label in [(85, "high"), (60, "medium"), (40, "low")]:
                    buf = io.BytesIO()
                    first_img.save(buf, format="JPEG", quality=quality, optimize=True)
                    zf.writestr(f"allformatsready/JPG/jpg_{label}_quality.jpg", buf.getvalue())

                # 4. Size-targeted JPGs
                for target_kb in [100, 200, 500]:
                    data = compress_to_target(first_img, "JPEG", target_kb)
                    zf.writestr(f"allformatsready/JPG/jpg_under_{target_kb}kb.jpg", data)

                # 5. PNG (lossless)
                buf = io.BytesIO()
                first_img.save(buf, format="PNG", optimize=True)
                zf.writestr("allformatsready/PNG/image.png", buf.getvalue())

                # 6. WebP versions
                for quality, label in [(85, "high"), (50, "compressed")]:
                    buf = io.BytesIO()
                    first_img.save(buf, format="WEBP", quality=quality)
                    zf.writestr(f"allformatsready/WebP/webp_{label}.webp", buf.getvalue())

                # 7. Size-targeted WebP
                data = compress_to_target(first_img, "WEBP", 200)
                zf.writestr("allformatsready/WebP/webp_under_200kb.webp", data)

        else:
            # ── Image input ────────────────────────────────────────────
            img = Image.open(io.BytesIO(file_bytes)).convert("RGB")

            # 1. JPG versions
            for quality, label in [(85, "high"), (60, "medium"), (40, "low")]:
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=quality, optimize=True)
                zf.writestr(f"allformatsready/JPG/jpg_{label}_quality.jpg", buf.getvalue())

            # 2. Size-targeted JPGs
            for target_kb in [100, 200, 500]:
                data = compress_to_target(img, "JPEG", target_kb)
                zf.writestr(f"allformatsready/JPG/jpg_under_{target_kb}kb.jpg", data)

            # 3. PNG
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            zf.writestr("allformatsready/PNG/image.png", buf.getvalue())

            # 4. WebP versions
            for quality, label in [(85, "high"), (50, "compressed")]:
                buf = io.BytesIO()
                img.save(buf, format="WEBP", quality=quality)
                zf.writestr(f"allformatsready/WebP/webp_{label}.webp", buf.getvalue())

            # 5. Size-targeted WebP
            data = compress_to_target(img, "WEBP", 200)
            zf.writestr("allformatsready/WebP/webp_under_200kb.webp", data)

            # 6. PDF from image
            buf = io.BytesIO()
            img.save(buf, format="PDF")
            zf.writestr("allformatsready/PDF/image_as_pdf.pdf", buf.getvalue())

            # 7. Compressed PDF from image
            raw_pdf = buf.getvalue()
            compressed = compress_pdf(raw_pdf)
            zf.writestr("allformatsready/PDF/image_as_pdf_compressed.pdf", compressed)

    zip_buffer.seek(0)
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": "attachment; filename=allformatsready.zip"
        }
    )
