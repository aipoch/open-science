# @aipoch/connector-mcp-client

MCP connection, discovery, cancellation and OAuth lifecycle. The host injects network transport, environment preparation, logging, browser opening and ordered credential persistence. No application settings or file stores are imported.

Use the root export for the manager and configuration contracts, and `./oauth-redirect` for browser-safe redirect validation. `npm run build`, `npm run typecheck` and `npm test` run in this package independently.

Inject `redactDiagnosticText` with the host diagnostic policy. Missing or failing policies
replace captured stderr text with `[redacted]`; configured secret masking and output limits remain package-owned.

Version 0.2 accepts `clientInfo` (`name`, `version`, optional `title`),
`authenticationRequiredMessage` and `oauthCallbackExpiredHtml` as caller-owned presentation.
Defaults identify `connector-mcp-client`. Callback HTML must be trusted application content.

`CustomMcpServerConfig.persistenceGuard` is an opaque readonly string map captured with
that configuration. `saveOAuthState(serverId, state, persistenceGuard)` must compare it
against current storage before writing. The manager does not interpret its fields, encrypt
values or choose storage paths; it still owns generations and shared-auth write ordering.
Adapt 0.1 fingerprint/secret-reference parameters in the host without dropping stale-write checks.
