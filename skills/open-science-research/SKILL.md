---
name: open-science-research
description: Use Open-Science MCP tools from an external agent when the user asks to find an Open-Science project, submit or follow a research run, or inspect its outputs.
---

# Research with Open-Science

Use the Open-Science tools registered in the current client. Hosts can prefix tool names. Match the names below to the tools the server advertises and use their input schemas.

- **Find a project.** Call `list_projects` with `{}` and match the requested project to its ID. An empty list is a successful connection. If the service is unreachable or its tools are missing, consult the [MCP setup guide](https://github.com/aipoch/open-science#connect-your-own-agent-through-mcp). For a request to list projects, return the list here.
- **Submit research.** Call `start_run` with the chosen `projectId` and the user's `prompt`. To continue an existing session, resolve its `sessionId` with `list_sessions` and pass it too. Omitting it creates a session. Keep the returned run and session identifiers for follow-up.
- **Follow progress.** Call `get_run` with `runId`. If the run needs human input, report the action requested by Open-Science. For a plan decision, read `get_plan` and use the reviewed version and revision when applying the user's decision. After a timeout or disconnect, check the existing run or session before submitting work again.
- **Report results.** Read the final status and result from `get_run`. Use `list_artifacts` with `sessionId` for output metadata. Identify the reported artifacts and distinguish their metadata from file contents you actually inspected.

For other operations, consult the [research tool catalog](https://github.com/aipoch/open-science/blob/main/packages/open-science/CLI.md#external-agents-through-mcp).
