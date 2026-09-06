def figure_outline_schema():
    return {"type":"object","properties":{
        "claim":{"type":"string"},
        "width_mm":{"type":"number","exclusiveMinimum":0,
                    "description":"Final figure width in physical millimeters."},
        "ncol":{"type":"integer","minimum":1,
                "description":"Number of grid columns; panel col indices are zero-based."},
        "row_heights_mm":{"type":"array","minItems":1,
                          "description":"Physical height of each grid row in millimeters, not weights or row indices (for example [38.0] for compact schematics).",
                          "items":{"type":"number","exclusiveMinimum":0}},
        "fixed_panel_set":{"type":"boolean",
                           "description":"True only when the user explicitly requires the exact listed panel set; reviewers must not add, remove, or merge panels."},
        "panels":{"type":"array","items":{"type":"object","properties":{
            "letter":{"type":"string"},
            "role":{"type":"string","enum":["schematic","hero","primary","supporting"]},
            "message":{"type":"string"}, "chart_family":{"type":"string"},
            "data_vid":{"type":["string","null"]}, "data_desc":{"type":"string"},
            "row":{"type":"integer","minimum":0,
                   "description":"Zero-based row index into row_heights_mm."},
            "col":{"type":"integer","minimum":0,
                   "description":"Zero-based grid-column index."},
            "colspan":{"type":"integer","minimum":1},
            "rowspan":{"type":"integer","minimum":1},
            "label_budget":{"type":"integer"}, "ask":{"type":"string"}},
            "required":["letter","role","message","chart_family","row","col","colspan","ask"]}}},
        "required":["claim","width_mm","ncol","row_heights_mm","panels"]}


def _validate_outline(outline, dpi=300, gutter_mm=4):
    """Reject invalid grid geometry with actionable errors before pixel arithmetic."""
    width = outline.get("width_mm")
    ncol = outline.get("ncol")
    row_heights = outline.get("row_heights_mm")
    if not isinstance(width, (int, float)) or width <= 0:
        raise ValueError("width_mm must be a positive physical width in millimeters")
    if not isinstance(ncol, int) or isinstance(ncol, bool) or ncol < 1:
        raise ValueError("ncol must be a positive integer")
    if not isinstance(row_heights, list) or not row_heights:
        raise ValueError("row_heights_mm must contain at least one physical height in millimeters")
    if any(not isinstance(height, (int, float)) or height <= 0 for height in row_heights):
        raise ValueError("every row_heights_mm entry must be a positive physical millimeter value")

    mm = dpi / 25.4
    gutter_px = int(gutter_mm * mm)
    width_px = int(width * mm)
    if (width_px - gutter_px * (ncol - 1)) // ncol < 1:
        raise ValueError("width_mm is too small for ncol and gutter_mm")

    panels = outline.get("panels")
    if not isinstance(panels, list) or not panels:
        raise ValueError("panels must contain at least one panel")
    letters = [panel.get("letter") for panel in panels if isinstance(panel, dict)]
    if len(letters) != len(panels) or len(set(letters)) != len(letters):
        raise ValueError("every panel must have a unique letter")
    for panel in panels:
        letter = panel["letter"]
        row, col = panel.get("row"), panel.get("col")
        rowspan, colspan = panel.get("rowspan", 1), panel.get("colspan")
        if not isinstance(row, int) or isinstance(row, bool) or not 0 <= row < len(row_heights):
            raise ValueError(
                f"panel {letter} row must be a zero-based index in 0..{len(row_heights)-1}"
            )
        if not isinstance(col, int) or isinstance(col, bool) or not 0 <= col < ncol:
            raise ValueError(f"panel {letter} col must be a zero-based index in 0..{ncol-1}")
        if not isinstance(rowspan, int) or isinstance(rowspan, bool) or rowspan < 1:
            raise ValueError(f"panel {letter} rowspan must be a positive integer")
        if not isinstance(colspan, int) or isinstance(colspan, bool) or colspan < 1:
            raise ValueError(f"panel {letter} colspan must be a positive integer")
        if row + rowspan > len(row_heights):
            raise ValueError(f"panel {letter} rowspan exceeds row_heights_mm")
        if col + colspan > ncol:
            raise ValueError(f"panel {letter} colspan exceeds ncol")


