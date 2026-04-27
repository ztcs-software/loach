"""Build the Loach UX Enhancements PDF.

Outputs to ../Loach-UX-Enhancements.pdf relative to this file.
"""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


# ---------------------------------------------------------------------------
# Output path
# ---------------------------------------------------------------------------

OUT = Path(__file__).resolve().parent.parent / "Loach-UX-Enhancements.pdf"


# ---------------------------------------------------------------------------
# Palette — picked to feel like Loach's dark glass UI without printing dark
# (PDFs read best on light paper).
# ---------------------------------------------------------------------------

INK = colors.HexColor("#1a1a1f")          # body text
INK_SOFT = colors.HexColor("#5b5b65")     # secondary
RULE = colors.HexColor("#dcdce2")         # hairline separators
ACCENT = colors.HexColor("#d97706")       # Loach orange
TILE_BG = colors.HexColor("#f6f6f8")      # callout backgrounds
TILE_BORDER = colors.HexColor("#e5e5ea")


# ---------------------------------------------------------------------------
# Styles
# ---------------------------------------------------------------------------

base = getSampleStyleSheet()

styles = {
    "h1": ParagraphStyle(
        "h1",
        parent=base["Title"],
        fontName="Helvetica-Bold",
        fontSize=28,
        leading=34,
        textColor=INK,
        alignment=TA_LEFT,
        spaceAfter=4,
    ),
    "subtitle": ParagraphStyle(
        "subtitle",
        parent=base["Normal"],
        fontName="Helvetica",
        fontSize=12,
        leading=16,
        textColor=INK_SOFT,
        spaceAfter=18,
    ),
    "h2": ParagraphStyle(
        "h2",
        parent=base["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=16,
        leading=20,
        textColor=INK,
        spaceBefore=18,
        spaceAfter=6,
    ),
    "h3": ParagraphStyle(
        "h3",
        parent=base["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=16,
        textColor=ACCENT,
        spaceBefore=10,
        spaceAfter=4,
    ),
    "body": ParagraphStyle(
        "body",
        parent=base["BodyText"],
        fontName="Helvetica",
        fontSize=10.5,
        leading=15,
        textColor=INK,
        spaceAfter=6,
    ),
    "small": ParagraphStyle(
        "small",
        parent=base["BodyText"],
        fontName="Helvetica",
        fontSize=9,
        leading=12,
        textColor=INK_SOFT,
        spaceAfter=4,
    ),
    "code": ParagraphStyle(
        "code",
        parent=base["Code"],
        fontName="Courier",
        fontSize=8.5,
        leading=11,
        textColor=INK,
        backColor=TILE_BG,
        borderPadding=6,
        leftIndent=0,
        rightIndent=0,
        spaceAfter=8,
    ),
    "label": ParagraphStyle(
        "label",
        parent=base["Normal"],
        fontName="Helvetica-Bold",
        fontSize=8,
        leading=10,
        textColor=ACCENT,
        spaceAfter=2,
    ),
    "tile_title": ParagraphStyle(
        "tile_title",
        parent=base["Normal"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=14,
        textColor=INK,
        spaceAfter=4,
    ),
    "tile_body": ParagraphStyle(
        "tile_body",
        parent=base["Normal"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=13,
        textColor=INK,
    ),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def hr(color=RULE, thickness=0.5):
    return HRFlowable(
        width="100%",
        thickness=thickness,
        color=color,
        spaceBefore=2,
        spaceAfter=8,
    )


def bullets(items, style_key="body"):
    return ListFlowable(
        [ListItem(Paragraph(text, styles[style_key]), leftIndent=10) for text in items],
        bulletType="bullet",
        bulletFontName="Helvetica",
        bulletFontSize=8,
        leftIndent=14,
        bulletColor=ACCENT,
    )


def callout(label, body):
    """Soft tinted box used for 'Before' / 'After' framing."""
    inner = [
        Paragraph(label.upper(), styles["label"]),
        Paragraph(body, styles["tile_body"]),
    ]
    t = Table(
        [[inner]],
        colWidths=[3.0 * inch],
    )
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), TILE_BG),
                ("BOX", (0, 0), (-1, -1), 0.4, TILE_BORDER),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return t


def before_after(before_text, after_text):
    """Two callouts side by side."""
    cells = [[callout("Before", before_text), callout("After", after_text)]]
    t = Table(cells, colWidths=[3.25 * inch, 3.25 * inch])
    t.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, 0), 6),
                ("LEFTPADDING", (1, 0), (1, 0), 6),
                ("RIGHTPADDING", (1, 0), (-1, -1), 0),
            ]
        )
    )
    return t


