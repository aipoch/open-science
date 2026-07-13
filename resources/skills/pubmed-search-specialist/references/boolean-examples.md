# Boolean Query Examples

## Basic Patterns

### Single Concept with MeSH and Text Words
```
("Diabetes Mellitus"[MeSH Terms] OR "diabetic"[Title/Abstract] OR "diabetics"[Title/Abstract])
```

### Two Concepts Combined
```
("Diabetes Mellitus"[MeSH Terms] OR "diabetic"[Title/Abstract]) AND 
("Aspirin"[MeSH Terms] OR "aspirin"[Title/Abstract])
```

### Three or More Concepts
```
(("Diabetes Mellitus"[MeSH Terms] OR "diabetic"[Title/Abstract]) AND 
 ("Aspirin"[MeSH Terms] OR "aspirin"[Title/Abstract]) AND 
 ("Stroke"[MeSH Terms] OR "stroke"[Title/Abstract]))
```

## By Search Type

### Systematic Review Search (High Sensitivity)
```
(("Diabetes Mellitus, Type 2"[MeSH Terms] OR "type 2 diabetes"[Title/Abstract] OR 
  "T2DM"[Title/Abstract] OR "NIDDM"[Title/Abstract] OR "adult onset diabetes"[Title/Abstract] OR
  "diabetic"[Title/Abstract]) AND
 ("Metformin"[MeSH Terms] OR "metformin"[Title/Abstract] OR "glucophage"[Title/Abstract]) AND
 ("cardiovascular"[Title/Abstract] OR "cardiac"[Title/Abstract] OR "heart"[Title/Abstract] OR
  "myocardial"[Title/Abstract] OR "coronary"[Title/Abstract] OR "stroke"[Title/Abstract] OR
  "cerebrovascular"[Title/Abstract]))
```

### Rapid Search (High Specificity)
```
("Diabetes Mellitus, Type 2/drug therapy"[MeSH Major Topic] AND 
 "Metformin"[MeSH Major Topic] AND
 "Cardiovascular Diseases/prevention & control"[MeSH Terms])
```

### Clinical Trial Search
```
(("Diabetes Mellitus"[MeSH Terms] OR "diabetic"[Title/Abstract]) AND
 ("SGLT2 Inhibitors"[MeSH Terms] OR "dapagliflozin"[Title/Abstract] OR 
  "empagliflozin"[Title/Abstract] OR "canagliflozin"[Title/Abstract]) AND
 (randomized controlled trial[Publication Type] OR 
  (randomized[Title/Abstract] AND controlled[Title/Abstract] AND trial[Title/Abstract])))
```

## By Clinical Domain

### Therapy
```
(("condition"[MeSH Terms] OR "condition"[Title/Abstract]) AND
 ("intervention"[MeSH Terms] OR "intervention"[Title/Abstract]) AND
 (randomized controlled trial[Publication Type] OR controlled clinical trial[Publication Type] OR
  randomized[Title/Abstract] OR placebo[Title/Abstract] OR "clinical trial"[Publication Type]))
```

### Diagnosis
```
(("condition/diagnosis"[MeSH Terms] OR "condition"[Title/Abstract]) AND
 ("diagnostic test"[MeSH Terms] OR "test name"[Title/Abstract]) AND
 (sensitivity[Title/Abstract] OR specificity[Title/Abstract] OR 
  "diagnostic accuracy"[Title/Abstract] OR "roc curve"[Title/Abstract] OR
  "likelihood ratio"[Title/Abstract] OR "predictive value"[Title/Abstract]))
```

### Prognosis
```
(("condition"[MeSH Terms] OR "condition"[Title/Abstract]) AND
 ("risk factor"[MeSH Terms] OR prognos*[Title/Abstract] OR predict*[Title/Abstract] OR
  outlook*[Title/Abstract] OR course[Title/Abstract]) AND
 (cohort studies[Publication Type] OR follow-up studies[MeSH Terms] OR
  prospective[Title/Abstract] OR longitudinal[Title/Abstract]))
```

### Harm/Etiology
```
(("condition"[MeSH Terms] OR "condition"[Title/Abstract]) AND
 ("exposure"[MeSH Terms] OR "exposure"[Title/Abstract]) AND
 (risk[Title/Abstract] OR associat*[Title/Abstract] OR caus*[Title/Abstract] OR
  "relative risk"[Title/Abstract] OR "odds ratio"[Title/Abstract] OR
  "hazard ratio"[Title/Abstract]))
```

## With Filters

### Human Studies Only
```
(query) AND humans[MeSH Terms]
```

### English Language
```
(query) AND english[Language]
```

### Last 5 Years
```
(query) AND 2020:2025[Publication Date]
```

### Adult Population
```
(query) AND adult[MeSH Terms]
```

### Meta-Analyses Only
```
(query) AND meta-analysis[Publication Type]
```

### Multiple Filters Combined
```
(query) AND humans[MeSH Terms] AND english[Language] AND 
2020:2025[Publication Date] AND adult[MeSH Terms]
```

## Complex Nested Examples

### Multi-Condition Search
```
(("Diabetes Mellitus"[MeSH Terms] OR "Hypertension"[MeSH Terms]) AND
 ("Kidney Diseases"[MeSH Terms] OR "nephropathy"[Title/Abstract]) AND
 ("ACE Inhibitors"[MeSH Terms] OR "Angiotensin Receptor Antagonists"[MeSH Terms]))
```

### Drug Class Search
```
(("Depressive Disorder, Major"[MeSH Terms] OR "major depression"[Title/Abstract] OR
  "major depressive disorder"[Title/Abstract]) AND
 ("Serotonin Uptake Inhibitors"[MeSH Terms] OR "SSRIs"[Title/Abstract] OR
  "fluoxetine"[Title/Abstract] OR "sertraline"[Title/Abstract] OR
  "paroxetine"[Title/Abstract] OR "citalopram"[Title/Abstract] OR
  "escitalopram"[Title/Abstract]))
```

### Surgical Intervention
```
(("Obesity, Morbid"[MeSH Terms] OR "morbid obesity"[Title/Abstract] OR
  "BMI"[Title/Abstract] OR "body mass index"[Title/Abstract]) AND
 ("Bariatric Surgery"[MeSH Terms] OR "gastric bypass"[Title/Abstract] OR
  "sleeve gastrectomy"[Title/Abstract] OR "gastric banding"[Title/Abstract] OR
  "roux-en-y"[Title/Abstract]))
```

## Line-by-Line Strategy Template

```
# 1. Population
("Population MeSH"[MeSH Terms] OR "synonym1"[Title/Abstract] OR "synonym2"[Title/Abstract])

# 2. Intervention
("Intervention MeSH"[MeSH Terms] OR "synonym1"[Title/Abstract] OR "synonym2"[Title/Abstract])

# 3. Outcome
("Outcome MeSH"[MeSH Terms] OR "synonym1"[Title/Abstract] OR "synonym2"[Title/Abstract])

# 4. Study Type Filter
(randomized controlled trial[Publication Type] OR systematic review[Publication Type])

# 5. Population Filter
humans[MeSH Terms] AND adult[MeSH Terms]

# 6. Language/Date
english[Language] AND 2020:2025[Publication Date]

# Final Query
(#1 AND #2 AND #3 AND #4 AND #5 AND #6)
```
