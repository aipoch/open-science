# MeSH Structure Guide

## What is MeSH?

Medical Subject Headings (MeSH) is the National Library of Medicine's controlled vocabulary thesaurus used for indexing articles in PubMed/MEDLINE.

## MeSH Hierarchy

MeSH terms are organized in a hierarchical tree structure with 16 main categories:

| Tree Number Prefix | Category |
|-------------------|----------|
| A | Anatomy |
| B | Organisms |
| C | Diseases |
| D | Chemicals and Drugs |
| E | Analytical, Diagnostic and Therapeutic Techniques |
| F | Psychiatry and Psychology |
| G | Phenomena and Processes |
| H | Disciplines and Occupations |
| I | Anthropology, Education, Sociology |
| J | Technology, Industry, Agriculture |
| K | Humanities |
| L | Information Science |
| M | Named Groups |
| N | Health Care |
| V | Publication Characteristics |
| Z | Geographicals |

## Tree Structure Example

```
C - Diseases
└── C15 - Hemic and Lymphatic Diseases
    └── C15.378 - Hematologic Diseases
        └── C15.378.100 - Anemia
            ├── C15.378.100.100 - Anemia, Aplastic
            ├── C15.378.100.141 - Anemia, Hemolytic
            └── C15.378.100.855 - Anemia, Sickle Cell
```

## Explode vs NoExp

### Explode (Default)
Includes the term AND all more specific terms below it in the hierarchy.

```
"Anemia"[MeSH Terms]  # Includes Anemia, Aplastic, Hemolytic, Sickle Cell, etc.
```

### No Explode
Only includes the exact term, excluding more specific terms.

```
"Anemia"[MeSH Terms:noexp]  # Only general Anemia articles
```

## Entry Terms (Synonyms)

Each MeSH term has associated entry terms (synonyms) that map to it:

| MeSH Term | Entry Terms |
|-----------|-------------|
| Myocardial Infarction | Heart Attack, Cardiac Infarction, MI |
| Cerebrovascular Accident | Stroke, Brain Attack, CVA |
| Acetylsalicylic Acid | Aspirin, ASA |
| Neoplasms | Cancer, Malignancy, Tumor |

## Subheadings (Qualifiers)

Subheadings narrow MeSH terms to specific aspects:

| Subheading | Code | Use For |
|------------|------|---------|
| /adverse effects | AE | Side effects of drugs/procedures |
| /blood | BL | Blood levels, blood studies |
| /diagnosis | DI | Diagnostic procedures |
| /drug therapy | DT | Drug treatment |
| /epidemiology | EP | Incidence, prevalence |
| /etiology | ET | Causes |
| /genetics | GE | Genetic aspects |
| /mortality | MO | Death rates |
| /pathology | PA | Disease pathology |
| /prevention & control | PC | Preventive measures |
| /therapy | TH | Treatment generally |

### Subheading Syntax

```
"Diabetes Mellitus/drug therapy"[MeSH Terms]
"Hypertension/epidemiology"[MeSH Terms]
"Neoplasms/mortality"[MeSH Terms]
```

## MeSH Major Topic

Limits to articles where the term is a major focus (starred in MEDLINE):

```
"Diabetes Mellitus"[MeSH Major Topic]
```

Use when:
- Too many results with regular MeSH search
- Topic is central to research question
- High precision needed

## Checking Current MeSH

MeSH terms are updated annually. Always verify at:
- https://meshb.nlm.nih.gov/ (MeSH Browser)
- https://www.ncbi.nlm.nih.gov/mesh

## Common Pitfalls

1. **Outdated terms**: MeSH changes; check current version
2. **US vs UK spelling**: Use MeSH preferred spelling
3. **Case sensitivity**: MeSH terms are case-sensitive in quotes
4. **Explosion scope**: Consider if you need all subtypes
5. **Subheading compatibility**: Not all subheadings work with all terms