def grid_geom(outline, dpi=300, gutter_mm=4):
    _validate_outline(outline, dpi, gutter_mm)
    mm = dpi/25.4
    W = int(outline["width_mm"]*mm); ncol = outline["ncol"]; g = int(gutter_mm*mm)
    colw = (W - g*(ncol-1)) // ncol
    rowh = [int(h*mm) for h in outline["row_heights_mm"]]
    row_y = [sum(rowh[:i]) + g*i for i in range(len(rowh))]
    return W, ncol, colw, rowh, row_y, g


def panel_px(outline, letter, dpi=300, gutter_mm=4):
    W, ncol, colw, rowh, row_y, g = grid_geom(outline, dpi, gutter_mm)
    p = next(q for q in outline["panels"] if q["letter"]==letter)
    cs, rs, r = p["colspan"], p.get("rowspan",1), p["row"]
    return colw*cs + g*(cs-1), sum(rowh[r:r+rs]) + g*(rs-1)


def panel_xy(outline, letter, dpi=300, gutter_mm=4):
    W, ncol, colw, rowh, row_y, g = grid_geom(outline, dpi, gutter_mm)
    p = next(q for q in outline["panels"] if q["letter"]==letter)
    return p["col"]*(colw+g), row_y[p["row"]]


def panel_task(outline, letter, fig_label="Figure"):
    p = next(q for q in outline["panels"] if q["letter"]==letter)
    w,h = panel_px(outline, letter)
    neighbours = ", ".join(f"{q['letter']}={q['role']}:{q['chart_family']}"
                           for q in outline["panels"] if q["letter"]!=letter)
    data_line = (f"**Data:** `{{{{artifact:{p['data_vid']}}}}}` — {p.get('data_desc','')}"
                 if p.get("data_vid") else "**Data:** none (schematic).")
    rowmates = [q["letter"] for q in outline["panels"]
                if q["row"]==p["row"] and q["letter"]!=letter and q.get("rowspan",1)==p.get("rowspan",1)]
    share_line = (f"- **Row-mates: {','.join(rowmates)}** — match y-limits if same metric; series identity "
                  f"labeled ONCE on the row (rightmost panel).") if rowmates else ""
    bud = p.get("label_budget", 4)
    return f"""Produce panel **{letter}** of {fig_label}. You are one of {len(outline['panels'])} parallel panel-makers; the composer tiles results on a {outline['ncol']}-column grid.

This task is self-contained. Do not search for, load, or read any `SKILL.md`; the exact rendering contract and helper call are below.

## Figure narrative (the one sentence this whole figure makes true)
> {outline['claim']}

Neighbors: {neighbours}

## Your panel
- **role:** {p['role']} · **chart family:** {p['chart_family']}
- **message:** {p['message']}
- **what to show:** {p['ask']}
{data_line}
{share_line}

## §2 Label discipline — ceiling AND floor
- **Floor (§2.1, non-negotiable):** every distinct mark, series, glyph, comparator
  is IDENTIFIABLE from this panel alone. Identity labels (what it is) do NOT count
  against the budget and are never removed. Comparator labels must be self-
  explanatory ("prior method", "ablation" — never "previous"/"old"/"v1").
- **Ceiling:** ≤{bud} *narrative* annotations (callouts, value labels, brackets,
  arrows) beyond title/axis/tick labels and identity labels.
- n=, held-fixed, footnotes, code expansions, exclusion rationale → CAPTION.
- Title is a standalone-parseable takeaway (read-aloud-cold test). Small-multiple
  rows: ONE row-header; per-subplot identity = x-axis label.
- One direction arrow per ROW (leftmost margin).

## §3.5 Fill the box
- Box is **{w}×{h} px (aspect {w/h:.2f})**. Data envelope must occupy ≥75% of it.
  Set `fig.subplots_adjust(...)` so the axes fill the box minus labels; do not center
  a small plot in a large canvas.

## Hard rendering constraints
- Environment `figures`, Python/matplotlib. Every dependent `notebook_execute` request includes `{{"kernelSkillIds":["figure-style"],"code":"apply_figure_style()\\n..."}}`. `kernelSkillIds` injects the registered helper; call `apply_figure_style()` directly in `code` without an import, Skill load, or discovery step,
  then **immediately** `import matplotlib as mpl; mpl.rcParams['savefig.bbox']=None` (the style helper
  sets it to `'tight'`, which silently resizes the canvas).
- `fig = plt.figure(figsize=({w}/300,{h}/300), dpi=300)`; keep the exact pixel-ratio expressions rather than rounded decimal inches. `fig.savefig('panel_{letter}.png', dpi=300, transparent=True)`. **No `bbox_inches='tight'`, no `plt.tight_layout()`, no `constrained_layout`** — they change pixel dimensions. Use `fig.subplots_adjust(...)` only.
- Reserve top-left ~10×6 mm clear for the composer's panel letter. Do NOT draw your own.
- **Bounded render verification:** use at most two `notebook_execute` calls total for this panel.
  The first call renders, saves, and runs every check below in one cell. Only if a check fails,
  use one second call for the targeted correction, re-save, and final checks. Do not use
  intermediate diagnostic notebook calls. Save once in the first call, then (a) `from PIL import Image; assert
  Image.open('panel_{letter}.png').size==({w},{h})` — if not, you used tight_layout/
  constrained_layout/bbox-tight somewhere, undo it; (b) collect every visible `Text`
  window_extent and assert none overlaps another, crosses a spine, or exceeds the canvas.
  If either check fails, make one targeted correction and re-save once. Do not start an
  open-ended visual QA loop; fail clearly if the corrected panel still violates the checks.
- Do not call `host.viewImage`, `view_image`, or any other image-view tool. The bounded
  programmatic checks above are the complete panel QA; the independent reviewer owns visual QA.
- Fixed style checklist: identifiable marks, ≤{bud} narrative annotations, standalone title,
  readable labels, ≥75% data-envelope fill, reserved letter corner, and exact pixel size.

Publish `panel_{letter}.png` with the Artifact writer using the exact notebook `runId` as `producerRunId`. Then call `await host.submitOutput({{ panelVersionId: version_id, labelsUsed }})` with the writer's returned immutable `version_id`, confirm it returned `accepted: true`, and finish normally. Do not merely print the JSON in the final answer. The parent accepts the identity only when it matches `artifactsCreated`."""


