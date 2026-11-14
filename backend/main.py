import os
import io
import threading
import time
import re
import base64
import logging
import math
import shutil
import subprocess
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

logger = logging.getLogger("allformatsready")

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
        # Register HEIC support
        try:
            from pillow_heif import register_heif_opener
            register_heif_opener()
        except ImportError:
            logger.info("Optional HEIF support is unavailable")
    if DocxDocument is None:
        try:
            from docx import Document as _Doc
            DocxDocument = _Doc
        except ImportError:
            DocxDocument = None

@asynccontextmanager
async def lifespan(app):
    load_libs()
    start_bg_model_loading()   # fetch the background-removal model in the background
    yield

# Rate limiter — max 10 requests per minute per IP
limiter = Limiter(key_func=get_remote_address, default_limits=["10/minute"])

app = FastAPI(title="AllFormatsReady API", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, exc: Exception):
    logger.exception("Unhandled request failure on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Processing failed. Please try again."})

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=3600,
)

# Extra CORS safety on every response
@app.middleware("http")
async def add_cors_headers(request: Request, call_next):
    if request.method == "OPTIONS":
        return Response(
            status_code=200,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "*",
            }
        )
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"   # the API host must never compete with the website in search
    return response

MAX_FILE_SIZE = 10 * 1024 * 1024
MAX_MERGE_SIZE = 30 * 1024 * 1024
MAX_DOCX_UNCOMPRESSED = int(os.getenv("MAX_DOCX_UNCOMPRESSED", str(60 * 1024 * 1024)))
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "50"))
MAX_IMAGE_DIMENSION = int(os.getenv("MAX_IMAGE_DIMENSION", "10000"))
MAX_IMAGE_PIXELS = int(os.getenv("MAX_IMAGE_PIXELS", "50000000"))
MAX_TOTAL_IMAGE_PIXELS = int(os.getenv("MAX_TOTAL_IMAGE_PIXELS", "100000000"))
MAX_OUTPUT_FILES = int(os.getenv("MAX_OUTPUT_FILES", "120"))
AADHAAR_RE = re.compile(r"(?<!\d)\d{4}(?:[\s-]*\d{4}){2}(?!\d)")
PAN_RE = re.compile(r"(?<![A-Z0-9])[A-Z]{5}[\s]*[0-9]{4}[\s]*[A-Z](?![A-Z0-9])", re.IGNORECASE)
SENSITIVE_KW = ["aadhaar", "aadhar", "uid", "pan", "income", "passport"]
OCR_STATUS = None


class InvalidUploadError(ValueError):
    """Raised when an uploaded document cannot be safely processed."""


def upload_extension(filename):
    return (filename or "").lower().rsplit(".", 1)[-1] if "." in (filename or "") else ""


def looks_like_docx(file_bytes):
    return file_bytes.startswith(b"PK\x03\x04")


async def read_upload(file, max_size=MAX_FILE_SIZE):
    data = await file.read()
    if not data:
        raise InvalidUploadError("The uploaded file is empty.")
    if len(data) > max_size:
        raise InvalidUploadError(f"File too large. Max {max_size // (1024 * 1024)}MB allowed.")
    return data


def ensure_output(data, description):
    if not data:
        raise RuntimeError(f"{description} produced no output")
    return data


def open_pdf(pdf_bytes):
    if not pdf_bytes.startswith(b"%PDF-"):
        raise InvalidUploadError("The uploaded file is not a valid PDF.")
    doc = None
    try:
        doc = fitz_mod.open(stream=pdf_bytes, filetype="pdf")
        if doc.is_encrypted:
            doc.close()
            raise InvalidUploadError("Encrypted PDFs are not supported.")
        if doc.page_count < 1:
            doc.close()
            raise InvalidUploadError("The PDF contains no pages.")
        if doc.page_count > MAX_PDF_PAGES:
            doc.close()
            raise InvalidUploadError(f"PDF has too many pages. Maximum is {MAX_PDF_PAGES}.")
        return doc
    except InvalidUploadError:
        raise
    except Exception as exc:
        if doc is not None:
            doc.close()
        raise InvalidUploadError("Could not read the PDF.") from exc


def open_image(image_bytes):
    try:
        with Image_cls.open(io.BytesIO(image_bytes)) as probe:
            probe.verify()
        with Image_cls.open(io.BytesIO(image_bytes)) as image:
            width, height = image.size
            if width < 1 or height < 1:
                raise InvalidUploadError("The image has invalid dimensions.")
            if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
                raise InvalidUploadError(
                    f"Image dimensions are too large. Maximum is {MAX_IMAGE_DIMENSION}px per side."
                )
            if width * height > MAX_IMAGE_PIXELS:
                raise InvalidUploadError("Image dimensions are too large to process safely.")
            image.load()
            return image.copy()
    except InvalidUploadError:
        raise
    except Exception as exc:
        raise InvalidUploadError("Could not read the image.") from exc


def validate_pdf_bytes(pdf_bytes):
    doc = open_pdf(pdf_bytes)
    doc.close()
    return pdf_bytes


def validate_generated_image(data, fmt):
    ensure_output(data, f"Generated {fmt} image")
    try:
        with Image_cls.open(io.BytesIO(data)) as image:
            image.verify()
    except Exception as exc:
        raise RuntimeError(f"Generated {fmt} image could not be verified") from exc
    return data


def image_to_rgb(img):
    if "A" in img.getbands() or img.info.get("transparency") is not None:
        rgba = img.convert("RGBA")
        background = Image_cls.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return img.convert("RGB")


