## ✨ Highlights

- **Artifacts you can edit.** Markdown, plain text, scripts, and source-code artifacts and uploads can now be edited as raw text — every save publishes a new version that preserves its source lineage, with a Compare action against the predecessor. (#1204)
- **NVIDIA Build joins the built-in providers.** A curated NVIDIA catalog with six agent-capable models, led by NVIDIA Nemotron 3.5 Lightning. (#2055)
- **Runtimes you can repair.** App-managed Python and R runtimes can be safely reinstalled from Settings, and a new toggle decides whether the agent may create runtime environments on its own. (#1984, #2058)
- **Delegation under your control.** A per-session switch in the composer's agent controls decides whether the agent may delegate work. (#2029)

## 🚀 New Features

- **Editable artifact versions** — text artifacts and uploads gain Edit and Compare actions: edit the raw source of Markdown, plain text, scripts, and source-code files, and each save publishes a new managed version while the original lineage and predecessor versions stay navigable. (#1204)
- **NVIDIA Build provider** — an official NVIDIA provider with a curated catalog of six agent-capable models, including NVIDIA Nemotron 3.5 Lightning (the default) and Kimi K3, with multimodal support marked per model. (#2055)
- **Session delegation controls** — a compact Delegation switch in the composer's agent controls; new sessions and message branches confirm the policy fail-closed before the first prompt runs. (#2029)
- **Project switcher search** — the workspace project menu gains a fuzzy search field once you have more than a few active projects, ranking title matches above description-only hits and highlighting the matched text. (#1964)
- **Safe managed-runtime reinstall** — reinstall healthy app-managed Python and R runtimes from Settings → Runtimes: running kernels drain and sessions rebind durably before the repair starts, and external interpreters are never touched. (#1984)
- **Control over agent-created environments** — a global Settings toggle decides whether the agent may create runtime environments; explicit setup and reinstall stay available either way. (#2058)
- **Network protection status in Settings → Runtimes** — a status-aware banner shows whether Notebook network protection is active, requires setup, or is unsupported, with a direct path to the domain settings — without overstating protection. (#2011)

## 🔧 Improvements

- Multi-version upgrades get faster: one recovery snapshot is now taken per upgrade batch instead of one per migration step, cutting upgrade time and disk churn on installs with large research histories. (#2039)
- Data-location migration shows the target drive's capacity and the estimated copy size before you commit. (#1984)
- Settings and About rows reveal their supporting descriptions on hover or keyboard focus instead of competing with primary labels. (#2023, #2026)

## 🐛 Bug Fixes

- **Delegation and side chats** — Codex subscription authentication now propagates to delegated work (#1953); archiving is blocked while delegated questions are pending (#2015); quit detection counts active side-chat replies (#2031); and delegated inputs keep stable identities. (#1974)
- **Notebook and runtimes** — protected kernel startup is restored (#1995); misleading sandbox warnings are gone (#1988); kernels no longer loop recovery attempts (#1998); injected runtime platforms are honored (#1981); runtime targets are respected in gating and restart (#2046); input and artifact file workflows are stabilized (#2050); interrupted responses are handled (#2063); environment preparation is shown after approval (#2036); managed runtimes survive failed updates (#1994); connection resets are contained (#2053); and prompt attachments stay readable in notebooks. (#2045)
- **Security and remote access** — raw credentials are redacted from tool activity (#2001); replay is scoped to remote authorization (#1999); external access resources are bounded (#2003); and transport boundaries are hardened. (#2035)
- **Sessions and storage** — project access is gated during data migration (#1996); archiving is blocked during compaction (#2000); retained session workspaces are revealed again (#2002); project deletion waits are scoped (#2038); writes stop flushing after a failure (#2040); session and project state contracts are aligned (#2044); and managed workspace ownership is preserved. (#2042)
- **Skills, artifacts, and compute** — the skill catalog can no longer deadlock during mutation (#2048); permanent finalization failures are classified correctly (#2061); large SSH commands stream reliably (#2062); and remote-compute examples return values instead of printing. (#2018)
- **Updates, platform, and workspace** — unsupported release-note languages are skipped cleanly (#2009); locked uninstaller targets are rejected on Windows (#2060); the app exits cleanly after a UI startup failure (#2030); quitting after a persistence failure asks for explicit consent (#2032); small upward scrolls are respected (#2007); notifications survive rejected targets (#2041); generated previews wait for publication (#2054); and the skills search placeholder is readable. (#2052)
