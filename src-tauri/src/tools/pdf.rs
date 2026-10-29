//! Built-in `pdf` tool — generate PDFs from a structured spec.
//!
//! A single `create` action builds a PDF from a model-supplied page/block
//! spec (headings, paragraphs, bullet / numbered lists, horizontal rules,
//! page breaks, tables). The result is returned as an [`Attachment`] that
//! the chat-stream layer appends to the assistant message; the existing
//! `PdfPreview` component then renders it inline.
//!
//! Unicode text: we bundle Liberation Sans (regular + bold), pre-subset to
//! Latin + European + common punctuation/currency, and embed it into each
//! PDF — so accented text (e.g. Polish), the euro sign, em dashes and
//! bullets render correctly. Wrapping and cell truncation measure text with
//! the font's own advance widths, so a line can't run past the margin.
//! Glyphs outside the bundled Latin-only set (Cyrillic, Greek, CJK, emoji)
//! are replaced with `?`
//! at render time so the file stays legible rather than showing blank
//! `.notdef` boxes, and the tool result counts them so the model can tell
//! the user.

use base64::Engine;
use printpdf::*;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp::{Attachment, McpCallResult};

pub const TOOL_NAME: &str = "pdf";

/// Bundled text fonts: Liberation Sans (SIL OFL — see
/// `assets/fonts/LICENSE-Liberation.txt`), metric-compatible with
/// Helvetica/Arial. The vendored files
/// are pre-subset (via fonttools) to Latin + European + common
/// punctuation/currency — ≈80 KB each instead of ≈410 KB — which keeps the
/// `include_bytes!` blobs small in the binary itself. printpdf subsets
/// again at save time; the two are independent and compose.
/// Characters outside that coverage become `?` in [`sanitise`].
const FONT_REGULAR: &[u8] = include_bytes!("../../assets/fonts/LiberationSans-Regular.ttf");
const FONT_BOLD: &[u8] = include_bytes!("../../assets/fonts/LiberationSans-Bold.ttf");

/// A4 in millimeters. printpdf's `Mm` wraps `f32`, so every mm-typed
/// constant and intermediate result stays `f32` to avoid a sea of
/// `as f32` conversions at every `Mm(...)` call site.
const PAGE_WIDTH_MM: f32 = 210.0;
const PAGE_HEIGHT_MM: f32 = 297.0;
const MARGIN_MM: f32 = 20.0;

/// Body font size in points. Headings scale this up by level.
const BODY_FONT_SIZE_PT: f32 = 11.0;
/// Line height in mm derived from `BODY_FONT_SIZE_PT`. 1 pt ≈ 0.3528 mm;
/// 11 pt × 1.4 line-height ≈ 5.4 mm. Used by every block that emits a
/// line of text so vertical rhythm stays consistent.
const BODY_LINE_HEIGHT_MM: f32 = 5.4;

/// Spec ceiling. A single PDF spec beyond ~256 KiB is almost certainly a
/// runaway prompt — text at 11 pt fits about 4000 characters per A4 page,
/// and a structured spec is denser than that.
const MAX_SPEC_BYTES: usize = 256 * 1024;
/// Per-action page ceiling — bounds rasterisation cost on the receiving
/// pdfjs viewer if a model decides to ask for 10 000 pages of bullet
/// lists. 200 pages is well past any real chat use. Counts physical pages:
/// the spec's `pages` are only checked against it up front, while text that
/// flows on and `page_break` blocks add pages a 256 KiB spec could
/// otherwise run into the thousands.
const MAX_PAGES: usize = 200;

pub fn tool_description() -> &'static str {
    "Create a PDF from a structured spec. Use this to produce a \
     downloadable document instead of a long markdown block in chat — the \
     user gets a real file they can save, print, or forward. \
     Render `pages: [{blocks: [...]}]` to a PDF. Block types: \
     `heading` (with `level` 1–3 and `text`), \
     `paragraph` (with `text` — word-wrapped at the right margin), \
     `bullet_list` (with `items: [string]`), \
     `numbered_list` (with `items: [string]`), \
     `horizontal_rule` (no fields), \
     `page_break` (force the next block onto a new page), \
     `table` (with `headers: [string]` and `rows: [[string]]` — equal \
     column widths, no cell-wrap so keep cells short). \
     `title` is optional and becomes the filename (sanitised). \
     Unicode text (Latin, accents, common symbols) renders fine; glyphs \
     the bundled font lacks (e.g. Cyrillic, Greek, CJK, emoji) are \
     replaced with `?`, and the result says how many were."
}

pub fn input_schema() -> Value {
    // Every block object MUST carry a `type` discriminator. Smaller models
    // miss this when it lives only in the prose description, so we encode
    // it structurally as a `oneOf` here — the Rust deserializer already
    // enforces it via `#[serde(tag = "type", ...)]`.
    let block_schema = json!({
        "oneOf": [
            {
                "type": "object",
                "properties": {
                    "type": { "const": "heading" },
                    "level": { "type": "integer", "minimum": 1, "maximum": 3 },
                    "text": { "type": "string" }
                },
                "required": ["type", "text"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "type": { "const": "paragraph" },
                    "text": { "type": "string" }
                },
                "required": ["type", "text"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "type": { "const": "bullet_list" },
                    "items": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["type", "items"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "type": { "const": "numbered_list" },
                    "items": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["type", "items"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "type": { "const": "horizontal_rule" }
                },
                "required": ["type"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "type": { "const": "page_break" }
                },
                "required": ["type"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "type": { "const": "table" },
                    "headers": { "type": "array", "items": { "type": "string" } },
                    "rows": {
                        "type": "array",
                        "items": { "type": "array", "items": { "type": "string" } }
                    }
                },
                "required": ["type", "rows"],
                "additionalProperties": false
            }
        ]
    });
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create"],
                "description": "Which action to perform."
            },
            "title": {
                "type": "string",
                "description": "Optional document title — used as the attachment filename (sanitised; `.pdf` suffix is added)."
            },
            "pages": {
                "type": "array",
                "description": "For `create`. Each page has `blocks`; a new page is started for each entry.",
                "items": {
                    "type": "object",
                    "properties": {
                        "blocks": {
                            "type": "array",
                            "description": "Ordered list of block objects. Every block MUST include a `type` field — one of: `heading`, `paragraph`, `bullet_list`, `numbered_list`, `horizontal_rule`, `page_break`, `table`.",
                            "items": block_schema
                        }
                    },
                    "required": ["blocks"]
                }
            }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

pub fn dispatch(args: &Value) -> McpCallResult {
    let serialized_len = args.to_string().len();
    if serialized_len > MAX_SPEC_BYTES {
        return err(format!(
            "spec is {serialized_len} bytes; max is {MAX_SPEC_BYTES} — break the document up or shorten cell text"
        ));
    }
    let action = match args.get("action").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `action` argument — use \"create\""),
    };
    match action {
        "create" => do_create(args),
        other => err(format!("unknown action `{other}` — only \"create\" is supported")),
    }
}

