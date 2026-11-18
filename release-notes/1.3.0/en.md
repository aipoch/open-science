## ✨ Highlights

- **Scheduled research tasks.** Set up recurring or one-time schedules that launch sessions and Notebook tasks on their own — each run opens in the workspace with its own record, and you stay in control with clear run history. (#4380)
- **Image generation and editing.** Generate images from a prompt with your configured provider, then iterate: each edit keeps a new version, so you can compare, revisit, and reuse earlier variants across the project. (#4424)
- **Editable presentations.** PowerPoint files open for editing: revise text with formatting — fonts, sizes, colors, alignment — and keep the file's structure intact, all inside the app. (#4392)
- **Research films, replayed.** Film operations can be replayed onto new branches with independent outputs, films open straight from the session menu, and the film dialog explains token usage before you generate. (#4389, #4414)
- **Smarter agent questions.** When the agent needs your input, it now lays out the trade-offs between the options it offers, so you can decide with the consequences in view. (#4357)

## ⚠️ Scope & Safety

- **Scheduled tasks run with your project's permissions.** A schedule launches its session or Notebook run without a further confirmation while the app is running. The run acts with the folders, credentials, and network access already granted to that project, and it consumes your configured provider quota. Review the schedule's target, cadence, and the project's grants before enabling it, and pause or delete schedules you no longer want. See the [scheduled-task boundary in the known-limitations register](https://github.com/aipoch/open-science/blob/v1.3.0/docs/known-limitations.md). (#4380)
- **Image generation and editing disclose prompts and source images to your configured provider.** Generation requests and the images used as their source are transmitted through the provider connection you configured, and cancelling or deleting locally cannot retract bytes the provider has already received. Review the provider's data terms before generating from sensitive material. See [data recipients](https://github.com/aipoch/open-science/blob/v1.3.0/docs/security.md#data-recipients). (#4424)

## 🚀 New Features

- Create scheduled tasks that launch a session or run a Notebook on a recurring or one-time cadence: each scheduled run opens in the workspace as its own record, with run history kept per schedule. (#4380)
- Generate images from prompts through your configured provider and edit them with follow-up instructions: every generation and edit stores a new artifact version, and earlier variants stay available for comparison and reuse. (#4424)
- Edit PowerPoint presentations in place: select and revise text with fonts, sizes, colors, and alignment while the slide structure is preserved. (#4392)
- Replay research-film operations onto a different branch and get an independent output without touching the original film. (#4389)
- Open generated research films directly from the session menu, and see an up-front explanation of how many tokens film generation will use. (#4414)
- Monitor running Notebook processes from the app and stop the ones the app owns when they are no longer needed. (#4399)
- Document and figure skills come ready to use: their supporting libraries are preinstalled into the managed environment on first use instead of failing mid-task. (#4411)

## 🔧 Improvements

- Long conversation histories persist incrementally, so large sessions save continuously, reload faster, and stay responsive while they grow. (#4378)
- The app reaches the project home sooner at startup by trimming work that blocked the first screen. (#4398)
- Stalled film generation, research-package transfers, and background deliveries recover on their own instead of waiting for a restart. (#4372)
- Windows installs and updates use a leaner, more reliable packaging pipeline, and update readiness checks are bounded so they cannot hang the flow. (#4420, #4417)
- Recovery scheduling for compute targets runs on demand instead of on a fixed timer, reducing idle overhead. (#4375)
- Skill references align with the public OpenCode 2.x skill names, so imported skills resolve as expected. (#4355)
- External PDFs recover their native structure more reliably during analysis and translation, the reader consolidates its toolbar, and image-support limits explain themselves instead of failing silently. (#4361, #4360, #4435, #4407, #4394, #4400)
- The composer keeps send controls reachable in narrow layouts, shows context usage accurately, and reveals the scroll-to-latest arrow when you hover the conversation. (#4367, #4403)
- First paint of long conversations is capped so the window opens quickly even with many loaded messages. (#4376)

## 🐛 Bug Fixes

- Sessions keep their correct numbering when records are repaired, and journal replay no longer repeats work or rescans history unnecessarily. (#4368, #4432, #4428)
- Agent runtimes release their resources across agent lifecycles, so repeated runs do not accumulate overhead. (#4396)
- Skill reloads no longer interrupt in-progress session creation. (#4427)
- Agent handoffs preserve their metadata even when tool results are truncated. (#4413)
- Artifact downloads through the local CLI no longer time out while data is still arriving. (#4430)
- Remote task requests and downloads honor the caller's lifetime, so abandoned operations stop promptly. (#4390)
- Terminal Ray jobs are removed after harvest instead of lingering on the target. (#4386)
- ACP resource links are accepted again. (#4381)
- Science packages open the available imported film mode instead of failing. (#4419)
- Previews keep their filename identity in narrow surfaces, run marks land at the right positions, and the project switcher keeps its scrolling inside the list. (#4401, #4350, #4405)
- Notebook frame transcripts paginate steadily, and Markdown footnotes keep their scroll contained. (#4370, #4391)

## 🙏 Acknowledgements

- Thanks to [@cyj1116](https://github.com/cyj1116) for editable presentations ([#4392](https://github.com/aipoch/open-science/pull/4392)), the PDF reader refinements ([#4394](https://github.com/aipoch/open-science/pull/4394)), handoff metadata preservation ([#4413](https://github.com/aipoch/open-science/pull/4413)), and CLI download timeout fixes ([#4430](https://github.com/aipoch/open-science/pull/4430)).
- Thanks to [@wen2zhou](https://github.com/wen2zhou) for option trade-offs in agent questions ([#4357](https://github.com/aipoch/open-science/pull/4357)), Notebook process monitoring ([#4399](https://github.com/aipoch/open-science/pull/4399)), and preview filename identity ([#4401](https://github.com/aipoch/open-science/pull/4401)).
- Thanks to [@fengdwx](https://github.com/fengdwx) for incremental session-history persistence ([#4378](https://github.com/aipoch/open-science/pull/4378)).
- Thanks to [@roxi3906](https://github.com/roxi3906) for run-mark navigation stability ([#4350](https://github.com/aipoch/open-science/pull/4350)), to [@BobbyLin7](https://github.com/BobbyLin7) for the OpenCode skill-name alignment ([#4355](https://github.com/aipoch/open-science/pull/4355)), and to [@daanveer-tech](https://github.com/daanveer-tech) for the README updates ([#4433](https://github.com/aipoch/open-science/pull/4433)).
