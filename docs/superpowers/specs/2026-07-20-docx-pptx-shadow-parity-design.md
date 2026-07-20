# DOCX/PPTX Page Shadow Parity

## Goal

Make each rendered DOCX page use the same subtle page shadow as the existing PPTX slide renderer: `0 2px 8px rgba(0, 0, 0, 0.15)`.

## Scope

- Override only the DOCX page shadow in the renderer-owned style.
- Keep the transparent DOCX wrapper, zero outer padding, responsive page fitting, paper background, document margins, and page spacing unchanged.
- Do not modify PPTX rendering or introduce a runtime dependency between the two renderers.

## Verification

- Add a renderer regression assertion for the exact shadow value.
- Run the direct Office preview tests and Web type check.
- Confirm the DOCX page shadow matches PPTX in the Electron preview panel and that no other page layout changes occur.