fn do_create(args: &Value) -> McpCallResult {
    let title_raw = args
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("document");
    let pages: Vec<PageSpec> = match args.get("pages") {
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(p) => p,
            Err(e) => return err(format!("invalid `pages` shape: {e}")),
        },
        None => return err("missing required `pages` argument for create — an array of `{blocks: [...]}` objects"),
    };
    if pages.is_empty() {
        return err("`pages` is empty — provide at least one page with at least one block");
    }
    if pages.len() > MAX_PAGES {
        return err(format!(
            "{} pages requested; cap is {MAX_PAGES} — consider splitting the document",
            pages.len()
        ));
    }
    let Rendered {
        bytes,
        page_count,
        uncovered,
    } = match render_document(title_raw, &pages) {
        Ok(r) => r,
        Err(e) => return err(format!("PDF render failed: {e}")),
    };
    let filename = build_filename(title_raw);
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    // `bytes` is the canonical field — `PdfPreview` reads it first and falls
    // back to `data` only when missing. We deliberately leave `data` empty
    // here rather than duplicating the base64 string, which on a 200 KB PDF
    // would ship ~270 KB of redundant content over the IPC channel and
    // through `tool_result` event handling on the frontend.
    let attachment = Attachment {
        kind: "file".to_string(),
        name: filename.clone(),
        mime: "application/pdf".to_string(),
        data: String::new(),
        bytes: Some(base64),
        truncated: None,
    };
    McpCallResult {
        content_text: format!(
            "Created `{filename}` ({page_count} page{}, {} bytes). The PDF is attached to this message — the user can preview / save it directly.{}",
            if page_count == 1 { "" } else { "s" },
            bytes.len(),
            uncovered_note(&uncovered),
        ),
        is_error: false,
        attachments: vec![attachment],
    }
}

/// Characters of the spec's text the bundled font has no glyph for, which
/// the PDF shows as `?`.
#[derive(Debug, Default, PartialEq)]
struct Uncovered {
    count: usize,
    /// The first few distinct ones, in order of appearance.
    sample: Vec<char>,
}

/// How many distinct characters [`Uncovered::sample`] keeps.
const UNCOVERED_SAMPLE: usize = 8;

/// The result's warning about characters printed as `?`, or nothing when
/// every one rendered — without it the model reports a clean success and
/// the user finds the `?`s.
fn uncovered_note(uncovered: &Uncovered) -> String {
    if uncovered.count == 0 {
        return String::new();
    }
    let shown: Vec<String> = uncovered.sample.iter().map(|c| format!("`{c}`")).collect();
    format!(
        " Note: {} character{} the bundled font can't draw (e.g. {}) appear as `?` in the PDF — it covers Latin-script text only, so tell the user.",
        uncovered.count,
        if uncovered.count == 1 { "" } else { "s" },
        shown.join(", "),
    )
}

/// Count what [`sanitise`] will turn into `?`, over the spec rather than as
/// it's drawn, so a table header repeated on a continued page counts once.
fn count_uncovered(pages: &[PageSpec], font: &ParsedFont) -> Uncovered {
    let mut uncovered = Uncovered::default();
    for block in pages.iter().flat_map(|p| &p.blocks) {
        let texts: Vec<&String> = match block {
            Block::Heading { text, .. } | Block::Paragraph { text } => vec![text],
            Block::BulletList { items } | Block::NumberedList { items } => items.iter().collect(),
            Block::Table { headers, rows } => headers.iter().chain(rows.iter().flatten()).collect(),
            Block::HorizontalRule | Block::PageBreak => Vec::new(),
        };
        for c in texts.iter().flat_map(|t| t.chars()).filter(|&c| !is_covered(c, font)) {
            uncovered.count += 1;
            if uncovered.sample.len() < UNCOVERED_SAMPLE && !uncovered.sample.contains(&c) {
                uncovered.sample.push(c);
            }
        }
    }
    uncovered
}

// ---------- spec types ----------

#[derive(Debug, Deserialize)]
struct PageSpec {
    blocks: Vec<Block>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Block {
    Heading {
        #[serde(default = "default_heading_level", deserialize_with = "lenient_level")]
        level: u8,
        text: String,
    },
    Paragraph {
        text: String,
    },
    BulletList {
        items: Vec<String>,
    },
    NumberedList {
        items: Vec<String>,
    },
    HorizontalRule,
    PageBreak,
    Table {
        #[serde(default)]
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
    },
}

fn default_heading_level() -> u8 {
    2
}

/// `level` as models write it: the `1.0` local models emit for `1` failed
/// the whole document, where the tools' top-level integer arguments take it
/// ([`crate::tools::lenient_i64`]).
fn lenient_level<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let v = Value::deserialize(d)?;
    crate::tools::lenient_i64_value(&v)
        .and_then(|n| u8::try_from(n).ok())
        .ok_or_else(|| serde::de::Error::custom(format!("invalid heading `level` {v} — use 1, 2 or 3")))
}

// ---------- rendering ----------