def ocr_is_available():
    global OCR_STATUS
    if OCR_STATUS is not None:
        return OCR_STATUS
    executable = shutil.which("tesseract")
    if not executable:
        OCR_STATUS = False
        return OCR_STATUS
    try:
        result = subprocess.run(
            [executable, "--list-langs"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        OCR_STATUS = result.returncode == 0 and "eng" in result.stdout.split()
    except (OSError, subprocess.SubprocessError):
        OCR_STATUS = False
    return OCR_STATUS


def detect_sensitive_types(text):
    """Detect only identifiers present in extracted text; filenames are not evidence."""
    if not text:
        return set()
    detected = set()
    if AADHAAR_RE.search(text):
        detected.add("aadhaar")
    if PAN_RE.search(text):
        detected.add("pan")
    return detected


def is_sensitive(filename, text=""):
    del filename
    return bool(detect_sensitive_types(text))


def filename_suggests_sensitive(filename):
    name = (filename or "").lower()
    return any(keyword in name for keyword in SENSITIVE_KW)


def page_character_text(page):
    text_chars = []
    char_boxes = []
    raw = page.get_text("rawdict")
    previous_line = None
    previous_char = None
    for block_index, block in enumerate(raw.get("blocks", [])):
        if block.get("type") != 0:
            continue
        for line_index, line in enumerate(block.get("lines", [])):
            line_key = (block_index, line_index)
            for char in [c for span in line.get("spans", []) for c in span.get("chars", [])]:
                if previous_line is not None and line_key != previous_line:
                    text_chars.append("\n")
                    char_boxes.append(None)
                elif previous_char is not None and char["bbox"][0] > previous_char["bbox"][2] + 1.5:
                    text_chars.append(" ")
                    char_boxes.append(None)
                text_chars.append(char.get("c", ""))
                char_boxes.append(tuple(char["bbox"]))
                previous_line = line_key
                previous_char = char
    return "".join(text_chars), char_boxes


def matched_character_indexes(match, char_boxes):
    return [
        (position, char_box)
        for position, char_box in enumerate(char_boxes[match.start():match.end()])
        if char_box is not None
    ]


def redaction_rects_for_match(match_type, match, match_indexes):
    if not match_indexes:
        return []
    preserve_positions = set()
    if match_type == "aadhaar":
        digit_positions = [position for position, char in enumerate(match.group()) if char.isdigit()]
        preserve_positions = set(digit_positions[-4:])
    return [
        fitz_mod.Rect(*char_box)
        for position, char_box in match_indexes
        if position not in preserve_positions
    ]


def redact_sensitive_pdf(pdf_bytes, expected_types):
    """Redact text-layer identifiers and verify the saved PDF no longer exposes them."""
    doc = open_pdf(pdf_bytes)
    matched_types = set()
    redaction_count = 0
    try:
        for page in doc:
            page_text, char_boxes = page_character_text(page)
            page_matches = []
            for match in AADHAAR_RE.finditer(page_text):
                page_matches.append(("aadhaar", match))
            for match in PAN_RE.finditer(page_text):
                page_matches.append(("pan", match))
            for match_type, match in page_matches:
                indexes = matched_character_indexes(match, char_boxes)
                rects = redaction_rects_for_match(match_type, match, indexes)
                if not rects:
                    raise RuntimeError("Sensitive text could not be mapped to PDF geometry")
                matched_types.add(match_type)
                for rect in rects:
                    page.add_redact_annot(rect, fill=(0, 0, 0))
                    redaction_count += 1
            if page_matches:
                page.apply_redactions()
        if not matched_types or not expected_types.issubset(matched_types):
            raise RuntimeError("Sensitive identifiers could not be completely mapped for redaction")
        output = io.BytesIO()
        doc.save(output, garbage=4, deflate=True, clean=True)
        redacted_bytes = validate_pdf_bytes(ensure_output(output.getvalue(), "Sensitive-document redaction"))
    finally:
        doc.close()

    verified_doc = open_pdf(redacted_bytes)
    try:
        remaining_text = "".join(page.get_text() for page in verified_doc)
    finally:
        verified_doc.close()
    remaining_types = detect_sensitive_types(remaining_text)
    if remaining_types:
        raise RuntimeError("Sensitive identifiers remained after redaction verification")
    return redacted_bytes, matched_types, redaction_count


def pdf_page_to_pil(page, dpi=120):
    page_width = max(float(page.rect.width), 1.0)
    page_height = max(float(page.rect.height), 1.0)
    max_dimension_dpi = MAX_IMAGE_DIMENSION * 72 / max(page_width, page_height)
    max_pixels_dpi = math.sqrt(MAX_IMAGE_PIXELS) * 72 / max(page_width, page_height)
    dpi = min(dpi, max_dimension_dpi, max_pixels_dpi)
    mat = fitz_mod.Matrix(dpi/72, dpi/72)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    image = Image_cls.frombytes("RGB", [pix.width, pix.height], pix.samples)
    if image.width > MAX_IMAGE_DIMENSION or image.height > MAX_IMAGE_DIMENSION:
        image.thumbnail((MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION), Image_cls.LANCZOS)
    return image


def compress_to_target(img, fmt, target_kb):
    if fmt not in {"JPEG", "WEBP"} or target_kb <= 0:
        raise ValueError("Unsupported compression target")
    target_bytes = target_kb * 1024
    lo, hi, best = 10, 95, None
    for _ in range(10):
        mid = (lo + hi) // 2
        buf = io.BytesIO()
        source = image_to_rgb(img) if fmt == "JPEG" else img
        source.save(buf, format=fmt, quality=mid, optimize=(fmt == "JPEG"))
        size = buf.tell()
        if size <= target_bytes: best = buf.getvalue(); lo = mid + 1
        else: hi = mid - 1
    if best is None:
        buf = io.BytesIO()
        source = image_to_rgb(img) if fmt == "JPEG" else img
        source.save(buf, format=fmt, quality=10, optimize=(fmt == "JPEG"))
        best = buf.getvalue()
    return ensure_output(best, f"{fmt} compression")


def compress_pdf(pdf_bytes):
    doc = open_pdf(pdf_bytes)
    try:
        buf = io.BytesIO()
        doc.save(buf, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True)
        return validate_pdf_bytes(ensure_output(buf.getvalue(), "PDF compression"))
    finally:
        doc.close()


def mask_pdf(pdf_bytes):
    doc = open_pdf(pdf_bytes)
    try:
        text = "\n\f\n".join(page.get_text() for page in doc)
    finally:
        doc.close()
    detected_types = detect_sensitive_types(text)
    if not detected_types:
        raise InvalidUploadError("No supported sensitive identifier was found in the PDF text layer.")
    return redact_sensitive_pdf(pdf_bytes, detected_types)[0]


def img_bytes(img, fmt, quality=85):
    buf = io.BytesIO()
    source = image_to_rgb(img) if fmt in {"JPEG", "PDF"} else img
    if fmt == "JPEG": source.save(buf, format="JPEG", quality=quality, optimize=True)
    elif fmt == "PNG":
        if source.mode not in {"1", "L", "LA", "P", "RGB", "RGBA", "I"}:
            source = source.convert("RGBA" if "A" in source.getbands() else "RGB")
        source.save(buf, format="PNG", optimize=True)
    elif fmt == "WEBP": source.save(buf, format="WEBP", quality=quality)
    elif fmt == "PDF": source.save(buf, format="PDF")
    else: raise ValueError("Unsupported image output format")
    data = ensure_output(buf.getvalue(), f"{fmt} output")
    if fmt == "PDF": validate_pdf_bytes(data)
    else: validate_generated_image(data, fmt)
    return data


def pil_to_docx(imgs) -> bytes:
    """Embed one or more PIL images into a single DOCX file — one image per page.

    Each image is scaled to fit inside the page's printable area (aspect ratio preserved) so
    it is never cropped or pushed off the page, and every page after the first starts with
    a page-break-before on its own picture paragraph (no stray blank pages).
    """
    if DocxDocument is None:
        return b""
    try:
        from docx.shared import Emu, Inches
        doc = DocxDocument()
        if not isinstance(imgs, list):
            imgs = [imgs]
        section = doc.sections[0]
        section.left_margin = section.right_margin = Inches(0.5)
        section.top_margin = section.bottom_margin = Inches(0.5)
        avail_w = int(section.page_width - section.left_margin - section.right_margin)
        # Leave a little vertical slack so the picture paragraph never spills onto a new page.
        avail_h = int(section.page_height - section.top_margin - section.bottom_margin - Inches(0.25))
        for idx, img in enumerate(imgs):
            rgb = image_to_rgb(img)
            buf = io.BytesIO()
            rgb.save(buf, format="JPEG", quality=88, optimize=True)
            buf.seek(0)
            aspect = rgb.height / max(rgb.width, 1)
            width = avail_w
            height = int(width * aspect)
            if height > avail_h:
                height = avail_h
                width = int(height / max(aspect, 1e-6))
            doc.add_picture(buf, width=Emu(max(width, 1)), height=Emu(max(height, 1)))
            if idx > 0:
                doc.paragraphs[-1].paragraph_format.page_break_before = True
        out = io.BytesIO()
        doc.save(out)
        return out.getvalue()
    except Exception:
        logger.exception("DOCX generation failed")
        return b""


# ── DOCX → PDF (pure Python, no LibreOffice needed on the free Render tier) ──
_DOCX_FONT_CACHE = None


def _docx_pdf_fonts():
    """(regular, bold, italic, bold-italic, unicode_ok). Uses DejaVu when installed, else Helvetica."""
    global _DOCX_FONT_CACHE
    if _DOCX_FONT_CACHE is not None:
        return _DOCX_FONT_CACHE
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.fonts import addMapping
    for base in ("/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu", "/usr/share/fonts/TTF"):
        files = {k: os.path.join(base, v) for k, v in (
            ("r", "DejaVuSans.ttf"), ("b", "DejaVuSans-Bold.ttf"),
            ("i", "DejaVuSans-Oblique.ttf"), ("bi", "DejaVuSans-BoldOblique.ttf"))}
        if all(os.path.exists(p) for p in files.values()):
            try:
                for key, name in (("r", "AFRSans"), ("b", "AFRSans-B"), ("i", "AFRSans-I"), ("bi", "AFRSans-BI")):
                    pdfmetrics.registerFont(TTFont(name, files[key]))
                addMapping("AFRSans", 0, 0, "AFRSans"); addMapping("AFRSans", 1, 0, "AFRSans-B")
                addMapping("AFRSans", 0, 1, "AFRSans-I"); addMapping("AFRSans", 1, 1, "AFRSans-BI")
                _DOCX_FONT_CACHE = ("AFRSans", "AFRSans-B", "AFRSans-I", "AFRSans-BI", True)
                return _DOCX_FONT_CACHE
            except Exception:
                logger.warning("Could not register DejaVu fonts; falling back to Helvetica")
    _DOCX_FONT_CACHE = ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", False)
    return _DOCX_FONT_CACHE


def docx_to_pdf_bytes(docx_bytes: bytes):
    """Best-effort render of a .docx (text, headings, lists, tables, inline images) to a text-layer PDF.

    Returns (pdf_bytes, notice) where notice is a user-facing warning string or None."""
    import zipfile
    from xml.sax.saxutils import escape
    try:
        from docx import Document as DocxDoc
        from docx.table import Table as DocxTable
        from docx.text.paragraph import Paragraph as DocxPara
        from docx.text.run import Run as DocxRun
        from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib import colors
        from reportlab.platypus import (Image as RLImage, PageBreak, Paragraph,
                                        SimpleDocTemplate, Spacer, Table, TableStyle)
    except ImportError as exc:
        raise RuntimeError("DOCX support libraries are not installed") from exc

    # ── Safety: must be a real OOXML zip, and not a zip bomb ──
    try:
        with zipfile.ZipFile(io.BytesIO(docx_bytes)) as zf:
            infos = zf.infolist()
            if "word/document.xml" not in {i.filename for i in infos}:
                raise InvalidUploadError("This is not a valid Word (.docx) document.")
            if len(infos) > 3000 or sum(i.file_size for i in infos) > MAX_DOCX_UNCOMPRESSED:
                raise InvalidUploadError("This Word document is too large to process safely.")
    except zipfile.BadZipFile as exc:
        raise InvalidUploadError("This is not a valid Word (.docx) document.") from exc
    try:
        doc = DocxDoc(io.BytesIO(docx_bytes))
    except Exception as exc:
        raise InvalidUploadError("Could not read the Word document. It may be corrupt or password-protected.") from exc

    f_reg, f_bold, f_ital, f_bi, unicode_ok = _docx_pdf_fonts()

    unsupported = [False]
    try:
        from reportlab.pdfbase import pdfmetrics
        covered = pdfmetrics.getFont(f_reg).face.charToGlyph if unicode_ok else None
    except Exception:
        covered = None

    def clean(text):
        """Swap characters the renderer cannot draw for '?' (never emit blank/null glyphs)."""
        if unicode_ok and covered is not None:
            out = "".join(ch if (ord(ch) in covered or ch in "\n\t\r") else "?" for ch in text)
        elif unicode_ok:
            out = text
        else:
            out = text.encode("cp1252", "replace").decode("cp1252")
        if out != text:
            unsupported[0] = True
        return out

    # ── Page geometry from the first section ──
    sec = doc.sections[0]
    def pts(v, default):
        try:
            return float(v.pt) if v is not None else default
        except Exception:
            return default
    pw, ph = pts(sec.page_width, 595.3), pts(sec.page_height, 841.9)
    pw, ph = min(max(pw, 200.0), 2000.0), min(max(ph, 200.0), 2000.0)
    lm, rm = pts(sec.left_margin, 72.0), pts(sec.right_margin, 72.0)
    tm, bm = pts(sec.top_margin, 72.0), pts(sec.bottom_margin, 72.0)
    lm, rm = min(max(lm, 18.0), pw * 0.3), min(max(rm, 18.0), pw * 0.3)
    tm, bm = min(max(tm, 18.0), ph * 0.3), min(max(bm, 18.0), ph * 0.3)
    frame_w, frame_h = pw - lm - rm, ph - tm - bm

    base_size = 11.0
    align_map = {1: TA_CENTER, 2: TA_RIGHT, 3: TA_JUSTIFY}
    heading_sizes = {"title": 24, "heading 1": 20, "heading 2": 16, "heading 3": 14, "heading 4": 12.5}
    total_pixels = [0]

    def style_name(p):
        try:
            return (p.style.name or "").lower()
        except Exception:
            return ""

    def run_markup(run):
        text = run.text
        if not text:
            return "", 0.0
        out = escape(clean(text)).replace("\t", "&nbsp;&nbsp;&nbsp;&nbsp;").replace("\n", "<br/>")
        size = 0.0
        try:
            if run.bold: out = f"<b>{out}</b>"
            if run.italic: out = f"<i>{out}</i>"
            if run.underline: out = f"<u>{out}</u>"
            attrs = ""
            if run.font.size:
                size = float(run.font.size.pt)
                attrs += f' size="{size:g}"'
            rgb = run.font.color.rgb if run.font.color is not None and run.font.color.type is not None else None
            if rgb is not None and str(rgb) != "000000":
                attrs += f' color="#{rgb}"'
            if attrs:
                out = f"<font{attrs}>{out}</font>"
        except Exception:
            pass
        return out, size

    def inline_images(run):
        flows = []
        for rid in run._r.xpath(".//a:blip/@r:embed"):
            try:
                blob = doc.part.related_parts[rid].blob
                with Image_cls.open(io.BytesIO(blob)) as im:
                    w, h = im.size
                    total_pixels[0] += w * h
                    if w < 1 or h < 1 or w * h > MAX_IMAGE_PIXELS or total_pixels[0] > MAX_TOTAL_IMAGE_PIXELS:
                        continue
                    png = io.BytesIO()
                    image_to_rgb(im.copy()).save(png, format="PNG")
                scale = min(1.0, frame_w / (w * 0.75), (frame_h * 0.9) / (h * 0.75))
                png.seek(0)
                flows.append(RLImage(png, width=w * 0.75 * scale, height=h * 0.75 * scale))
            except Exception:
                continue  # unsupported image type (e.g. EMF/WMF) — skip rather than fail the document
        return flows

    def para_to_flowables(p, in_cell=False):
        name = style_name(p)
        parts, max_size, images, page_break = [], 0.0, [], False
        try:
            inner = list(p.iter_inner_content())
        except Exception:
            inner = list(p.runs)
        for item in inner:
            runs = [item] if isinstance(item, DocxRun) else list(getattr(item, "runs", []))
            for r in runs:
                markup, size = run_markup(r)
                parts.append(markup); max_size = max(max_size, size)
                images.extend(inline_images(r))
                if r._r.xpath('.//w:br[@w:type="page"]'):
                    page_break = True
        text = "".join(parts)
        size = heading_sizes.get(name, 0) or max(max_size, 0) or base_size
        if in_cell:
            size = min(size, 10.0) if not max_size else size
        heading = name in heading_sizes
        try:
            numbered = p._p.pPr is not None and p._p.pPr.numPr is not None
        except Exception:
            numbered = False
        is_list = numbered or name.startswith("list")
        if is_list and text.strip():
            level = 0
            try:
                level = int(p._p.pPr.numPr.ilvl.val) if numbered and p._p.pPr.numPr.ilvl is not None else 0
            except Exception:
                level = 0
            text = "•&nbsp;&nbsp;" + text
            left_indent = 18 + 18 * level
        else:
            left_indent = 0
        align = p.alignment if p.alignment is not None else getattr(p.style.paragraph_format, "alignment", None)
        st = ParagraphStyle(
            "afr", fontName=f_bold if heading else f_reg, fontSize=size, leading=size * 1.3,
            alignment=align_map.get(int(align), TA_LEFT) if align is not None else TA_LEFT,
            leftIndent=left_indent, firstLineIndent=-12 if is_list else 0,
            spaceBefore=10 if heading else 0, spaceAfter=(8 if heading else (2 if in_cell else 6)),
            bulletFontName=f_reg,
        )
        flows = []
        if text.strip():
            try:
                flows.append(Paragraph(text, st))
            except Exception:
                flows.append(Paragraph(escape(clean(p.text)), st))
        elif not images and not in_cell:
            flows.append(Spacer(1, size * 0.9))
        flows.extend(images)
        if page_break:
            flows.append(PageBreak())
        return flows

    def table_to_flowable(tbl):
        grid = [[cell for cell in row.cells] for row in tbl.rows]
        if not grid:
            return None
        ncols = max(len(r) for r in grid)
        spans, first_seen, data = [], {}, []
        for ri, row in enumerate(grid):
            data_row = []
            for ci in range(ncols):
                cell = row[ci] if ci < len(row) else None
                if cell is None:
                    data_row.append("")
                    continue
                key = id(cell._tc)
                if key in first_seen:           # merged continuation: keep content only once
                    first_seen[key][2:] = [ci, ri]
                    data_row.append("")
                else:
                    first_seen[key] = [ci, ri, ci, ri]
                    inner = []
                    for cp in cell.paragraphs:
                        inner.extend(para_to_flowables(cp, in_cell=True))
                    data_row.append(inner or "")
            data.append(data_row)
        for c0, r0, c1, r1 in first_seen.values():
            if (c1, r1) != (c0, r0):
                spans.append(("SPAN", (c0, r0), (c1, r1)))
        t = Table(data, colWidths=[frame_w / ncols] * ncols, splitByRow=1)
        t.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#9CA3AF")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ] + spans))
        return t

    story = []
    try:
        for child in doc.element.body.iterchildren():
            tag = child.tag.rsplit("}", 1)[-1]
            if tag == "p":
                story.extend(para_to_flowables(DocxPara(child, doc)))
            elif tag == "tbl":
                flow = table_to_flowable(DocxTable(child, doc))
                if flow is not None:
                    story.extend([flow, Spacer(1, 8)])
    except InvalidUploadError:
        raise
    except Exception as exc:
        raise InvalidUploadError("Could not read the contents of this Word document.") from exc

    if not story:
        raise InvalidUploadError("This Word document appears to be empty.")

    too_long = [False]

    def page_guard(canvas, _doc):
        if canvas.getPageNumber() > MAX_PDF_PAGES:
            too_long[0] = True
            raise InvalidUploadError("page limit")  # message is rewritten below (reportlab decorates it)

    out = io.BytesIO()
    template = SimpleDocTemplate(out, pagesize=(pw, ph), leftMargin=lm, rightMargin=rm,
                                 topMargin=tm, bottomMargin=bm, title="Converted document")
    try:
        template.build(story, onFirstPage=page_guard, onLaterPages=page_guard)
    except Exception as exc:
        if too_long[0]:
            raise InvalidUploadError(
                f"This document renders to more than {MAX_PDF_PAGES} pages, which is the maximum."
            ) from exc
        if isinstance(exc, InvalidUploadError):
            raise
        logger.exception("DOCX → PDF layout failed")
        raise InvalidUploadError("This Word document could not be laid out for conversion.") from exc
    notice = None
    if unsupported[0]:
        notice = ("Some characters in this Word document (for example Hindi/Telugu or other complex scripts) "
                  "could not be rendered and were replaced with '?'. For documents in those scripts, use "
                  "Word's File → Save as PDF and upload the PDF instead.")
    return ensure_output(out.getvalue(), "DOCX to PDF"), notice


def docx_plain_text(docx_bytes: bytes) -> str:
    """Body text of a .docx in document order, including table cells."""
    from docx import Document as DocxDoc
    from docx.table import Table as DocxTable
    from docx.text.paragraph import Paragraph as DocxPara
    doc = DocxDoc(io.BytesIO(docx_bytes))
    lines = []
    for child in doc.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            text = DocxPara(child, doc).text
            if text.strip():
                lines.append(text)
        elif tag == "tbl":
            for row in DocxTable(child, doc).rows:
                seen, cells = None, []
                for cell in row.cells:
                    if seen is not None and cell._tc is seen:
                        continue
                    seen = cell._tc
                    cells.append(" ".join(p.text.strip() for p in cell.paragraphs if p.text.strip()))
                if any(cells):
                    lines.append(" | ".join(cells))
    return "\n".join(lines)


def make_file(name, fmt, data, label, category, page=None):
    ensure_output(data, name)
    return {
        "name": name, "format": fmt, "label": label,
        "category": category, "page": page,
        "size_bytes": len(data), "size_kb": round(len(data)/1024, 1),
        "data_b64": base64.b64encode(data).decode(),
    }


def image_outputs(img, prefix="", page_num=None):
    """Generate all image formats for a single page — NO DOCX here, handled separately."""
    outputs = []
    pg = f" · Page {page_num}" if page_num else ""
    p = f"p{page_num}_" if page_num else ""

    # Resize if too large
    max_w = 1200
    if img.width > max_w:
        ratio = max_w / img.width
        img = img.resize((max_w, int(img.height * ratio)), Image_cls.LANCZOS)

    # JPG variants
    for q, lbl in [(85,"High Quality"),(50,"Compressed")]:
        d = img_bytes(img, "JPEG", q)
        outputs.append(make_file(f"{p}jpg_{lbl.lower().replace(' ','_')}.jpg","JPG",d,f"JPG — {lbl}{pg}","JPG",page_num))

    # JPG size targets
    for kb in [100, 200, 500]:
        d = compress_to_target(img, "JPEG", kb)
        label = f"JPG — Under {kb}KB{pg}" if len(d) <= kb * 1024 else f"JPG — {kb}KB target ({len(d) / 1024:.1f}KB){pg}"
        outputs.append(make_file(f"{p}jpg_under_{kb}kb.jpg","JPG",d,label,"JPG",page_num))

    # PNG
    d = img_bytes(img, "PNG")
    outputs.append(make_file(f"{p}image.png","PNG",d,f"PNG — Lossless{pg}","PNG",page_num))

    # WebP
    d = compress_to_target(img, "WEBP", 200)
    label = f"WebP — Under 200KB{pg}" if len(d) <= 200 * 1024 else f"WebP — 200KB target ({len(d) / 1024:.1f}KB){pg}"
    outputs.append(make_file(f"{p}webp_under_200kb.webp","WEBP",d,label,"WebP",page_num))

    return outputs


@app.get("/")
def root(): return {"status": "AllFormatsReady API is live"}

@app.get("/robots.txt", include_in_schema=False)
def robots_txt(): return Response(content="User-agent: *\nDisallow: /\n", media_type="text/plain")

@app.get("/health")
def health(): return {"status": "ok"}

@app.get("/ping")
def ping(): return {"ping": "pong"}


@app.post("/convert")
@limiter.limit("10/minute")
async def convert(request: Request, file: UploadFile = File(...)):
    load_libs()
    filename = file.filename or "document"
    try:
        file_bytes = await read_upload(file)
        outputs = []
        total_pages = 1
        docx_notice = None

        # DOCX upload → render to PDF first, then reuse the normal PDF pipeline below.
        if upload_extension(filename) == "docx" or (upload_extension(filename) == "doc" and looks_like_docx(file_bytes)):
            if not looks_like_docx(file_bytes):
                raise InvalidUploadError("This is not a valid Word (.docx) document.")
            file_bytes, docx_notice = docx_to_pdf_bytes(file_bytes)
        elif upload_extension(filename) == "doc":
            raise InvalidUploadError("Legacy .doc files are not supported. Open it in Word and save as .docx or PDF.")

        if file_bytes.startswith(b"%PDF-"):
            doc = open_pdf(file_bytes)
            try:
                total_pages = doc.page_count
                if 2 + (7 * total_pages) + 1 > MAX_OUTPUT_FILES:
                    raise InvalidUploadError("PDF would generate too many output files.")
                text = "\n\f\n".join(page.get_text() for page in doc)
                sensitive_types = detect_sensitive_types(text)
                sensitive_notice = None
                if not text.strip():
                    sensitive_notice = "This PDF has no extractable text. Scanned images were not OCR-checked or redacted."
                elif not sensitive_types and filename_suggests_sensitive(filename):
                    sensitive_notice = "The filename suggests sensitive content, but no supported identifier was verified in the text layer."
                outputs.append(make_file("compressed.pdf", "PDF", compress_pdf(file_bytes), "Compressed PDF", "PDF"))
                if sensitive_types:
                    try:
                        redacted, matched_types, _ = redact_sensitive_pdf(file_bytes, sensitive_types)
                    except Exception as exc:
                        logger.exception("Sensitive-document redaction failed")
                        raise HTTPException(status_code=422, detail="Sensitive identifiers were detected, but redaction could not be verified.") from exc
                    type_label = " and ".join(identifier_type.title() for identifier_type in sorted(matched_types))
                    type_slug = "_".join(sorted(matched_types))
                    policy = "Aadhaar preserves only the last four digits; PAN is fully covered."
                    outputs.append(make_file(
                        f"masked_{type_slug}.pdf",
                        "PDF",
                        redacted,
                        f"Masked {type_label} PDF — text layer verified ({policy})",
                        "PDF",
                    ))
                all_page_imgs = [pdf_page_to_pil(page) for page in doc]
            finally:
                doc.close()

            for i, img in enumerate(all_page_imgs, 1):
                pg = i if total_pages > 1 else None
                outputs.extend(image_outputs(img, f"page{i}", pg))
            d = pil_to_docx(all_page_imgs)
            if d:
                label = f"DOCX — All {total_pages} Pages" if total_pages > 1 else "DOCX — Word Document"
                outputs.append(make_file("document_all_pages.docx", "DOCX", d, label, "DOCX"))
        else:
            if upload_extension(filename) == "pdf":
                raise InvalidUploadError("The uploaded file is not a valid PDF.")
            img = open_image(file_bytes)
            outputs.extend(image_outputs(img))
            raw_pdf = img_bytes(img, "PDF")
            outputs.append(make_file("image_as_pdf.pdf", "PDF", raw_pdf, "PDF — From Image", "PDF"))
            outputs.append(make_file("image_as_pdf_compressed.pdf", "PDF", compress_pdf(raw_pdf), "PDF — Compressed", "PDF"))
            d = pil_to_docx([img])
            if d:
                outputs.append(make_file("document.docx", "DOCX", d, "DOCX — Word Document", "DOCX"))

        if not outputs or len(outputs) > MAX_OUTPUT_FILES:
            raise RuntimeError("Generated output volume exceeded the configured limit")
        response = {"files": outputs, "total": len(outputs), "total_pages": total_pages}
        if file_bytes.startswith(b"%PDF-") and sensitive_notice:
            response["sensitive_notice"] = sensitive_notice
        if docx_notice:
            response["conversion_notice"] = docx_notice
        return JSONResponse(content=response)
    except InvalidUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Conversion failed for uploaded document")
        raise HTTPException(status_code=422, detail="Could not process the uploaded document.") from exc
    finally:
        await file.close()


@app.post("/convert-multiple")
@limiter.limit("5/minute")
async def convert_multiple(request: Request, files: list[UploadFile] = File(...)):
    """Accept multiple images → generate individual formats + one combined PDF + combined DOCX."""
    load_libs()

    if not files:
        raise HTTPException(status_code=400, detail="Upload at least one image.")
    if len(files) > 10:
        raise HTTPException(status_code=400, detail="Maximum 10 images at once.")

    all_imgs = []
    total_size = 0
    total_pixels = 0

    for f in files:
        try:
            file_bytes = await read_upload(f)
            total_size += len(file_bytes)
            if total_size > MAX_FILE_SIZE:
                raise InvalidUploadError("Total size too large. Max 10MB total.")
            img = open_image(file_bytes)
            total_pixels += img.width * img.height
            if total_pixels > MAX_TOTAL_IMAGE_PIXELS:
                raise InvalidUploadError("Image batch is too large to process safely.")
            # Resize if needed
            max_w = 1200
            if img.width > max_w:
                ratio = max_w / img.width
                img = img.resize((max_w, int(img.height * ratio)), Image_cls.LANCZOS)
            all_imgs.append((f.filename or f"image_{len(all_imgs)+1}", img))
        except InvalidUploadError as exc:
            raise HTTPException(status_code=400, detail=f"Could not read image: {f.filename or 'upload'}: {exc}") from exc
        except Exception as exc:
            logger.exception("Multi-image conversion failed while reading an upload")
            raise HTTPException(status_code=422, detail=f"Could not process image: {f.filename or 'upload'}") from exc
        finally:
            await f.close()

    if not all_imgs:
        raise HTTPException(status_code=400, detail="No valid images found.")

    outputs = []
    total_count = len(all_imgs)

    # ── Per-image individual outputs ──
    for i, (fname, img) in enumerate(all_imgs, 1):
        pg = i if total_count > 1 else None
        pg_label = f" · Image {i}" if total_count > 1 else ""
        p = f"img{i}_" if total_count > 1 else ""

        # JPG variants
        for q, lbl in [(85,"High Quality"),(50,"Compressed")]:
            d = img_bytes(img, "JPEG", q)
            outputs.append(make_file(f"{p}jpg_{lbl.lower().replace(' ','_')}.jpg","JPG",d,f"JPG — {lbl}{pg_label}","JPG",pg))

        # JPG size targets
        for kb in [100, 200, 500]:
            d = compress_to_target(img, "JPEG", kb)
            label = f"JPG — Under {kb}KB{pg_label}" if len(d) <= kb * 1024 else f"JPG — {kb}KB target ({len(d) / 1024:.1f}KB){pg_label}"
            outputs.append(make_file(f"{p}jpg_under_{kb}kb.jpg","JPG",d,label,"JPG",pg))

        # PNG
        d = img_bytes(img, "PNG")
        outputs.append(make_file(f"{p}image.png","PNG",d,f"PNG — Lossless{pg_label}","PNG",pg))

        # WebP
        d = compress_to_target(img, "WEBP", 200)
        label = f"WebP — Under 200KB{pg_label}" if len(d) <= 200 * 1024 else f"WebP — 200KB target ({len(d) / 1024:.1f}KB){pg_label}"
        outputs.append(make_file(f"{p}webp_under_200kb.webp","WEBP",d,label,"WebP",pg))

        # Individual PDF
        raw_pdf = img_bytes(img, "PDF")
        outputs.append(make_file(f"{p}image_as_pdf.pdf","PDF",raw_pdf,f"PDF — Image {i}","PDF",pg))

    # ── Combined PDF (all images in one PDF) ──
    if total_count > 1:
        imgs_only = [img for _, img in all_imgs]
        # Use Pillow to save all images as multi-page PDF
        buf = io.BytesIO()
        imgs_only[0].save(buf, format="PDF", save_all=True, append_images=imgs_only[1:])
        combined_pdf = buf.getvalue()
        outputs.append(make_file(
            "combined_all_images.pdf","PDF",
            compress_pdf(combined_pdf),
            f"PDF — All {total_count} Images Combined","PDF"
        ))

        # ── Combined DOCX (all images in one Word doc) ──
        d = pil_to_docx(imgs_only)
        if d:
            outputs.append(make_file(
                "combined_all_images.docx","DOCX",d,
                f"DOCX — All {total_count} Images Combined","DOCX"
            ))

    if len(outputs) > MAX_OUTPUT_FILES:
        raise HTTPException(status_code=400, detail="Requested image batch would generate too many outputs.")

    return JSONResponse(content={
        "files": outputs,
        "total": len(outputs),
        "total_pages": total_count,
        "combined": total_count > 1
    })


# ══════════════════════════════════════════════
# NEW ENDPOINT: PDF Merge
# ══════════════════════════════════════════════
@app.post("/merge-pdf")
@limiter.limit("5/minute")
async def merge_pdf(request: Request, files: list[UploadFile] = File(...)):
    """Merge multiple PDFs into one combined PDF."""
    load_libs()

    if len(files) < 2:
        raise HTTPException(status_code=400, detail="Upload at least 2 PDF files to merge.")
    if len(files) > 10:
        raise HTTPException(status_code=400, detail="Maximum 10 PDFs at once.")

    merger = fitz_mod.open()
    total_size = 0
    total_pages = 0
    try:
        for f in files:
            try:
                file_bytes = await read_upload(f, MAX_MERGE_SIZE)
                total_size += len(file_bytes)
                if total_size > MAX_MERGE_SIZE:
                    raise InvalidUploadError("Total size too large. Max 30MB total for merge.")
                doc = open_pdf(file_bytes)
                try:
                    total_pages += doc.page_count
                    if total_pages > MAX_PDF_PAGES:
                        raise InvalidUploadError(f"Merged PDF has too many pages. Maximum is {MAX_PDF_PAGES}.")
                    merger.insert_pdf(doc)
                finally:
                    doc.close()
            except InvalidUploadError as exc:
                raise HTTPException(status_code=400, detail=f"Could not read {f.filename or 'PDF'}: {exc}") from exc
            except Exception as exc:
                logger.exception("PDF merge failed while reading an upload")
                raise HTTPException(status_code=422, detail=f"Could not process {f.filename or 'PDF'}.") from exc
            finally:
                await f.close()

        buf = io.BytesIO()
        merger.save(buf, garbage=4, deflate=True, deflate_images=True)
        merged_bytes = validate_pdf_bytes(ensure_output(buf.getvalue(), "PDF merge"))
        return JSONResponse(content={
            "merged_pdf": base64.b64encode(merged_bytes).decode(),
            "size_kb": round(len(merged_bytes) / 1024, 1),
            "pages": total_pages,
            "files_merged": len(files)
        })
    finally:
        merger.close()


# ══════════════════════════════════════════════
# PDF Organizer: extract / reorder / rotate / shrink to a target size
# ══════════════════════════════════════════════
def parse_page_spec(spec: str, page_count: int) -> list:
    """'1-3,5' / '3,1,2' / '2-last' → zero-based page indexes, order kept. Blank = all pages."""
    spec = (spec or "").strip().lower().replace(" ", "")
    if not spec:
        return list(range(page_count))
    def num(token):
        if token in ("last", "end"):
            return page_count
        if not token.isdigit():
            raise InvalidUploadError(f"'{token}' is not a valid page number. Use something like 1-3,5.")
        value = int(token)
        if value < 1 or value > page_count:
            raise InvalidUploadError(f"Page {value} does not exist. This PDF has {page_count} page(s).")
        return value
    order = []
    for part in spec.split(","):
        if not part:
            continue
        if "-" in part:
            bits = part.split("-")
            if len(bits) != 2:
                raise InvalidUploadError(f"'{part}' is not a valid range. Use something like 2-5.")
            start, end = num(bits[0]), num(bits[1])
            step = 1 if end >= start else -1
            order.extend(range(start - 1, end - 1 + step, step))
        else:
            order.append(num(part) - 1)
        if len(order) > MAX_PDF_PAGES:
            raise InvalidUploadError(f"Too many pages selected. Maximum is {MAX_PDF_PAGES}.")
    if not order:
        raise InvalidUploadError("No pages selected.")
    return order


def shrink_pdf_to_target(doc, limit_bytes: int):
    """Re-render pages as JPEG at falling quality until the PDF fits limit_bytes. Returns (bytes, fits)."""
    data = b""
    for dpi, quality in ((150, 70), (120, 60), (100, 50), (80, 40), (72, 30), (60, 25)):
        out = fitz_mod.open()
        try:
            zoom = dpi / 72.0
            for page in doc:
                pix = page.get_pixmap(matrix=fitz_mod.Matrix(zoom, zoom), alpha=False)
                jpg = pix.tobytes("jpeg", jpg_quality=quality)
                new_page = out.new_page(width=page.rect.width, height=page.rect.height)
                new_page.insert_image(new_page.rect, stream=jpg)
                pix = None
            buf = io.BytesIO()
            out.save(buf, garbage=4, deflate=True)
            data = buf.getvalue()
        finally:
            out.close()
        if len(data) <= limit_bytes:
            return data, True
    return data, False


@app.post("/organize-pdf")
@limiter.limit("5/minute")
async def organize_pdf(
    request: Request,
    file: UploadFile = File(...),
    pages: str = Form(""),
    rotate: int = Form(0),
    target_kb: int = Form(0),
):
    """Pick/reorder pages, rotate them, and optionally shrink the PDF to a target size in KB."""
    load_libs()
    try:
        file_bytes = await read_upload(file)
        if not file_bytes.startswith(b"%PDF-"):
            raise InvalidUploadError("Please upload a PDF file.")
        if rotate not in (0, 90, 180, 270):
            raise InvalidUploadError("Rotation must be 0, 90, 180 or 270 degrees.")
        if target_kb and not (20 <= target_kb <= 10240):
            raise InvalidUploadError("Target size must be between 20 KB and 10240 KB.")
        doc = open_pdf(file_bytes)
        try:
            doc.select(parse_page_spec(pages, doc.page_count))
            if rotate:
                for page in doc:
                    page.set_rotation((page.rotation + rotate) % 360)
            buf = io.BytesIO()
            doc.save(buf, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True)
            out_bytes = buf.getvalue()
            notice = None
            if target_kb and len(out_bytes) > target_kb * 1024:
                out_bytes, fits = shrink_pdf_to_target(doc, target_kb * 1024)
                if fits:
                    notice = "To reach the target size, pages were converted to images, so text can no longer be selected."
                else:
                    notice = (f"Could not reach {target_kb} KB. The smallest version is {round(len(out_bytes) / 1024)} KB "
                              "(pages converted to images).")
            page_total = doc.page_count
        finally:
            doc.close()
        out_bytes = validate_pdf_bytes(ensure_output(out_bytes, "PDF organize"))
        return JSONResponse(content={
            "pdf": base64.b64encode(out_bytes).decode(),
            "size_kb": round(len(out_bytes) / 1024, 1),
            "pages": page_total,
            "notice": notice,
        })
    except InvalidUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("PDF organize failed")
        raise HTTPException(status_code=422, detail="Could not process this PDF.") from exc
    finally:
        await file.close()


# ══════════════════════════════════════════════
# Audio converter (ffmpeg)
# ══════════════════════════════════════════════
MAX_AUDIO_SIZE = int(os.getenv("MAX_AUDIO_SIZE", str(20 * 1024 * 1024)))
MAX_AUDIO_SECONDS = int(os.getenv("MAX_AUDIO_SECONDS", "1800"))
AUDIO_TIMEOUT = int(os.getenv("AUDIO_TIMEOUT", "240"))
AUDIO_FORMATS = {
    "mp3":  {"args": ["-c:a", "libmp3lame"], "bitrate": True,  "mime": "audio/mpeg"},
    "wav":  {"args": ["-c:a", "pcm_s16le"],  "bitrate": False, "mime": "audio/wav"},
    "m4a":  {"args": ["-c:a", "aac"],        "bitrate": True,  "mime": "audio/mp4"},
    "aac":  {"args": ["-c:a", "aac"],        "bitrate": True,  "mime": "audio/aac"},
    "ogg":  {"args": ["-c:a", "libvorbis"],  "bitrate": True,  "mime": "audio/ogg"},
    "opus": {"args": ["-c:a", "libopus"],    "bitrate": True,  "mime": "audio/ogg"},
    "flac": {"args": ["-c:a", "flac"],       "bitrate": False, "mime": "audio/flac"},
    "wma":  {"args": ["-c:a", "wmav2"],      "bitrate": True,  "mime": "audio/x-ms-wma"},
    "mp4":  {"args": ["-c:a", "aac"],        "bitrate": True,  "mime": "audio/mp4"},
}
AUDIO_BITRATES = {64, 96, 128, 160, 192, 256, 320}


def looks_like_audio(data: bytes) -> bool:
    """Accept only known audio/media containers (blocks playlists and text files before ffmpeg sees them)."""
    h = data[:16]
    return bool(
        h[:3] == b"ID3"
        or (len(h) > 1 and h[0] == 0xFF and (h[1] & 0xE0) == 0xE0)          # MPEG audio / ADTS AAC
        or (h[:4] == b"RIFF" and data[8:12] == b"WAVE")
        or h[:4] in (b"OggS", b"fLaC", b"\x1aE\xdf\xa3", b"\x30\x26\xb2\x75")
        or data[4:8] == b"ftyp"                                              # m4a / mp4 / 3gp
        or h[:5] == b"#!AMR" or (h[:4] == b"FORM" and data[8:12] in (b"AIFF", b"AIFC"))
    )


def find_ffmpeg():
    env = os.getenv("FFMPEG_BIN")
    if env and os.path.exists(env):
        return env
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def convert_audio_bytes(data: bytes, fmt: str, bitrate: int = 128) -> bytes:
    import tempfile
    spec = AUDIO_FORMATS.get(fmt)
    if not spec:
        raise InvalidUploadError("Unsupported output format.")
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not available")
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = os.path.join(tmp, "input.bin"), os.path.join(tmp, "output." + fmt)
        with open(src, "wb") as fh:
            fh.write(data)
        cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
               "-protocol_whitelist", "file", "-threads", "1", "-i", src,
               "-vn", "-map_metadata", "-1", "-t", str(MAX_AUDIO_SECONDS), "-fs", str(60 * 1024 * 1024)] + spec["args"]
        if spec["bitrate"]:
            cmd += ["-b:a", f"{bitrate}k"]
        cmd.append(dst)
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=AUDIO_TIMEOUT, cwd=tmp)
        except subprocess.TimeoutExpired as exc:
            raise InvalidUploadError("This file took too long to convert. Try a shorter file.") from exc
        if proc.returncode != 0 or not os.path.exists(dst) or os.path.getsize(dst) == 0:
            logger.warning("ffmpeg failed: %s", proc.stderr[-300:].decode("utf-8", "replace"))
            raise InvalidUploadError("Could not read this audio file. It may be damaged or in an unsupported format.")
        with open(dst, "rb") as fh:
            return fh.read()


