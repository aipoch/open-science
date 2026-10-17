# Research source preparation

`prepare-git-snapshot.mjs` creates a candidate source artifact from an exact local Git commit, without checking it out, reading its working files, executing project code or accessing the network. It does not import, publish or execute a study.

```sh
node scripts/research/prepare-git-snapshot.mjs \
  --repository /path/to/project \
  --commit FULL_LOWERCASE_COMMIT_ID \
  --output /path/outside/project/new-snapshot \
  --source-url https://example.org/owner/project
```

The output directory must not exist. The tool writes:

- `source.tar.gz`: deterministic gzip/ustar, regular files only, a `project/` prefix, normalized timestamps and ownership, committed executable modes.
- `source-manifest.json`: repository/commit/tree identity, archive digest, each selected path/size/SHA-256/mode, actual excluded paths, and discovered license-file evidence.

Only committed objects are read. `.env*` (including examples), `.git`, `node_modules`, `.cache`, `.venv`, `__pycache__`, `coverage`, and `reports` path components are excluded. The programmatic API supports additional explicit relative path exclusions. This is a source snapshot; datasets excluded by this policy must be prepared as separately reviewed research artifacts when a study requires them.

The tool rejects links, submodules, non-portable/case-colliding paths, more than 10000 files, or more than 128 MiB of selected file bytes. It refuses output within the source repository, including through a symlinked parent. It does not extract the source archive; restoration belongs to the managed workspace service.

This process is not a secret detector, license grant, proof of historical runtime identity, or guarantee that included source is safe to execute. The output remains a publication candidate until its full content and disclosure scope have been reviewed. No local absolute producer path is recorded in the portable manifest.

The optional research reproduction description can reference these files as ordinary artifacts. This does not modify `.science` archive rules or permit imported content to execute automatically. See `docs/research-reproduction-description.md` for that separate content convention.

Run the focused guard tests with `npx vitest run scripts/research/prepare-git-snapshot.test.ts`.
