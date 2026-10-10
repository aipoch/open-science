# @aipoch/connector-mcp-client

MCP connection, discovery, cancellation and OAuth lifecycle. The host injects network transport, environment preparation, logging, browser opening and ordered credential persistence. No application settings or file stores are imported.

Use the root export for the manager and configuration contracts, and `./oauth-redirect` for browser-safe redirect validation. `npm run build`, `npm run typecheck` and `npm test` run in this package independently.

Inject `redactDiagnosticText` with the host diagnostic policy. Missing or failing policies
replace captured stderr text with `[redacted]`; configured secret masking and output limits remain package-owned.
