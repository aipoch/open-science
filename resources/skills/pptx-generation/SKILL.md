---
name: pptx-generation
description: Use when creating a PowerPoint .pptx slide deck or presentation, turning analysis results, figures, or a literature review into slides, or reading, editing, or filling a template for an existing .pptx/.potx. Covers python-pptx in the Notebook, slide design rules, native charts, speaker notes, CJK fonts, layout QA without an Office engine, preview limits, and Artifact delivery.
license: Apache-2.0
---

# PPTX creation, editing, and QA

Build decks with python-pptx in the Notebook. User requirements for content, template, brand, and design take precedence over the defaults below.

| Task                           | Approach                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Create a new deck              | `Presentation()` with a 16:9 size, Blank layout, shapes placed explicitly                                 |
| Fill a template or edit a deck | `Presentation("inputs/template.pptx")`, reuse its layouts, replace run text                               |
| Read content                   | `pptx_outline(path)`; no code is needed to summarize an attached deck if `read_document` already shows it |

## Setup

Run all deck code with `notebook_execute`, not the shell. Install `python-pptx` and `pillow` with `manage_packages` if `inspect_packages` does not show them; never run `pip` in a cell. Attached files are under `inputs/` relative to the Notebook working directory. Write the deck to the working directory, never over an input and never into this skill's directory.

The registered helpers are injected with `kernelSkillIds`. Call them directly without importing, and repeat `kernelSkillIds` in every cell that uses them:

```json
{
  "kernelSkillIds": ["pptx-generation"],
  "code": "report = lint_pptx('deck.pptx')\nprint(report['ok'], report['issues'][:20])"
}
```

| Helper                                                                    | Purpose                                                                                                                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pptx_outline(path)`                                                      | Per-slide layout, title, text blocks, notes, picture/chart/table counts                                                                                   |
| `lint_pptx(path, *, margin_in=0.4, min_font_pt=10)`                       | Off-slide shapes, estimated text overflow, leftover placeholder text, edge margins, overlapping text boxes, empty placeholders, small or unreliable fonts |
| `place_picture(slide, path, left, top, width, height, *, align="center")` | Insert a PNG/JPEG fitted inside a box (inches) without distortion                                                                                         |
| `set_run_fonts(run, *, latin=None, east_asian=None)`                      | Set Latin and East Asian typefaces; `run.font.name` alone does not affect Chinese text                                                                    |
| `render_pptx_pages(path, out_dir="pptx-pages")`                           | Slide PNGs through LibreOffice when the user has it installed; otherwise returns `available: False`                                                       |

## Creating a deck with python-pptx

```python
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

INK, ACCENT, MUTED = RGBColor.from_string("1E2761"), RGBColor.from_string("F96167"), RGBColor.from_string("6B7280")
deck = Presentation()
deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)   # 16:9
BLANK = deck.slide_layouts[6]

def text(slide, x, y, w, h, value, size, *, bold=False, color=INK, align=PP_ALIGN.LEFT):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = box.text_frame
    frame.word_wrap = True
    frame.vertical_anchor = MSO_ANCHOR.TOP
    for i, line in enumerate(value if isinstance(value, list) else [value]):
        paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        paragraph.alignment = align
        paragraph.space_after = Pt(6)
        run = paragraph.add_run()
        run.text = line
        run.font.size, run.font.bold, run.font.color.rgb = Pt(size), bold, color
        set_run_fonts(run, latin="Calibri", east_asian="Microsoft YaHei")
    return box

slide = deck.slides.add_slide(BLANK)
text(slide, 0.6, 0.5, 12.1, 1.0, "Treatment B halves relapse at 12 months", 36, bold=True)
data = CategoryChartData()
data.categories = ["Placebo", "A", "B"]
data.add_series("Relapse (%)", (41, 33, 19))
chart = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.6), Inches(1.8),
                               Inches(7.4), Inches(4.6), data).chart
