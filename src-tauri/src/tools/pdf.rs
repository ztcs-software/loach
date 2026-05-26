//! Built-in `pdf` tool — generate PDFs from a structured spec.
//!
//! Two actions live behind this single tool (mirroring `json_tool`'s
//! op-enum pattern):
//!
//!   * `create` — builds a PDF from a model-supplied page/block spec
//!     (headings, paragraphs, bullet / numbered lists, horizontal rules,
//!     page breaks, tables). The result is returned as an [`Attachment`]
//!     that the chat-stream layer appends to the assistant message; the
//!     existing `PdfPreview` component then renders it inline.
//!
//!   * `merge` — concatenates existing PDF attachments. Stubbed for v1:
//!     the model would need to reference attachments by name, which
//!     requires a name → bytes resolver we haven't plumbed through
//!     yet. Returns a structured `not yet supported` error so the model
//!     can self-correct and fall back to `create`.
//!
//! ASCII-only by design (v1): printpdf's built-in Helvetica is a base-14
//! font with no Unicode coverage. Non-ASCII characters in the spec are
//! replaced with `?` before render so the file stays valid. Bundling a
//! Unicode TTF (Liberation Sans / DejaVu) is the natural v2 upgrade but
//! adds ~700 KB to the binary and a font-loading code path; deferred
//! until someone asks for it.

use base64::Engine;
use printpdf::{BuiltinFont, IndirectFontRef, Mm, PdfDocument, PdfDocumentReference, PdfLayerReference};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp::{Attachment, McpCallResult};

pub const TOOL_NAME: &str = "pdf";

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
/// Conservative per-character width estimate for Helvetica at body size,
/// in mm. Real Helvetica is proportional (each glyph has its own width)
/// so this slightly under-fills lines — that's the right side to err on
/// because over-estimating would let lines overflow the right margin.
const BODY_CHAR_WIDTH_MM: f32 = 2.0;

/// Spec ceiling. A single PDF spec beyond ~256 KiB is almost certainly a
/// runaway prompt — Helvetica-rendered text at 11 pt fits about 4000
/// characters per A4 page, and a structured spec is denser than that.
const MAX_SPEC_BYTES: usize = 256 * 1024;
/// Per-action page ceiling — bounds rasterisation cost on the receiving
/// pdfjs viewer if a model decides to ask for 10 000 pages of bullet
/// lists. 200 pages is well past any real chat use.
const MAX_PAGES: usize = 200;

pub fn tool_description() -> &'static str {
    "Create a PDF from a structured spec, or merge existing PDF \
     attachments. Use this to produce a downloadable document instead of \
     a long markdown block in chat — the user gets a real file they can \
     save, print, or forward. \
     Actions: \
     `create` — render `pages: [{blocks: [...]}]` to a PDF. Block types: \
     `heading` (with `level` 1–3 and `text`), \
     `paragraph` (with `text` — word-wrapped at the right margin), \
     `bullet_list` (with `items: [string]`), \
     `numbered_list` (with `items: [string]`), \
     `horizontal_rule` (no fields), \
     `page_break` (force the next block onto a new page), \
     `table` (with `headers: [string]` and `rows: [[string]]` — equal \
     column widths, no cell-wrap so keep cells short). \
     `merge` — concatenate existing PDF attachments by `attachment_names`. \
     **Currently returns a not-yet-supported error** in this build; use \
     `create` instead. \
     `title` is optional and becomes the filename (sanitised). \
     ASCII-only: non-ASCII characters are replaced with `?` because the \
     built-in font has no Unicode coverage."
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
                "enum": ["create", "merge"],
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
            },
            "attachment_names": {
                "type": "array",
                "description": "For `merge`. Names of PDF attachments already in the conversation to concatenate in order.",
                "items": { "type": "string" }
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
        None => return err("missing required `action` argument — use \"create\" or \"merge\""),
    };
    match action {
        "create" => do_create(args),
        "merge" => err(
            "merge action is not yet supported in this build — it requires a \
             name → bytes attachment resolver that hasn't been plumbed through \
             the chat stream yet. Use `create` to produce a new PDF instead."
        ),
        other => err(format!("unknown action `{other}` — use \"create\" or \"merge\"")),
    }
}

