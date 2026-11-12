## ✨ Highlights

- **One place for every resource.** The Resource Center now manages skills, connectors, and specialists — including Marketplace installation, also in the Web UI — with shared cards, filters, and detail views, and Skill references open in the project pane without leaving the conversation. (#4270)
- **Scientific prompt optimization.** Refine the current project's prompt from the composer with one click; review, edit, or undo the result, and save custom templates in Project settings. Optimization only runs through your configured provider when you invoke it. (#3991)
- **A stronger built-in Agent.** Codex subscription accounts are now available for the main agent and subagents, Claude Fable 5.2 joins the model list, and long answers are no longer cut short at 4,096 tokens. (#4250, #4249, #4275)
- **Long research sessions export without stalling.** Notebook and Compute runs store their evidence once in a compact, verifiable form, so `.science` exports of long histories stay fast and small. (#4248, #4258, #4240)
- **Cloud compute sign-in that survives real networks.** Modal and Hugging Face provision a compatible Python runtime before opening the browser, and account verification now follows your system proxy. (#4255)

## 🚀 New Features

- Manage Skills, Connectors, and Specialists — and install from the Marketplace, including in the Web renderer — from the unified Resource Center, with consistent catalog cards, filters with reset, bulk selection, and detail drawers; Skill references from the composer and sent messages open in the project Resource Center pane without disturbing the active conversation or draft. (#4270)
- Optimize the active project's prompt from the composer: review and edit the result before it replaces the draft, Undo restores the previous text and any removed pasted attachments, and custom optimization templates live in Project settings. Optimization is manual and runs through the configured provider only when invoked. (#3991)
- Use imported or app-owned Codex subscription accounts for the main agent and subagents in the built-in Open-Science Agent, with sign-in, refresh, and credential replacement reusing the existing Codex connection flows. (#4250)
- Select Claude Fable 5.2 with a 1M context window from the bundled Anthropic model list. (#4249)
- Export bibliography metadata as CSV alongside BibTeX and RIS — selected references across pages with individual exclusions, or an entire project or collection — using 16 stable English column names, with empty cells for missing values. (#4262)

## 🔧 Improvements

- The built-in Agent honors each model's advertised output limit (the configured value, then exact vendor metadata, then a 16,384-token fallback) and prefers each model's native endpoint protocol, so provider-supported long answers arrive complete. (#4275)
- The built-in Agent measures its context usage correctly and compacts much later in long sessions. (#4209)
- An answered Agent question no longer waits on a deferred persistence flush, removing the "completion has not committed yet" stall before the answer continues. (#4279)
- Modal and Hugging Face compute targets share one Python-runtime preparation flow: the selected interpreter is checked without installing into it, authorization and SDK calls stay bound to it, and a stale authorization result can no longer overwrite a newer connection. (#4255)
- Notebook and Compute evidence is stored once per unique content with verified digests; exports of long histories — hundreds of runs over the same files — produce compact packages, and the first export backfills historical evidence. (#4248, #4258, #4240, #4259)
- Research film generation continues when you switch sessions, instead of stopping with the conversation that started it. (#4268)
- Idle Python, R, REPL, and Shell interpreters are reclaimed after 15 minutes without session activity, with small per-kind pools, so finished conversations no longer accumulate resident runtimes. (#4274)
- The context-reset notice dismisses itself after six seconds, and resource catalog cards keep their usage avatars compact. (#4281, #4276)

## 🐛 Bug Fixes

- Notebook files attached in chat open a preview again, and local file links in replies open the corresponding file. (#4257)
- Signed Windows update packaging is unblocked, and update recovery names the files and processes holding the app, prunes closed startup logs, and resolves blockers without wedging the installer. (#4233, #4230, #4231, #4247)
- Literature imports preserve identifier routing and DOI letter case. (#4225)
- Website source previews are responsive again in narrow layouts. (#4220)
- External PDF structure recovery hardens against damaged files, and PDF translation isolates per-document agent prompts and tool capabilities. (#4238, #4228)
- Mobile pairing stays off until you select it, and web remote-control RPC failures explain what happened instead of failing silently. (#4221)
- Provider error details survive through the agent runtime, and OpenCode request-classification failures no longer leak beyond the request that hit them. (#4237, #4261)
- Conversation commits acknowledge terminal events reliably, authorized local CLI imports work again in session packages, and first-message navigation is restored in long conversations. (#4269, #4267, #4260)
- Linux recovery no longer mistakes confirmed kernel threads for leaked Notebook processes. (#4265)

## 🙏 Acknowledgements

- Thanks to [@wen2zhou](https://github.com/wen2zhou) for Codex subscription support in the built-in Agent ([#4250](https://github.com/aipoch/open-science/pull/4250)), Modal and Hugging Face runtime preparation ([#4255](https://github.com/aipoch/open-science/pull/4255)), and chat file previews ([#4257](https://github.com/aipoch/open-science/pull/4257)).
- Thanks to [@roxi3906](https://github.com/roxi3906) for project-scoped prompt optimization ([#3991](https://github.com/aipoch/open-science/pull/3991)).
- Thanks to [@nasus2002](https://github.com/nasus2002) for the bibliographic CSV export ([#4262](https://github.com/aipoch/open-science/pull/4262)) and DOI handling fixes ([#4225](https://github.com/aipoch/open-science/pull/4225)).
- Thanks to [@guch96](https://github.com/guch96) for the answered-question continuation fix ([#4279](https://github.com/aipoch/open-science/pull/4279)) and Windows update recovery ([#4230](https://github.com/aipoch/open-science/pull/4230)), to [@cyj1116](https://github.com/cyj1116) for mobile pairing improvements ([#4221](https://github.com/aipoch/open-science/pull/4221)), and to [@daanveer-tech](https://github.com/daanveer-tech) for the README benchmark documentation ([#4219](https://github.com/aipoch/open-science/pull/4219), [#4227](https://github.com/aipoch/open-science/pull/4227)).
