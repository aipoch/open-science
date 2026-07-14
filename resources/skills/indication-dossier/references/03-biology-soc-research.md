# Phase 3 — Biology & standard-of-care research

**When:** `waypoints/epidemiology.json` exists, `waypoints/biology_soc.json` doesn't.

## Objective

Understand the biology underlying this patient population and how they're
currently treated. This covers Sections 2 (Disease Biology) and 3 (Standard of Care).

## Actions

**Step 1: Pathophysiology**
- Search pubmed MCP for recent review articles on the disease mechanism
- Identify key biological pathways involved
- Note which pathways are validated drug targets vs. emerging hypotheses
- For complex multi-pathway conditions, focus on the pathways most relevant
  to therapeutic intervention

**Step 2: Biomarkers**
- Diagnostic biomarkers: how is the condition confirmed?
- Prognostic biomarkers: what predicts disease progression?
- Pharmacodynamic biomarkers: what can measure drug effect?
- Note which biomarkers are FDA-qualified vs. exploratory
- This directly informs Section 4 (endpoints)

**Step 3: Approved therapies**
- WebSearch site:fda.gov for approved drugs for this indication
- For each approved therapy: mechanism, approval year, key limitations
- Note if therapies are approved for this specific indication or used off-label
- Identify major drug classes and their positioning (first-line, second-line, etc.)
- For indications with no approved therapies: state this explicitly

**Step 4: Treatment guidelines**
- WebSearch for specialty society guidelines (NCCN, AASLD, ATS/ERS, AGS, etc.)
- Current standard of care algorithm
- How guidelines differ between regions (US vs EU) if relevant
- Recent guideline changes and their implications

**Step 5: Unmet need**
- What does current therapy fail to address?
- Patient populations underserved by existing treatments
- Disease modification vs. symptom management gap
- Quality of life impact not addressed by current therapies

**Step 6: Write `waypoints/biology_soc.json`**
Follow the schema from `references/waypoint-schemas.md`.

## Guidance

- For pathophysiology: aim for "analyst-level" understanding — key pathways and
  why they matter for therapy, not textbook depth
- For biomarkers: explicitly connect to clinical trial utility
- For approved therapies: focus on limitations — this is what creates the opportunity
- Use parallel subagents: pubmed MCP for biology, WebSearch for guidelines,
  WebSearch site:fda.gov for approvals
