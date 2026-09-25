## ✨ Highlights

- **Code-signed Windows installers.** Stable Windows packages are now signed, so the SmartScreen "unrecognized app" warning no longer appears on first launch. (#2980)
- **STRING protein-interaction enrichment.** The protein-annotation connector gains a STRING PPI enrichment analysis that scores the functional associations among your gene list. (#2984)
- **Persistent live-source previews.** Browser previews of live sources now use a persistent session, so sign-ins and state survive app restarts. (#2824)

## 🚀 New Features

- Windows installers are code-signed — first launch is a normal, warning-free experience. (#2980)
- STRING PPI enrichment in the protein-annotation connector: submit a gene list and retrieve enrichment scores and the scored interaction network. (#2984)
- Live-source browser previews run in a persistent partition, keeping your session between visits and across restarts. (#2824)
- Library Auto permission mode interrupts less often, asking for approval only where it matters during routine work. (#2983)

## 🔧 Improvements

- App downloads now point to the official download page, with verification notes linked from there. (#2987)

## 🐛 Bug Fixes

- **Delegation** — completed results survive cleanup failures instead of being dropped (#2977); the Figure Composer delegation workflow is refreshed (#2981).
- **Workspace** — file type icons now appear in preview headers, matching the workspace lists (#2982); smart collection options get tighter, more consistent spacing (#2985).
- **Notebook** — retained macOS cleanup obligations are isolated so notebook work is not blocked by unrelated cleanup bookkeeping (#2919).
- **Agent runtime** — native Responses routing and teardown cancellation are preserved (#2972).
- **Codex backend** — plugin and app discovery is disabled, reducing unexpected background activity (#2979).