fn do_create(args: &Value) -> McpCallResult {
    let title_raw = args
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("document");
    let title = sanitise_text(title_raw);
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
    let bytes = match render_document(&title, &pages) {
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

/// Carries the mutable cursor state across blocks. printpdf doesn't have
/// a concept of "current layer / y position" — the caller threads them.
struct RenderState<'doc> {
    doc: &'doc PdfDocumentReference,
    font: IndirectFontRef,
    bold: IndirectFontRef,
    /// Current page's layer reference. Each page gets a fresh layer
    /// because printpdf scopes drawing calls to a layer handle.
    layer: PdfLayerReference,
    /// Y cursor in mm from the bottom of the page (printpdf's origin).
    cursor_y_mm: f32,
}

impl<'doc> RenderState<'doc> {
    fn new_page(&mut self, layer: PdfLayerReference) {
        self.layer = layer;
        self.cursor_y_mm = PAGE_HEIGHT_MM - MARGIN_MM;
    }

    /// Reserve `space_mm` of vertical room. If the cursor would go below
    /// the bottom margin, flow to a new page.
    fn ensure_room(&mut self, space_mm: f32) {
        if self.cursor_y_mm - space_mm < MARGIN_MM {
            let (page, layer) = self.doc.add_page(
                Mm(PAGE_WIDTH_MM),
                Mm(PAGE_HEIGHT_MM),
                "Layer 1",
            );
            let new_layer = self.doc.get_page(page).get_layer(layer);
            self.new_page(new_layer);
        }
    }

    fn advance(&mut self, dy_mm: f32) {
        self.cursor_y_mm -= dy_mm;
    }
}

fn render_document(title: &str, pages: &[PageSpec]) -> Result<Vec<u8>, String> {
    let (doc, first_page, first_layer) =
        PdfDocument::new(title, Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), "Layer 1");
    let font = doc
        .add_builtin_font(BuiltinFont::Helvetica)
        .map_err(|e| format!("Helvetica load failed: {e}"))?;
    let bold = doc
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .map_err(|e| format!("Helvetica-Bold load failed: {e}"))?;
    let mut state = RenderState {
        doc: &doc,
        font,
        bold,
        layer: doc.get_page(first_page).get_layer(first_layer),
        cursor_y_mm: PAGE_HEIGHT_MM - MARGIN_MM,
    };

    for (page_idx, page) in pages.iter().enumerate() {
        // Spec'd page boundaries always force a new physical page after
        // the first — the first page already exists from `PdfDocument::new`.
        if page_idx > 0 {
            let (p, l) = doc.add_page(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), "Layer 1");
            let new_layer = doc.get_page(p).get_layer(l);
            state.new_page(new_layer);
        }
        for block in &page.blocks {
            render_block(&mut state, block)?;
        }
    }

    doc.save_to_bytes()
        .map_err(|e| format!("save_to_bytes failed: {e}"))
}

fn render_block(state: &mut RenderState, block: &Block) -> Result<(), String> {
    match block {
        Block::Heading { level, text } => render_heading(state, *level, text),
        Block::Paragraph { text } => render_paragraph(state, text),
        Block::BulletList { items } => render_list(state, items, ListStyle::Bullet),
        Block::NumberedList { items } => render_list(state, items, ListStyle::Numbered),
        Block::HorizontalRule => render_hr(state),
        Block::PageBreak => {
            let (p, l) = state
                .doc
                .add_page(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), "Layer 1");
            let new_layer = state.doc.get_page(p).get_layer(l);
            state.new_page(new_layer);
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
    state.ensure_room(line_mm);
    let cleaned = sanitise_text(text);
    state.layer.use_text(
        cleaned,
        size_pt,
        Mm(MARGIN_MM),
        Mm(state.cursor_y_mm - pt_to_mm(size_pt)),
        &state.bold,
    );
    state.advance(line_mm);
    Ok(())
}

fn render_paragraph(state: &mut RenderState, text: &str) -> Result<(), String> {
    let lines = wrap_text(text, body_width_mm(), BODY_CHAR_WIDTH_MM);
    for line in lines {
        state.ensure_room(BODY_LINE_HEIGHT_MM);
        state.layer.use_text(
            line,
            BODY_FONT_SIZE_PT,
            Mm(MARGIN_MM),
            Mm(state.cursor_y_mm - pt_to_mm(BODY_FONT_SIZE_PT)),
            &state.font,
        );
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
            // ordering. ASCII-only constraint means we always use `1.`
            // style rather than `①` or similar.
            ListStyle::Numbered => format!("{}.", i + 1),
        };
        let marker = sanitise_text(&marker);
        let lines = wrap_text(item, wrap_width_mm, BODY_CHAR_WIDTH_MM);
        for (line_idx, line) in lines.iter().enumerate() {
            state.ensure_room(BODY_LINE_HEIGHT_MM);
            // Marker only on the first wrapped line; continuation lines
            // align under the text column.
            if line_idx == 0 {
                state.layer.use_text(
                    &marker,
                    BODY_FONT_SIZE_PT,
                    Mm(bullet_col_mm),
                    Mm(state.cursor_y_mm - pt_to_mm(BODY_FONT_SIZE_PT)),
                    &state.font,
                );
            }
            state.layer.use_text(
                line,
                BODY_FONT_SIZE_PT,
                Mm(text_col_mm),
                Mm(state.cursor_y_mm - pt_to_mm(BODY_FONT_SIZE_PT)),
                &state.font,
            );
            state.advance(BODY_LINE_HEIGHT_MM);
        }
    }
    state.advance(BODY_LINE_HEIGHT_MM * 0.4);
    Ok(())
}