def files_table(rows):
    """A small table for 'Files touched' summaries."""
    header = [
        Paragraph("<b>File</b>", styles["small"]),
        Paragraph("<b>Change</b>", styles["small"]),
    ]
    data = [header] + [
        [Paragraph(f"<font face='Courier' size='8.5'>{path}</font>", styles["small"]),
         Paragraph(change, styles["small"])]
        for path, change in rows
    ]
    t = Table(data, colWidths=[2.4 * inch, 4.1 * inch])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), TILE_BG),
                ("LINEBELOW", (0, 0), (-1, 0), 0.4, TILE_BORDER),
                ("LINEBELOW", (0, -1), (-1, -1), 0.4, TILE_BORDER),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fafafb")]),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return t


# ---------------------------------------------------------------------------
# Page furniture (header rule + footer page numbers)
# ---------------------------------------------------------------------------


def on_page(canvas, doc):
    canvas.saveState()

    # Top brand strip
    canvas.setFillColor(ACCENT)
    canvas.rect(0, LETTER[1] - 8, LETTER[0], 8, stroke=0, fill=1)

    # Footer rule + page number
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.4)
    canvas.line(0.75 * inch, 0.55 * inch, LETTER[0] - 0.75 * inch, 0.55 * inch)

    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(INK_SOFT)
    canvas.drawString(0.75 * inch, 0.38 * inch, "Loach — UI/UX Enhancement Proposals")
    canvas.drawRightString(
        LETTER[0] - 0.75 * inch,
        0.38 * inch,
        f"Page {doc.page}",
    )
    canvas.restoreState()


# ---------------------------------------------------------------------------
# Story
# ---------------------------------------------------------------------------


