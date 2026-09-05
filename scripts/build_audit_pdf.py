#!/usr/bin/env python3
"""Render the committed Tradytics V2 Markdown audit to a reviewable PDF."""
from __future__ import annotations

import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "tradytics_model_engine_v2_technical_audit.md"
OUTPUT = ROOT / "docs" / "tradytics_model_engine_v2_technical_audit.pdf"
NAVY = colors.HexColor("#07121D")
CYAN = colors.HexColor("#36C8E8")
INK = colors.HexColor("#152536")
MUTED = colors.HexColor("#5C6D7D")
PALE = colors.HexColor("#EAF7FA")
LINE = colors.HexColor("#C7D7E2")


def register_fonts() -> None:
    candidates = {
        "AuditSans": Path(r"C:\Windows\Fonts\arial.ttf"),
        "AuditSansBold": Path(r"C:\Windows\Fonts\arialbd.ttf"),
        "AuditMono": Path(r"C:\Windows\Fonts\consola.ttf"),
    }
    for name, path in candidates.items():
        if path.exists():
            pdfmetrics.registerFont(TTFont(name, str(path)))


def inline(value: str) -> str:
    value = html.escape(value.strip())
    value = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", value)
    value = re.sub(r"`([^`]+)`", r'<font name="AuditMono">\1</font>', value)
    return value


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "body": ParagraphStyle("AuditBody", parent=base["BodyText"], fontName="AuditSans", fontSize=8.8,
                               leading=12.2, textColor=INK, spaceAfter=6),
        "h1": ParagraphStyle("AuditH1", parent=base["Heading1"], fontName="AuditSansBold", fontSize=17,
                             leading=20, textColor=NAVY, spaceBefore=12, spaceAfter=7, keepWithNext=True),
        "h2": ParagraphStyle("AuditH2", parent=base["Heading2"], fontName="AuditSansBold", fontSize=12.5,
                             leading=15, textColor=NAVY, spaceBefore=10, spaceAfter=5, keepWithNext=True),
        "bullet": ParagraphStyle("AuditBullet", parent=base["BodyText"], fontName="AuditSans", fontSize=8.6,
                                 leading=11.8, leftIndent=13, firstLineIndent=-7, textColor=INK, spaceAfter=3),
        "quote": ParagraphStyle("AuditQuote", parent=base["BodyText"], fontName="AuditSansBold", fontSize=10,
                                leading=14, leftIndent=14, rightIndent=14, borderColor=CYAN, borderWidth=1.5,
                                borderPadding=8, backColor=PALE, textColor=NAVY, spaceAfter=10),
        "code": ParagraphStyle("AuditCode", parent=base["Code"], fontName="AuditMono", fontSize=7.4,
                               leading=9.4, leftIndent=8, rightIndent=8, borderPadding=7,
                               backColor=colors.HexColor("#F2F6F8"), textColor=INK, spaceAfter=7),
        "small": ParagraphStyle("AuditSmall", parent=base["BodyText"], fontName="AuditSans", fontSize=7.2,
                                leading=9.5, textColor=MUTED),
        "cover_title": ParagraphStyle("CoverTitle", parent=base["Title"], fontName="AuditSansBold", fontSize=30,
                                      leading=34, alignment=TA_LEFT, textColor=colors.white),
        "cover_sub": ParagraphStyle("CoverSub", parent=base["BodyText"], fontName="AuditSans", fontSize=13,
                                    leading=18, textColor=colors.HexColor("#BFDDE8")),
        "cover_meta": ParagraphStyle("CoverMeta", parent=base["BodyText"], fontName="AuditMono", fontSize=8.4,
                                     leading=12, textColor=colors.HexColor("#D4EEF5")),
    }


