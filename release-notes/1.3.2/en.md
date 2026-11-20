## ✨ Highlights

- **Long conversations use less memory.** Streamed replies no longer accumulate hidden performance entries, and conversation bodies you are not viewing are reclaimed once they are safely saved — large sessions stay responsive without losing your place, pending edits, or active work. (#4500)
- **Kilo Gateway is an official provider.** Add it with or without an API key: an anonymous catalog refresh shows the free models your connection is eligible for, and the onboarding provider step can be skipped to decide later. Existing credentials and main-model choices are preserved on upgrade. (#4465)
- **Image model catalogs you can check.** Official image services for OpenAI, MiniMax, Bailian, and Volcengine Ark can refresh their bundled model list from the provider before you save, keeping your active model when it is still available. (#4474)
- **Reliable first messages in agent sessions.** Fresh default Agent, Claude Code, and Codex conversations no longer fail before their first model request, and the built-in Agent starts scheduled sessions with their intended prompt. (#4505, #4490)
- **PDF translation that keeps the native layout.** Wrapped titles, captions, definitions, and mathematical statements are recovered in reading order, and formulas, links, and graphics stay in their original places in the translated document. (#4492)

## ⚠️ Scope & Safety

- **Adding Kilo without a key contacts Kilo anonymously.** The catalog refresh that shows eligible free models is a request to Kilo's servers that carries no account identity. Image and model requests after setup go to Kilo like any other provider connection. See [data recipients](https://github.com/aipoch/open-science/blob/v1.3.2/docs/security.md#data-recipients). (#4465)
- **Checking an image model catalog contacts the provider.** A refresh sends the configured connection's credentials to that provider to list its image models, and a failed check cannot retract what was already sent. Run it only for connections you configured. See [data recipients](https://github.com/aipoch/open-science/blob/v1.3.2/docs/security.md#data-recipients). (#4474)

## 🚀 New Features

- Add Kilo Gateway as an official provider with an optional API key; an anonymous catalog refresh shows the eligible free models, and saving without a key keeps the model choice open. (#4465)
- The desktop onboarding provider step gains a Skip action that adds Kilo without a key and leaves the model decision to you; upgrades add any missing Kilo configuration without touching existing provider credentials or main-model choices. (#4465)
- Official image services for OpenAI, MiniMax, Bailian, and Volcengine Ark can check the provider's live image-model catalog on demand: matching bundled models are shown before saving, the active model is preserved, and a model kept as default but missing from the refreshed catalog is marked. (#4474)
- Bailian image-catalog requests are scoped to the workspace region, and China-linked credentials are limited to the China catalog. (#4474)

## 🔧 Improvements

- Long conversations and sessions use less memory: streamed replies no longer accumulate hidden performance entries, inactive conversation bodies are reclaimed once their durable copy matches, and live session updates reuse serialized copies for delivery and replay. (#4500)
- Notebook memory pressure is announced by a dismissible notice with a six-second expiry instead of occupying the workspace top row or opening a modal; refusal to start applies only to actual execution decisions, and recovery is announced once it completes. (#4499)
- The home screen names the specific reason a use-case download failed — a missing manifest, unavailable package, timeout, network, server, verification, disk-full, or storage problem — instead of a generic failure. (#4498)
- Replay keeps historical conversations clean: the ask and capture actions for completed steps appear on hover or keyboard focus, with full-size targets on touch or hybrid-pointer devices. (#4483)

## 🐛 Bug Fixes

- Fresh default Agent, Claude Code, and Codex conversations no longer fail before their first model request when Notebook authority preparation resumes an already-attached or history-less native session. (#4505)
- The built-in Agent opens scheduled sessions with their first prompt instead of interrupting an attached writer during Notebook credential refresh. (#4490)
- PDF translation recovers text that native extraction split across rows or page boundaries — titles, captions, definitions, and mathematical statements — and keeps formulas, reference text, links, and embedded graphics in their original locations during writeback. (#4492)
- Notebook startup no longer misreads a closed WSL command pipe as a failure. (#4500)

## 🙏 Acknowledgements

- Thanks to [@ShuangChenyue](https://github.com/ShuangChenyue) for specific use-case download failure reasons ([#4498](https://github.com/aipoch/open-science/pull/4498)).
- Thanks to [@liguohhh](https://github.com/liguohhh) for official image model catalog checks ([#4474](https://github.com/aipoch/open-science/pull/4474)) and the Kilo Gateway onboarding ([#4465](https://github.com/aipoch/open-science/pull/4465)).