def build_story():
    s = []

    # ---- Cover ----------------------------------------------------------
    s.append(Spacer(1, 0.2 * inch))
    s.append(Paragraph("Loach", styles["h1"]))
    s.append(Paragraph(
        "UI / UX Enhancement Proposals",
        ParagraphStyle(
            "cover_sub",
            parent=styles["subtitle"],
            fontSize=16,
            leading=20,
            textColor=ACCENT,
            spaceAfter=4,
        ),
    ))
    s.append(Paragraph(
        "Sidebar libraries, navigation hygiene, and visual polish",
        styles["subtitle"],
    ))
    s.append(hr(thickness=1, color=ACCENT))

    s.append(Paragraph("Summary", styles["h2"]))
    s.append(Paragraph(
        "This document captures the UX enhancements applied to the Loach native chat client. "
        "Each proposal is framed as <b>Problem &rarr; Solution &rarr; Outcome</b>, with the "
        "concrete files touched listed at the end of every section so the change is easy to "
        "audit.",
        styles["body"],
    ))
    s.append(Paragraph(
        "Five themes run through the work:",
        styles["body"],
    ))
    s.append(bullets([
        "<b>Surface the action.</b> Replace dense vertical lists with tile galleries that put the dominant verb (Run, Open) one click away.",
        "<b>Make every control meaningful.</b> Move the sidebar collapse toggle into the panel it actually affects, and only show its inverse on the rail when there is something to expand into.",
        "<b>Keep navigation honest.</b> Switching tabs should never strand the user on an unrelated screen — clear override views (Space detail, Model detail) on tab change.",
        "<b>Land the user where the work happens.</b> Running a snippet from the library should drop you on the chat canvas, not leave you on the library tab with no chat in sight.",
        "<b>Quiet visual polish.</b> Compact relative timestamps, footer alignment via flex spacers, and reserved layout slots so controls don't make sibling elements jump.",
    ]))
    s.append(Spacer(1, 0.2 * inch))

    s.append(PageBreak())

    # ---- 1. Library tile redesign --------------------------------------
    s.append(Paragraph("1. Spaces & Snippets as tile galleries", styles["h2"]))
    s.append(hr())

    s.append(Paragraph("Problem", styles["h3"]))
    s.append(Paragraph(
        "Spaces and Snippets were rendered as vertical lists nested inside the left sidebar. "
        "Two problems followed: the dominant action for a snippet (start a chat with this prompt) "
        "was buried in a row hover state, and the list pattern carried no room for the metadata "
        "that makes a saved prompt or a project space useful at a glance — model pin, chat "
        "count, last-edited time, instructions presence.",
        styles["body"],
    ))

    s.append(Paragraph("Solution", styles["h3"]))
    s.append(Paragraph(
        "Promote both surfaces to <b>full-canvas tile galleries</b>. The sidebar collapses to its "
        "icon rail when either tab is active, so the gallery is the only thing competing for "
        "attention. Each tile carries:",
        styles["body"],
    ))
    s.append(bullets([
        "<b>Snippet tile.</b> Title, 4-line prompt preview (fenced, monospace-feeling so it reads as a template), pinned model chip in the footer, primary <b>Run</b> button on the right, &lsquo;&middot;&middot;&middot;&rsquo; menu for Edit / Delete.",
        "<b>Space tile.</b> Title, 3-line description, footer with live chat count, an &lsquo;Instructions&rsquo; badge when custom instructions exist, relative updated time, and an outlined <b>Open &rarr;</b> action.",
        "Search bar (filters across title / body / model), empty state with a CTA, sorted by <code>updated_at</code> descending so freshly used items surface first.",
        "Footer pinned to the bottom via a <code>flex-1</code> spacer so action buttons line up across rows even when previews vary in length.",
    ]))

    s.append(Paragraph("Why this works", styles["h3"]))
    s.append(before_after(
        "Snippets / Spaces lived as cramped rows in a 280-px sidebar column. The Run button "
        "only appeared on hover, metadata was clipped, and the layout couldn't grow with the "
        "user's library.",
        "A 2 / 3-column responsive grid (<code>sm:grid-cols-2 xl:grid-cols-3</code>) gives each "
        "item room to breathe, surfaces the primary verb without hover, and shows useful "
        "metadata directly on the tile."
    ))

    s.append(Paragraph("Run-snippet flow", styles["h3"]))
    s.append(Paragraph(
        "Hitting <b>Run</b> from a snippet tile must land the user on the chat canvas, not "
        "leave them looking at the library they just left. The handler explicitly clears any "
        "Space-detail override, switches the sidebar tab back to <code>chats</code>, opens a "
        "new session (honoring the snippet's pinned model when present), then primes the "
        "composer with the snippet text.",
        styles["body"],
    ))
    s.append(Paragraph(
        "<font face='Courier' size='8.5'>"
        "setViewingSpace(null);<br/>"
        "setSidebarTab(&quot;chats&quot;);<br/>"
        "await newSession({ spaceId: null, provider: snippet.provider, model: snippet.model });<br/>"
        "primeComposer(snippet.prompt, []);"
        "</font>",
        styles["code"],
    ))

    s.append(Paragraph("Files touched", styles["h3"]))
    s.append(files_table([
        ("src/components/SnippetsLibrary.tsx", "New &mdash; full-canvas grid, search, empty state, SnippetCard with Run / Edit / Delete."),
        ("src/components/SpacesLibrary.tsx", "New &mdash; mirrors SnippetsLibrary; SpaceCard with chat-count + instructions badge + Open &rarr;."),
        ("src/App.tsx", "Routing precedence: viewingSpaceId &rarr; SpaceView, viewingModel &rarr; ModelsView, sidebarTab &rarr; library, else chat."),
        ("src/components/Sidebar.tsx", "Collapse to icon rail when on a library tab; remove dead SpacesPanel / SnippetsPanel row components."),
        ("src/lib/utils.ts", "Add <code>relativeTime()</code> for compact tile timestamps (just now / Xm / Xh / Xd / Xw / Xmo / Xy)."),
    ]))

    s.append(PageBreak())

    # ---- 2. Sidebar collapse control ------------------------------------
    s.append(Paragraph("2. Move the sidebar collapse toggle where it has effect", styles["h2"]))
    s.append(hr())

    s.append(Paragraph("Problem", styles["h3"]))
    s.append(Paragraph(
        "After collapsing the sidebar to its icon rail on Spaces / Snippets tabs, the rail's "
        "&ldquo;collapse vertical list&rdquo; toggle no longer had anything to collapse &mdash; "
        "it sat there as a dead control. Worse, on tabs where it <i>did</i> work (Chats, Models), "
        "users learned to look for it on the rail; moving them between tabs broke that "
        "expectation.",
        styles["body"],
    ))

    s.append(Paragraph("Solution", styles["h3"]))
    s.append(Paragraph(
        "Two coordinated moves:",
        styles["body"],
    ))
    s.append(bullets([
        "<b>On the rail:</b> the expand toggle only renders when the sidebar is collapsed <i>and</i> the active tab actually has a panel to expand into (Chats or Models). A reserved <code>h-9</code> spacer keeps the tab list from jumping when the toggle appears or disappears.",
        "<b>In the panel header:</b> a new optional <code>onCollapse</code> prop on <code>PanelHeader</code> renders a <code>PanelLeftClose</code> button on the leading edge. ChatsPanel and ModelsPanel pass <code>useUIStore((s) =&gt; s.toggleSidebar)</code> through, so the collapse control sits inside the thing it collapses.",
    ]))

    s.append(Paragraph("Why this works", styles["h3"]))
    s.append(before_after(
        "The toggle lived on the icon rail and was always visible, even on tabs where it did "
        "nothing. Users either learned to ignore a non-functional control or got confused when "
        "clicks had no effect.",
        "Collapse control lives <i>inside</i> the panel it affects (Chats or Models). Expand "
        "control appears on the rail only when there is a panel to expand back into. Every "
        "click now changes something visible."
    ))

    s.append(Paragraph("Affordance signature", styles["h3"]))
    s.append(Paragraph(
        "Both rail and panel buttons use the matching lucide-react glyph pair "
        "<code>PanelLeftOpen</code> / <code>PanelLeftClose</code>, same size (h-4), same "
        "muted-on-rest, foreground-on-hover treatment &mdash; so users see them as the same "
        "control viewed from two sides.",
        styles["body"],
    ))

    s.append(Paragraph("Files touched", styles["h3"]))
    s.append(files_table([
        ("src/components/Sidebar.tsx",
         "IconRail conditionally renders expand toggle (<code>collapsed &amp;&amp; tabHasPanel</code>); "
         "PanelHeader gains <code>onCollapse?</code> prop; ChatsPanel + ModelsPanel wire <code>toggleSidebar</code> through."),
    ]))

    s.append(Spacer(1, 0.2 * inch))

    # ---- 3. Navigation hygiene ------------------------------------------
    s.append(Paragraph("3. Tab switches clear override views", styles["h2"]))
    s.append(hr())

    s.append(Paragraph("Problem", styles["h3"]))
    s.append(Paragraph(
        "App-level routing in <code>App.tsx</code> follows a precedence chain: <code>viewingSpaceId</code> "
        "wins, then <code>viewingModel</code>, then <code>sidebarTab</code>. That precedence "
        "meant a user viewing a Space or a Model could click a sidebar tab (Spaces, Snippets, "
        "Chats) and see no change &mdash; the override view kept winning.",
        styles["body"],
    ))

    s.append(Paragraph("Solution", styles["h3"]))
    s.append(Paragraph(
        "<code>handleSelectTab</code> in the sidebar always clears <code>viewingSpaceId</code>, "
        "and clears <code>viewingModel</code> unless the user is selecting the Models tab "
        "(where the detail view is the natural destination). Result: every tab click "
        "changes the canvas predictably.",
        styles["body"],
    ))
    s.append(Paragraph(
        "<font face='Courier' size='8.5'>"
        "const handleSelectTab = (tab: SidebarTab) =&gt; {<br/>"
        "&nbsp;&nbsp;setViewingSpace(null);<br/>"
        "&nbsp;&nbsp;if (tab !== &quot;models&quot;) setViewingModel(null);<br/>"
        "&nbsp;&nbsp;setSidebarTab(tab);<br/>"
        "};"
        "</font>",
        styles["code"],
    ))

    s.append(PageBreak())

    # ---- 4. Visual polish ----------------------------------------------
    s.append(Paragraph("4. Visual polish details", styles["h2"]))
    s.append(hr())

    s.append(Paragraph("Compact relative timestamps", styles["h3"]))
    s.append(Paragraph(
        "Tile footers can't afford to wrap. <code>relativeTime()</code> in <code>lib/utils.ts</code> "
        "buckets durations into one of seven short labels &mdash; <i>just now</i>, <code>3m ago</code>, "
        "<code>2h ago</code>, <code>5d ago</code>, <code>3w ago</code>, <code>2mo ago</code>, "
        "<code>1y ago</code> &mdash; so the metadata row stays on a single line on every tile size.",
        styles["body"],
    ))

    s.append(Paragraph("Footer alignment", styles["h3"]))
    s.append(Paragraph(
        "Snippet prompts and Space descriptions vary wildly in length. A <code>flex-1</code> spacer "
        "between body and footer in each card guarantees the action button (Run / Open) sits at "
        "the same Y across every tile in a row &mdash; the eye scans a clean horizontal line of "
        "primary actions instead of a ragged staircase.",
        styles["body"],
    ))

    s.append(Paragraph("Reserved layout slots", styles["h3"]))
    s.append(Paragraph(
        "The icon rail's expand toggle appears and disappears across tabs. Without a reserved "
        "slot the entire tab column would jump up by one row each time. A fixed <code>h-9</code> "
        "spacer at the top of the rail eats that variance &mdash; the toggle fades in and out, "
        "the tabs never move.",
        styles["body"],
    ))

    s.append(Paragraph("Action hierarchy on tiles", styles["h3"]))
    s.append(Paragraph(
        "Snippet's <b>Run</b> uses the primary (filled) button variant; Space's <b>Open</b> uses "
        "the outline variant. The visual weight reflects the verb's commitment level &mdash; <i>Run</i> "
        "starts a streaming generation and is the snippet library's whole reason to exist; "
        "<i>Open</i> just navigates.",
        styles["body"],
    ))

    s.append(Paragraph("Empty states", styles["h3"]))
    s.append(Paragraph(
        "Both libraries share the same dashed-border, centered empty card &mdash; oversized "
        "rounded-square icon, short headline, supportive line, single CTA. Mirroring the shape "
        "across surfaces makes the two libraries feel like the same place in two outfits.",
        styles["body"],
    ))

    s.append(Spacer(1, 0.15 * inch))

    # ---- 5. Closing -----------------------------------------------------
    s.append(Paragraph("5. Verification", styles["h2"]))
    s.append(hr())
    s.append(Paragraph(
        "Manual checks performed end-to-end:",
        styles["body"],
    ))
    s.append(bullets([
        "Snippets tab opens the gallery; Run on any tile creates a new chat with the prompt pre-filled in the composer.",
        "Spaces tab opens the gallery; Open on a tile drops into the Space's detail view with chat history and reference files.",
        "Sidebar collapse button on the Chats / Models panel header collapses to the rail; rail's expand button restores the panel.",
        "On Spaces / Snippets tabs the rail shows no expand button (there's no panel to expand into) but the tab list still doesn't jump.",
        "Switching from a Space-detail view to any other sidebar tab actually changes the canvas.",
        "tsc and Vite build remain clean.",
    ]))

    s.append(Spacer(1, 0.25 * inch))
    s.append(hr(color=ACCENT, thickness=1))
    s.append(Paragraph(
        "<i>Document generated as part of the Loach UI/UX iteration. See "
        "<code>CLAUDE.md</code> for the project conventions referenced throughout.</i>",
        styles["small"],
    ))

    return s


def main():
    doc = SimpleDocTemplate(
        str(OUT),
        pagesize=LETTER,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title="Loach — UI/UX Enhancement Proposals",
        author="Loach",
    )
    doc.build(build_story(), onFirstPage=on_page, onLaterPages=on_page)
    print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
