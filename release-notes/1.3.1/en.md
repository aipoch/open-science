## ✨ Highlights

- **Web search and page reading for the built-in agent.** The Open-Science Agent can search the web and read public pages. Search approvals show the query and its filters in a readable card, and the sources it cites stay with the conversation across restarts, branches, and research packages. (#4448, #4471)
- **Interactive citation graph.** A paper's references and citing papers appear as a graph you can explore. Re-center the graph on any related paper, filter by direction, and return to the original paper. (#4418, #4467)
- **Use your agent through MCP without opening the app.** When an external agent connects to Open-Science through MCP, the background service starts on its own. The setup guide now covers more than 30 agents and clients. (#4470, #4464)
- **Lab models and organization cases.** Sign in with a Lab account to use the models your organization assigns, and search, import, or share research cases with your teammates. (#4447)
- **Fresh model lists and clearer provider errors.** Refresh a provider's model list from Settings. When a provider request fails, the conversation names the cause and offers the matching next step. (#4415)

## ⚠️ Scope & Safety

- **Updating from 1.3.0 may need a manual installation.** The 1.3.0 updater can mistake one of the app's own background processes for another program and refuse to install. This release cannot change the updater that is already running in 1.3.0. If the update reports that another process is using the installation, fully quit Open-Science and its background service, then install the downloaded package manually. Your profiles and research data stay as they are. Updates that start from 1.3.1 are not affected. See the [known-limitations register](https://github.com/aipoch/open-science/blob/v1.3.1/docs/known-limitations.md). (#4454)
- **Web search and page reading contact outside services.** Search queries go to Exa, a third-party search service, without an account. Reading a page contacts that page's website. Both tools follow your permission mode, and stopping a request cannot retract what was already sent. See [data recipients](https://github.com/aipoch/open-science/blob/v1.3.1/docs/security.md#data-recipients). (#4448)
- **Lab sign-in changes where requests go.** With a Lab account, requests to Lab models go through the Lab server you sign in to. Sharing a case uploads that session's research package to that server for your organization. Review the package before you share it, and review an organization case before you import it. (#4447)
- **Connecting an agent keeps the service running.** Connecting an external agent starts the background service, and the service keeps running after the agent disconnects. Stop it with `open-science stop` when you no longer need it. (#4470)

## 🚀 New Features

- The built-in Open-Science Agent can search the web and read public pages. It cites its sources, and those sources stay available offline, across branches, and in research packages that allow it. (#4448)
- Web search approvals show the query, time range, result limit, and domain filters in a readable card. (#4471)
- Explore a paper's citation network as an interactive graph. Choose All, References, or Cited by, follow arrows that show citation direction, re-center on any related paper, and return to the original paper. (#4418)
- External agents connected through MCP start or reuse the Open-Science service for your profile when they connect, so you no longer need to open the app first. (#4470)
- The README and CLI guide include an external-agent quick start, with setup options for more than 30 agents and local clients and a first call that confirms the connection. (#4464)
- Sign in with a Lab account to use your organization's models and track their usage. Search your organization's research cases, import verified cases, and upload a session to share it with a share code. (#4447)
- Refresh a provider's model list from Settings. A failed refresh keeps the previous list. (#4415)
- Image services can run an optional test generation before you save them. Saving a new image service selects its first model when no default model is set. (#4455)

## 🔧 Improvements

- Provider failures name their cause in the conversation, including authentication, quota, rate limits, unavailable models, connection loss, interrupted responses, and context limits, and offer the matching recovery action. (#4415)
- Notebook runs check available memory before they start. When the system is low on memory, a run is not started and you can retry it yourself. From Compute, you can choose a session and release its Notebook resources while active work stays protected. (#4374)
- The project home appears sooner at startup. Session details load when you open a session instead of all at once. (#4434)
- When the saved research folder is missing, the startup recovery dialog shows that folder's path and asks you to reconnect the drive. (#4472)
- First-run onboarding on Windows no longer stops at the optional WSL step. You can set up WSL2 Bash later in Settings → Runtimes. (#4463)
- Windows installation failures show their diagnostics faster. (#4457)
- Citation graph arrows meet their target papers, and the off-screen hint takes less space on small screens. (#4467)

## 🐛 Bug Fixes

- In-app updates no longer treat the app's own background log process as another program that blocks installation. (#4454)
- Windows uninstall and update no longer fail when the settings file is large. (#4469)
- After a reconnect, sessions keep unsent drafts, load long branched histories, and accept answers to questions restored after a crash. Renaming or pinning a session no longer overwrites newer changes. (#4460)
- A session whose details failed to load no longer retries that load over and over. (#4452)
- New agent sessions no longer show repeated literature warnings while they start. (#4462)
- Deleting an imported session on Windows removes its files and records completely. (#4459)
- A Notebook session opened on its own loads the agent's conversation history instead of starting without it. (#4461)

## 🙏 Acknowledgements

- Thanks to [@wen2zhou](https://github.com/wen2zhou) for built-in web search and page reading ([#4448](https://github.com/aipoch/open-science/pull/4448)).
- Thanks to [@nasus2002](https://github.com/nasus2002) for the interactive citation graph ([#4418](https://github.com/aipoch/open-science/pull/4418), [#4467](https://github.com/aipoch/open-science/pull/4467)).
- Thanks to [@ShuangChenyue](https://github.com/ShuangChenyue) for Lab models and organization case sharing ([#4447](https://github.com/aipoch/open-science/pull/4447)).
- Thanks to [@liguohhh](https://github.com/liguohhh) for model-list refresh and clearer provider errors ([#4415](https://github.com/aipoch/open-science/pull/4415)).
- Thanks to [@guch96](https://github.com/guch96) for Notebook memory checks and resource release ([#4374](https://github.com/aipoch/open-science/pull/4374)), and to [@liyeshunag](https://github.com/liyeshunag) for the literature warning fix in new sessions ([#4462](https://github.com/aipoch/open-science/pull/4462)).
