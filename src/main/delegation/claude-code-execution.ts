import { claudeCodeFramework } from '../agent-framework'
import type { SessionSetup } from '../agent-framework/types'
import {
  createAcpDelegateExecution,
  type AcpDelegateExecutionCallbacks,
  type AcpDelegateExecutionOptions,
  type AcpDelegateRuntime,
  type PreparedDelegateExecution
} from './acp-execution'
import type { NativeDelegationAudit } from './certification'

const TASK_ENTRY_POINT_TOOLS = ['Agent', 'Task'] as const
const MULTI_AGENT_ENTRY_POINT_TOOLS = [
  'Agent',
  'Workflow',
  'SendMessage',
  'TeamCreate',
  'TeamDelete'
] as const

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const claudeOptions = (setup: SessionSetup): Readonly<Record<string, unknown>> | undefined =>
  asRecord(asRecord(setup.meta?.claudeCode)?.options)

const hasEveryTool = (
  options: Readonly<Record<string, unknown>> | undefined,
  required: readonly string[]
): boolean => {
  const denied = new Set(
    Array.isArray(options?.disallowedTools)
      ? options.disallowedTools.filter((value): value is string => typeof value === 'string')
      : []
  )
  return required.every((tool) => denied.has(tool))
}

const hasLockedSetting = (
  options: Readonly<Record<string, unknown>> | undefined,
  key: string,
  envKey: string
): boolean =>
  asRecord(options?.managedSettings)?.[key] === true && asRecord(options?.env)?.[envKey] === '1'

/**
 * Derives release evidence from the exact session metadata passed to claude-agent-acp. No declared
 * status is trusted: removing one SDK deny or one process-level lock turns the audit unsafe.
 */
const claudeCodeNativeDelegationAudit = (setup: SessionSetup): readonly NativeDelegationAudit[] => {
  const options = claudeOptions(setup)
  const taskDisabled = hasEveryTool(options, TASK_ENTRY_POINT_TOOLS)
  const agentDisabled =
    hasEveryTool(options, ['Agent']) &&
    hasLockedSetting(options, 'disableAgentView', 'CLAUDE_CODE_DISABLE_AGENT_VIEW')
  const multiAgentDisabled =
    hasEveryTool(options, MULTI_AGENT_ENTRY_POINT_TOOLS) &&
    hasLockedSetting(options, 'disableWorkflows', 'CLAUDE_CODE_DISABLE_WORKFLOWS') &&
    asRecord(options?.managedSettings)?.workflowKeywordTriggerEnabled === false

  return Object.freeze([
    Object.freeze({ entryPoint: 'task', status: taskDisabled ? 'disabled' : 'enabled' }),
    Object.freeze({ entryPoint: 'agent', status: agentDisabled ? 'disabled' : 'enabled' }),
    Object.freeze({
      entryPoint: 'multi-agent',
      status: multiAgentDisabled ? 'disabled' : 'enabled'
    })
  ] satisfies NativeDelegationAudit[])
}

const defaultClaudeCodeDelegatedSessionSetup = (): SessionSetup =>
  claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] })

const assertClaudeCodeNativeDelegationDisabled = (
  setup: SessionSetup = defaultClaudeCodeDelegatedSessionSetup()
): void => {
  const unsafe = claudeCodeNativeDelegationAudit(setup).filter(
    ({ status }) => status !== 'disabled' && status !== 'not-present'
  )
  if (unsafe.length > 0) {
    throw new Error(
      'Claude Code native Task/Agent/multi-agent delegation is not completely disabled.'
    )
  }
}

/** Admission guard used before durable child creation. */
const assertClaudeCodeDelegatedWorkAvailable = (
  setup: SessionSetup = defaultClaudeCodeDelegatedSessionSetup()
): void => {
  if (!claudeCodeFramework.supportsDelegatedWork) {
    throw new Error('Claude Code delegated work has not passed framework certification.')
  }
  assertClaudeCodeNativeDelegationDisabled(setup)
}

type ClaudeCodeDelegateExecutionOptions = Omit<
  AcpDelegateExecutionOptions,
  'assertFrameworkNativeDelegationDisabled'
> &
  Readonly<{
    sessionSetup?(scope: PreparedDelegateExecution): SessionSetup
  }>

/**
 * Claude-specific production adapter. It retains the common ACP execution lifecycle while making
 * framework identity and the native-entry audit non-optional before any runtime/process is created.
 */
const createClaudeCodeDelegateExecution = (
  options: ClaudeCodeDelegateExecutionOptions
): ReturnType<typeof createAcpDelegateExecution> =>
  createAcpDelegateExecution({
    capacity: options.capacity,
    prepare: options.prepare,
    assertFrameworkNativeDelegationDisabled: (scope) => {
      if (scope.frameworkId !== 'claude-code') {
        throw new Error('Claude Code delegated execution received a different framework scope.')
      }
      assertClaudeCodeDelegatedWorkAvailable(
        options.sessionSetup?.(scope) ?? defaultClaudeCodeDelegatedSessionSetup()
      )
    },
    createRuntime: options.createRuntime
  })

export {
  assertClaudeCodeDelegatedWorkAvailable,
  assertClaudeCodeNativeDelegationDisabled,
  claudeCodeNativeDelegationAudit,
  createClaudeCodeDelegateExecution
}
export type {
  AcpDelegateExecutionCallbacks,
  AcpDelegateRuntime,
  ClaudeCodeDelegateExecutionOptions,
  PreparedDelegateExecution
}
