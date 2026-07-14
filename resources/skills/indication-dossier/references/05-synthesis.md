# Phase 5 — Synthesis

**When:** `waypoints/regulatory_trials.json` exists.

## Objective

Read all waypoint files and write the final Markdown report.
Also write `research_output.json` for downstream consumers.

## Output structure

**Final Output**: `waypoints/indication_dossier_report.md`

```markdown
# Indication Dossier: [Name]

**Definition**: [one-sentence clinical definition]
**ICD-10**: [codes, or "Not a standard diagnostic entity"]
**Parent Indication**: [parent name, or "Root"]

## 1. Population Definition & Epidemiology

### 1.1 Diagnostic Criteria
[How this population is identified. Consensus definitions, diagnostic criteria.
Note if criteria are evolving or non-standard.]

### 1.2 Prevalence & Incidence
[Global and US prevalence. Incidence trends. Data quality notes.]

### 1.3 Demographics & Risk Factors
[Age, sex, racial/ethnic distribution. Key risk factors and comorbidities.]

### 1.4 Natural History
[Disease course, progression, staging. Mortality data. Key inflection points.]

## 2. Disease Biology

### 2.1 Pathophysiology
[Key biological pathways. Validated vs. emerging therapeutic targets.]

### 2.2 Biomarkers
[Diagnostic, prognostic, pharmacodynamic. FDA-qualified vs. exploratory.
Connect to clinical trial utility.]

## 3. Standard of Care

### 3.1 Approved Therapies
[Approved drugs with mechanism, approval year, limitations.
Or: "No therapies are currently approved for this indication."]

### 3.2 Treatment Guidelines
[Current SOC algorithm. Specialty society recommendations.]

### 3.3 Unmet Need
[What current therapy fails to address. Disease modification gap.
Underserved populations.]

## 4. Clinical Endpoints & Regulatory Path

### 4.1 Accepted Endpoints
[FDA/EMA accepted primary endpoints. Surrogate vs. clinical.
Or: "No FDA guidance exists for this indication."]

### 4.2 Regulatory Precedents
[Key approvals, guidance documents, advisory committee discussions.]

### 4.3 Trial Design Parameters
[Typical trial sizes, durations, comparators, per-patient costs.
Based on Phase 3 trial patterns from ClinicalTrials.gov.]

## 5. Key Trials

### 5.1 Landmark Trials
[3-5 most important trials. For each: NCT ID, drug, results, impact.]

### 5.2 Notable Failures
[Significant failures and mechanism-level lessons learned.]

## Appendix: Sources

[Numbered list of every source consulted, grouped under bold subheadings by
source type. Numbering is continuous across groups. Title is the hyperlink;
accessed date closes the entry.]
```

## Actions

**Step 1: Load all waypoint data**
- Read `waypoints/meta.json`
- Read `waypoints/epidemiology.json`
- Read `waypoints/biology_soc.json`
- Read `waypoints/regulatory_trials.json`
- Read `waypoints/sources_evaluated.json`
- If writing reveals a missing value for a field already in a waypoint, one
  targeted fetch to fill it is fine; record the new source in
  `sources_evaluated.json`. Do not open new research threads.

**Step 2: Write `waypoints/indication_dossier_report.md`**

CRITICAL: Write to `<workdir>/waypoints/indication_dossier_report.md` (inside waypoints/).

Follow the output_structure above. Key guidance:

*Sections 1-3*: Narrative prose with inline citations. Be specific with numbers
(prevalence rates, trial sizes, approval years). Coverage status belongs in
`research_output.json`, not the prose. In the report, only name what is
partial or missing; never label a section as covered.

*Section 4*: Mix of prose and structured data. Include tables for endpoint
comparisons and trial parameters where helpful.

*Section 5*: Structured entries for each trial. Connect to lessons for
future trial design.

*Throughout*: Frame from the patient population perspective. Use the framing
guidance from SKILL.md.

*Figures*: Only generate a chart when it shows a relationship or
distribution that prose cannot. Give each a one-line caption that names the
data source. After rendering, `Read` the image and answer: does this tell
the reader something the surrounding prose does not? Are title, axes with
units, and legend all present and legible? Do axis ticks and chart type
match the data (no fractional ticks on years, counts, or categories; no
misleading scales)? If any answer is no, delete the figure rather than
regenerating.

**Step 3: Write `waypoints/research_output.json`**
```json
{
  "indication_name": "...",
  "parent_indication": "...",
  "meta": {...},
  "epidemiology": {...},
  "biology_soc": {...},
  "regulatory_trials": {...},
  "sources_evaluated": [...],
  "coverage_summary": {
    "epidemiology": {"covered": [...], "partial": [...], "missing": [...]},
    "biology_soc": {"covered": [...], "partial": [...], "missing": [...]},
    "regulatory_trials": {"covered": [...], "partial": [...], "missing": [...]}
  }
}
```

**Step 4: Mark complete**

CRITICAL: Write `waypoints/indication_dossier_report.md` FIRST, then this step.

Write `waypoints/progress.json`:
```json
{
  "complete": true,
  "output_file": "indication_dossier_report.md",
  "current_phase": "synthesis"
}
```

## Guidance

- Final report is narrative prose with inline citations
- Follow `references/06-writing-style.md` for source attribution
- Be explicit about gaps and data quality limitations
- For novel/non-standard indications, the regulatory section may be very short —
  that's correct, not a gap to fill
