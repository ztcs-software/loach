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
//! bullets render correctly. Liberation Sans is metric-compatible with
//! Helvetica/Arial, so the fixed per-character width estimate the layout
//! relies on stays valid. Glyphs outside the bundled set (e.g. CJK, emoji)
//! are replaced with `?` at render time so the file stays legible rather
//! than showing blank `.notdef` boxes.

use base64::Engine;
use printpdf::*;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp::{Attachment, McpCallResult};

pub const TOOL_NAME: &str = "pdf";

/// Bundled text fonts: Liberation Sans (SIL OFL — see
/// `assets/fonts/LICENSE-Liberation.txt`), metric-compatible with
/// Helvetica/Arial so the fixed width estimate holds. The vendored files
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
/// Conservative per-character width estimate at body size, in mm
/// (Liberation Sans ≈ Helvetica/Arial metrics). The font is proportional
/// (each glyph has its own width) so this slightly under-fills lines —
/// that's the right side to err on because over-estimating would let
/// lines overflow the right margin.
const BODY_CHAR_WIDTH_MM: f32 = 2.0;

/// Spec ceiling. A single PDF spec beyond ~256 KiB is almost certainly a
/// runaway prompt — text at 11 pt fits about 4000 characters per A4 page,
/// and a structured spec is denser than that.
const MAX_SPEC_BYTES: usize = 256 * 1024;
/// Per-action page ceiling — bounds rasterisation cost on the receiving
/// pdfjs viewer if a model decides to ask for 10 000 pages of bullet
/// lists. 200 pages is well past any real chat use.
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
     the bundled font lacks (e.g. CJK, emoji) are replaced with `?`."
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
    let bytes = match render_document(title_raw, &pages) {
        Ok(b) => b,
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
            "Created `{filename}` ({} page{}, {} bytes). The PDF is attached to this message — the user can preview / save it directly.",
            pages.len(),
            if pages.len() == 1 { "" } else { "s" },
            bytes.len(),
        ),
        is_error: false,
        attachments: vec![attachment],
    }
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
        #[serde(default = "default_heading_level")]
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

// ---------- rendering ----------

/// Carries the mutable cursor state across blocks. printpdf 0.9 is
/// operation-based: a page is a `Vec<Op>`. We accumulate ops for the
/// current page and flush a `PdfPage` whenever we flow onto a new one.
struct RenderState<'f> {
    /// Regular font, kept for glyph-coverage checks in `sanitise`.
    coverage: &'f ParsedFont,
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

impl RenderState<'_> {
    /// Flush the in-progress page and begin a fresh one with the cursor
    /// back at the top margin.
    fn new_page(&mut self) {
        let ops = std::mem::replace(&mut self.ops, page_init_ops());
        self.pages
            .push(PdfPage::new(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), ops));
        self.cursor_y_mm = PAGE_HEIGHT_MM - MARGIN_MM;
    }

    /// Reserve `space_mm` of vertical room. If the cursor would go below
    /// the bottom margin, flow to a new page.
    fn ensure_room(&mut self, space_mm: f32) {
        if self.cursor_y_mm - space_mm < MARGIN_MM {
            self.new_page();
        }
    }

    fn advance(&mut self, dy_mm: f32) {
        self.cursor_y_mm -= dy_mm;
    }

    /// Consume the state, flushing the last in-progress page.
    fn into_pages(mut self) -> Vec<PdfPage> {
        self.pages
            .push(PdfPage::new(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), self.ops));
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

