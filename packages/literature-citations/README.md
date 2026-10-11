# @aipoch/literature-citations

Citation parsing, CSL formatting, style validation and DOCX/LaTeX transformations. The package owns its WASM dependency and bundled CSL/locale resources; it never locates assets through the host working directory.

- Root: formatter, style library and typed style errors.
- `/contracts`: bibliographic records, identifiers, creators and citation conventions; browser safe.
- `/csl`: conversion to/from CSL; browser safe.
- `/styles`: style storage/validation and packaged resource location (Node).
- `/exchange`: BibTeX/RIS field fidelity helpers; browser safe.
- `/documents`: DOCX formatting/reformatting and LaTeX bundles (Node).

Supply a custom style directory and a `getMany` reader returning only document IDs, metadata revisions and bibliographic records. The host owns permissions, Library personal fields, Artifact persistence and corpus provenance; validate/preserve those fields at the host boundary. Document markers, custom style hashes and sidecar bytes retain the existing format. Reformat returns the citation portion of a manifest, not host corpus data.

Run `npm run build` and `npm test` in this directory. `npm pack` includes declarations, runtime code, styles and locale assets. Consumers use the package's public exports only. Tests and source code are excluded from the archive.
