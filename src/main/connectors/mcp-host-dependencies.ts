import { redactSensitiveText } from '../../shared/diagnostic-redaction'
import type { McpClientManagerDeps } from '@aipoch/connector-mcp-client'
import { augmentedPathEnv } from '../settings/shell-path'
import { netFetchStandard } from '../skills/net-fetch'
import { createLogger } from '../logger'

// Application capabilities injected into the package; the package owns client lifecycle.
export const mcpHostDependencies: McpClientManagerDeps = {
  fetchImpl: netFetchStandard,
  redactDiagnosticText: redactSensitiveText,
  prepareEnvironment: (environment) => augmentedPathEnv(environment) as Record<string, string>,
  logger: createLogger('connectors:mcp-client')
}