/// Carries the mutable cursor state across blocks. printpdf 0.9 is
/// operation-based: a page is a `Vec<Op>`. We accumulate ops for the
/// current page and flush a `PdfPage` whenever we flow onto a new one.
struct RenderState<'f> {
    /// Parsed fonts, for glyph-coverage checks in `sanitise` (regular) and
    /// for measuring text in the face it's drawn in.
    regular_font: &'f ParsedFont,
    bold_font: &'f ParsedFont,
    /// Registered font handles for emitting `SetFont` ops.
    regular: FontId,
    bold: FontId,
    /// Pages flushed so far.
    pages: Vec<PdfPage>,
    /// Ops accumulating for the page currently being built.
    ops: Vec<Op>,
    /// Y cursor in mm from the bottom of the page (PDF origin).
    cursor_y_mm: f32,
}

impl<'f> RenderState<'f> {
    fn font(&self, bold: bool) -> &'f ParsedFont {
        if bold {
            self.bold_font
        } else {
            self.regular_font
        }
    }

    /// Whether nothing has been drawn on the page in progress yet.
    fn page_is_blank(&self) -> bool {
        self.ops.len() == page_init_ops().len()
    }

    /// Flush the in-progress page and begin a fresh one with the cursor
    /// back at the top margin — or refuse, if that would be one page more
    /// than [`MAX_PAGES`].
    fn new_page(&mut self) -> Result<(), String> {
        // A page with nothing on it yet stays the page in progress: a
        // `page_break` first thing on a page, or just before the next spec
        // page starts one, used to flush it blank.
        if self.page_is_blank() {
            self.cursor_y_mm = PAGE_HEIGHT_MM - MARGIN_MM;
            return Ok(());
        }
        // `pages` holds the finished ones; the page in progress is one more.
        if self.pages.len() + 1 >= MAX_PAGES {
            return Err(format!(
                "the document runs past the {MAX_PAGES}-page cap — split it into several PDFs or shorten it"
            ));
        }
        let ops = std::mem::replace(&mut self.ops, page_init_ops());
        self.pages
            .push(PdfPage::new(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), ops));
        self.cursor_y_mm = PAGE_HEIGHT_MM - MARGIN_MM;
        Ok(())
    }

    /// Reserve `space_mm` of vertical room. If the cursor would go below
    /// the bottom margin, flow to a new page.
    fn ensure_room(&mut self, space_mm: f32) -> Result<(), String> {
        if self.cursor_y_mm - space_mm < MARGIN_MM {
            self.new_page()?;
        }
        Ok(())
    }

    fn advance(&mut self, dy_mm: f32) {
        self.cursor_y_mm -= dy_mm;
    }

    /// Consume the state, flushing the last in-progress page — unless the
    /// document ended on a `page_break` and left it blank, and it isn't the
    /// only page.
    fn into_pages(mut self) -> Vec<PdfPage> {
        if !self.page_is_blank() || self.pages.is_empty() {
            self.pages
                .push(PdfPage::new(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), self.ops));
        }
        self.pages
    }

    /// Draw one line of text at an absolute mm position. Emits a self-
    /// contained text section so each call positions independently —
    /// the op-based equivalent of printpdf 0.7's `layer.use_text`.
    fn draw_text(&mut self, text: &str, size_pt: f32, x_mm: f32, y_mm: f32, bold: bool) {
        let font = if bold { self.bold.clone() } else { self.regular.clone() };
        self.ops.extend([
            Op::StartTextSection,
            Op::SetTextCursor {
                pos: Point::new(Mm(x_mm), Mm(y_mm)),
            },
            Op::SetFont {
                font: PdfFontHandle::External(font),
                size: Pt(size_pt),
            },
            Op::ShowText {
                items: vec![TextItem::Text(text.to_string())],
            },
            Op::EndTextSection,
        ]);
    }

    /// Draw a straight stroked line between two mm points.
    fn draw_line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32) {
        self.ops.push(Op::DrawLine {
            line: Line {
                points: vec![
                    LinePoint {
                        p: Point::new(Mm(x1), Mm(y1)),
                        bezier: false,
                    },
                    LinePoint {
                        p: Point::new(Mm(x2), Mm(y2)),
                        bezier: false,
                    },
                ],
                is_closed: false,
            },
        });
    }
}

/// Graphics-state ops applied at the top of every page: black fill (text)
/// and a thin black stroke (table / rule lines). Reset per page because a
/// fresh page's op stream starts with default state.
fn page_init_ops() -> Vec<Op> {
    vec![
        Op::SetFillColor { col: black() },
        Op::SetOutlineColor { col: black() },
        Op::SetOutlineThickness { pt: Pt(0.5) },
    ]
}

fn black() -> Color {
    Color::Rgb(Rgb {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        icc_profile: None,
    })
}

/// A rendered PDF and what the result should say about it.
struct Rendered {
    bytes: Vec<u8>,
    /// Physical pages, after text flowed on and page breaks applied — the
    /// spec's `pages` count only the ones it asked to start.
    page_count: usize,
    uncovered: Uncovered,
}

fn render_document(title: &str, pages: &[PageSpec]) -> Result<Rendered, String> {
    let mut doc = PdfDocument::new(title);
    let regular = ParsedFont::from_bytes(FONT_REGULAR, 0, &mut Vec::new())
        .ok_or("bundled regular font failed to parse")?;
    let bold = ParsedFont::from_bytes(FONT_BOLD, 0, &mut Vec::new())
        .ok_or("bundled bold font failed to parse")?;
    let regular_id = doc.add_font(&regular);
    let bold_id = doc.add_font(&bold);

    let mut state = RenderState {
        regular_font: &regular,
        bold_font: &bold,
        regular: regular_id,
        bold: bold_id,
        pages: Vec::new(),
        ops: page_init_ops(),
        cursor_y_mm: PAGE_HEIGHT_MM - MARGIN_MM,
    };

    for (page_idx, page) in pages.iter().enumerate() {
        // Each spec page starts a fresh physical page; the first is already
        // in progress from initialisation. `ensure_room` may also flow onto
        // further pages mid-block.
        if page_idx > 0 {
            state.new_page()?;
        }
        for block in &page.blocks {
            render_block(&mut state, block)?;
        }
    }

    let rendered_pages = state.into_pages();
    let page_count = rendered_pages.len();
    // `PdfSaveOptions::default()` sets `subset_fonts: true`, so printpdf
    // trims each embedded font down to the glyphs actually used.
    let opts = PdfSaveOptions::default();
    Ok(Rendered {
        bytes: doc.with_pages(rendered_pages).save(&opts, &mut Vec::new()),
        page_count,
        uncovered: count_uncovered(pages, &regular),
    })
}

