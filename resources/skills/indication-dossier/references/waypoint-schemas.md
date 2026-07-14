# Waypoint file schemas

These define the structure of each `<workdir>/waypoints/*.json` file. The
phase reference files point here for output formats.

## progress.json — Loop control

```json
{
  "complete": false,
  "output_file": null,
  "current_phase": "meta_initialization",
  "iteration_notes": "What was accomplished this iteration"
}
```

When complete:
```json
{
  "complete": true,
  "output_file": "indication_dossier_report.md",
  "current_phase": "synthesis"
}
```

## meta.json — Indication identity (written in meta_initialization)

```json
{
  "indication_name": "...",
  "parent_indication": "... or null",
  "definition": "...",
  "icd_codes": ["K70", "..."],
  "aliases": ["..."],
  "is_standard_diagnosis": true,
  "notes": "Any caveats about this indication's status (not ICD-coded, novel, etc.)"
}
```

## epidemiology.json — Section 1 data

```json
{
  "subsections": {
    "diagnostic_criteria": {"content": "...", "sources": [...], "coverage": "covered|partial|missing"},
    "prevalence_incidence": {"content": "...", "sources": [...], "coverage": "..."},
    "demographics": {"content": "...", "sources": [...], "coverage": "..."},
    "natural_history": {"content": "...", "sources": [...], "coverage": "..."}
  },
  "gaps": ["unfillable gaps documented here"]
}
```

## biology_soc.json — Sections 2-3 data

```json
{
  "subsections": {
    "pathophysiology": {"content": "...", "sources": [...], "coverage": "..."},
    "biomarkers": {"content": "...", "sources": [...], "coverage": "..."},
    "approved_therapies": {"content": "...", "sources": [...], "coverage": "..."},
    "treatment_guidelines": {"content": "...", "sources": [...], "coverage": "..."},
    "unmet_need": {"content": "...", "sources": [...], "coverage": "..."}
  },
  "gaps": [...]
}
```

## regulatory_trials.json — Sections 4-5 data

```json
{
  "subsections": {
    "accepted_endpoints": {"content": "...", "sources": [...], "coverage": "..."},
    "fda_guidance": {"content": "...", "sources": [...], "coverage": "..."},
    "trial_parameters": {"content": "...", "sources": [...], "coverage": "..."},
    "landmark_trials": {"content": "...", "sources": [...], "coverage": "..."},
    "notable_failures": {"content": "...", "sources": [...], "coverage": "..."}
  },
  "trial_landscape": {
    "total_trials": 0,
    "by_phase": {"Phase 1": 0, "Phase 2": 0, "Phase 3": 0, "Phase 4": 0},
    "by_status": {"Recruiting": 0, "Completed": 0, "...": 0}
  },
  "gaps": [...]
}
```

## sources_evaluated.json — All sources consulted

```json
{
  "sources": [
    {"url": "...", "source_type": "...", "date_accessed": "...", "result": "success|failed|partial"}
  ]
}
```

## indication_dossier_report.md / research_output.json

Final Markdown report and consolidated structured output (both written to
`waypoints/` in the synthesis phase). See `references/05-synthesis.md` for
`research_output.json` structure.