@app.post("/convert-audio")
@limiter.limit("6/minute")
async def convert_audio(request: Request, file: UploadFile = File(...), format: str = Form("mp3"), bitrate: int = Form(128)):
    """Convert an audio file (MP3, WAV, M4A, OGG, OPUS, FLAC, WMA, AMR...) to another audio format."""
    try:
        data = await read_upload(file, max_size=MAX_AUDIO_SIZE)
        fmt = (format or "mp3").lower().strip()
        if fmt not in AUDIO_FORMATS:
            raise InvalidUploadError("Choose one of: " + ", ".join(AUDIO_FORMATS) + ".")
        if not looks_like_audio(data):
            raise InvalidUploadError("This does not look like an audio file.")
        if bitrate not in AUDIO_BITRATES:
            bitrate = 128
        out = await run_in_threadpool(convert_audio_bytes, data, fmt, bitrate)
        return Response(content=out, media_type=AUDIO_FORMATS[fmt]["mime"])
    except InvalidUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except RuntimeError as exc:
        logger.error("Audio conversion unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="Audio conversion is temporarily unavailable.") from exc
    except Exception:
        logger.exception("Audio conversion failed")
        raise HTTPException(status_code=422, detail="Could not convert this audio file.")
    finally:
        await file.close()


# ══════════════════════════════════════════════
# Background remover: AI model (U²-Net "silueta" via ONNX) with an OpenCV fallback
# ══════════════════════════════════════════════
BG_MODELS = {
    # name: download URL, md5 ("" = skip the check), network input size, normalisation std
    "silueta": {"url": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx",
                "md5": "55e59e0d8062d2f5d013f4725ee84782", "size": 320, "std": (0.229, 0.224, 0.225)},
    "isnet-general-use": {"url": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
                          "md5": "", "size": 1024, "std": (1.0, 1.0, 1.0)},
}
BG_MODEL = os.getenv("BG_MODEL", "silueta") if os.getenv("BG_MODEL", "silueta") in BG_MODELS else "silueta"
BG_MODEL_URL = os.getenv("BG_MODEL_URL", BG_MODELS[BG_MODEL]["url"])
BG_MODEL_MD5 = os.getenv("BG_MODEL_MD5", BG_MODELS[BG_MODEL]["md5"])
BG_MODEL_DIR = os.getenv("BG_MODEL_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"))
# The AI model needs far more memory than a free 512 MB server has. It is OFF unless ENABLE_BG_AI=1 is set (use a bigger server or the separate bg-space service instead).
BG_ENABLED = os.getenv("ENABLE_BG_AI", "0").strip() == "1"
BG_MAX_SIDE = int(os.getenv("BG_MAX_SIDE", "1600"))
_bg_state = {"session": None, "state": "idle", "failed_at": 0.0}
_bg_lock = threading.Lock()


