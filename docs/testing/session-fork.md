# Session Fork verification

## Contract

Fork creates a new writable Session in the same Project. It preserves every conversation branch and copied research evidence, selects the source's active branch, and starts fresh provider context with history replay. Import remains read-only. Fork uses an ordinary Session ID instead of the `import-` prefix used by catalog-only imported Sessions; loaded Sessions continue to derive read-only state from `packageOrigin`. No database field or schema migration is added for this presentation. Side Chat is excluded.

Local forks retain the selected model, Specialist, permission and compute configuration. Imported forks use receiving-app defaults instead of restoring another installation's credentials or execution authority. Pin/archive state and in-flight provider/run state are reset. Project settings and Memory remain Project-owned; they are not new independent copies. A local configured working directory remains the configured directory; Fork copies package-managed research data, not arbitrary external workspace contents.

Private Bookmarks and notes are copied only for in-app Fork, with new IDs and remapped message/file/PDF targets. They are not serialized into `.science` exports. Files referenced only by local private Bookmarks are included in Fork's research snapshot.

## Publication boundary

The package journal owns filesystem and SQLite publication. Before reporting success or emitting `session:created`, live publication calls `SessionPersistenceCoordinator.adoptPublishedSession`. This reads durable authority and records the Session's Project owner in the catalog used by resume and save admission. Startup package recovery runs before catalog construction; subsequent hydration adopts its results. Recovery after startup uses the live publication hook.

If native publication commits but live adoption fails, Fork reports the existing child/operation identity as committed and retains its recovery journal. Recovery adopts that child; it does not create another copy. Renderer notification failure after adoption does not undo publication.

## Regression coverage

| Capability | What is verified | Tests |
| --- | --- | --- |
| Desktop lifecycle | Menu Fork, imported `Fork to continue`, new reply, durable save, reopening and another reply after restart; no lock on fork | `e2e/session-fork.spec.ts` |
| Live ownership | Real repository, persistence coordinator, archive gate and ACP resume workflow agree before restart; completed publication is adopted before UI notification | `src/main/session-package/fork.test.ts`, `src/main/application-command-wiring.test.ts` |
| Graph and continuation | All branches/messages copied with new identities; selected branch preserved; new message saved; switch branch without losing it; inherited usage attribution and fresh replay state | `src/main/session-package/fork.test.ts` |
| File independence | Exact copied bytes, separate IDs, editable child-owned text, new version keeps old bytes, source unchanged; new Artifact creation | `src/main/session-package/fork.test.ts`, `src/main/session-package/service.test.ts` |
| Notebook | Root and delegated-frame histories, scripts, pinned inputs, execution evidence checksums; append a new run without replacing history | `src/main/session-package/service.test.ts` |
| Plans | Historical Plan document, step status and prompt binding survive; immutable file referenced only by Plan history is copied | `src/main/session-package/fork.test.ts` |
| PDF and annotations | Reading PDF bindings; PDF, text and image annotations; new IDs and remapped immutable versions; exact target bytes | `src/main/session-package/service.test.ts` |
| Literature | Metadata and PDF content resolve through the normal content authority; explicit missing-content evidence survives; no duplicate Library installation | `src/main/session-package/literature.test.ts` |
| Private Bookmarks | Text/message/file/PDF targets and notes; editing source note does not change child; repeated Fork; PDF referenced only by a Bookmark; export excludes private notes | `src/main/session-package/fork.test.ts`, `src/main/session-package/literature.test.ts` |
| Task and Compute history | Terminal results preserved through Fork/refork; no imported executable jobs, host credentials or recovery handles | `src/main/session-package/service.test.ts` |
| Export/refork | Re-export and re-import after continuation; inherited evidence and exclusions survive another Fork | `e2e/session-fork.spec.ts`, package service, literature and fork tests |
| Archive/delete/recovery | Archive blocks resume, restore admits it; source deletion leaves child usable; committed adoption failure recovers the same child; deletion respects conservative evidence retention | Fork and package deletion tests |
| Menus and lock state | Disabled Fork has a reason; imported source remains locked; fork is unlocked in loaded and catalog-only views | Session action-menu and sidebar tests; package Fork identity assertions |

The Electron test uses a deterministic ACP provider. Notebook execution uses an executor test double while exercising the real Notebook service and repository. These prove application lifecycle and persistence contracts, not live external model behavior, remote Compute execution, or every provider-specific runtime.

Upstream immutable inputs remain read-only evidence. Child-owned writable files can acquire new versions. Existing cleanup deliberately retains entire packages when external Notebook/history references cannot be ruled out; deleting a conversation does not promise immediate byte deletion.
