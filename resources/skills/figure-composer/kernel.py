def figure_outline_schema():
    panel = {"type":"object","additionalProperties":False,"properties":{
        "letter":{"type":"string","pattern":"^[A-Za-z]$"},
        "role":{"type":"string","enum":["schematic","hero","primary","supporting"]},
        "message":{"type":"string","minLength":1},
        "chart_family":{"type":"string","minLength":1},
        "data_vid":{"type":["string","null"]}, "data_desc":{"type":"string"},
        "row":{"type":"integer","minimum":0}, "col":{"type":"integer","minimum":0},
        "colspan":{"type":"integer","minimum":1},
        "rowspan":{"type":"integer","minimum":1},
        "label_budget":{"type":"integer","minimum":0},
        "ask":{"type":"string","minLength":1}},
        "required":["letter","role","message","chart_family","row","col","colspan","ask"],
        "allOf":[{"if":{"properties":{"role":{"not":{"const":"schematic"}}},
                          "required":["role"]},
                  "then":{"required":["data_vid"],
                          "properties":{"data_vid":{"type":"string","minLength":1}}}}]}
    return {"type":"object","additionalProperties":False,"properties":{
        "claim":{"type":"string","minLength":1},
        "width_mm":{"type":"number","exclusiveMinimum":0},
        "ncol":{"type":"integer","minimum":1},
        "row_heights_mm":{"type":"array","minItems":1,
                          "items":{"type":"number","exclusiveMinimum":0}},
        "panels":{"type":"array","minItems":1,"items":panel}},
        "required":["claim","width_mm","ncol","row_heights_mm","panels"]}


def validate_figure_outline(outline):
    """Reject cross-field grid/provenance errors that plain JSON Schema cannot express."""
    ncol = outline["ncol"]
    nrow = len(outline["row_heights_mm"])
    if (outline["width_mm"] <= 0 or ncol < 1 or nrow < 1
            or any(height <= 0 for height in outline["row_heights_mm"])):
        raise ValueError("figure outline requires positive width and at least one positive row/column")
    if not outline["panels"]:
        raise ValueError("figure outline requires at least one panel")
    letters = set()
    occupied = set()
    for panel in outline["panels"]:
        letter = panel["letter"]
        if len(letter) != 1 or not letter.isascii() or not letter.isalpha():
            raise ValueError("panel letter must be one ASCII letter")
        letter_key = letter.lower()
        if letter_key in letters:
            raise ValueError(f"duplicate panel letter: {letter}")
        letters.add(letter_key)
        row, col = panel["row"], panel["col"]
        rowspan, colspan = panel.get("rowspan", 1), panel["colspan"]
        if row < 0 or col < 0 or rowspan < 1 or colspan < 1:
            raise ValueError(f"panel {letter} has invalid row/column/span values")
        if row + rowspan > nrow or col + colspan > ncol:
            raise ValueError(f"panel {letter} extends outside the declared grid")
        if panel["role"] != "schematic" and not panel.get("data_vid"):
            raise ValueError(f"panel {letter} role {panel['role']} requires data_vid")
        cells = {(r, c) for r in range(row, row + rowspan)
                 for c in range(col, col + colspan)}
        if occupied & cells:
            raise ValueError(f"panel {letter} overlaps another panel")
        occupied |= cells
    return outline


def grid_geom(outline, dpi=300, gutter_mm=4):
    validate_figure_outline(outline)
    mm = dpi/25.4
    W = int(outline["width_mm"]*mm); ncol = outline["ncol"]; g = int(gutter_mm*mm)
    colw = (W - g*(ncol-1)) // ncol
    rowh = [int(h*mm) for h in outline["row_heights_mm"]]
    if W <= 0 or colw <= 0 or any(height <= 0 for height in rowh):
        raise ValueError("figure outline produces a non-positive pixel dimension")
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


def panel_task(outline, letter, fig_label="Figure", rules_ref="(load `figure-style`)"):
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
- Environment `figures`, Python/matplotlib. Load `figure-style`; in your own producer request declare `helperModules: ["figure-style"]`, then call `apply_figure_style()`,
  then **immediately** `import matplotlib as mpl; mpl.rcParams['savefig.bbox']=None` (the style helper
  sets it to `'tight'`, which silently resizes the canvas).
