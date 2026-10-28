import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { AgentFramework, AgentSpawnInput } from '../agent-framework'
import {
  createAcpDelegateExecution,
  type AcpDelegateExecutionOptions,
  type PreparedDelegateExecution
} from './acp-execution'
import type { NativeDelegationAudit } from './certification'

type PreparedPiDelegateExecution = PreparedDelegateExecution & Readonly<{ spawn: AgentSpawnInput }>

type PiDelegateExecutionOptions = Omit<
  AcpDelegateExecutionOptions,
  'prepare' | 'assertFrameworkNativeDelegationDisabled' | 'createRuntime'
> &
  Readonly<{
    framework: Pick<AgentFramework, 'spawn'>
    prepare(
      input: Parameters<AcpDelegateExecutionOptions['prepare']>[0]
    ): Promise<PreparedPiDelegateExecution> | PreparedPiDelegateExecution
    createRuntime(
      scope: PreparedPiDelegateExecution,
      callbacks: Parameters<AcpDelegateExecutionOptions['createRuntime']>[1],
      agentProcess: ChildProcessWithoutNullStreams
    ): ReturnType<AcpDelegateExecutionOptions['createRuntime']>
  }>

// Pi has one native delegation surface. The app-owned adapter build removes it and every launch must
// also pass --no-delegation, so task, agent, and multi-agent entry points share that single switch.
const auditPiNativeDelegation = (spawn: AgentSpawnInput): readonly NativeDelegationAudit[] => {
  const status = spawn.args.includes('--no-delegation') ? 'disabled' : 'enabled'
  return Object.freeze([
    { entryPoint: 'task', status },
    { entryPoint: 'agent', status },
    { entryPoint: 'multi-agent', status }
  ] satisfies NativeDelegationAudit[])
}

const assertPiNativeDelegationDisabled = (spawn: AgentSpawnInput): void => {
  if (auditPiNativeDelegation(spawn).every(({ status }) => status === 'disabled')) return
  throw new Error('Pi native delegation is not disabled.')
}

const createPiDelegateExecution = (
  options: PiDelegateExecutionOptions
): ReturnType<typeof createAcpDelegateExecution> =>
  createAcpDelegateExecution({
    ...options,
    assertFrameworkNativeDelegationDisabled: (scope) => {
      if (scope.frameworkId !== 'pi') {
        throw new Error('Pi delegated execution received a different framework scope.')
      }
      assertPiNativeDelegationDisabled((scope as PreparedPiDelegateExecution).spawn)
    },
    createRuntime(scope, callbacks) {
      const piScope = scope as PreparedPiDelegateExecution
      const agentProcess = options.framework.spawn(piScope.spawn)
      try {
        return options.createRuntime(piScope, callbacks, agentProcess)
      } catch (error) {
        agentProcess.kill()
        throw error
      }
    }
  })

export { auditPiNativeDelegation, createPiDelegateExecution }
export type { PreparedPiDelegateExecution }
