// One source of truth for persisted, wire, and renderer-visible Agent identifiers.
export const AGENT_FRAMEWORK_ID_VALUES = Object.freeze([
  'claude-code',
  'opencode',
  'codex',
  'codebuddy',
  'pi'
] as const)

export type AgentFrameworkId = (typeof AGENT_FRAMEWORK_ID_VALUES)[number]

export const isAgentFrameworkId = (value: unknown): value is AgentFrameworkId =>
  typeof value === 'string' && (AGENT_FRAMEWORK_ID_VALUES as readonly string[]).includes(value)

// The Pi SDK version the managed adapter accepts (enforced again by src/main/pi-acp/bootstrap.mjs).
export const PI_SDK_VERSION = '1.4.0'

// Registration and runtime readiness both come from Main; older snapshots must fail closed.
export const isPiFrameworkReady = (
  frameworks: readonly { id: AgentFrameworkId }[],
  runtimeReady: boolean | undefined
): boolean => runtimeReady === true && frameworks.some(({ id }) => id === 'pi')