def page(canvas, doc) -> None:
    canvas.saveState()
    width, height = letter
    if doc.page == 1:
        canvas.setFillColor(NAVY)
        canvas.rect(0, 0, width, height, fill=1, stroke=0)
        canvas.setFillColor(CYAN)
        canvas.rect(0, height - 16, width, 16, fill=1, stroke=0)
    else:
        canvas.setStrokeColor(LINE)
        canvas.line(42, height - 34, width - 42, height - 34)
        canvas.setFont("AuditSansBold", 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(42, height - 27, "TRADYTICS DETERMINISTIC OPTIONS ENGINE V2")
        canvas.setFont("AuditSans", 7.5)
        canvas.drawRightString(width - 42, 24, f"Technical audit  ·  page {doc.page}")
    canvas.restoreState()


def markdown_flowables(text: str, st: dict[str, ParagraphStyle], available_width: float):
    lines = text.splitlines()
    output = []
    paragraph: list[str] = []
    index = 0

    def flush() -> None:
        if paragraph:
            output.append(Paragraph(inline(" ".join(part.strip() for part in paragraph)), st["body"]))
            paragraph.clear()

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if stripped.startswith("```"):
            flush()
            code: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code.append(lines[index])
                index += 1
            output.append(Preformatted("\n".join(code), st["code"], maxLineLength=110))
        elif stripped.startswith("## "):
            flush(); output.append(Paragraph(inline(stripped[3:]), st["h1"]))
        elif stripped.startswith("### "):
            flush(); output.append(Paragraph(inline(stripped[4:]), st["h2"]))
        elif stripped.startswith("> "):
            flush(); output.append(Paragraph(inline(stripped[2:]), st["quote"]))
        elif stripped.startswith("|") and index + 1 < len(lines) and re.match(r"^\s*\|?[\s:|-]+\|", lines[index + 1]):
            flush()
            rows: list[list[str]] = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells):
                    rows.append(cells)
                index += 1
            index -= 1
            count = max(len(row) for row in rows)
            normalized = [row + [""] * (count - len(row)) for row in rows]
            table_data = [[Paragraph(inline(cell), st["small"]) for cell in row] for row in normalized]
            widths = [available_width / count] * count
            table = Table(table_data, colWidths=widths, repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "AuditSansBold"),
                ("GRID", (0, 0), (-1, -1), .35, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FA")]),
            ]))
            output.extend([table, Spacer(1, 7)])
        elif re.match(r"^[-*] ", stripped):
            flush(); output.append(Paragraph("• " + inline(stripped[2:]), st["bullet"]))
        elif re.match(r"^\d+\. ", stripped):
            flush(); output.append(Paragraph(inline(stripped), st["bullet"]))
        elif not stripped:
            flush()
        elif stripped == "---":
            flush(); output.append(Spacer(1, 5))
        elif stripped.startswith("# "):
            flush()  # The title is already represented by the cover.
        else:
            paragraph.append(stripped)
        index += 1
    flush()
    return output


def build() -> None:
    register_fonts()
    st = styles()
    doc = SimpleDocTemplate(
        str(OUTPUT), pagesize=letter, rightMargin=42, leftMargin=42,
        topMargin=46, bottomMargin=38, title="Tradytics V2 Technical Audit",
        author="OpenAI Codex for the Tradytics project",
        subject="Actual implemented behavior and validation evidence",
    )
    story = [
        Spacer(1, 1.35 * inch),
        Paragraph("TRADYTICS", st["cover_sub"]),
        Spacer(1, 10),
        Paragraph("Deterministic Options<br/>Engine V2", st["cover_title"]),
        Spacer(1, 16),
        Paragraph("Technical implementation audit · paper/shadow decision support", st["cover_sub"]),
        Spacer(1, .55 * inch),
        Table([["IMPLEMENTED", "VERIFIED", "DEGRADED", "EXTERNAL DEPENDENCY"]], colWidths=[1.15*inch]*4,
              style=TableStyle([("BACKGROUND", (0,0), (-1,-1), colors.HexColor("#102B3B")),
                                ("TEXTCOLOR", (0,0), (-1,-1), colors.white),
                                ("FONTNAME", (0,0), (-1,-1), "AuditSansBold"),
                                ("FONTSIZE", (0,0), (-1,-1), 7), ("ALIGN", (0,0), (-1,-1), "CENTER"),
                                ("BOX", (0,0), (-1,-1), .5, CYAN), ("INNERGRID", (0,0), (-1,-1), .25, CYAN),
                                ("TOPPADDING", (0,0), (-1,-1), 7), ("BOTTOMPADDING", (0,0), (-1,-1), 7)])),
        Spacer(1, .7 * inch),
        Paragraph("Implementation source  83ff5372a7a9a37efa740925ca402483545ce917<br/>Production deployment  99bd0aa8acdb8587f1ce9c0eb104057fd963196a<br/>Audit date  2026-09-05<br/>Rollback  v1-live-20260904-before-v2", st["cover_meta"]),
        Spacer(1, .55 * inch),
        Paragraph("SETUP QUALITY IS NOT A PROBABILITY.", ParagraphStyle("CoverWarning", parent=st["cover_sub"], fontName="AuditSansBold", textColor=CYAN)),
        PageBreak(),
    ]
    story.extend(markdown_flowables(SOURCE.read_text(encoding="utf-8"), st, letter[0] - 84))
    doc.build(story, onFirstPage=page, onLaterPages=page)
    print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    build()
