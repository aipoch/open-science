def figure_outline_schema():
    return {"type":"object","properties":{
        "claim":{"type":"string"}, "width_mm":{"type":"number"},
        "ncol":{"type":"integer"},
        "row_heights_mm":{"type":"array","minItems":1,
                          "description":"Physical row heights in millimeters, not grid weights.",
                          "items":{"type":"number","exclusiveMinimum":0}},
        "fixed_panel_set":{"type":"boolean","description":
            "True only when the user requires the exact listed panels."},
        "panels":{"type":"array","items":{"type":"object","properties":{
            "letter":{"type":"string"},
            "role":{"type":"string","enum":["schematic","hero","primary","supporting"]},
            "message":{"type":"string"}, "chart_family":{"type":"string"},
            "data_vid":{"type":["string","null"]}, "data_desc":{"type":"string"},
            "row":{"type":"integer"}, "col":{"type":"integer"},
            "colspan":{"type":"integer"}, "rowspan":{"type":"integer"},
            "label_budget":{"type":"integer"}, "ask":{"type":"string"}},
            "required":["letter","role","message","chart_family","row","col","colspan","ask"]}}},
        "required":["claim","width_mm","ncol","row_heights_mm","panels"]}


def grid_geom(outline, dpi=300, gutter_mm=4):
    """Validate panel geometry before deriving pixel positions or writing images."""
    import math
    from numbers import Integral, Real
    for name, value in (("dpi", dpi), ("width_mm", outline["width_mm"]),
                        ("gutter_mm", gutter_mm)):
        if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
            raise ValueError(f"{name} must be a finite number")
    if dpi <= 0 or outline["width_mm"] <= 0 or gutter_mm < 0:
        raise ValueError("dpi and width_mm must be positive; gutter_mm must be nonnegative")
    ncol = outline["ncol"]
    if isinstance(ncol, bool) or not isinstance(ncol, Integral) or ncol < 1:
        raise ValueError("ncol must be a positive integer")
    heights = outline["row_heights_mm"]
    if len(heights) == 0 or any(isinstance(h, bool) or not isinstance(h, Real)
                          or not math.isfinite(h) or h <= 0 for h in heights):
        raise ValueError("row_heights_mm must contain positive finite heights")
    letters, rectangles = set(), []
    for p in outline["panels"]:
        letter = p["letter"]
        if not isinstance(letter, str) or not letter.strip() or letter != letter.strip():
            raise ValueError("Panel letters must be nonempty strings without surrounding whitespace")
        # Composition stamps either lower or upper case; avoid visually duplicate labels.
        key = letter.casefold()
        if key in letters:
            raise ValueError(f"Duplicate panel letter: {letter!r}")
        letters.add(key)
        r, c, rs, cs = p["row"], p["col"], p.get("rowspan", 1), p["colspan"]
        if any(isinstance(v, bool) or not isinstance(v, Integral) for v in (r, c, rs, cs)):
            raise ValueError("Panel row, col and spans must be integers")
        if r < 0 or c < 0 or rs < 1 or cs < 1 or r + rs > len(heights) or c + cs > ncol:
            raise ValueError(f"Panel {letter!r} is outside the grid or has an invalid span")
        for ar, ac, ars, acs in rectangles:
            if r < ar + ars and ar < r + rs and c < ac + acs and ac < c + cs:
                raise ValueError(f"Panel {letter!r} overlaps another panel")
        rectangles.append((r, c, rs, cs))
    mm = dpi/25.4
    W = int(outline["width_mm"]*mm); ncol = outline["ncol"]; g = int(gutter_mm*mm)
    colw = (W - g*(ncol-1)) // ncol
    rowh = [int(h*mm) for h in outline["row_heights_mm"]]
    if colw < 1 or any(h < 1 for h in rowh):
        raise ValueError("Grid dimensions must leave at least one pixel per row and column")
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
- Environment `figures`, Python/matplotlib. Load `figure-style`; every dependent `notebook_execute` request includes `{{"kernelSkillIds":["figure-style"],"code":"apply_figure_style()\\n..."}}`. `kernelSkillIds` contains the skill ID; call `apply_figure_style()` directly in `code` without an import or discovery step,
  then **immediately** `import matplotlib as mpl; mpl.rcParams['savefig.bbox']=None` (the style helper
  sets it to `'tight'`, which silently resizes the canvas).
- `import math; fig = plt.figure(figsize=(math.nextafter({w}/300, math.inf), math.nextafter({h}/300, math.inf)), dpi=300)`; `fig.savefig('panel_{letter}.png', dpi=300, transparent=True)`. Keep the integer pixel dimensions in these expressions: nextafter prevents floating-point truncation from losing a pixel. **No `bbox_inches='tight'`** — it changes canvas dimensions. Use `fig.subplots_adjust(...)` to arrange axes inside the fixed canvas.
- Reserve top-left ~10×6 mm clear for the composer's panel letter. Do NOT draw your own.
- **§9 Render-then-verify:** after savefig, (a) `from PIL import Image; assert
  Image.open('panel_{letter}.png').size==({w},{h})` — if not, check figsize, DPI and
  bbox settings against the expressions above; (b) collect every visible `Text`
  window_extent and assert none overlaps another, crosses a spine, or exceeds the canvas.
  Fix and re-save until both pass — do not ship a panel that fails either check.
- Design rules {rules_ref} apply in full.

