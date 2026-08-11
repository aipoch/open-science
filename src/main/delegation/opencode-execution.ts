import type { AgentModelConfig } from '../agent-framework'
import {
  createAcpDelegateExecution,
  type AcpDelegateExecutionOptions,
  type PreparedDelegateExecution
} from './acp-execution'
import { nativeDelegationAuditFailureMessage, type NativeDelegationAudit } from './certification'
import { DelegateExecutionError, type DelegateExecution } from './execution-port'

type PreparedOpenCodeDelegateExecution = PreparedDelegateExecution &
  Readonly<{ modelConfig: AgentModelConfig }>

type OpenCodeDelegateExecutionOptions = Omit<
  AcpDelegateExecutionOptions,
  'prepare' | 'assertFrameworkNativeDelegationDisabled'
> &
  Readonly<{
    /** Optional direct-adapter admission audit. Production audits through its fresh backend owner. */
    certificationConfig?(): AgentModelConfig
    prepare(
      input: Parameters<AcpDelegateExecutionOptions['prepare']>[0]
    ): Promise<PreparedOpenCodeDelegateExecution> | PreparedOpenCodeDelegateExecution
  }>

const parsedRecord = (value: string | undefined): Record<string, unknown> | undefined => {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const taskDenied = (config: Record<string, unknown> | undefined): boolean => {
  const permission = config?.permission
  return (
    typeof permission === 'object' &&
    permission !== null &&
    !Array.isArray(permission) &&
    (permission as Record<string, unknown>).task === 'deny'
  )
}

const nativeAgentsDisabled = (config: Record<string, unknown> | undefined): boolean => {
  const agents = config?.agent
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) return false
  return ['general', 'explore', 'scout'].every((name) => {
    const agent = (agents as Record<string, unknown>)[name]
    return (
      typeof agent === 'object' &&
      agent !== null &&
      !Array.isArray(agent) &&
      (agent as Record<string, unknown>).disable === true
    )
  })
}

/**
 * Audits the exact production OpenCode config surfaces. OpenCode has one native child creation
 * primitive (Task); its agent and multi-agent experiences both route through that same tool.
 */
const auditOpenCodeNativeDelegation = (
  modelConfig: AgentModelConfig
): readonly NativeDelegationAudit[] => {
  const file = modelConfig.configFiles?.find((candidate) =>
    candidate.path.endsWith('opencode.json')
  )
  const authoritative = parsedRecord(modelConfig.env?.OPENCODE_CONFIG_CONTENT)
  const taskIsDisabled =
    modelConfig.env?.OPENCODE_DISABLE_PROJECT_CONFIG === 'true' &&
    taskDenied(parsedRecord(file?.content)) &&
    taskDenied(authoritative)
  const agentsAreDisabled =
    nativeAgentsDisabled(parsedRecord(file?.content)) && nativeAgentsDisabled(authoritative)

  return Object.freeze([
    { entryPoint: 'task', status: taskIsDisabled ? 'disabled' : 'enabled' },
    { entryPoint: 'agent', status: agentsAreDisabled ? 'disabled' : 'enabled' },
    { entryPoint: 'multi-agent', status: taskIsDisabled ? 'disabled' : 'enabled' }
  ] satisfies NativeDelegationAudit[])
}

const assertOpenCodeNativeDelegationDisabled = (modelConfig: AgentModelConfig): void => {
  if (
    auditOpenCodeNativeDelegation(modelConfig).every(
      ({ status }) => status === 'disabled' || status === 'not-present'
    )
  ) {
    return
  }
  throw new Error('OpenCode native delegation is not disabled')
}

/** Production ACP execution with fail-closed OpenCode admission and per-Attempt config auditing. */
const createOpenCodeDelegateExecution = (
  options: OpenCodeDelegateExecutionOptions
): DelegateExecution => {
  const { certificationConfig, prepare, ...executionOptions } = options
  const execution = createAcpDelegateExecution({
    ...executionOptions,
    prepare,
    assertFrameworkNativeDelegationDisabled: (scope) =>
      assertOpenCodeNativeDelegationDisabled(
        (scope as PreparedOpenCodeDelegateExecution).modelConfig
      )
  })

  return Object.freeze({
    async reserve(count) {
      if (certificationConfig) {
        try {
          assertOpenCodeNativeDelegationDisabled(certificationConfig())
        } catch {
          throw new DelegateExecutionError(
            'unsupported_framework',
            nativeDelegationAuditFailureMessage('opencode')
          )
        }
      }
      return execution.reserve(count)
    },
    run: execution.run
  })
}

export {
  assertOpenCodeNativeDelegationDisabled,
  auditOpenCodeNativeDelegation,
  createOpenCodeDelegateExecution
}
export type { OpenCodeDelegateExecutionOptions, PreparedOpenCodeDelegateExecution }
