# Released legacy Session JSON fixture

`open-science-1.0.8-session.v2.json` is a real Session document produced by Open-Science **1.0.8**
(old baseline `495361a2b1103170a8240ef59d4b8ff93529c17f`) on 2026-11-13, archived from
`.scratch/upgrade-json-real-20261113/artifacts/legacy-before-upgrade.json` after the real
old-build → current-build upgrade probe.

Only unstable identity fields were replaced to make it safe to commit:

- `session.projectId`: `legacy-project-id`
- `session.cwd`: `/legacy/workspace`

The test replaces those two fields again at runtime with the project and directory it creates.
It supplies the fake provider's `agentConfiguration` so the test can continue the conversation.
Opening the session may materialize the defaults `description: ""` and `filesRevision: 0` and
increment `session.revision` once. The test compares the complete document after the renderer
flushes, including the original messages, branch graph, timestamps, and envelope version.

Original archived sample SHA-256:
`336e6d4250d6847179c6d2afd65fd7be4241fa3f337bb806af322877d39adf59`.

Shape that makes it a released-1.0.8 sample:

- single JSON envelope with `version: 2` (not the current newline-delimited `.jsonl` stream);
- `session.conversationGraph.schemaVersion: 1` with frames, branches, and graph messages;
- legacy session fields such as `number`, `revision`, `permissionProfile`, `autoReviewEnabled`,
  `memoryEnabled`, and `delegationPolicy`;
- no `agentConfiguration`, because 1.0.8 did not persist it.
