## ✨ Highlights

- **Scientific connectors reach native source APIs.** Europe PMC gains direct Boolean, core and abstract search with explicit pagination, alongside new HGNC gene metadata, ChEA3 enrichment ranks, bioDBnet conversions and orthology, Cellosaurus RDF knowledge-graph queries, STR similarity, and official file discovery for NHANES, PhysioNet, openFDA and CTD — all opt-in and returning official URLs with provenance rather than opaque downloads. Queries and identifiers you submit — search terms, gene names, DOIs — are sent to the respective public services, and access-gated sources are listed with official access instructions only; the app never asserts your authorization. (#3869)
- **Track reading progress in the literature library.** References can be marked Unread, In progress, or Finished reading; the status shows in a dedicated column, edits inline or from the details page, updates in bulk across pages and exclusions, and filters the library with consistent counts and selection scope. (#3897, #3907)
- **Session packages work in the browser.** Local Web deployments can export a `.science` package as a download and import one through an upload picker — no CLI fallback needed when working entirely in the browser. An exported package contains the conversations, files, notebook records, and provenance you selected, and browser transfers run between your browser and your own local service. (#3911)
- **Service lifetime follows your intent.** Keeping the app open or running `open-science start` holds the local service alive; closing one window no longer stops it or unrelated background work. Plain `stop` releases your hold, and `stop --force` requests a whole-service shutdown. While a hold is active, the service and its background work keep running until you release the hold or force the shutdown. (#3769)

## 🚀 New Features

- The Home page gains a use case gallery: browse published examples, open their details, and import a verified session package with download progress and cancellation. (#3901)
- Manual update entry points: persistent download and instruction links in Settings and update surfaces, plus a read-only command that reveals the confirmed installer. (#3902)
- Settings → About links the project's security policy. (#3906)
- Authorized directories render as a compact folder list with read/write badges and grant-time tooltips, instead of raw JSON. (#3871)

## 🔧 Improvements

- DOCX reports preserve intended table styles, borders and page layout during generation and preview, and a maintained, template-based Markdown-to-DOCX conversion workflow is available on demand. (#3811)
- Publication-check results present one short action with Crossref attribution and last-check time. (#3896)
- Reference details consolidate tags and type into the header, with repetitive explanations removed. (#3910)
- Imported session package and replay surfaces drop redundant diagnostics and give their actions consistent, visible boundaries. (#3908)
- Windows managed R requests for Bioconductor packages now explain the explicit BiocManager route instead of failing with a generic Conda error. (#3918)

## 🐛 Bug Fixes

- Full-access sessions admit public network destinations without approval prompts, and downgrading Full closes existing connections. (#3898)
- Settings → Network immediately reflects global domain grants made from approval dialogs. (#3900)
- OpenCode 2.x runtimes start and work again, with the 1.x path retained. (#3903)
- macOS notebooks find CLI tools whose Node runtime lives outside the app's inherited PATH. (#3916)
- Windows chats no longer wait on protection configuration before a provider request starts. (#3922)
- Notebooks read application-managed skill reference files without a folder-access prompt. (#3920)
- Collapsing tool groups preserves your reading position. (#3873)
- Wide Markdown tables reveal their scrollbar on hover and keyboard focus. (#3875)