def composition_task(outline, panel_versions, fig_label="Figure"):
    """Build the non-delegating composition child's exact task."""
    import json
    ordered = []
    by_letter = {item["letter"]: item["versionId"] for item in panel_versions}
    for panel in outline["panels"]:
        letter = panel["letter"]
        if letter not in by_letter:
            raise ValueError(f"missing panel Version for {letter}")
        ordered.append({"letter": letter, "versionId": by_letter[letter]})
    return f"""Compose the finalized panel Artifacts into `{fig_label}`. This is a producer task, not the outer composer: do not call `host.delegate`.

Use this exact outline:
```json
{json.dumps(outline, indent=2)}
```

Use these ordered, immutable panel Versions:
```json
{json.dumps(ordered, indent=2)}
```

1. In `repl_execute`, resolve each Version with `host.artifactPath(versionId)`. Write a small JSON manifest containing the outline and resolved paths under `process.env.OPEN_SCIENCE_HANDOFF_DIR`.
2. In one Python `notebook_execute`, set `kernelSkillIds` to `["figure-composer"]`, read that manifest, and call `compose_figure(outline, panel_paths, 'figure.png', letter_case='upper')` directly without importing or discovering it. Pass the ordered, de-duplicated Version IDs as `artifactVersionInputs`. Verify the run completed and retain its exact `runId`.
3. Publish `figure.png` with `write_artifact_file`, using that exact `runId` as `producerRunId`.
4. Call `host.submitOutput({{compositeVersionId}})` with the returned Artifact `version_id`, then finish normally.

The task is self-contained. Do not search for, load, or read any `SKILL.md`, and do not perform panel-level style review or pixel-by-pixel QA. The parent owns review. The parent accepts the composite identity only when it matches the exact `figure.png` entry in `artifactsCreated`."""


