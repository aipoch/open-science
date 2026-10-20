# @aipoch/literature-citations

Citation parsing, CSL formatting, style validation and DOCX/LaTeX transformations. The package owns its WASM dependency and bundled CSL/locale resources; it never locates assets through the host working directory.

- Root: formatter, style library and typed style errors.
- `/contracts`: bibliographic records, identifiers, creators and citation conventions; browser safe.
- `/csl`: conversion to/from CSL; browser safe.
- `/styles`: custom style storage and validation (Node).
- `/exchange`: BibTeX/RIS field fidelity helpers; browser safe.
- `/documents`: DOCX formatting/reformatting and LaTeX bundles (Node).

Supply a custom style directory and a `getMany` reader returning only document IDs, metadata revisions and bibliographic records. The host owns permissions, Library personal fields, Artifact persistence and corpus provenance; validate/preserve those fields at the host boundary. Document markers, custom style hashes and sidecar bytes retain the existing format. Reformat returns the citation portion of a manifest, not host corpus data.

Run `npm run build` and `npm test` in this directory. `npm pack` includes declarations, runtime code, styles and locale assets. Consumers use the package's public exports only. Tests and source code are excluded from the archive.

Identifier normalization, canonical URLs, CSL validation and formatting cases are tested in this package. Host tests verify application error translation, Artifact/corpus preservation and command wiring; renderer tests consume transport error envelopes and verify localized presentation.

Style management uses `formatter.citationStyles({ kind: 'list' | 'import' | 'delete' | 'preview', ... })`
with a `LiteratureCitationStyleLibrary` supplied to the formatter. The request/result schemas live in
`/contracts`; Literature Library reexports them for compatibility. The package owns mutation, listing,
preview and engine refresh. Formatters sharing a library observe its revision automatically, including
mutations made through the library directly. Hosts select the writable directory, enforce write
admission and translate typed errors; they never invalidate the formatting engine.
