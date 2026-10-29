import os
import io
import re
import base64
import logging
import math
import shutil
import subprocess
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, HTTPException, Request
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
