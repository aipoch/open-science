# Phase 1 — Meta initialization

**When:** first phase, or `waypoints/meta.json` doesn't exist.

## Objective

Resolve indication identity and gather basic context.
This is the foundation for all subsequent phases.

## Actions

**Step 1: Setup**
```bash
mkdir -p "<workdir>/waypoints"
```

**Step 2: Resolve indication identity**
- WebSearch for the indication name to confirm:
  - Standard clinical definition (if one exists)
  - ICD-10 codes (if applicable)
  - Common aliases and alternative names
  - Whether this is a recognized diagnostic entity or a biological state/concept
- Note: some indications are not standard diagnoses (e.g., "immunosenescence",
  "ageing", "GLP-1 induced sarcopenia") — document this explicitly

**Step 3: Establish hierarchy**
- Identify the parent indication from the input (additional_context may contain this)
- Understand where this fits in the clinical taxonomy (therapy area, condition class)
- Note cross-cutting classifications if applicable

**Step 4: Quick trial landscape scan**
- Use clinical-trials MCP to search for trials: `search_trials(condition="[indication name]")`
- Record total count, phase distribution, and status distribution
- This gives a rough sense of how mature the indication is clinically

**Step 5: Write outputs**
- Write `waypoints/meta.json` with indication identity
- Initialize `waypoints/sources_evaluated.json`

## Guidance

- This phase should complete in a single iteration
- If the indication has no ICD codes or standard definition, note this clearly —
  it affects every downstream section (epidemiology data will be scarce,
  regulatory path will be novel)
- Output references: see `references/waypoint-schemas.md` for `meta.json` format
