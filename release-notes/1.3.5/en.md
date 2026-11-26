## ✨ Highlights

- **Smaller macOS updates.** In-app updates on macOS now download signed deltas instead of ZIP blockmaps, so an update transfers only what changed — and a missing delta can no longer silently turn into a full download. (#4649)
- **Read literature without losing your place.** Figures and tables preview directly from in-text references, and selected passages translate in place — single-page image-only PDFs now open with a selectable text layer. (#4681, #4667)
- **More ways to connect models.** Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry, and Vectrust join the provider catalog, alongside dedicated Ollama, LM Studio, llama.cpp, and vLLM presets with local model discovery. (#4662)
- **A lighter, steadier app.** Transcript history and Notebook figures load on demand, home catalog scans and workspace typing cost less, and Notebook memory admission rechecks before continuing desktop work. (#4676, #4678, #4695)

## ⚠️ Scope & Safety

- **New provider connections send data to the endpoints you configure.** Requests through a cloud gateway (Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry, Vectrust) go to that provider under its terms; local presets (Ollama, LM Studio, llama.cpp, vLLM) keep traffic on the machine or network you point them at. Review the destination before routing sensitive project content through a newly added connection. See [data recipients](https://github.com/aipoch/open-science/blob/v1.3.5/docs/security.md#data-recipients). (#4662)

## 🚀 New Features

- Providers gain **cloud gateway presets** (Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry, Vectrust) with protocol-specific endpoints and authentication, and **local model presets** (Ollama, LM Studio, llama.cpp, vLLM) with local model discovery; cloud and local providers share an editable model list with display names, context windows, and reasoning effort. (#4662)
- Figures and tables **preview inline from in-text references** in the PDF reader, even when the paper links only the number or nothing at all. (#4681)
- The PDF reader can **translate a selected passage in place**, keeping your reading position; image-only single-page literature PDFs open with a selectable text layer. (#4667)
- Settings gains an **image service picker** that shows the official services before the custom form, and the provider list is reordered so active subscriptions surface first. (#4650)
- Windows desktop setup now installs the `open-science` command launcher, so external agents can drive the app right after a silent install. (#4679)
- External agents can run grouped CLI/MCP loops against the app through the shared agent adapter contract. (#4661)

## 🔧 Improvements

- Long sessions feel lighter: transcript history and Notebook figures load on demand instead of all at once, and home catalog scans and workspace typing do less work per keystroke. (#4676, #4678)
- Notebook memory admission rechecks available memory before continuing desktop work, and cross-platform memory thresholds are lowered to match real-world headroom. (#4695, #4643)
- Model availability is now explained by cause, so an unusable model tells you why instead of just failing. (#4696)
- Managed agent installs probe npm registries concurrently, cutting setup wait on slow networks. (#4660)
- Theme contrast and provider icon visibility are improved across light and dark modes. (#4655)

## 🐛 Bug Fixes

- PDF translation preserves native layout more faithfully, with improved scientific-PDF segmentation and writeback, and preview verification is separated so layout issues surface before delivery. (#4671, #4693, #4697)
- Session resume recovers when a model provider is temporarily unavailable, and resumed runs are validated against their durable recovery state instead of failing outright. (#4672, #4652)
- Provider bridge retries now preserve the original model error instead of masking it. (#4653)
- Notebook robustness: handoff metadata and saved shell output survive session recovery, startup probes stay scoped to the recovering lane, and captured figures render when tool rows expand. (#4657, #4647, #4677)
- Session packages route temporary space to the data root instead of the system drive. (#4665)
- Updates: the prominent update reminder is back, Windows upgrades tolerate transient runtime disconnects, and runtime downloads retry on network failure. (#4646, #4645, #4644)
- Research videos keep alt text for non-image targets, imported research navigation stays responsive, and captured working files no longer trigger spurious truncation warnings. (#4670, #4663, #4648)

## 🙏 Acknowledgements

- Thanks to everyone reporting update, Notebook, and model-provider issues in [Discord](https://discord.gg/zxQAYjReRv), [X](https://x.com/aipoch_ai), and [Discussions](https://github.com/aipoch/open-science/discussions).
- Thanks to [@liguohhh](https://github.com/liguohhh) for the cloud gateway and local model presets ([#4662](https://github.com/aipoch/open-science/pull/4662)).
- Thanks to [@nasus2002](https://github.com/nasus2002) for in-text figure and table previews ([#4681](https://github.com/aipoch/open-science/pull/4681)).
- Thanks to [@guch96](https://github.com/guch96) for the grouped CLI/MCP agent loop and Notebook memory rechecks ([#4661](https://github.com/aipoch/open-science/pull/4661), [#4695](https://github.com/aipoch/open-science/pull/4695)).
- Thanks to [@ShuangChenyue](https://github.com/ShuangChenyue) for concurrent registry probes and provider-outage session recovery ([#4660](https://github.com/aipoch/open-science/pull/4660), [#4672](https://github.com/aipoch/open-science/pull/4672)).
- Thanks to [@cyj1116](https://github.com/cyj1116) for Notebook handoff and shell-output recovery ([#4657](https://github.com/aipoch/open-science/pull/4657)).