fn render_block(state: &mut RenderState, block: &Block) -> Result<(), String> {
    match block {
        Block::Heading { level, text } => render_heading(state, *level, text),
        Block::Paragraph { text } => render_paragraph(state, text),
        Block::BulletList { items } => render_list(state, items, ListStyle::Bullet),
        Block::NumberedList { items } => render_list(state, items, ListStyle::Numbered),
        Block::HorizontalRule => render_hr(state),
        Block::PageBreak => state.new_page(),
        Block::Table { headers, rows } => render_table(state, headers, rows),
    }
}

fn render_heading(state: &mut RenderState, level: u8, text: &str) -> Result<(), String> {
    // Three levels — clamp anything outside to keep the size table tight.
    let size_pt: f32 = match level {
        1 => 20.0,
        2 => 16.0,
        _ => 13.0,
    };
    // ~1.2 line-height for headings (tighter than body) + a bit of top
    // padding so consecutive blocks don't crash into each other.
    let line_mm = pt_to_mm(size_pt) * 1.2;
    let top_pad_mm = if state.cursor_y_mm < PAGE_HEIGHT_MM - MARGIN_MM - 0.1 {
        line_mm * 0.5
    } else {
        0.0
    };
    state.advance(top_pad_mm);
    // Measured in the bold face at the heading's own size — what's drawn.
    let cleaned = sanitise(text, state.regular_font);
    for line in wrap_text(&cleaned, body_width_mm(), state.bold_font, size_pt) {
        state.ensure_room(line_mm)?;
        let y = state.cursor_y_mm - pt_to_mm(size_pt);
        state.draw_text(&line, size_pt, MARGIN_MM, y, true);
        state.advance(line_mm);
    }
    Ok(())
}

fn render_paragraph(state: &mut RenderState, text: &str) -> Result<(), String> {
    let cleaned = sanitise(text, state.regular_font);
    for line in wrap_text(&cleaned, body_width_mm(), state.regular_font, BODY_FONT_SIZE_PT) {
        state.ensure_room(BODY_LINE_HEIGHT_MM)?;
        let y = state.cursor_y_mm - pt_to_mm(BODY_FONT_SIZE_PT);
        state.draw_text(&line, BODY_FONT_SIZE_PT, MARGIN_MM, y, false);
        state.advance(BODY_LINE_HEIGHT_MM);
    }
    // Trailing blank to separate from the next block.
    state.advance(BODY_LINE_HEIGHT_MM * 0.4);
    Ok(())
}

enum ListStyle {
    Bullet,
    Numbered,
}

fn render_list(
    state: &mut RenderState,
    items: &[String],
    style: ListStyle,
) -> Result<(), String> {
    let markers: Vec<String> = (1..=items.len())
        .map(|n| match style {
            ListStyle::Bullet => "•".to_string(),
            // Numbers wrap monotonically; we don't try to detect nested
            // ordering, so always the flat `1.` style.
            ListStyle::Numbered => format!("{n}."),
        })
        .collect();
    let indent_mm = list_indent_mm(&markers, state.regular_font);
    let bullet_col_mm = MARGIN_MM;
    let text_col_mm = MARGIN_MM + indent_mm;
    let wrap_width_mm = body_width_mm() - indent_mm;
    for (item, marker) in items.iter().zip(&markers) {
        let marker = sanitise(marker, state.regular_font);
        let cleaned = sanitise(item, state.regular_font);
        let lines = wrap_text(&cleaned, wrap_width_mm, state.regular_font, BODY_FONT_SIZE_PT);
        for (line_idx, line) in lines.iter().enumerate() {
            state.ensure_room(BODY_LINE_HEIGHT_MM)?;
            let y = state.cursor_y_mm - pt_to_mm(BODY_FONT_SIZE_PT);
            // Marker only on the first wrapped line; continuation lines
            // align under the text column.
            if line_idx == 0 {
                state.draw_text(&marker, BODY_FONT_SIZE_PT, bullet_col_mm, y, false);
            }
            state.draw_text(line, BODY_FONT_SIZE_PT, text_col_mm, y, false);
            state.advance(BODY_LINE_HEIGHT_MM);
        }
    }
    state.advance(BODY_LINE_HEIGHT_MM * 0.4);
    Ok(())
}

/// How far a list's text sits from the margin: 6 mm, or past its widest
/// marker with a gap to spare when that's further. A fixed 6 mm fits `•`
/// and `9.`, but from `100.` on the number ran into the item's text.
fn list_indent_mm(markers: &[String], font: &ParsedFont) -> f32 {
    let widest_mm = markers
        .iter()
        .map(|m| text_width_mm(m, font, BODY_FONT_SIZE_PT))
        .fold(0.0, f32::max);
    (widest_mm + 2.0).max(6.0)
}

fn render_hr(state: &mut RenderState) -> Result<(), String> {
    let pad_mm = BODY_LINE_HEIGHT_MM * 0.5;
    state.advance(pad_mm);
    state.ensure_room(0.5)?;
    let y = state.cursor_y_mm;
    state.draw_line(MARGIN_MM, y, PAGE_WIDTH_MM - MARGIN_MM, y);
    state.advance(pad_mm);
    Ok(())
}