chart.has_legend = False
chart.plots[0].has_data_labels = True
chart.plots[0].data_labels.font.size = Pt(14)
chart.series[0].format.fill.solid()
chart.series[0].format.fill.fore_color.rgb = ACCENT
chart.value_axis.has_major_gridlines = False
text(slide, 8.4, 1.8, 4.3, 3.0, ["n = 412, randomized", "Follow-up 12 months", "HR 0.46 (95% CI 0.31-0.68)"], 16)
text(slide, 0.6, 6.6, 12.1, 0.4, "Source: trial export inputs/relapse.csv (n = 412)", 10, color=MUTED)
slide.notes_slide.notes_text_frame.text = "Spoken explanation goes here, not on the slide."
deck.save("deck.pptx")
```

python-pptx rules that prevent common defects:

- **Set the slide size before adding slides.** `Presentation()` defaults to 4:3 (10" × 7.5"). Use 13.333" × 7.5" for 16:9 unless the user or template says otherwise. Coordinates past the edge are saved as given; nothing clamps them.
- **Colors are `RGBColor.from_string("1E2761")`**: six hex digits, no `#`. Transparency is not exposed by the API; avoid designs that need it.
- **`text_frame.text = ...` and `shape.text = ...` replace every paragraph with a single unformatted run.** On templates and styled boxes, set `run.text` on the existing runs instead, and add paragraphs with `add_paragraph()` that copy the sibling's formatting.
- **One paragraph per list item.** Never join items with `\n` inside one run, and never type a literal `•`. Bullets come from the layout's placeholder; plain text boxes have no bullets, so use a body placeholder or short separate lines.
- **Text boxes do not shrink or grow when generated.** `auto_size` and `normAutofit` are applied by PowerPoint only after the user edits the text, and the Open Science preview renders the stored box. Size boxes for their content and run `lint_pptx`.
- **Text box padding** is 0.1" left/right and 0.05" top/bottom. Set `frame.margin_left = 0` (and the others) when text must align with a shape edge at the same x.
- **CJK text:** call `set_run_fonts(run, latin=..., east_asian=...)` for every run that can contain Chinese, Japanese, or Korean. Microsoft YaHei ships with Office on Windows and macOS; PingFang SC exists only on macOS.
- **Keep charts native** with `add_chart` and `CategoryChartData`/`XyChartData` for bar, column, line, pie, doughnut, area, scatter, and radar data, so the user can edit them. Set data labels, series colors from the palette, no legend for one series, and quiet gridlines. Use an image only for plots that PowerPoint cannot draw natively (heatmaps, violin plots, networks, statistical figures from `figure-style`).
- **Figures** from `figure-style` or `figure-composer` are PNGs; insert them with `place_picture` so the aspect ratio is kept. Make the figure readable at slide scale: at least 14 pt equivalent labels, which usually means re-rendering the figure at the slide box size rather than shrinking a journal figure.
- **python-pptx cannot duplicate a slide, open SVG/EMF images, or delete a slide through the public API.** Plan the slide sequence from layouts. To delete slide `i`: `sld = deck.slides._sldIdLst[i]; deck.part.drop_rel(sld.rId); deck.slides._sldIdLst.remove(sld)`. To reorder, move the `sldId` elements in `deck.slides._sldIdLst`.
- **Speaker notes** go in `slide.notes_slide.notes_text_frame`, never in a text box on the slide.
- **Equations:** OMML equations are not supported by the preview and python-pptx cannot write them. Render an equation with matplotlib mathtext to a transparent PNG and place it as a picture, or write it inline as plain text.

## Design

- **One message per slide.** For research decks, write the slide title as the claim ("Treatment B halves relapse at 12 months"), and let the chart or figure be the evidence. Put the source in a 10-12 pt caption on the same slide, with a DOI link when one exists (`run.hyperlink.address`). Never invent a citation.
- **Pick a palette for this topic**: one dominant color (60-70% visual weight), one or two supporting tones, one sharp accent. Use dark title and closing slides with light content slides, or commit to one background throughout. Examples: Midnight `1E2761`/`CADCFC`/`FFFFFF`, Forest `2C5F2D`/`97BC62`/`F5F5F5`, Coral `F96167`/`F9E795`/`2F3C7E`, Terracotta `B85042`/`E7E8D1`/`A7BEAE`, Ocean `065A82`/`1C7293`/`21295C`, Charcoal `36454F`/`F2F2F2`/`212121`, Teal `028090`/`00A896`/`02C39A`, Berry `6D2E46`/`A26769`/`ECE2D0`. Use the user's brand or template colors when given.
- **Every slide needs a visual element**: chart, figure, image, icon, table, or a large stat callout (60-72 pt number with a small label). Vary layouts: two columns, a 2×2 grid, comparison columns, a timeline or process flow, a half-bleed image.
- **Typography**: Calibri, Arial, Cambria, Times New Roman, Courier New, Bookman Old Style, and Century Schoolbook render with predictable widths. A serif title (Cambria) with a sans body (Calibri) gives contrast safely. Never default to Aptos; it is missing from older Office versions. Use Georgia, Garamond, Trebuchet MS, or Impact only when asked, and leave about 10% extra space in those boxes.

