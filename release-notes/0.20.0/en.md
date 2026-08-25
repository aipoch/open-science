## ✨ Highlights

- **Session references (`#`).** Reference another session directly in the composer. The inserted chip navigates back to the target session, and the agent receives read-only access to the referenced session's visible transcript for that turn. (#1682)
- **Side-chat advisories in running main turns.** Advice from a side conversation now reaches the main agent while its turn is still running, through each framework's native follow-up channel instead of waiting for the next user message. (#1624)
- **Long pasted text as attachments.** Plain-text pastes over 10,000 characters or 300 lines become a managed attachment with a card in the composer; Show in text field restores the exact text and caret position, and undo re-stages the attachment. (#1678)
- **Long-session performance.** Transcript rendering is bounded and indexed with cached images and prefetching before the scroll edge, notebook history loads progressively in pages, startup defers transcript and runtime probes, and the usage panel caches its projection — long sessions open and scroll smoothly. (#1636, #1654, #1667, #1651, #1637, #1658)

## 🚀 New Features

- **Session references (`#`)** in the composer, with turn-scoped read access to the referenced session and clickable chips in drafts and sent messages. (#1682)
- **Session-number lookup in global search**, with exact matches ranked first and stable number metadata on session rows. (#1691)
- **Side-chat advisories injected into running main turns**, with durable relay to the next user turn when injection is not possible. (#1624)
- **Package installation progress** for notebook environments, showing requested count, elapsed time, and expectation guidance in the session activity. (#1650)
- **Scenario models card** in Settings, consolidating the subagent, reviewer, and vision model policies into one accordion alongside a merged main-model section. (#1645)
- **Simplified Marketplace navigation** — Installed is the management home with one primary Browse Marketplace action, and Marketplace is a separate route with an explicit return path. (#1644)
- **Localized update-dialog release notes** — dynamic release notes now follow the selected interface language. (#1664)

## 🔧 Improvements

- Transcript images are cached as bounded renderer blobs, and the next transcript batch is prefetched before the scroll edge. (#1636, #1654)
- Long-session transcript projections are indexed, keeping rendering linear as conversations grow. (#1667)
- Notebook run history loads progressively in pages with scroll anchoring and a bounded page cache. (#1651)
- Startup no longer opens the last session transcript or waits for runtime probes before entering Home. (#1637)
- The usage settings panel reuses a fresh projection for ten minutes instead of reloading on every visit. (#1658)
- Review history loads through batched, indexed queries. (#1689)

## 🐛 Bug Fixes

- **Permission denials now hold.** After you deny a permission, the agent is told it has no authorization for that operation and must not retry or approximate it through another route in the current turn. (#1653)
- **Notebook environments** expose runtime targets consistently, protect environments still bound to a session from removal, keep REPL errors concise for agents, validate interrupted environment prefixes, and reject flag-like package names in named environments. (#1671, #1672, #1670, #1688, #1687)
- **Provenance** captures handoff-directory producer execution and accepts producers from ancestor conversation branches. (#1659, #1660)
- **Artifact finalization** keeps a completed run visible after a later save conflict. (#1647)
- **Connectors** handle versioned IDs and request timeouts with clearer failures, and surface actionable gate errors. (#1639, #1663, #1655)
- **Sessions and workspace** publish side-chat session updates, wake the main agent after delegated work settles, link Codex resume errors to Agent settings, keep the mobile sidebar usable, and prevent duplicate onboarding submissions. (#1642, #1532, #1676, #1668, #1674)
- **Python dependency analysis** scopes uncertainty to conditionally defined names, restoring accurate cross-run tracking. (#1640)
- **Concurrent CLI sessions** preserve their selected compute host bindings. (#1661)
- **Settings** align package-install controls with runtime ownership and stabilize token usage refresh. (#1648, #1638)
- **Renderer events** deliver reliably and isolate failing subscribers. (#1646, #1666)

## ⚠️ Breaking Changes

- **Host SDK result fields are camelCase.** Agent-facing Host SDK results that previously used snake_case fields (delegation receipts, frames, lineage, help descriptors) now use camelCase. Skills and scripts that read these fields must switch to the camelCase names; user-owned structured output is unchanged. (#1643)