fn render_table(
    state: &mut RenderState,
    headers: &[String],
    rows: &[Vec<String>],
) -> Result<(), String> {
    // Total column count is max of header len and the widest row, so a
    // row with extra cells doesn't get clipped silently.
    let cols = headers
        .len()
        .max(rows.iter().map(|r| r.len()).max().unwrap_or(0));
    if cols == 0 {
        return err_str("table has no columns — provide `headers` or non-empty `rows`");
    }
    let col_width_mm = body_width_mm() / cols as f32;
    let cell_pad_mm: f32 = 1.2;
    let row_height_mm = BODY_LINE_HEIGHT_MM + cell_pad_mm * 2.0;

    // Headers first (if any), in bold.
    let has_headers = !headers.is_empty();
    if has_headers {
        state.ensure_room(row_height_mm)?;
        render_table_row(state, headers, cols, col_width_mm, cell_pad_mm, row_height_mm, true);
    }
    for row in rows {
        // If this row would overflow the page, `ensure_room` flows to a new
        // one. Detect that up front (the same predicate `ensure_room` uses)
        // so we can repeat the header band at the top of the continued
        // table rather than leaving the carried-over rows unlabelled.
        let flowed = state.cursor_y_mm - row_height_mm < MARGIN_MM;
        state.ensure_room(row_height_mm)?;
        if flowed && has_headers {
            render_table_row(state, headers, cols, col_width_mm, cell_pad_mm, row_height_mm, true);
            state.ensure_room(row_height_mm)?;
        }
        render_table_row(state, row, cols, col_width_mm, cell_pad_mm, row_height_mm, false);
    }
    state.advance(BODY_LINE_HEIGHT_MM * 0.4);
    Ok(())
}

fn render_table_row(
    state: &mut RenderState,
    cells: &[String],
    cols: usize,
    col_width_mm: f32,
    cell_pad_mm: f32,
    row_height_mm: f32,
    bold: bool,
) {
    let top_y = state.cursor_y_mm;
    let bottom_y = top_y - row_height_mm;
    // Horizontal border lines (top + bottom of this row).
    for y in [top_y, bottom_y] {
        state.draw_line(MARGIN_MM, y, PAGE_WIDTH_MM - MARGIN_MM, y);
    }
    // Cell text + left vertical border per column.
    for col in 0..cols {
        let x = MARGIN_MM + col as f32 * col_width_mm;
        state.draw_line(x, top_y, x, bottom_y);
        // Cell text — truncated to col width (no wrap inside cells).
        let raw = cells.get(col).map(String::as_str).unwrap_or("");
        let text = truncate_to_width(
            &sanitise(raw, state.regular_font),
            col_width_mm - cell_pad_mm * 2.0_f32,
            state.font(bold),
            BODY_FONT_SIZE_PT,
        );
        let text_y = top_y - cell_pad_mm - pt_to_mm(BODY_FONT_SIZE_PT);
        state.draw_text(&text, BODY_FONT_SIZE_PT, x + cell_pad_mm, text_y, bold);
    }
    // Right border of the rightmost column.
    let right_x = PAGE_WIDTH_MM - MARGIN_MM;
    state.draw_line(right_x, top_y, right_x, bottom_y);
    state.advance(row_height_mm);
}

// ---------- helpers ----------

/// Replace characters the bundled font can't render with `?`. ASCII is
/// always kept (the font covers it, and `\n` drives `wrap_text`); other
/// characters are kept when the font has a glyph for them (Latin/European
/// accents, common symbols, bullets) and dropped to `?` only when it does
/// not (e.g. CJK, emoji) so output stays legible instead of showing blank
/// `.notdef` boxes.
fn sanitise(s: &str, font: &ParsedFont) -> String {
    s.chars()
        .map(|c| if is_covered(c, font) { c } else { '?' })
        .collect()
}

/// Whether the bundled font draws `c` — see [`sanitise`].
fn is_covered(c: char, font: &ParsedFont) -> bool {
    c.is_ascii() || font.lookup_glyph_index(c as u32).is_some_and(|g| g != 0)
}

/// Advance width of `c` in mm at `size_pt`, from the font's own metrics.
/// printpdf lays a `ShowText` out by exactly these, with no kerning, and
/// draws a character the font doesn't map as glyph 0 (`.notdef`) — which is
/// what it is measured as here too.
fn char_width_mm(c: char, font: &ParsedFont, size_pt: f32) -> f32 {
    let gid = font.lookup_glyph_index(c as u32).unwrap_or(0);
    let units = font.get_glyph_width(gid).unwrap_or(0);
    f32::from(units) / f32::from(font.units_per_em) * pt_to_mm(size_pt)
}

fn text_width_mm(s: &str, font: &ParsedFont, size_pt: f32) -> f32 {
    s.chars().map(|c| char_width_mm(c, font, size_pt)).sum()
}

/// Greedy word wrap by the font's real advance widths, so no line runs
/// past `width_mm`. A fixed per-character estimate let all-caps and digit
/// runs overflow the margin (a `W` is nearly twice an average glyph).
/// Input is assumed already sanitised.
fn wrap_text(text: &str, width_mm: f32, font: &ParsedFont, size_pt: f32) -> Vec<String> {
    let space_mm = char_width_mm(' ', font, size_pt);
    let mut out: Vec<String> = Vec::new();
    for paragraph in text.split('\n') {
        let mut current = String::new();
        let mut current_mm = 0.0;
        for word in paragraph.split_whitespace() {
            let word_mm = text_width_mm(word, font, size_pt);
            if current.is_empty() {
                // Word longer than the line — hard-break it.
                if word_mm > width_mm {
                    out.extend(chunk_by_width(word, width_mm, font, size_pt));
                } else {
                    current.push_str(word);
                    current_mm = word_mm;
                }
                continue;
            }
            if current_mm + space_mm + word_mm <= width_mm {
                current.push(' ');
                current.push_str(word);
                current_mm += space_mm + word_mm;
            } else {
                out.push(std::mem::take(&mut current));
                if word_mm > width_mm {
                    out.extend(chunk_by_width(word, width_mm, font, size_pt));
                } else {
                    current.push_str(word);
                    current_mm = word_mm;
                }
            }
        }
        if !current.is_empty() {
            out.push(current);
        } else if paragraph.is_empty() {
            // Preserve blank lines between paragraphs.
            out.push(String::new());
        }
    }
    out
}