Publish `panel_{letter}.png` with the Artifact writer using the exact notebook `runId` as `producerRunId`. Call `host.submitOutput({{panelVersionId: version_id, labelsUsed}})` using the returned immutable Version ID, verify `accepted: true`, and finish with an ordinary final response. The parent accepts the identity only when it matches `artifactsCreated`."""


def composition_task(outline, panel_versions, fig_label="Figure"):
    """Build a producer-child task with one validated Version per outline panel."""
    import json
    grid_geom(outline)
    expected = [panel["letter"] for panel in outline["panels"]]
    versions = {}
    for item in panel_versions:
        letter, version_id = item["letter"], item["versionId"]
        if letter not in expected or letter in versions:
            raise ValueError(f"unexpected or duplicate panel Version for {letter!r}")
        if not isinstance(version_id, str) or not version_id:
            raise ValueError(f"panel {letter!r} needs an immutable Version ID")
        versions[letter] = version_id
    if set(versions) != set(expected):
        raise ValueError("composition needs exactly one Version for every outline panel")
    ordered = [{"letter": letter, "versionId": versions[letter]} for letter in expected]
    return f"""Compose the panels into {fig_label}. You are the producer child, not the outer composer. Do not delegate or review the figure.

Outline:
```json
{json.dumps(outline, ensure_ascii=False)}
```
Ordered panel Versions:
```json
{json.dumps(ordered)}
```

1. In `repl_execute`, resolve each exact Version ID with `host.artifactPath(versionId)`. Write the outline and resolved paths as a JSON handoff under `process.env.OPEN_SCIENCE_HANDOFF_DIR`. Do not substitute filenames or search for panels.
2. In `notebook_execute`, set `kernelSkillIds: ["figure-composer"]`, read the handoff, and call `compose_figure(outline, panel_paths, 'figure.png')` directly. Set `artifactVersionInputs` to the ordered, de-duplicated panel Version IDs. Verify completion and retain the actual `runId`.
3. Publish `figure.png` with `write_artifact_file` using that `runId` as `producerRunId`.
4. Call `host.submitOutput({{compositeVersionId: version_id}})` with the writer's immutable Version ID. Verify `accepted: true`, then finish with an ordinary final response.

Publish exactly one `figure.png`. Never use a pending Version or path as an `artifactVersionInputs` value."""


def compose_crops(outline, dpi=300, gutter_mm=4, pad_px=4):
    """Return top-left-origin pixel crop boxes for the composed PNG."""
    from numbers import Integral
    if isinstance(pad_px, bool) or not isinstance(pad_px, Integral) or pad_px < 0:
        raise ValueError("pad_px must be a nonnegative integer")
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
            if source.size != (w,h):
                raise ValueError(f"Panel {L!r} has size {source.size}; expected {(w,h)}. Regenerate it at the required dimensions.")
            im = source.convert("RGBA")
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


def composite_review_task(composite_vid, outline, rules_vid=None, prev_vid=None):
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
                  if rules_vid else "**Additional design rules:** none.")
    panel_set_line = ("The user requires exactly these panels; do not propose adding, removing, "
                      "merging, or renaming them."
                      if outline.get("fixed_panel_set") else
                      "Suggest panel-set changes only when the claim needs them.")
    return f"""You are an adversarial journal production editor reviewing a COMPOSED multi-panel figure.
Review at TWO levels:

1. **Outline level** (`outline_revisions`): the layout, grid, panel set, title strategy.
   - §3.5 Fill the box: any panel with >25% dead whitespace, or whose natural aspect doesn't
     fit its slot → propose rowspan/colspan/row_heights change.
   - §2.4 Titles: any title that fails the "read it aloud cold" test (cryptic noun fragments),
     or a small-multiple row that should have ONE row-header instead of per-panel titles.
   - Panel set: anything that doesn't earn its space, or a missing panel the claim needs. {panel_set_line}
2. **Panel level** (`violations`): legibility and text collisions, mark identity,
   color and legend binding, panel letters and seams, data fidelity, and regressions.

## Figure
**Composite:** `{{{{artifact:{composite_vid}}}}}`
{rules_line}{prev_line}

**Claim:** {outline['claim']}

**Outline** ({outline['ncol']}-col grid, row heights {outline['row_heights_mm']} mm):
{panel_tbl}

**Panel data Artifacts:**
{data_tbl}

## Method
Environment `figures`. Load `figure-style` for its full review rules. Inspect the
full composite and crop panels where detail is
ambiguous. For panels with data, spot-check plotted values against the source data.
Report every real finding; zero findings is valid. Do not manufacture findings.
Submit one object satisfying the output schema with `host.submitOutput(review)`,
verify `accepted: true`, and finish with an ordinary final response."""


def apply_outline_revisions(outline, revisions, previous_outline=None, dpi=300, gutter_mm=4):
    """Return surviving panels requiring regeneration after explicit outline edits.

    Pass the pre-edit outline to include new panels and shared geometry changes.
    The two-argument form retains declaration-only scope for existing callers.
    """
    current = {p["letter"] for p in outline["panels"]}
    affected = set()
    for r in revisions:
        affected |= set(r.get("affected_panels", []))
    if previous_outline is not None:
        previous = {p["letter"] for p in previous_outline["panels"]}
        for letter in current:
            if letter not in previous or panel_px(outline, letter, dpi, gutter_mm) != panel_px(
                    previous_outline, letter, dpi, gutter_mm):
                affected.add(letter)
    return affected & current