fn render_document(title: &str, pages: &[PageSpec]) -> Result<Vec<u8>, String> {
    let mut doc = PdfDocument::new(title);
    let regular = ParsedFont::from_bytes(FONT_REGULAR, 0, &mut Vec::new())
        .ok_or("bundled regular font failed to parse")?;
    let bold = ParsedFont::from_bytes(FONT_BOLD, 0, &mut Vec::new())
        .ok_or("bundled bold font failed to parse")?;
    let regular_id = doc.add_font(&regular);
    let bold_id = doc.add_font(&bold);

    let mut state = RenderState {
        coverage: &regular,
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
            state.new_page();
        }
        for block in &page.blocks {
            render_block(&mut state, block)?;
        }
    }

    let rendered_pages = state.into_pages();
    // `PdfSaveOptions::default()` sets `subset_fonts: true`, so printpdf
    // trims each embedded font down to the glyphs actually used.
    let opts = PdfSaveOptions::default();
    Ok(doc.with_pages(rendered_pages).save(&opts, &mut Vec::new()))
}

fn render_block(state: &mut RenderState, block: &Block) -> Result<(), String> {
    match block {
        Block::Heading { level, text } => render_heading(state, *level, text),
        Block::Paragraph { text } => render_paragraph(state, text),
        Block::BulletList { items } => render_list(state, items, ListStyle::Bullet),
        Block::NumberedList { items } => render_list(state, items, ListStyle::Numbered),
        Block::HorizontalRule => render_hr(state),
        Block::PageBreak => {
            state.new_page();
            Ok(())
        }
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
    // Headings are proportionally wider than body text, so scale the
    // per-char width estimate by the font-size ratio before wrapping —
    // otherwise a long heading runs off the right margin.
    let char_width_mm = BODY_CHAR_WIDTH_MM * size_pt / BODY_FONT_SIZE_PT;
    let cleaned = sanitise(text, state.coverage);
    for line in wrap_text(&cleaned, body_width_mm(), char_width_mm) {
        state.ensure_room(line_mm);
        let y = state.cursor_y_mm - pt_to_mm(size_pt);
        state.draw_text(&line, size_pt, MARGIN_MM, y, true);
        state.advance(line_mm);
    }
    Ok(())
}

fn render_paragraph(state: &mut RenderState, text: &str) -> Result<(), String> {
    let cleaned = sanitise(text, state.coverage);
    for line in wrap_text(&cleaned, body_width_mm(), BODY_CHAR_WIDTH_MM) {
        state.ensure_room(BODY_LINE_HEIGHT_MM);
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
    let indent_mm = 6.0;
    let bullet_col_mm = MARGIN_MM;
    let text_col_mm = MARGIN_MM + indent_mm;
    let wrap_width_mm = body_width_mm() - indent_mm;
    for (i, item) in items.iter().enumerate() {
        let marker = match style {
            ListStyle::Bullet => "•".to_string(),
            // Numbers wrap monotonically; we don't try to detect nested
            // ordering, so always the flat `1.` style.
            ListStyle::Numbered => format!("{}.", i + 1),
        };
        let marker = sanitise(&marker, state.coverage);
        let cleaned = sanitise(item, state.coverage);
        let lines = wrap_text(&cleaned, wrap_width_mm, BODY_CHAR_WIDTH_MM);
        for (line_idx, line) in lines.iter().enumerate() {
            state.ensure_room(BODY_LINE_HEIGHT_MM);
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

fn render_hr(state: &mut RenderState) -> Result<(), String> {
    let pad_mm = BODY_LINE_HEIGHT_MM * 0.5;
    state.advance(pad_mm);
    state.ensure_room(0.5);
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
        state.ensure_room(row_height_mm);
        render_table_row(state, headers, cols, col_width_mm, cell_pad_mm, row_height_mm, true);
    }
    for row in rows {
        // If this row would overflow the page, `ensure_room` flows to a new
        // one. Detect that up front (the same predicate `ensure_room` uses)
        // so we can repeat the header band at the top of the continued
        // table rather than leaving the carried-over rows unlabelled.
        let flowed = state.cursor_y_mm - row_height_mm < MARGIN_MM;
        state.ensure_room(row_height_mm);
        if flowed && has_headers {
            render_table_row(state, headers, cols, col_width_mm, cell_pad_mm, row_height_mm, true);
            state.ensure_room(row_height_mm);
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
        let max_chars = ((col_width_mm - cell_pad_mm * 2.0_f32) / BODY_CHAR_WIDTH_MM).floor() as usize;
        let text = truncate_to_chars(&sanitise(raw, state.coverage), max_chars);
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
        .map(|c| {
            if c.is_ascii() || font.lookup_glyph_index(c as u32).map_or(false, |g| g != 0) {
                c
            } else {
                '?'
            }
        })
        .collect()
}

/// Greedy word wrap based on a fixed per-character width estimate. The
/// bundled font is proportional, so this is conservative — lines will
/// under-fill rather than overflow. Input is assumed already sanitised.
fn wrap_text(text: &str, width_mm: f32, char_width_mm: f32) -> Vec<String> {
    let max_chars = (width_mm / char_width_mm).floor() as usize;
    if max_chars == 0 {
        return vec![text.to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    for paragraph in text.split('\n') {
        let mut current = String::new();
        for word in paragraph.split_whitespace() {
            if current.is_empty() {
                // Word longer than the line — hard-break it.
                if word.len() > max_chars {
                    for chunk in chunk_by_chars(word, max_chars) {
                        out.push(chunk);
                    }
                } else {
                    current.push_str(word);
                }
                continue;
            }
            if current.len() + 1 + word.len() <= max_chars {
                current.push(' ');
                current.push_str(word);
            } else {
                out.push(std::mem::take(&mut current));
                if word.len() > max_chars {
                    for chunk in chunk_by_chars(word, max_chars) {
                        out.push(chunk);
                    }
                } else {
                    current.push_str(word);
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

fn chunk_by_chars(s: &str, n: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        cur.push(ch);
        if cur.len() >= n {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn truncate_to_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    if max <= 1 {
        return s.chars().take(max).collect();
    }
    // Append `~` as the clipped-cell hint — kept as plain ASCII so the
    // marker width stays predictable (a real `…` would render fine now too).
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('~');
    out
}

fn body_width_mm() -> f32 {
    PAGE_WIDTH_MM - MARGIN_MM * 2.0
}

fn pt_to_mm(pt: f32) -> f32 {
    pt * 0.352_777_8
}

fn build_filename(raw_title: &str) -> String {
    let mut slug = String::with_capacity(raw_title.len());
    for ch in raw_title.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            slug.push(ch);
        } else if ch.is_whitespace() {
            slug.push('_');
        }
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

    #[test]
    fn wrap_text_respects_width() {
        // 60 mm wide, ~2 mm per char → ~30 chars per line.
        let wrapped = wrap_text(
            "the quick brown fox jumps over the lazy dog and then some more words",
            60.0,
            2.0,
        );
        assert!(wrapped.len() >= 2, "expected multi-line wrap, got: {wrapped:?}");
        for line in &wrapped {
            assert!(line.len() <= 30, "line too long: `{line}` ({} chars)", line.len());
        }
    }

    #[test]
    fn truncate_to_chars_adds_hint_when_clipping() {
        // Fits within the budget — returned unchanged.
        assert_eq!(truncate_to_chars("hi", 5), "hi");
        // Clipped — keeps `max - 1` chars and appends the ASCII `~` hint,
        // landing exactly on the budget.
        let t = truncate_to_chars("abcdefgh", 4);
        assert_eq!(t, "abc~");
        assert_eq!(t.chars().count(), 4);
        // Degenerate widths must not panic.
        assert_eq!(truncate_to_chars("abc", 0), "");
        assert_eq!(truncate_to_chars("abc", 1), "a");
    }

    #[test]
    fn wrap_text_hard_breaks_overlong_word() {
        // A single token longer than the line is chunked rather than
        // overflowing the right margin. 10 mm / 2 mm per char ≈ 5 chars.
        let wrapped = wrap_text("aaaaaaaaaaaaaaaaaaaa", 10.0, 2.0);
        assert!(wrapped.len() >= 2, "expected a hard break, got: {wrapped:?}");
        for line in &wrapped {
            assert!(line.len() <= 5, "chunk too long: `{line}`");
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
