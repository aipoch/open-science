## ✨ Highlights

- **See inside the built-in Agent.** Projects can opt in to Agent tracing, exporting correlated spans for turns, model requests, and tool executions to an OTLP/HTTP receiver you host — generic collectors and Langfuse are supported — with capture detail you control. (#4514)
- **Windows updates, unblocked and smaller.** An in-app update no longer stalls when the built-in Agent is running: the updater now recognizes the app's own Agent processes instead of failing closed. Stable Windows updates also apply as compact installer deltas again — v1.3.3 fell back to the full installer. (#4602, #4606, #4611, #4605)
- **Long Notebook histories stay fast.** Starting and finishing Runs, selecting results, and opening previews no longer re-read the whole history, and eligible Run transitions are batched into durable checkpoints. (#4615, #4617)
- **Memory readings you can trust.** On macOS, the Compute summary now matches Activity Monitor by excluding cached memory; on Windows, committed memory against its limit is shown alongside physical memory. (#4599, #4600)

## ⚠️ Scope & Safety

- **Agent tracing sends data to a receiver you configure.** Project tracing is off by default and only starts when a project enables it; for a single CLI Run, `--otel-traces` (or `otelTraces: true` in the SDK) is an explicit per-run opt-in that does not require the project switch. In both cases the spans — turn structure, model requests, and tool executions at your chosen capture detail — go only to the OTLP/HTTP endpoint set in the app's launch configuration, never to an app-operated service. Choose a receiver you control and review the capture switches before enabling tracing on shared machines. See [data recipients](https://github.com/aipoch/open-science/blob/v1.3.4/docs/security.md#data-recipients). (#4514)

## 🚀 New Features

- Projects gain an opt-in **Agent tracing** switch: when enabled and a receiver is configured, the built-in Agent exports correlated OTLP/HTTP JSON spans for turns, model requests, and MCP tool executions to generic collectors or Langfuse. Four detail switches tune what is captured, and a local upload-status switch reports delivery health. (#4514)
- CodeBuddy connections discover each model's supported reasoning efforts during sign-in and catalog refresh; the effort picker then offers only the levels the selected model actually supports. (#4619)
- The Zhipu model catalog now lists GLM-5.4, available directly on Zhipu connections. (#4637)

## 🔧 Improvements

- Long Notebook histories cost less: a bounded, validated history view replaces repeated full reads when starting or finishing a Run, selecting results, or opening previews, and eligible Run transitions are written to durable per-lane slots that fold into checkpoints. (#4615, #4617)
- The Compute system summary aligns with each platform's native accounting: macOS usage matches Activity Monitor (cached memory excluded), and Windows shows committed memory against its limit with tuned default thresholds. (#4599, #4600)

## 🐛 Bug Fixes

- On Windows, an in-app update no longer stalls when the built-in Agent or the image helper is running — both are now recognized as the app's own installation helpers, and helper registration is enforced automatically so a new helper can never be missed again. (#4602, #4606, #4611)
- Stable Windows releases again publish the compact installer delta used for delta updates; a missing delta for an already-published release can be repaired without re-shipping the version. (#4605)
- CodeBuddy film subscriptions now prepare their first model request correctly, and built-in Agent side chats keep their checkpoints under the chat's own profile. (#4616)
- Generated edit-image versions open reliably in the full image preview while their version is still being published. (#4603)
- Explicit upstream HTTP statuses are surfaced as provider facts: a 402 such as "Insufficient Balance" now shows an actionable billing explanation with the status and safe provider details preserved. (#4601)
- On Windows, the first Python plotting flow no longer stalls on a leftover kernel-recovery fence from an unrelated lane. (#4620)
- When a tool action is denied, the turn now ends with a durable explanation instead of going silent, and denial counts stay distinct from completed work. (#4517)
- CodeBuddy connections restore the selected model when resuming a history-bearing session, so token-usage updates keep flowing. (#4631)
- Research-film generations stay visible: the conversation remains in Active with its film status shown, and a blocked film dialog can open the conversation that owns the generation. (#4633)
- The built-in Agent accepts tool continuations that carry null identity fields instead of failing the turn. (#4638)

## 🙏 Acknowledgements

- Thanks to everyone reporting update, Notebook, and memory-monitoring issues in [Discord](https://discord.gg/zxQAYjReRv), [X](https://x.com/aipoch_ai), and [Discussions](https://github.com/aipoch/open-science/discussions).
- Thanks to [@wen2zhou](https://github.com/wen2zhou) for the project-scoped Agent tracing and per-run CLI tracing contributions ([#4514](https://github.com/aipoch/open-science/pull/4514), [#4618](https://github.com/aipoch/open-science/pull/4618)).
