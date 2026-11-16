## ✨ Highlights

- **Strict Notebook networking.** An opt-in Strict mode replaces authorization offers with a manually managed whitelist: a request is allowed only when it matches your rules by protocol, hostname or IP, and port — unmatched requests are blocked outright. Relaxed mode remains the default and keeps the existing approval behavior. (#4253)
- **Research films resume from checkpoints.** Interrupted film generation continues with validated work intact: completed scenes, narration, timings, and mix are reused across process restarts, the dialog shows the current of five steps, and you choose resume or fresh generation. (#4290)
- **PDF round-trip fidelity.** External PDFs recover complete native figures, captions, table records, and reading order, and translated documents keep the original structure and layout instead of falling back to unproven placement. (#4300, #4342, #4340, #4334, #4286)
- **Safer Windows grants and updates.** Folder grants in protected mode are validated before they are saved; update, uninstall, and handoff flows recover more reliably, name what blocked them, and preserve their diagnostics. (#4217, #4305, #4327, #4328, #4337, #4346)
- **Provider catalog refresh.** Qwen4 Max Preview joins Bailian Token Plans in Beijing and Singapore with a 1M context window, and default models for official connections are updated. (#4311, #4301)

## 🚀 New Features

- Switch Notebook networking to Strict mode: requests must match a manually managed whitelist by protocol, hostname or IP, and port, and unmatched requests are blocked without offering authorization. Manage rules as editable logical groups with provenance tags; the pre-existing built-in destinations are seeded once and edits persist. Review the seeded rules before relying on the mode, since blocked requests fail instead of asking. (#4253)
- Resume interrupted research-film generation from validated checkpoints: completed helpers and scenes survive a later failure, narration and timings are cached independently of the player build, and the Film dialog shows the current step of five with explicit resume or fresh generation choices. (#4290)
- Preflight Windows folder grants in protected mode with a read-only ACL check before saving: unusable folders are rejected with their reason before any grant is written, so Notebook execution no longer fails later with a hidden kernel-start error. (#4217)
- Select Qwen4 Max Preview from Bailian Token Plans in Beijing and Singapore: 1M context window, multimodal input, and low/medium/xhigh reasoning efforts, resolved through the existing region selector and key console. (#4311)

## 🔧 Improvements

- External PDF structure recovery preserves complete figures with their captions, table records and cells, and native inline reading order around scaled text and running headers. (#4300, #4342, #4340)
- Translated PDFs keep native structure and layout: placement requires verified target-owned evidence, and the original content is retained whenever placement cannot be proved. (#4334, #4286)
- Session package imports report their outcome: cancellation returns a nonzero result, request timeouts are marked unconfirmed with a check-before-retry advice, and missing files or malformed archives get distinct error codes with a log correlation ID. (#4338)
- Default models for official provider connections are updated to current recommendations. (#4301)
- Preview surfaces adapt to mobile viewports. (#4325)
- A configured data root can be addressed through registered aliases. (#4306)
- The local CLI keeps credential profiles intact, tolerates console failures, and keeps artifact downloads alive while data arrives. (#4298, #4299)

## 🐛 Bug Fixes

- When the desktop loses its local service, a window-wide recovery surface now blocks workspace interaction until the connection returns, keeping drafts mounted and restoring focus afterward. (#4323)
- Windows update and uninstall flows separate update safety from record cleanup, scan physical installation resources, reap owned helpers before handoff, cancel host checks promptly, identify processes by birth identity rather than PID alone, and preserve failure diagnostics. (#4305, #4327, #4328, #4337, #4346)
- Interrupted Windows kernel jobs recover, and PowerShell stderr redirection no longer swallows native Notebook output. (#4297, #4295)
- Session persistence avoids deletion-cleanup deadlocks and decouples startup hydration from active saves. (#4312, #4314)
- Agent runtime errors distinguish model provider failures from ACP failures, reloaded sessions stay protected until prompt activation, and cancelled prompts interrupt classification lookups. (#4322, #4283, #4289)
- Unrelated saved folder grants no longer block Notebook startup. (#4309)
- Previews keep content in place during version checks. (#4293)
- Direct SSH job cancellation bounds unconfirmed cancellation attempts. (#4313)
- Contrast is preserved across light and dark surfaces, including dark-mode avatars, replay input, and theme transitions. (#4345, #4339, #4332)
- The desktop exits after the first uncaught main-process error instead of limping on in a broken state. (#4316)
- Environment review status is worded distinctly from other review states, and literature entries accept LaTeX package lists with flexible whitespace. (#4347, #4303)

## 🙏 Acknowledgements

- Thanks to [@roxi3906](https://github.com/roxi3906) for the strict Notebook whitelist mode ([#4253](https://github.com/aipoch/open-science/pull/4253)) and the risky-code presentation fixes ([#4318](https://github.com/aipoch/open-science/pull/4318), [#4282](https://github.com/aipoch/open-science/pull/4282)).
- Thanks to [@ShuangChenyue](https://github.com/ShuangChenyue) for the Windows folder-grant preflight ([#4217](https://github.com/aipoch/open-science/pull/4217)).
- Thanks to [@liyeshunag](https://github.com/liyeshunag) for the CLI credential-profile fixes ([#4298](https://github.com/aipoch/open-science/pull/4298)) and cancelled-prompt handling ([#4289](https://github.com/aipoch/open-science/pull/4289)).
- Thanks to [@cyj1116](https://github.com/cyj1116) for the mobile preview surfaces ([#4325](https://github.com/aipoch/open-science/pull/4325)) and artifact download fixes ([#4299](https://github.com/aipoch/open-science/pull/4299)), to [@wen2zhou](https://github.com/wen2zhou) for SSH cancellation bounds ([#4313](https://github.com/aipoch/open-science/pull/4313)) and PowerShell output preservation ([#4295](https://github.com/aipoch/open-science/pull/4295)), to [@liguohhh](https://github.com/liguohhh) for reloaded-session protection ([#4283](https://github.com/aipoch/open-science/pull/4283)), to [@nasus2002](https://github.com/nasus2002) for LaTeX literature parsing ([#4303](https://github.com/aipoch/open-science/pull/4303)), to [@guch96](https://github.com/guch96) for session persistence ([#4314](https://github.com/aipoch/open-science/pull/4314)), and to [@daanveer-tech](https://github.com/daanveer-tech) for the README updates ([#4292](https://github.com/aipoch/open-science/pull/4292), [#4294](https://github.com/aipoch/open-science/pull/4294), [#4324](https://github.com/aipoch/open-science/pull/4324)).
