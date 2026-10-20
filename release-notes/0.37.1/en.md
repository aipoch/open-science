## ✨ Highlights

- **PDF fidelity restored.** Structure extraction keeps complete figures with their captions and legends, reconstructs ruled tables that sit next to formulas without rejecting them, and preserves native ownership of figure regions, table records, and source-proven text. (#3456, #3465)
- **A quieter, more robust Windows experience.** The desktop CLI works from non-ASCII installation paths, PDF translation handles Windows drive paths, and Notebook kernels and environment captures no longer open console windows. (#3457, #3460)

## 🔧 Improvements

- Desktop installers and the standalone runtime shed unused payloads — duplicate bundled dependencies, unused model-runtime and tokenizer assets, and platform libraries the app never loads — reversing the size growth introduced by the v0.37.0 backend split (#3451, #3470)

## 🐛 Bug Fixes

- A spaced panel reference in running prose no longer splits a figure into separate raster and vector crops, and detector padding below a table's closing rule no longer causes the whole table to be rejected as a damaged formula (#3465)
- Native PDF extraction keeps caption and graphics ownership with the right element, recovers independently bounded table records with grouped headers and row groups, and retains cell source references and rich text (#3456)
- The desktop CLI no longer misreads its launcher under legacy code pages when the installation path contains Chinese characters, and preserves the caller's code page and exit code (#3457)
- Local PDF translation on Windows no longer fails with an unsupported module URL when the WASM assets live on a drive path (#3457)
- Notebook kernels, environment fingerprinting, package inventory, and lock capture no longer flash a console window or Windows Terminal during execution (#3460)
- Translated PDF regeneration no longer rejects legitimate source text because of differing embedded glyph-name spellings — proven glyphs keep their original ink (#3469)
