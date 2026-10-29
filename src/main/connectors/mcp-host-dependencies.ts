import { redactSensitiveText } from '@aipoch/diagnostics'
import type { McpClientManagerDeps } from '@aipoch/connector-mcp-client'
import { prepareMcpStdioLaunch } from './mcp-stdio-launch'
import { netFetchStandard } from '../network-fetch'
import { createLogger } from '@aipoch/diagnostics/node'

// Application capabilities injected into the package; the package owns client lifecycle.
export const mcpHostDependencies: McpClientManagerDeps = {
  clientInfo: { name: 'open-science', version: '0.0.0', title: 'Open-Science' },
  authenticationRequiredMessage:
    'OAuth authentication required. Sign in from Settings > Connectors.',
  oauthCallbackExpiredHtml:
    '<h1>Open-Science authorization expired</h1><p>You can close this window.</p>',
  fetchImpl: netFetchStandard,
  redactDiagnosticText: redactSensitiveText,
  prepareStdioLaunch: prepareMcpStdioLaunch,
  logger: createLogger('connectors:mcp-client')
}
