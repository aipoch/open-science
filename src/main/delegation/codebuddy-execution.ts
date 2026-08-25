import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { codeBuddyFramework, type AgentFramework, type AgentSpawnInput } from '../agent-framework'
import {
  createAcpDelegateExecution,
  type AcpDelegateExecutionOptions,
  type PreparedDelegateExecution
} from './acp-execution'
import type { NativeDelegationAudit } from './certification'

type PreparedCodeBuddyDelegateExecution = PreparedDelegateExecution &
  Readonly<{ spawn: AgentSpawnInput }>

type CodeBuddyDelegateExecutionOptions = Omit<
  AcpDelegateExecutionOptions,
  'prepare' | 'assertFrameworkNativeDelegationDisabled' | 'createRuntime'
> &
  Readonly<{
    framework?: Pick<AgentFramework, 'spawn'>
    prepare(
      input: Parameters<AcpDelegateExecutionOptions['prepare']>[0]
    ): Promise<PreparedCodeBuddyDelegateExecution> | PreparedCodeBuddyDelegateExecution
    createRuntime(
      scope: PreparedCodeBuddyDelegateExecution,
      callbacks: Parameters<AcpDelegateExecutionOptions['createRuntime']>[1],
      agentProcess: ChildProcessWithoutNullStreams
    ): ReturnType<AcpDelegateExecutionOptions['createRuntime']>
  }>

const CODEBUDDY_NATIVE_DELEGATION_TOOLS = new Set([
  'Agent',
  'Task',
  'Workflow',
  'TaskOutput',
  'TaskStop',
  'SendMessage',
  'TeamCreate',
  'TeamDelete'
])

const codeBuddyTools = (args: readonly string[]): readonly string[] | undefined => {
  const index = args.lastIndexOf('--tools')
  if (index < 0) return undefined
  return args[index + 1]
    ?.split(',')
    .map((tool) => tool.trim())
    .filter(Boolean)
}

const auditCodeBuddyNativeDelegation = (
  spawn: AgentSpawnInput
): readonly NativeDelegationAudit[] => {
  const tools = codeBuddyTools(spawn.args)
  const allowlistClosed =
    tools !== undefined && tools.every((tool) => !CODEBUDDY_NATIVE_DELEGATION_TOOLS.has(tool))
  const forkDisabled = spawn.env.CODEBUDDY_DISABLE_FORK_SUBAGENT === '1'
  const backgroundDisabled =
    spawn.env.CODEBUDDY_DISABLE_BACKGROUND_TASKS === '1' &&
    spawn.env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS === '1'

  return Object.freeze([
    { entryPoint: 'task', status: allowlistClosed ? 'disabled' : 'enabled' },
    {
      entryPoint: 'agent',
      status: allowlistClosed && forkDisabled ? 'disabled' : 'enabled'
    },
    {
      entryPoint: 'multi-agent',
      status: allowlistClosed && forkDisabled && backgroundDisabled ? 'disabled' : 'enabled'
    }
  ] satisfies NativeDelegationAudit[])
}

const assertCodeBuddyNativeDelegationDisabled = (spawn: AgentSpawnInput): void => {
  if (auditCodeBuddyNativeDelegation(spawn).every(({ status }) => status === 'disabled')) return
  throw new Error('CodeBuddy native Task/Agent/multi-agent delegation is not completely disabled.')
}

const createCodeBuddyDelegateExecution = (
  options: CodeBuddyDelegateExecutionOptions
): ReturnType<typeof createAcpDelegateExecution> =>
  createAcpDelegateExecution({
    ...options,
    assertFrameworkNativeDelegationDisabled: (scope) => {
      if (scope.frameworkId !== 'codebuddy') {
        throw new Error('CodeBuddy delegated execution received a different framework scope.')
      }
      assertCodeBuddyNativeDelegationDisabled((scope as PreparedCodeBuddyDelegateExecution).spawn)
    },
    createRuntime(scope, callbacks) {
      const codeBuddyScope = scope as PreparedCodeBuddyDelegateExecution
      const agentProcess = (options.framework ?? codeBuddyFramework).spawn(codeBuddyScope.spawn)
      try {
        return options.createRuntime(codeBuddyScope, callbacks, agentProcess)
      } catch (error) {
        agentProcess.kill()
        throw error
      }
    }
  })

export {
  assertCodeBuddyNativeDelegationDisabled,
  auditCodeBuddyNativeDelegation,
  createCodeBuddyDelegateExecution
}
export type { CodeBuddyDelegateExecutionOptions, PreparedCodeBuddyDelegateExecution }