- `fig = plt.figure(figsize=({w/300:.3f},{h/300:.3f}), dpi=300)`; `fig.savefig('panel_{letter}.png', dpi=300, transparent=True)`. **No `bbox_inches='tight'`, no `plt.tight_layout()`, no `constrained_layout`** — they change pixel dimensions. Use `fig.subplots_adjust(...)` only.
- Reserve top-left ~10×6 mm clear for the composer's panel letter. Do NOT draw your own.
- **§9 Render-then-verify:** after savefig, (a) `from PIL import Image; assert
  Image.open('panel_{letter}.png').size==({w},{h})` — if not, you used tight_layout/
  constrained_layout/bbox-tight somewhere, undo it; (b) collect every visible `Text`
  window_extent and assert none overlaps another, crosses a spine, or exceeds the canvas.
  Fix and re-save until both pass — do not ship a panel that fails either check.
- Design rules {rules_ref} apply in full.

Publish `panel_{letter}.png` with the Artifact writer using the exact notebook `runId` as `producerRunId`; submit its returned `panelVersionId` plus `labelsUsed`. The parent accepts the identity only when it matches `artifactsCreated`."""


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
        with Image.open(panel_paths[L]) as source:
            im = source.convert("RGBA")
        if im.size != (w,h):
            raise ValueError(f"panel {L} has size {im.size}; expected {(w, h)}")
        canvas.paste(im,(x,y),im)
        stamp = L.lower() if letter_case == "lower" else L.upper()
        draw.text((x+int(1.5/25.4*dpi), y+int(1/25.4*dpi)), stamp, fill="black", font=ft)
    canvas.save(out_path, dpi=(dpi, dpi)); return out_path,(W,H)


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


def composite_review_task(composite_vid, outline, rules_vid, prev_vid=None, round_no=1, min_floor=None):
    panel_tbl = "\n".join(
        f"  {p['letter']}: {p['role']:<10} row{p['row']}+{p.get('rowspan',1)} col{p['col']}+{p['colspan']} "
        f"— {p['chart_family']} — \"{p['message']}\""
        for p in outline["panels"])
    data_tbl = "\n".join(
        f"  {p['letter']}: `{{{{artifact:{p['data_vid']}}}}}`"
        for p in outline["panels"] if p.get("data_vid")) or "  none (all panels are schematic)"
    checks = min_floor if min_floor is not None else max(3, 6 - round_no)
    prev_line = (f"\n**Previous version** (for `regression_vs_prev`): `{{{{artifact:{prev_vid}}}}}`"
                 if prev_vid else "")
    return f"""You are an adversarial journal production editor reviewing a COMPOSED multi-panel figure.
Review at TWO levels:

1. **Outline level** (`outline_revisions`): the layout, grid, panel set, title strategy.
   - §3.5 Fill the box: any panel with >25% dead whitespace, or whose natural aspect doesn't
     fit its slot → propose rowspan/colspan/row_heights change.
   - §2.4 Titles: any title that fails the "read it aloud cold" test (cryptic noun fragments),
     or a small-multiple row that should have ONE row-header instead of per-panel titles.
   - Panel set: anything that doesn't earn its space, or a missing panel the claim needs.
2. **Panel level** (`violations`): everything the design rules cover, scoped to one panel.

## Figure
**Composite:** `{{{{artifact:{composite_vid}}}}}`
**Design rules:** `{{{{artifact:{rules_vid}}}}}`{prev_line}

**Claim:** {outline['claim']}

**Outline** ({outline['ncol']}-col grid, row heights {outline['row_heights_mm']} mm):
{panel_tbl}

**Panel data Artifacts:**
{data_tbl}

## Method
Environment `figures`. Render the composite at full size, then inspect each panel crop from
the outline geometry. For panels with data, spot-check 2–3 plotted values against the CSV.
Inspect at least {checks} independent rule areas in round {round_no}. Report every observed
violation, but zero violations is valid; never manufacture findings. Return ONLY structured output."""


def apply_outline_revisions(outline, revisions):
    affected = set()
    for revision in revisions:
        affected |= set(revision.get("affected_panels", []))
    return affected
