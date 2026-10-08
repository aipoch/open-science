# PDF translation regression fixtures

JSONL records are loaded directly by automated tests. Keep a fixture only when
it reproduces a distinct defect or protects a safety boundary. Prefer one minimal
positive case plus counterexamples that reject unsafe paragraph or object ownership.

Reuse the same page data when separate tests exercise different assertions. Do not
check in run histories, downloaded PDFs, local paths, model outputs, or manual
corpus manifests. Native geometry may reproduce a real failure; all displayed text
must be synthetic, with fictional names and reserved example-domain URLs. Keep only the
font, ordering, punctuation and layout evidence needed to reproduce the defect.
