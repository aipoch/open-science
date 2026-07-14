# Phase 2 — Epidemiology research

**When:** `waypoints/meta.json` exists, `waypoints/epidemiology.json` doesn't.

## Objective

Characterize this patient population: how they're identified, how many there are,
and what happens to them over time.

## Actions

**Step 1: Diagnostic criteria and population definition**
- WebSearch for consensus diagnostic criteria (e.g., EWGSOP2 for sarcopenia, GOLD for COPD)
- Identify how this population is clinically identified and distinguished from related populations
- Note if criteria are evolving or contested
- For non-standard indications: document what proxy definitions exist (research criteria,
  clinical trial enrollment criteria, expert consensus)

**Step 2: Prevalence and incidence**
- Search pubmed MCP for recent systematic reviews and meta-analyses on prevalence
- WebSearch for CDC, WHO, or national registry data
- Capture: global prevalence, US prevalence, incidence rates, trends over time
- Distinguish between community-dwelling and clinical populations where relevant
- Note data quality: are estimates from large epidemiological studies or small single-center studies?

**Step 3: Demographics and risk factors**
- Age distribution, sex differences, racial/ethnic disparities
- Key risk factors and comorbidities
- Geographic variation if significant

**Step 4: Natural history and disease progression**
- Typical disease course (acute vs chronic, progressive vs relapsing)
- Staging systems if applicable
- Mortality and morbidity data
- Key inflection points in disease trajectory (when intervention matters most)

**Step 5: Write `waypoints/epidemiology.json`**
Follow the schema from `references/waypoint-schemas.md`. For each subsection, note coverage level.

## Guidance

- Prioritize systematic reviews and meta-analyses over individual studies
- For rare diseases, smaller studies are acceptable — note the evidence quality
- If the indication is novel or non-standard, explicitly state that epidemiology
  data is limited and explain what proxy data exists
- Use parallel subagents to search pubmed MCP and WebSearch simultaneously