fn render_hr(state: &mut RenderState) -> Result<(), String> {
    use printpdf::{Line, Point};
    let pad_mm = BODY_LINE_HEIGHT_MM * 0.5;
    state.advance(pad_mm);
    state.ensure_room(0.5);
    let y_mm = state.cursor_y_mm;
    let line = Line {
        points: vec![
            (Point::new(Mm(MARGIN_MM), Mm(y_mm)), false),
            (Point::new(Mm(PAGE_WIDTH_MM - MARGIN_MM), Mm(y_mm)), false),
        ],
        is_closed: false,
    };
    state.layer.add_line(line);
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
    if !headers.is_empty() {
        state.ensure_room(row_height_mm);
        render_table_row(state, headers, cols, col_width_mm, cell_pad_mm, row_height_mm, true);
    }
    for row in rows {
        state.ensure_room(row_height_mm);
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
    use printpdf::{Line, Point};
    let top_y = state.cursor_y_mm;
    let bottom_y = top_y - row_height_mm;
    // Horizontal border lines (top + bottom of this row).
    for y in [top_y, bottom_y] {
        let line = Line {
            points: vec![
                (Point::new(Mm(MARGIN_MM), Mm(y)), false),
                (Point::new(Mm(PAGE_WIDTH_MM - MARGIN_MM), Mm(y)), false),
            ],
            is_closed: false,
        };
        state.layer.add_line(line);
    }
    // Cell text + vertical borders.
    for col in 0..cols {
        let x = MARGIN_MM + col as f32 * col_width_mm;
        // Vertical border at the left of each column.
        let line = Line {
            points: vec![
                (Point::new(Mm(x), Mm(top_y)), false),
                (Point::new(Mm(x), Mm(bottom_y)), false),
            ],
            is_closed: false,
        };
        state.layer.add_line(line);
        // Cell text — truncated to col width (no wrap inside cells).
        let raw = cells.get(col).map(String::as_str).unwrap_or("");
        let max_chars = ((col_width_mm - cell_pad_mm * 2.0_f32) / BODY_CHAR_WIDTH_MM).floor() as usize;
        let text = truncate_to_chars(&sanitise_text(raw), max_chars);
        let text_y = top_y - cell_pad_mm - pt_to_mm(BODY_FONT_SIZE_PT);
        let font = if bold { &state.bold } else { &state.font };
        state
            .layer
            .use_text(text, BODY_FONT_SIZE_PT, Mm(x + cell_pad_mm), Mm(text_y), font);
    }
    // Right border of the rightmost column.
    let right_x = PAGE_WIDTH_MM - MARGIN_MM;
    let line = Line {
        points: vec![
            (Point::new(Mm(right_x), Mm(top_y)), false),
            (Point::new(Mm(right_x), Mm(bottom_y)), false),
        ],
        is_closed: false,
    };
    state.layer.add_line(line);
    state.advance(row_height_mm);
}

// ---------- helpers ----------

/// Replace non-ASCII characters with `?` so printpdf's built-in fonts
/// (which have no Unicode glyphs) emit a valid PDF. The model is told
/// about this limitation in the tool description.
fn sanitise_text(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii() { c } else { '?' })
        .collect()
}

/// Greedy word wrap based on a fixed per-character width estimate. Real
/// Helvetica is proportional, so this is conservative — lines will
/// under-fill rather than overflow.
fn wrap_text(text: &str, width_mm: f32, char_width_mm: f32) -> Vec<String> {
    let cleaned = sanitise_text(text);
    let max_chars = (width_mm / char_width_mm).floor() as usize;
    if max_chars == 0 {
        return vec![cleaned];
    }
    let mut out: Vec<String> = Vec::new();
    for paragraph in cleaned.split('\n') {
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
    // Take max - 1 chars and append `…` ... wait, that's non-ASCII.
    // Use `~` as the ellipsis hint since we're ASCII-only.
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
    fn merge_returns_not_supported() {
        let r = dispatch(&json!({ "action": "merge", "attachment_names": ["a.pdf"] }));
        assert!(r.is_error);
        assert!(
            r.content_text.contains("not yet supported"),
            "got: {}",
            r.content_text
        );
    }

    #[test]
    fn unknown_action_errors() {
        let r = dispatch(&json!({ "action": "convert" }));
        assert!(r.is_error);
        assert!(r.content_text.contains("unknown action"));
    }

    #[test]
    fn sanitise_replaces_non_ascii() {
        // `d` is ASCII and survives; the three Polish glyphs become `?`.
        assert_eq!(sanitise_text("Łódź"), "??d?");
        assert_eq!(sanitise_text("plain ascii"), "plain ascii");
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
}
