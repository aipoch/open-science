import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export type ExternalAcpAgent = 'claude' | 'codex' | 'opencode'

const adapterEnvironment: Record<ExternalAcpAgent, string> = {
  claude: 'CLAUDE_ACP_PATH',
  codex: 'CODEX_ACP_PATH',
  opencode: 'OPENCODE_ACP_PATH'
}

export const externalAcpPath = (agent: ExternalAcpAgent): string | undefined =>
  process.env[adapterEnvironment[agent]]

export const externalAcpAvailable = (agent: ExternalAcpAgent): boolean =>
  Boolean(externalAcpPath(agent))

export const externalAcpFile = (agent: ExternalAcpAgent, name: string): string => {
  const path = externalAcpPath(agent)
  if (!path) throw new Error(`${adapterEnvironment[agent]} is required for ACP tests.`)
  return join(dirname(path), name)
}

export const resolveExternalAcpModule = (agent: ExternalAcpAgent, specifier: string): string => {
  const path = externalAcpPath(agent)
  if (!path) throw new Error(`${adapterEnvironment[agent]} is required for ACP tests.`)
  return createRequire(path).resolve(specifier)
}
