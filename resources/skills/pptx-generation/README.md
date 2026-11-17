# PPTX generation skill

On-demand skill for creating and editing PowerPoint decks with python-pptx in the
Open Science Notebook.

## Execution boundary

Run-time code is in `kernel.py`, registered in `open-science.json` and injected
with `kernelSkillIds: ["pptx-generation"]`. Third-party imports are lazy, so
injection succeeds before python-pptx is installed with `manage_packages`.
No Office engine is bundled. `render_pptx_pages` uses a user-installed
LibreOffice when one exists and otherwise reports `available: False`;
`lint_pptx` provides layout QA without a renderer.

## Attribution

Design guidance, template-filling rules, and the QA checklist are adapted from the
`pptx` skill in [anthropics/skills](https://github.com/anthropics/skills)
(Apache-2.0). Changes: python-pptx instead of pptxgenjs, Open Science execution,
preview limits, and Artifact delivery, programmatic layout lint, CJK font helper.

## Validation

```sh
python3 -m unittest discover -s test/pptx-generation -v
npx vitest run src/main/skills/pptx-generation.test.ts
```

The Python suite skips when python-pptx or Pillow is missing from the test
interpreter; set `OPEN_SCIENCE_TEST_PYTHON` to one that has them.
