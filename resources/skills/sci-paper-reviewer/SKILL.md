---
name: sci-paper-reviewer
description: Simulates a strict SCI peer-review workflow; trigger when a user uploads or pastes a manuscript (PDF/DOC/DOCX/TXT) and requests an innovation score (1–12) plus experimental-logic vulnerability checks and revision suggestions.
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)

## When to Use

- When a user uploads a manuscript (PDF/DOC/DOCX/TXT) and asks for an SCI-style peer review.
- When a user wants an **innovation/novelty score (1–12)** with explicit criteria and justification.
- When a user needs a **logic audit** of the Results section (false positives, missing controls, broken mechanism chains).
- When a user requests **actionable experimental revisions** (what to add/verify, which controls are missing).
- When a user provides copy-pasted manuscript text and wants the same structured review output.

## Key Features

- Automatic manuscript parsing for **PDF, Word, and TXT**, plus direct text input.
- Section-oriented analysis: focuses on **Abstract**, **Results**, **Introduction**, and **Discussion**.
- Research type classification: **Materials**, **Basic Medical**, **Clinical**, or **Review**.
- Innovation evaluation with a **strict 1–12 scoring rubric** (originality, theory extension, translational path).
- Logic vulnerability screening in Results:
  - false-positive risk (lack of orthogonal validation)
  - mechanism breaks (unverified upstream/downstream links)
  - control failures (missing double-negative controls)
- Structured review report with **numbered, concrete modification suggestions** (no generic filler).

## Dependencies

- Python `>=3.9`
- Document parsing libraries (optional but supported):
  - `pypdf` (version varies)
  - `pdfplumber` (version varies)
  - `PyMuPDF` (version varies)
  - `PyPDF2` (version varies)
  - `python-docx` (version varies)

> The parser should fall back to basic extraction if some advanced libraries are unavailable.

## Example Usage

### 1) Parse a file and review the extracted text

```bash
# Parse an uploaded manuscript into a text file (recommended to avoid console buffer limits)
python scripts/enhanced_document_parser.py /path/to/manuscript.pdf extracted_content.txt
```

Then provide `extracted_content.txt` to the skill (or paste its content) and request a review, for example:

```text
Please review this manuscript as a strict SCI reviewer.
Requirements:
1) Classify research type.
2) Evaluate innovation (score 1–12) using your rubric.
3) Screen Results for logic vulnerabilities (false positives, mechanism breaks, control failures).
4) Output a structured report with numbered experimental modification suggestions.
[PASTE CONTENT OF extracted_content.txt HERE]
```

### 2) Direct text input (no file)

```text
I will paste the manuscript text below. Please perform an SCI-style review:
- Extract Abstract/Results/Introduction/Discussion (as available)
- Classify research type
- Innovation score (1–12) and rationale
- Logic vulnerability screening
- Provide numbered modification suggestions only (no generic “other suggestions”)
[PASTE MANUSCRIPT TEXT]
```

## Implementation Details

### 1) Document Processing Rules

- **Input detection**:
  - If a file is provided, detect type: `PDF`, `DOCX`, `DOC`, or `TXT`.
  - If text is pasted, process it directly.
- **Parsing script**:
  - Use: `scripts/enhanced_document_parser.py`
  - Recommended invocation (write to file):
    - `python scripts/enhanced_document_parser.py <file_path> extracted_content.txt`
  - Then read `extracted_content.txt` as the canonical extracted content.
- **Failure handling**:
  - If the parser outputs `Warning: No text extracted`, treat the file as likely **scanned/image-based** and inform the user that OCR may be required before review.

### 2) Section Extraction (for analysis)

From the parsed content, extract (as available):
- **Abstract** (work summary)
- **Results** (core experimental findings and data claims)
- **Introduction & Discussion** (background, positioning, interpretation)

If headings are missing, infer sections by typical academic structure and transitions.

### 3) Research Type Classification

Classify into one of:
- Materials Research
- Basic Medical Research
- Clinical Research
- Review

Use cues such as study subjects (cells/animals/patients), endpoints, materials synthesis/characterization, and whether the manuscript is primarily summarizing prior work.

### 4) Innovation Evaluation (Score 1–12)

Evaluate primarily from **Introduction** and **Discussion** (and claims in Abstract), using the following rubric:

- **Major Original (9–12)**: Proposes a fundamentally new mechanism or a disruptive hypothesis.
- **Clear Translation Path (8–11)**: Identifies targetable markers *and* provides inhibitor screening/validation data.
- **Theory Extension (5–8)**: Extends the boundary or applicability of an existing theory/framework.
- **Potential Application Value (4–7)**: Reveals regulatory mechanisms but lacks actionable intervention/translation.
- **Validation Study (1–4)**: Primarily replicates/validates known theories or fills incremental details.
- **Heuristic note**: “miRNA-based novelty” is generally treated as **average** unless supported by strong mechanistic and translational evidence.

### 5) Logic Vulnerability Screening (Results-Focused)

Screen the Results for the following vulnerabilities:

1. **False Positive Risk**  
   - Claims rely on a single assay/marker without **orthogonal validation** (e.g., only qPCR without protein-level confirmation; only one antibody without specificity checks).

2. **Mechanism Break**  
   - Upstream/downstream relationships are asserted but not experimentally verified (e.g., correlation presented as causation; missing rescue/epistasis tests).

3. **Control Failure**  
   - Key experiments lack appropriate controls, especially **double-negative controls** where required (e.g., vehicle + non-targeting controls; isotype controls; sham operations; matched baseline).

4. **Basic Medicine Rule (method sufficiency)**  
   - For cell-level knockdown, **siRNA/shRNA is sufficient**; **CRISPR is not mandatory** unless the claim requires stable knockout or allele-specific inference.

### 6) Required Output Structure (Final Review Report)

The generated review must follow this structure:

1. **Document Information**
   - File type and processing status
   - Extracted sections overview (what was found/used)
   - Parser used (enhanced parser vs. fallback)

2. **Innovation Evaluation**
   - Provide the innovation level and rationale (score may be stated explicitly or implied, but must map to the rubric).
   - Use academic, precise language.

3. **Experimental Modification Suggestions**
   - Provide only concrete, logic-driven revisions derived from the vulnerability screening.
   - Number items as **2.1, 2.2, 2.3, ...**
   - Avoid generic “Other suggestions”; each item must specify what experiment/control/verification to add and what claim it would support or falsify.