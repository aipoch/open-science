# Website update publication

Run **Mirror to website** against the intended repository revision and release tag. The workflow
keeps existing client URLs and feed formats. Its default **backfill** mode uploads only versioned
files under `releases/<version>/`; it does not change the website or application update channel.
Use **promote** explicitly when the stable channel should advance.

Promotion requires all Windows, Linux, combined macOS, and per-architecture macOS feeds. Every staged
feed must describe the requested version. Before writing channel entries, the publisher reads the
current manifest and all required feeds. If any names a newer stable version, only the versioned
backfill runs. Invalid, unreadable or missing current metadata stops promotion; this workflow does
not initialize an empty channel or infer that an access error means an object is absent.

The workflow serializes website mirror runs with a shared concurrency group. Version comparisons
remain necessary because scheduling order is not a version ordering guarantee. Other tools writing
the same bucket are outside this lock and must not run concurrently with promotion.

## Recovering a failed promotion

Channel objects are separate storage writes, not an atomic transaction. The feeds upload first and
`version.json` last, so failure can temporarily leave platforms pointing at different releases.

- Inspect the failed run to identify the intended version and failing upload. Correct the reported
  storage, permissions or feed problem before retrying.
- Rerun **promote** for that same version, using the same reviewed release inputs. The version guard
  permits equal versions and prevents a delayed older run from overwriting a partially advanced feed.
- Verify `version.json` and every required root feed show the intended version after the run succeeds.
  A versioned copy of `version.json` is uploaded alongside the versioned feeds for comparison and
  recovery. It adds no application data field or migration.
- If current metadata is missing or corrupt, restore it through the existing storage administration
  process using the reviewed versioned files before retrying. Do not treat a failed read as permission
  to replace all channel pointers.

The workflow does not provide a downgrade/rollback mode. Do not use an older mirror run as an implicit
rollback. A rollback requires a separately reviewed operational action.

**Dry run** still executes release metadata/feed transforms without AWS setup or uploads. Sparse
installer fixtures in that mode verify metadata processing; they do not verify real installer bytes.
The portable publication regression tests run the actual publication command against local fake
storage, covering backfill, promotion, delayed older runs and recovery after a failed upload.