def compose_crops(outline, dpi=300, gutter_mm=4, pad_px=4):
    """Return top-left-origin pixel crop boxes for the composed PNG."""
    W, ncol, colw, rowh, row_y, g = grid_geom(outline, dpi, gutter_mm)
    H = row_y[-1] + rowh[-1]
    out = {}
    for p in outline["panels"]:
        L = p["letter"]
        w, h = panel_px(outline, L, dpi, gutter_mm)
        x, y = panel_xy(outline, L, dpi, gutter_mm)
        out[L] = (max(x - pad_px, 0), max(y - pad_px, 0),
                  min(x + w + pad_px, W), min(y + h + pad_px, H))
    return out


def compose_figure(outline, panel_paths, out_path, dpi=300, gutter_mm=4,
                   letter_font="DejaVuSans-Bold.ttf", letter_pt=9, letter_case="lower"):
    from PIL import Image, ImageDraw, ImageFont
    W, ncol, colw, rowh, row_y, g = grid_geom(outline, dpi, gutter_mm)
    H = row_y[-1] + rowh[-1]
    canvas = Image.new("RGB",(W,H),"white"); draw = ImageDraw.Draw(canvas)
    try: ft = ImageFont.truetype(letter_font, int(letter_pt/72*dpi))
    except Exception: ft = ImageFont.load_default()
    for p in outline["panels"]:
        L = p["letter"]; w,h = panel_px(outline,L,dpi,gutter_mm); x,y = panel_xy(outline,L,dpi,gutter_mm)
        im = Image.open(panel_paths[L]).convert("RGBA")
        if im.size != (w,h): im = im.resize((w,h))
        canvas.paste(im,(x,y),im)
        stamp = L.lower() if letter_case == "lower" else L.upper()
        draw.text((x+int(1.5/25.4*dpi), y+int(1/25.4*dpi)), stamp, fill="black", font=ft)
    canvas.save(out_path); return out_path,(W,H)


def group_fixes_by_panel(review):
    out = {}
    for v in review.get("violations",[]):
        if v.get("severity") not in ("BLOCKER","MAJOR"): continue
        L = v.get("panel_letter") or (v.get("location"," ")+" ")[0]
        out.setdefault(L,[]).append(
            f"- **[{v['severity']}]** ({v.get('rule_ref','')}, {v.get('location','')}) "
            f"{v.get('finding','')} **Fix:** {v.get('fix','')}")
    return {k:"\n".join(v) for k,v in out.items()}


def review_schema(per_panel=True):
    """Adversarial composite-review schema with outline- and panel-level feedback."""
    v_props = {"severity":{"type":"string","enum":["BLOCKER","MAJOR","MINOR"]},
               "rule_ref":{"type":"string"},"location":{"type":"string"},
               "finding":{"type":"string"},"fix":{"type":"string"}}
    if per_panel: v_props["panel_letter"]={"type":"string"}
    return {"type":"object","properties":{
        "editor_verdict":{"type":"string",
            "enum":["accept","minor_revision","major_revision","reject"]},
        "outline_revisions":{"type":"array","description":
            "Figure-level changes that no single panel can fix in isolation: grid geometry "
            "(rowspan/colspan/row_heights), panel add/remove/merge, row-header vs per-panel "
            "titles, label_budget reallocation, whitespace fill (§3.5).",
            "items":{"type":"object","properties":{
                "kind":{"type":"string","enum":["geometry","titles","panel_set","label_budget","other"]},
                "affected_panels":{"type":"array","items":{"type":"string"}},
                "finding":{"type":"string"},"revision":{"type":"string"}},
                "required":["kind","affected_panels","finding","revision"]}},
        "violations":{"type":"array","items":{"type":"object","properties":v_props,
            "required":list(v_props)}},
        "regression_vs_prev":{"type":"array","items":{"type":"string"}},
        "strongest_aspect":{"type":"string"}},
        "required":["editor_verdict","outline_revisions","violations","strongest_aspect"]}