| Element              | Size                  |
| -------------------- | --------------------- |
| Slide title          | 36-44 pt bold         |
| Section header       | 20-24 pt bold         |
| Body text            | 14-16 pt              |
| Captions and sources | 10-12 pt, muted color |

- **Spacing**: at least 0.5" from slide edges, and one consistent gap of 0.3" or 0.5" between blocks.
- **Avoid**: repeating one layout on every slide, centered body text, text-only title-and-bullets slides, low contrast (light text on light backgrounds), cream or beige default backgrounds when no palette was given, text that overflows its box, accent lines under titles, and decorative color bars or edge stripes on slides and cards. Those last two read as generated filler; use whitespace, a background tint, or an icon instead.

## Editing existing decks and templates

1. Call `pptx_outline("inputs/template.pptx")` and map each section of the content onto a slide or layout. Use varied layouts.
2. Do structural work first (adding slides from layouts, deleting, reordering), then edit content.
3. Replace text run by run to keep formatting. Keep one `<a:p>` per list item, and let bullets inherit from the layout.
4. **Template slots are not content items.** If the template shows four team members and you have three, delete the fourth member's whole group (picture and text boxes), not just its text.
5. To reuse a template image or icon, use a layout that contains it. python-pptx cannot copy pictures between slides with their relationships.
6. Save under a new name, keep `.potx` output only when the user asked for a template, and run QA on the result.

Legacy `.ppt` files need conversion by the user (python-pptx reads only `.pptx`/`.potx`); say so instead of guessing their content.

## QA (required)

Your first build usually has a few real issues. Find and fix them in the generator code, rebuild, and stop when the checks pass.

1. **Content:** `pptx_outline("deck.pptx")`. Check for missing content, wrong order, typos, and empty notes where notes were requested.
2. **Layout:** `lint_pptx("deck.pptx")`. Fix every `error` (off_slide, text_overflow, placeholder_text) and review each warning. Overflow is estimated from average glyph widths: when a box is near the limit, enlarge it, reduce the text, or split the slide. `assumed_size: true` means the size is inherited from the layout; set it explicitly to get a reliable estimate.
3. **Visual:** call `render_pptx_pages("deck.pptx", "qa/deck")`. If it returns `available: true`, view the slide PNGs in a foreground `repl_execute` with `await host.viewImage({ path: "qa/deck/slide-001.png" })`, at most four per invocation. If the path is rejected, publish the PNG with `write_artifact_file` and view it by `versionId`. Look for text cut off or overflowing, overlapping elements, captions colliding with content, uneven gaps, margins under 0.5", misaligned columns, low contrast, and leftover template decoration. If it returns `available: false`, LibreOffice is not installed. Rely on steps 1-2 and tell the user the deck was checked programmatically, not visually.

## Open Science preview limits

The in-app preview (desktop only, files up to 40 MiB) redraws native charts with its own engine and does not embed fonts. It supports bar, column, line, area, pie, doughnut, radar, scatter, bubble, and stock charts. It does not show 3D charts, animations and transitions, OMML equations, shadows and glow, SmartArt, EMF/WMF images, or embedded OLE objects. Avoid those features, or tell the user that the preview will differ from PowerPoint.

## Artifact delivery

Pass the deck's local path to `write_artifact_file` with `mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"` and the exact execution `runId` as `producerRunId`. Do not publish QA PNGs unless the user asks or you needed one for `viewImage`. Claim the deck is available only after the Artifact tool succeeds, then end the reply with `- [deck.pptx](deck.pptx) — one-line description`.