/// Split one overlong word into pieces that each fit `width_mm`. Every
/// piece takes at least one character, so this always makes progress.
fn chunk_by_width(s: &str, width_mm: f32, font: &ParsedFont, size_pt: f32) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_mm = 0.0;
    for ch in s.chars() {
        let ch_mm = char_width_mm(ch, font, size_pt);
        if !cur.is_empty() && cur_mm + ch_mm > width_mm {
            out.push(std::mem::take(&mut cur));
            cur_mm = 0.0;
        }
        cur.push(ch);
        cur_mm += ch_mm;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `s` cut down to fit `max_mm`, measured the same way [`wrap_text`]
/// measures, so a clipped cell can't spill into its neighbour.
fn truncate_to_width(s: &str, max_mm: f32, font: &ParsedFont, size_pt: f32) -> String {
    if text_width_mm(s, font, size_pt) <= max_mm {
        return s.to_string();
    }
    // Append `~` as the clipped-cell hint, which needs room of its own; a
    // column too narrow for even that stays empty.
    let budget_mm = max_mm - char_width_mm('~', font, size_pt);
    if budget_mm < 0.0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used_mm = 0.0;
    for ch in s.chars() {
        used_mm += char_width_mm(ch, font, size_pt);
        if used_mm > budget_mm {
            break;
        }
        out.push(ch);
    }
    out.push('~');
    out
}

fn body_width_mm() -> f32 {
    PAGE_WIDTH_MM - MARGIN_MM * 2.0
}

fn pt_to_mm(pt: f32) -> f32 {
    pt * 0.352_777_8
}

/// Longest the filename's stem may be, in UTF-8 bytes. Linux and macOS cap a
/// name at 255 bytes, Windows at 255 UTF-16 units (which never outnumber the
/// UTF-8 bytes), and this leaves room for `.pdf` and the ` (1)` a download
/// gets when the name is taken.
const MAX_FILENAME_STEM_BYTES: usize = 120;

/// The title as a filename: letters and digits of any script, `-` and `_`,
/// with whitespace as `_`. Letters are safe in a name on Windows, macOS and
/// Linux alike — keeping only ASCII ones turned `Zażółć gęślą jaźń` into
/// `Za_gl_ja` — while separators, `:`, dots, control and text-direction
/// characters are not, and are dropped. Cut to [`MAX_FILENAME_STEM_BYTES`].
fn build_filename(raw_title: &str) -> String {
    let mut slug = String::with_capacity(raw_title.len());
    for ch in raw_title.trim().chars() {
        let kept = if ch.is_alphanumeric() || ch == '-' || ch == '_' {
            ch
        } else if ch.is_whitespace() {
            '_'
        } else {
            continue;
        };
        if slug.len() + kept.len_utf8() > MAX_FILENAME_STEM_BYTES {
            break;
        }
        slug.push(kept);
    }
    let slug = slug.trim_matches('_').to_string();
    let base = if slug.is_empty() { "document" } else { &slug };
    format!("{base}.pdf")
}

fn err(msg: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: msg.into(),
        is_error: true,
        ..Default::default()
    }
}

