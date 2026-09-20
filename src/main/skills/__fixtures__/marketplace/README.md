# Published protocol v1 fixtures

Exact release metadata bytes from `aipoch/openscience-skill-marketplace`, published commit
`1fcb52be4743e42e54f89709720f7a41df11c36c`, captured 2026-09-13 UTC via authenticated GitHub Contents API.
These files are test inputs only and are not imported by the renderer or production service.

- `marketplace.json` and `marketplace.json.sig`: original root paths.
- `release-index.json`: `indexes/5156d4017c34a7cc4736da0e5cbc46dcc7a24937fb0d40f1d937385493df203f.json`.
- `abstract-trimmer.json`: `releases/abstract-trimmer/1.0.0.json`.

The production public key was independently read from the repository's production environment
public variable, not trusted from these fixtures. SHA-256 of its SPKI DER bytes:
`662a35f7bd962722e35980b09fac2b598a20fde189084a49dec4bb7fbb78faea`.
No Skill package, executable instructions or private key is included.

At capture time the external repository was private, and anonymous API/raw requests returned 404.
The runtime intentionally uses anonymous metadata requests and does not borrow development CLI credentials.
The repository owner subsequently made it public; anonymous live service reading then passed against
the same published commit. The runtime does not require a GitHub token.