def _bg_prepare():
    """Download (once) and load the model. Runs in a background thread so requests never wait for it."""
    try:
        import hashlib
        import urllib.request
        import onnxruntime as ort
        os.makedirs(BG_MODEL_DIR, exist_ok=True)
        path = os.path.join(BG_MODEL_DIR, BG_MODEL + ".onnx")

        def md5_ok(p):
            if not os.path.exists(p):
                return False
            if not BG_MODEL_MD5:
                return os.path.getsize(p) > 1_000_000
            h = hashlib.md5()
            with open(p, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            return h.hexdigest() == BG_MODEL_MD5

        if not md5_ok(path):
            tmp = path + ".part"
            with urllib.request.urlopen(BG_MODEL_URL, timeout=120) as resp, open(tmp, "wb") as out:
                shutil.copyfileobj(resp, out)
            if not md5_ok(tmp):
                os.remove(tmp)
                raise RuntimeError("background model checksum mismatch")
            os.replace(tmp, path)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(os.getenv("BG_THREADS", "2"))
        _bg_state["session"] = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        _bg_state["state"] = "ready"
        logger.info("Background model ready")
    except Exception:
        logger.exception("Background model unavailable; using the OpenCV fallback")
        _bg_state["state"] = "failed"
        _bg_state["failed_at"] = time.time()


def start_bg_model_loading():
    if not BG_ENABLED:
        return
    with _bg_lock:
        state = _bg_state["state"]
        if state == "loading" or state == "ready":
            return
        if state == "failed" and time.time() - _bg_state["failed_at"] < 300:
            return
        _bg_state["state"] = "loading"
    threading.Thread(target=_bg_prepare, daemon=True).start()


def get_bg_session():
    if _bg_state["state"] == "ready":
        return _bg_state["session"]
    start_bg_model_loading()
    return None


def u2net_mask(session, img):
    """Salient-object mask from a U²-Net / IS-Net ONNX session, same pre/post-processing as rembg."""
    import numpy as np
    from PIL import Image
    cfg = BG_MODELS[BG_MODEL]
    side = cfg["size"]
    arr = np.asarray(img.convert("RGB").resize((side, side), Image.LANCZOS), dtype=np.float32)
    arr = arr / max(float(arr.max()), 1e-6)
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array(cfg["std"], dtype=np.float32)
    arr = ((arr - mean) / std).transpose(2, 0, 1)[None].astype(np.float32)
    out = session.run(None, {session.get_inputs()[0].name: arr})[0][:, 0, :, :]
    lo, hi = float(out.min()), float(out.max())
    pred = np.squeeze((out - lo) / max(hi - lo, 1e-6))
    return Image.fromarray((pred * 255).astype("uint8"), "L").resize(img.size, Image.LANCZOS)


def _saliency(small_bgr):
    """Spectral-residual saliency (no extra libraries): where does the eye go?"""
    import cv2
    import numpy as np
    g = cv2.resize(cv2.cvtColor(small_bgr, cv2.COLOR_BGR2GRAY), (128, 128)).astype(np.float32)
    f = np.fft.fft2(g)
    log_amp = np.log(np.abs(f) + 1e-6)
    resid = log_amp - cv2.blur(log_amp, (3, 3))
    s = np.abs(np.fft.ifft2(np.exp(resid + 1j * np.angle(f)))) ** 2
    s = cv2.GaussianBlur(s.astype(np.float32), (0, 0), 3)
    s = (s - s.min()) / max(float(s.max() - s.min()), 1e-6)
    return cv2.resize(s, (small_bgr.shape[1], small_bgr.shape[0]))


def _border_distance(small_bgr):
    """How different is each pixel from the colours found along the picture's edge? (<1 = looks like background)"""
    import cv2
    import numpy as np
    lab = cv2.cvtColor(small_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = lab.shape[:2]
    bw = max(3, int(0.03 * min(h, w)))
    strips = np.concatenate([lab[:bw].reshape(-1, 3), lab[-bw:].reshape(-1, 3), lab[:, :bw].reshape(-1, 3), lab[:, -bw:].reshape(-1, 3)])
    k = 3 if len(strips) > 300 else 1
    _, labels, centers = cv2.kmeans(strips, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0), 2, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel()
    dists = []
    for i in range(k):
        members = strips[labels == i]
        if len(members) < 0.08 * len(strips):
            continue            # a small colour patch on the edge is probably the subject touching the border
        spread = max(6.0, float(np.linalg.norm(members - centers[i], axis=1).mean()) * 2.0)
        dists.append(np.linalg.norm(lab - centers[i], axis=2) / spread)
    if not dists:
        return np.ones((h, w), np.float32) * 2.0
    return np.min(np.stack(dists), axis=0)


def grabcut_mask(img):
    """Fallback for any subject: edge-colour model + saliency seed GrabCut (portrait-aware when a face is found)."""
    import cv2
    import numpy as np
    from PIL import Image
    w, h = img.size
    s = min(1.0, 640.0 / max(w, h))
    small = cv2.cvtColor(np.asarray(img.convert("RGB").resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)), cv2.COLOR_RGB2BGR)
    sh, sw = small.shape[:2]
    face = None
    try:
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        faces = cascade.detectMultiScale(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 1.1, 5, minSize=(max(24, sw // 12), max(24, sw // 12)))
        if len(faces):
            face = max(faces, key=lambda f: f[2] * f[3])
    except Exception:
        face = None
    mask = np.full((sh, sw), cv2.GC_PR_BGD, np.uint8)
    edge = max(2, int(0.02 * min(sw, sh)))
    if face is not None:
        mask[:edge, :] = cv2.GC_BGD; mask[:, :edge] = cv2.GC_BGD; mask[:, -edge:] = cv2.GC_BGD
        fx, fy, fw, fh = [int(v) for v in face]
        x0, x1 = max(edge, fx - int(1.3 * fw)), min(sw - edge, fx + fw + int(1.3 * fw))
        mask[max(edge, fy - int(0.5 * fh)):sh, x0:x1] = cv2.GC_PR_FGD
        mask[fy + int(0.2 * fh):fy + int(0.85 * fh), fx + int(0.2 * fw):fx + int(0.8 * fw)] = cv2.GC_FGD
    else:
        d = _border_distance(small)
        sal = _saliency(small)
        bgish = (d < 1.0).astype(np.uint8)
        n, lbl = cv2.connectedComponents(bgish, connectivity=4)
        touching = set(np.unique(np.concatenate([lbl[0], lbl[-1], lbl[:, 0], lbl[:, -1]]))) - {0}
        sure_bg = np.isin(lbl, list(touching)) & (bgish == 1) if touching else np.zeros((sh, sw), bool)
        mask[(d > 1.6) & (sal > 0.25)] = cv2.GC_PR_FGD
        centre = np.zeros((sh, sw), bool); centre[int(0.15 * sh):int(0.85 * sh), int(0.15 * sw):int(0.85 * sw)] = True
        mask[(d > 2.4) & (sal > 0.5) & centre] = cv2.GC_FGD
        mask[sure_bg] = cv2.GC_BGD
        if int(((mask == cv2.GC_PR_FGD) | (mask == cv2.GC_FGD)).sum()) < 0.005 * sh * sw:
            mask[:] = cv2.GC_PR_BGD
            mask[int(0.08 * sh):int(0.92 * sh), int(0.08 * sw):int(0.92 * sw)] = cv2.GC_PR_FGD
            mask[int(0.3 * sh):int(0.7 * sh), int(0.3 * sw):int(0.7 * sw)] = cv2.GC_FGD
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(small, mask, None, bgd, fgd, 6, cv2.GC_INIT_WITH_MASK)
    fg = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(fg, 8)
    if n > 1:
        biggest = max(stats[i, cv2.CC_STAT_AREA] for i in range(1, n))
        keep = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= 0.15 * biggest]
        fg = np.isin(labels, keep).astype(np.uint8)
    k = max(3, int(0.01 * max(sw, sh)) | 1)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    cnts, hier = cv2.findContours(fg, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = np.zeros_like(fg)
    for i, c in enumerate(cnts):                      # fill small holes, keep big ones (handles, gaps)
        is_hole = hier[0][i][3] != -1
        if not is_hole:
            cv2.drawContours(out, [c], -1, 1, thickness=-1)
    for i, c in enumerate(cnts):
        if hier[0][i][3] != -1 and cv2.contourArea(c) > 0.004 * sh * sw:
            cv2.drawContours(out, [c], -1, 0, thickness=-1)
    soft = cv2.GaussianBlur(out * 255, (0, 0), 1.2)
    return Image.fromarray(soft, "L").resize(img.size, Image.LANCZOS)


def _guided_filter(guide, src, radius, eps):
    import cv2
    k = (radius * 2 + 1, radius * 2 + 1)
    mean_i, mean_p = cv2.boxFilter(guide, -1, k), cv2.boxFilter(src, -1, k)
    var_i = cv2.boxFilter(guide * guide, -1, k) - mean_i * mean_i
    cov_ip = cv2.boxFilter(guide * src, -1, k) - mean_i * mean_p
    a = cov_ip / (var_i + eps)
    b = mean_p - a * mean_i
    return cv2.boxFilter(a, -1, k) * guide + cv2.boxFilter(b, -1, k)


def refine_alpha(img, mask):
    """Snap a coarse mask to the real edges of the photo (guided filter), clean specks, keep fine hair-like softness."""
    import cv2
    import numpy as np
    gray = cv2.cvtColor(np.asarray(img.convert("RGB")), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    a = np.asarray(mask, dtype=np.float32) / 255.0
    r = max(3, int(0.006 * max(a.shape)))
    a = np.clip(_guided_filter(gray, a, r, 1e-3), 0, 1)
    a = np.clip((a - 0.22) / 0.56, 0.0, 1.0)
    solid = (a > 0.5).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
    if n > 2:
        biggest = max(stats[i, cv2.CC_STAT_AREA] for i in range(1, n))
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] < max(0.004 * solid.size, 0.02 * biggest):
                a[labels == i] = 0.0
    return cv2.GaussianBlur(a, (0, 0), 0.7)


def decontaminate(img, alpha):
    """Remove the old-background colour fringe from semi-transparent edge pixels."""
    import cv2
    import numpy as np
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    a3 = alpha[..., None]
    num = cv2.GaussianBlur(rgb * a3, (0, 0), 2.5)
    den = cv2.GaussianBlur(alpha, (0, 0), 2.5)[..., None]
    est = num / np.maximum(den, 1e-3)
    edge = ((alpha > 0.02) & (alpha < 0.98))[..., None]
    return np.clip(np.where(edge, est, rgb), 0, 255).astype(np.uint8)


def remove_background_bytes(data: bytes):
    """Return (png_bytes, method) where method is 'ai' or 'basic'."""
    import numpy as np
    from PIL import Image, ImageOps
    try:
        img = Image.open(io.BytesIO(data)); img.load()
    except Exception as exc:
        raise InvalidUploadError("Could not read this image. Use JPG, PNG or WebP.") from exc
    img = ImageOps.exif_transpose(img).convert("RGB")
    if img.width * img.height > MAX_IMAGE_PIXELS:
        raise InvalidUploadError("This image is too large to process.")
    if max(img.size) > BG_MAX_SIDE:
        s = BG_MAX_SIDE / float(max(img.size))
        img = img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)
    mask, method = None, "basic"
    session = get_bg_session()
    if session is not None:
        try:
            mask, method = u2net_mask(session, img), "ai"
        except Exception:
            logger.exception("AI background removal failed; falling back")
    if mask is None:
        mask = grabcut_mask(img)
    alpha = refine_alpha(img, mask)
    share = float((alpha > 0.5).mean())
    if method == "basic" and (share < 0.02 or share > 0.97):
        raise InvalidUploadError("The AI engine is not ready, and the basic method could not find a clear subject in this image. "
                                 "Please try again in a minute, or use the Simple method on a plain wall or sheet.")
    rgb = decontaminate(img, alpha)
    rgba = np.dstack([rgb, np.clip(alpha * 255.0, 0, 255).astype(np.uint8)])
    buf = io.BytesIO(); Image.fromarray(rgba, "RGBA").save(buf, format="PNG", compress_level=3)
    return buf.getvalue(), method


def _memory_mb():
    try:
        with open("/proc/self/status") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024)
    except Exception:
        pass
    return None


@app.get("/status")
def status():
    """Open this in a browser to see which features are ready. (Checks only look for installed packages; nothing heavy is loaded.)"""
    import importlib.util

    def installed(name):
        try:
            return importlib.util.find_spec(name) is not None
        except Exception:
            return False
    return {
        "background_ai": _bg_state["state"] if BG_ENABLED else "disabled",   # disabled | idle | loading | ready | failed
        "background_enabled": BG_ENABLED,
        "background_model": BG_MODEL,
        "onnxruntime_installed": installed("onnxruntime"),
        "opencv_installed": installed("cv2"),
        "audio_converter_ready": bool(find_ffmpeg()),
        "memory_mb": _memory_mb(),
    }


@app.post("/remove-bg")
@limiter.limit("8/minute")
async def remove_bg(request: Request, file: UploadFile = File(...)):
    """Cut the person/subject out of a photo and return a transparent PNG."""
    if not BG_ENABLED:
        raise HTTPException(status_code=503, detail="The AI background engine is not turned on for this server yet. Use the Simple method, or connect the separate AI service.")
    try:
        data = await read_upload(file)
        png, method = await run_in_threadpool(remove_background_bytes, data)
        return Response(content=png, media_type="image/png",
                        headers={"X-BG-Method": method, "Access-Control-Expose-Headers": "X-BG-Method"})
    except InvalidUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception:
        logger.exception("Background removal failed")
        raise HTTPException(status_code=422, detail="Could not remove the background from this image.")
    finally:
        await file.close()


# ══════════════════════════════════════════════
# NEW ENDPOINT: PDF to Text (extract text)
# ══════════════════════════════════════════════
@app.post("/pdf-to-text")
@limiter.limit("10/minute")
async def pdf_to_text(request: Request, file: UploadFile = File(...)):
    """Extract all text from a PDF file."""
    load_libs()

    try:
        file_bytes = await read_upload(file)
        doc = open_pdf(file_bytes)
        try:
            pages_text = []
            full_text = ""
            for i, page in enumerate(doc, 1):
                text = page.get_text().strip()
                pages_text.append({"page": i, "text": text, "chars": len(text)})
                full_text += f"\n--- Page {i} ---\n{text}\n"
        finally:
            doc.close()

        total_chars = sum(p["chars"] for p in pages_text)
        total_pages = len(pages_text)

        # Also return as downloadable .txt base64
        txt_bytes = full_text.encode("utf-8")
        txt_b64 = base64.b64encode(txt_bytes).decode()

        return JSONResponse(content={
            "pages": pages_text,
            "total_pages": total_pages,
            "total_chars": total_chars,
            "full_text": full_text,
            "txt_b64": txt_b64,
            "has_text": total_chars > 50
        })
    except InvalidUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("PDF text extraction failed")
        raise HTTPException(status_code=422, detail="Could not extract text from the PDF.") from exc
    finally:
        await file.close()


# ══════════════════════════════════════════════
# NEW ENDPOINT: Extract text from image (OCR)
# ══════════════════════════════════════════════
@app.post("/extract-text")
@limiter.limit("10/minute")
async def extract_text(request: Request, file: UploadFile = File(...)):
    """Extract text from PDF, image, or DOCX."""
    load_libs()

    filename = file.filename or "document"
    ext = upload_extension(filename)
    try:
        file_bytes = await read_upload(file)
        full_text = ""
        pages_text = []
        total_pages = 1

        # ── PDF → extract text directly ──
        if file_bytes.startswith(b"%PDF-"):
            doc = open_pdf(file_bytes)
            try:
                for i, page in enumerate(doc, 1):
                    text = page.get_text().strip()
                    pages_text.append({"page": i, "text": text, "chars": len(text)})
                    full_text += f"\n--- Page {i} ---\n{text}\n"
                total_pages = doc.page_count
            finally:
                doc.close()

        # ── DOCX → read text directly (paragraphs and tables) ──
        elif ext in ["docx", "doc"] and looks_like_docx(file_bytes):
            try:
                full_text = docx_plain_text(file_bytes)
                pages_text = [{"page": 1, "text": full_text, "chars": len(full_text)}]
                total_pages = 1
            except Exception as exc:
                raise InvalidUploadError("Could not read the DOCX document.") from exc
        # ── Image → OCR using PyMuPDF's Tesseract integration ──
        else:
            try:
                img = open_image(file_bytes)
            except InvalidUploadError as exc:
                if ext == "pdf":
                    raise InvalidUploadError("The uploaded file is not a valid PDF.") from exc
                raise InvalidUploadError("Unsupported or invalid document. Use PDF, JPG, PNG, WebP, HEIC, or DOCX.") from exc
            if not ocr_is_available():
                raise HTTPException(status_code=503, detail="OCR is unavailable: Tesseract with English language data is not installed.")
            img_buf = io.BytesIO()
            img.save(img_buf, format="PDF")
            doc = open_pdf(img_buf.getvalue())
            try:
                for i, page in enumerate(doc, 1):
                    try:
                        text = page.get_textpage_ocr(flags=0, language="eng", dpi=300).extractText().strip()
                    except Exception as exc:
                        logger.exception("OCR failed for image upload")
                        raise HTTPException(status_code=503, detail="OCR is unavailable or could not process this image.") from exc
                    pages_text.append({"page": i, "text": text, "chars": len(text)})
                    full_text += f"\n--- Page {i} ---\n{text}\n"
                total_pages = doc.page_count
            finally:
                doc.close()

        total_chars = sum(p["chars"] for p in pages_text)
        txt_bytes = full_text.encode("utf-8")
        txt_b64 = base64.b64encode(txt_bytes).decode()
        return JSONResponse(content={
            "pages": pages_text,
            "total_pages": total_pages,
            "total_chars": total_chars,
            "full_text": full_text,
            "txt_b64": txt_b64,
            "has_text": total_chars > 20,
            "format": ext
        })
    except InvalidUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Text extraction failed")
        raise HTTPException(status_code=422, detail="Could not extract text from the uploaded document.") from exc
    finally:
        await file.close()
