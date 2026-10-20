# @aipoch/connector-mcp-client

MCP connection, discovery, cancellation and OAuth lifecycle. The host injects network transport, environment preparation, logging, browser opening and ordered credential persistence. No application settings or file stores are imported.

Use the root export for the manager and configuration contracts, and `./oauth-redirect` for browser-safe redirect validation. `npm run build`, `npm run typecheck` and `npm test` run in this package independently.

Inject `redactDiagnosticText` with the host diagnostic policy. Missing or failing policies
replace captured stderr text with `[redacted]`; configured secret masking and output limits remain package-owned.

The manager accepts `clientInfo` (`name`, `version`, optional `title`),
`authenticationRequiredMessage` and `oauthCallbackExpiredHtml` as caller-owned presentation.
Defaults identify `connector-mcp-client`. Callback HTML must be trusted application content.

`CustomMcpServerConfig.persistenceGuard` is an opaque readonly string map captured with
that configuration. `saveOAuthState(serverId, state, persistenceGuard)` must compare it
against current storage before writing. The manager does not interpret its fields, encrypt
values or choose storage paths; it still owns generations and shared-auth write ordering.
The host supplies fingerprint/secret-reference fields and retains its stale-write checks.

## Safety and integration

- **Scope:** Local/remote MCP connections, discovery, cancellation, and OAuth lifecycle management.
- **Controls:** Connection generations, ordered auth-state writes, redirect validation, and bounded,
  redacted diagnostics support the host's policy.
- **Remaining risks:** A local MCP server executes code; a remote server receives tool arguments
  and applicable credentials. Discovery and OAuth success do not establish server trustworthiness.
  The client does not provide a server-process sandbox or encrypt caller-persisted OAuth state.
- **Safe integration:** Review server sources, executable arguments, destinations, and OAuth scopes.
  Inject a minimal environment and enforce process/network policy, tool authorization, and secure
  credential persistence in the host. See the application's
  [service boundaries](https://github.com/aipoch/open-science/blob/main/docs/security.md#models-connectors-and-external-services).