fn err_str(msg: &str) -> Result<(), String> {
    Err(msg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create_minimal() -> McpCallResult {
        dispatch(&json!({
            "action": "create",
            "title": "Test",
            "pages": [{
                "blocks": [
                    { "type": "heading", "level": 1, "text": "Hello" },
                    { "type": "paragraph", "text": "World." }
                ]
            }]
        }))
    }

    #[test]
    fn create_produces_pdf_attachment() {
        let r = create_minimal();
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.attachments.len(), 1);
        let a = &r.attachments[0];
        assert_eq!(a.kind, "file");
        assert_eq!(a.mime, "application/pdf");
        assert!(a.name.ends_with(".pdf"));
        // PDF files start with `%PDF-` — base64 decode the first few bytes
        // and check. This confirms printpdf actually produced a valid file,
        // not just an empty buffer. The canonical payload lives on `bytes`
        // now; `data` is left empty to avoid duplicating the base64 string.
        assert!(a.data.is_empty(), "expected `data` to be empty (use `bytes`)");
        let raw = a.bytes.as_deref().expect("bytes field present");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .expect("attachment bytes is base64");
        assert!(
            decoded.starts_with(b"%PDF-"),
            "expected PDF magic bytes, got: {:?}",
            &decoded[..decoded.len().min(8)],
        );
    }

    #[test]
    fn create_filename_is_sanitised() {
        let r = dispatch(&json!({
            "action": "create",
            "title": "Q4 Report 2026 / draft",
            "pages": [{ "blocks": [{ "type": "paragraph", "text": "x" }] }]
        }));
        assert!(!r.is_error);
        let name = &r.attachments[0].name;
        // Slashes dropped, spaces → underscores, `.pdf` appended.
        assert_eq!(name, "Q4_Report_2026__draft.pdf");
    }

    #[test]
    fn create_supports_lists_and_table() {
        let r = dispatch(&json!({
            "action": "create",
            "pages": [{
                "blocks": [
                    { "type": "bullet_list", "items": ["one", "two", "three"] },
                    { "type": "numbered_list", "items": ["alpha", "beta"] },
                    { "type": "horizontal_rule" },
                    { "type": "table",
                      "headers": ["A", "B"],
                      "rows": [["1", "2"], ["3", "4"]] }
                ]
            }]
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.attachments.len(), 1);
    }

    #[test]
    fn create_handles_multiple_pages() {
        let r = dispatch(&json!({
            "action": "create",
            "pages": [
                { "blocks": [{ "type": "heading", "text": "Page 1" }] },
                { "blocks": [{ "type": "heading", "text": "Page 2" }] }
            ]
        }));
        assert!(!r.is_error);
        // Result text mentions 2 pages.
        assert!(r.content_text.contains("2 page"));
    }

    #[test]
    fn create_rejects_empty_pages() {
        let r = dispatch(&json!({ "action": "create", "pages": [] }));
        assert!(r.is_error);
        assert!(r.content_text.contains("empty"));
    }

    #[test]
    fn create_rejects_missing_pages() {
        let r = dispatch(&json!({ "action": "create" }));
        assert!(r.is_error);
        assert!(r.content_text.contains("missing"));
    }

    #[test]
    fn create_rejects_too_many_pages() {
        let pages: Vec<serde_json::Value> = (0..MAX_PAGES + 1)
            .map(|_| json!({ "blocks": [{ "type": "paragraph", "text": "x" }] }))
            .collect();
        let r = dispatch(&json!({ "action": "create", "pages": pages }));
        assert!(r.is_error);
        assert!(r.content_text.contains("cap"));
    }

    #[test]
    fn unknown_action_errors() {
        let r = dispatch(&json!({ "action": "convert" }));
        assert!(r.is_error);
        assert!(r.content_text.contains("unknown action"));
    }

    #[test]
    fn sanitise_keeps_covered_glyphs_and_replaces_unsupported() {
        let font = printpdf::ParsedFont::from_bytes(FONT_REGULAR, 0, &mut Vec::new())
            .expect("bundled regular font parses");
        // Polish accents and the euro sign are covered by Liberation Sans
        // → preserved (the old ASCII-only build turned these into `?`).
        assert_eq!(sanitise("Łódź €", &font), "Łódź €");
        // Plain ASCII is untouched.
        assert_eq!(sanitise("plain ascii", &font), "plain ascii");
        // A glyph the font lacks (CJK) still falls back to `?`.
        assert_eq!(sanitise("A中B", &font), "A?B");
    }

    #[test]
    fn create_renders_unicode_text() {
        // Full path with non-ASCII headings, paragraph, and list items —
        // must produce a valid PDF, not error or mangle to `?`.
        let r = dispatch(&json!({
            "action": "create",
            "title": "Zażółć gęślą jaźń",
            "pages": [{ "blocks": [
                { "type": "heading", "level": 1, "text": "Zażółć gęślą jaźń" },
                { "type": "paragraph", "text": "Cena: 100 € — naprawdę." },
                { "type": "bullet_list", "items": ["Ćma", "Łódź", "Źdźbło"] }
            ]}]
        }));
        assert!(!r.is_error, "{}", r.content_text);
        let raw = r.attachments[0].bytes.as_deref().expect("bytes field present");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .expect("attachment bytes is base64");
        assert!(decoded.starts_with(b"%PDF-"), "expected a valid PDF");
    }

    fn fonts() -> (ParsedFont, ParsedFont) {
        let parse = |bytes| ParsedFont::from_bytes(bytes, 0, &mut Vec::new()).expect("bundled font parses");
        (parse(FONT_REGULAR), parse(FONT_BOLD))
    }

    #[test]
    fn wrap_text_respects_width() {
        let (regular, _) = fonts();
        let wrapped = wrap_text(
            "the quick brown fox jumps over the lazy dog and then some more words",
            60.0,
            &regular,
            BODY_FONT_SIZE_PT,
        );
        assert!(wrapped.len() >= 2, "expected multi-line wrap, got: {wrapped:?}");
        for line in &wrapped {
            let w = text_width_mm(line, &regular, BODY_FONT_SIZE_PT);
            assert!(w <= 60.0, "line too long: `{line}` ({w} mm)");
        }
    }

    /// Wide glyphs are where a fixed 2 mm/char estimate overflowed: 85
    /// characters "fit" the 170 mm body width, but 85 capitals at 11 pt run
    /// to ~250 mm and 85 `W`s to over 300 mm.
    #[test]
    fn wide_text_wraps_inside_the_margin() {
        let (regular, bold) = fonts();
        let caps = "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG ".repeat(4);
        let digits = "1234567890 ".repeat(12);
        let ws = "W".repeat(85);
        for text in [caps.as_str(), digits.as_str(), ws.as_str()] {
            for (font, size) in [(&regular, BODY_FONT_SIZE_PT), (&bold, 20.0)] {
                let lines = wrap_text(text, body_width_mm(), font, size);
                assert!(lines.len() >= 2, "{text:?} at {size} pt should wrap: {lines:?}");
                for line in &lines {
                    let w = text_width_mm(line, font, size);
                    assert!(w <= body_width_mm(), "`{line}` is {w} mm at {size} pt");
                }
                assert_eq!(lines.concat().replace(' ', ""), text.replace(' ', ""), "nothing lost");
            }
        }
    }

    #[test]
    fn truncate_to_width_adds_hint_when_clipping() {
        let (regular, _) = fonts();
        let w = |s: &str| text_width_mm(s, &regular, BODY_FONT_SIZE_PT);
        // Fits within the budget — returned unchanged.
        assert_eq!(truncate_to_width("hi", w("hi"), &regular, BODY_FONT_SIZE_PT), "hi");
        // Clipped — keeps what fits beside the ASCII `~` hint.
        let t = truncate_to_width("abcdefgh", w("abc~"), &regular, BODY_FONT_SIZE_PT);
        assert_eq!(t, "abc~");
        // Measured, not counted: four capitals take more room than four
        // lowercase letters, so fewer of them fit the same width.
        let t = truncate_to_width("WWWWWWWW", w("abc~"), &regular, BODY_FONT_SIZE_PT);
        assert!(w(&t) <= w("abc~"), "`{t}` overflows");
        assert!(t.chars().count() < 4, "{t}");
        // Degenerate widths must not panic.
        assert_eq!(truncate_to_width("abc", 0.0, &regular, BODY_FONT_SIZE_PT), "");
        assert_eq!(truncate_to_width("abc", -3.0, &regular, BODY_FONT_SIZE_PT), "");
    }

    #[test]
    fn wrap_text_hard_breaks_overlong_word() {
        // A single token longer than the line is chunked rather than
        // overflowing the right margin.
        let (regular, _) = fonts();
        let word = "a".repeat(20);
        let wrapped = wrap_text(&word, 10.0, &regular, BODY_FONT_SIZE_PT);
        assert!(wrapped.len() >= 2, "expected a hard break, got: {wrapped:?}");
        for line in &wrapped {
            assert!(text_width_mm(line, &regular, BODY_FONT_SIZE_PT) <= 10.0, "chunk too long: `{line}`");
        }
        assert_eq!(wrapped.concat(), word);
    }

    /// Characters the bundled subset lacks used to become `?` behind a plain
    /// "Created …"; the result now says how many, and which.
    #[test]
    fn unrenderable_characters_are_reported() {
        let r = dispatch(&json!({
            "action": "create",
            "pages": [{ "blocks": [
                { "type": "heading", "text": "Ωμέγα" },
                { "type": "paragraph", "text": "中文, but Łódź is fine" },
                { "type": "table", "headers": ["Ж"], "rows": [["Ж"]] }
            ]}]
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("9 characters"), "{}", r.content_text);
        for c in ["`Ω`", "`α`", "`中`", "`Ж`"] {
            assert!(r.content_text.contains(c), "{c} missing: {}", r.content_text);
        }
        assert!(!r.content_text.contains("`Ł`"), "{}", r.content_text);
        assert!(!create_minimal().content_text.contains("Note:"));
        let font = fonts().0;
        let cyrillic = [PageSpec { blocks: vec![Block::Paragraph { text: "Привет мир".into() }] }];
        assert_eq!(
            count_uncovered(&cyrillic, &font),
            Uncovered { count: 9, sample: vec!['П', 'р', 'и', 'в', 'е', 'т', 'м'] },
            "every occurrence counts, each character is named once, the space renders"
        );
    }

    /// The cap and the reported count are physical pages: page breaks and
    /// text that flows on add pages the spec's `pages` array doesn't show.
    #[test]
    fn physical_pages_are_counted_and_capped() {
        // `n` pages of text, a page break between each two.
        let paged = |n: usize| {
            let text = json!({ "type": "paragraph", "text": "x" });
            let mut blocks = vec![text.clone()];
            for _ in 1..n {
                blocks.extend([json!({ "type": "page_break" }), text.clone()]);
            }
            blocks
        };
        let r = dispatch(&json!({ "action": "create", "pages": [{ "blocks": paged(3) }] }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("(3 pages,"), "{}", r.content_text);

        let lines = "line\n".repeat(100);
        let r = dispatch(&json!({
            "action": "create",
            "pages": [{ "blocks": [{ "type": "paragraph", "text": lines }] }]
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("(3 pages,"), "{}", r.content_text);

        let r = dispatch(&json!({ "action": "create", "pages": [{ "blocks": paged(MAX_PAGES + 1) }] }));
        assert!(r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("cap"), "{}", r.content_text);
        let r = dispatch(&json!({ "action": "create", "pages": [{ "blocks": paged(MAX_PAGES) }] }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains(&format!("({MAX_PAGES} pages,")), "{}", r.content_text);
    }

    /// A page break with nothing before it on its page — first thing in the
    /// document, straight after another break, or the last block before the
    /// next spec page — doesn't put out a blank page; nor does one at the end.
    #[test]
    fn page_breaks_never_leave_a_blank_page() {
        let text = || json!({ "type": "paragraph", "text": "x" });
        let brk = || json!({ "type": "page_break" });
        let pages_in = |pages: Value| {
            let r = dispatch(&json!({ "action": "create", "pages": pages }));
            assert!(!r.is_error, "{}", r.content_text);
            r.content_text
        };
        for (pages, want) in [
            (json!([{ "blocks": [brk(), text()] }]), "(1 page,"),
            (json!([{ "blocks": [text(), brk(), brk(), text()] }]), "(2 pages,"),
            (json!([{ "blocks": [text(), brk()] }, { "blocks": [text()] }]), "(2 pages,"),
            (json!([{ "blocks": [text(), brk()] }]), "(1 page,"),
            // Nothing drawn at all is still a one-page PDF.
            (json!([{ "blocks": [brk()] }]), "(1 page,"),
        ] {
            let got = pages_in(pages.clone());
            assert!(got.contains(want), "{pages}: {got}");
        }
    }

    #[test]
    fn heading_level_accepts_a_float_shaped_integer() {
        let heading = |level: Value| {
            dispatch(&json!({
                "action": "create",
                "pages": [{ "blocks": [{ "type": "heading", "level": level, "text": "Title" }] }]
            }))
        };
        let r = heading(json!(1.0));
        assert!(!r.is_error, "{}", r.content_text);
        let r = heading(json!(1.5));
        assert!(r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("level"), "{}", r.content_text);
    }

    #[test]
    fn filenames_keep_letters_of_any_script_and_stay_short() {
        assert_eq!(build_filename("Zażółć gęślą jaźń"), "Zażółć_gęślą_jaźń.pdf");
        assert_eq!(build_filename("Отчёт: 2026/Q4"), "Отчёт_2026Q4.pdf");
        assert_eq!(build_filename("🦊 \u{202E}"), "document.pdf");
        let long = build_filename(&"ż".repeat(300));
        assert!(long.len() <= MAX_FILENAME_STEM_BYTES + ".pdf".len(), "{}", long.len());
        assert!(long.starts_with("żżż") && long.ends_with("ż.pdf"), "{long}");
    }

    /// From `100.` on, a number is wider than the old fixed 6 mm indent and
    /// ran into the item's text.
    #[test]
    fn list_text_clears_its_widest_marker() {
        let (regular, _) = fonts();
        let numbered = |n: usize| (1..=n).map(|i| format!("{i}.")).collect::<Vec<_>>();
        assert_eq!(list_indent_mm(&["•".to_string()], &regular), 6.0);
        assert_eq!(list_indent_mm(&numbered(9), &regular), 6.0);
        for n in [100, 1000] {
            let marker_mm = text_width_mm(&format!("{n}."), &regular, BODY_FONT_SIZE_PT);
            let indent = list_indent_mm(&numbered(n), &regular);
            assert!(indent > marker_mm + 1.0, "{n}: {indent} mm for a {marker_mm} mm marker");
        }
    }

    #[test]
    fn table_spanning_multiple_pages_renders() {
        // ~33 rows fit per A4 page; 120 rows force several page splits. The
        // table must flow across pages without erroring (headers repeat on
        // each continued page — see `render_table`).
        let rows: Vec<serde_json::Value> = (0..120)
            .map(|i| json!([format!("row {i}"), format!("value {i}")]))
            .collect();
        let r = dispatch(&json!({
            "action": "create",
            "pages": [{ "blocks": [
                { "type": "table", "headers": ["Key", "Value"], "rows": rows }
            ]}]
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.attachments.len(), 1);
    }

    #[test]
    fn long_heading_wraps_without_error() {
        let long = "This is an extremely long level-one heading that clearly \
                    exceeds the printable width of a single A4 line and so must \
                    wrap across several lines instead of running off the right \
                    margin of the page";
        let r = dispatch(&json!({
            "action": "create",
            "pages": [{ "blocks": [{ "type": "heading", "level": 1, "text": long }] }]
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.attachments.len(), 1);
    }
}