def composite_review_task(composite_vid, outline, rules_vid=None, prev_vid=None, round_no=1):
    """Build the adversarial reviewer's task string for the composed figure."""
    panel_tbl = "\n".join(
        f"  {p['letter']}: {p['role']:<10} row{p['row']}+{p.get('rowspan',1)} col{p['col']}+{p['colspan']} "
        f"— {p['chart_family']} — \"{p['message']}\""
        for p in outline["panels"])
    data_tbl = "\n".join(
        f"  {p['letter']}: `{{{{artifact:{p['data_vid']}}}}}`"
        for p in outline["panels"] if p.get("data_vid")) or "  none (all panels are schematic)"
    prev_line = (f"\n**Previous version** (for `regression_vs_prev`): `{{{{artifact:{prev_vid}}}}}`"
                 if prev_vid else "")
    rules_line = (f"**Additional design rules:** `{{{{artifact:{rules_vid}}}}}`"
                  if rules_vid else "**Additional design rules:** none; use the fixed rubric below.")
    panel_set_line = (
        "**Panel-set constraint:** The user explicitly requires exactly the listed panels. "
        "Do not propose adding, removing, merging, or renaming panels; solve real issues within "
        "that fixed set."
        if outline.get("fixed_panel_set") else
        "**Panel-set constraint:** none; panel-set revisions are allowed when they materially improve the claim."
    )
    return f"""You are an adversarial journal production editor reviewing a COMPOSED multi-panel figure.
This task is self-contained. Do not search for, load, or read any `SKILL.md`.
Review at TWO levels:

1. **Outline level** (`outline_revisions`): the layout, grid, panel set, title strategy.
   - §3.5 Fill the box: any panel with >25% dead whitespace, or whose natural aspect doesn't
     fit its slot → propose rowspan/colspan/row_heights change.
   - §2.4 Titles: any title that fails the "read it aloud cold" test (cryptic noun fragments),
     or a small-multiple row that should have ONE row-header instead of per-panel titles.
   - Panel set: anything that doesn't earn its space, or a missing panel the claim needs.
2. **Panel level** (`violations`): check these fixed categories, scoped to one panel:
   legibility and text collisions; mark/series identity; color and legend binding;
   panel-letter/gutter seams; data fidelity; and regressions from the previous version.

## Figure
**Composite:** `{{{{artifact:{composite_vid}}}}}`
{rules_line}{prev_line}
{panel_set_line}

**Claim:** {outline['claim']}

**Outline** ({outline['ncol']}-col grid, row heights {outline['row_heights_mm']} mm):
{panel_tbl}

**Panel data Artifacts:**
{data_tbl}

## Method
Environment `figures`. Resolve the composite once with `await host.artifactPath("{composite_vid}")`;
do not search the filesystem or list directories to locate it. Make at most **two image-view calls total**: exactly one full-composite
view, plus at most one crop only when that full view exposes one specific ambiguous region.
Never create or view per-panel zooms, strips, multiple crops, or pixel-sampling diagnostics; do
not inspect every panel separately. One full view is sufficient when no region is ambiguous.
For panels with data, spot-check one or two plotted values against the CSV without creating
additional image views. Check every rubric category and report every real finding. Always return an empty `violations` array when none exists.
There is no violation quota and no reason to manufacture findings. Build one object that satisfies the delegated output schema, call
`await host.submitOutput(review)` with that object, confirm it returned `accepted: true`, and finish
only after the submission is accepted.
Do not merely print or return the JSON as terminal text."""


def apply_outline_revisions(outline, revisions):
    """Return panel letters affected by outline-level revisions."""
    affected = set()
    for r in revisions:
        affected |= set(r.get("affected_panels", []))
    return affected
