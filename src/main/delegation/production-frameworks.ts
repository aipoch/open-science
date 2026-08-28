import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import type {
  AgentFramework,
  AgentModelConfig,
  AgentSpawnInput,
  SessionSetup
} from '../agent-framework'
import { CODEX_ACP_VERSION, CODEX_VERSION } from '../settings/managed-codex'
import type {
  AcpDelegateExecutionCallbacks,
  AcpDelegateRuntime,
  PreparedDelegateExecution
} from './acp-execution'
import { createClaudeCodeDelegateExecution } from './claude-code-execution'
import {
  createCodexDelegateExecution,
  type CodexRuntimeIdentity,
  type PreparedCodexDelegateExecution
} from './codex-execution'
import {
  createCodeBuddyDelegateExecution,
  type PreparedCodeBuddyDelegateExecution
} from './codebuddy-execution'
import type { DelegateExecution, DelegateExecutionInput } from './execution-port'
import {
  createOpenCodeDelegateExecution,
  type PreparedOpenCodeDelegateExecution
} from './opencode-execution'

type PreparedClaudeCodeDelegateExecution = PreparedDelegateExecution &
  Readonly<{ sessionSetup: SessionSetup }>

type PreparedProductionFrameworkScope = PreparedDelegateExecution &
  Partial<
    Readonly<{
      sessionSetup: SessionSetup
      modelConfig: AgentModelConfig
      spawn: AgentSpawnInput
    }>
  >

type ProductionFrameworkCertification = Readonly<{
  frameworkId: AgentFrameworkId
  codexRuntime?: CodexRuntimeIdentity
  codexFramework?: Pick<AgentFramework, 'spawn'>
  codebuddyFramework?: Pick<AgentFramework, 'spawn'>
  assertProviderAvailable(): Promise<void> | void
  prepare(
    input: DelegateExecutionInput
  ): Promise<PreparedProductionFrameworkScope> | PreparedProductionFrameworkScope
  createRuntime(
    scope: PreparedProductionFrameworkScope,
    callbacks: AcpDelegateExecutionCallbacks,
    agentProcess?: ChildProcessWithoutNullStreams
  ): AcpDelegateRuntime
}>

type ProductionDelegatedFrameworksOptions = Readonly<{
  capacity: number
  certify(session: PersistedChatSession): Promise<ProductionFrameworkCertification>
}>

type ProductionDelegatedFrameworks = Readonly<{
  forSession(session: PersistedChatSession): Promise<{
    frameworkId: AgentFrameworkId
    execution: DelegateExecution
    assertAvailable(): Promise<void>
  }>
}>

const requireCodexRuntime = (
  certification: ProductionFrameworkCertification
): CodexRuntimeIdentity =>
  certification.codexRuntime ?? {
    nativeVersion: CODEX_VERSION,
    adapterVersion: CODEX_ACP_VERSION
  }

const createProductionDelegatedFrameworks = (
  options: ProductionDelegatedFrameworksOptions
): ProductionDelegatedFrameworks => ({
  async forSession(session) {
    const frameworkId = session.agentFrameworkId
    if (!frameworkId) throw new Error('Delegated Work Session has no framework identity.')
    const certification = await options.certify(session)
    if (certification.frameworkId !== frameworkId) {
      throw new Error('Delegated Work certification does not match the Session framework.')
    }

    if (frameworkId === 'claude-code') {
      const execution = createClaudeCodeDelegateExecution({
        capacity: options.capacity,
        prepare: (input) =>
          certification.prepare(input) as Promise<PreparedClaudeCodeDelegateExecution>,
        sessionSetup: (scope) => (scope as PreparedClaudeCodeDelegateExecution).sessionSetup,
        createRuntime: (scope, callbacks) => certification.createRuntime(scope, callbacks)
      })
      return Object.freeze({
        frameworkId,
        execution,
        async assertAvailable() {
          await certification.assertProviderAvailable()
        }
      })
    }

    if (frameworkId === 'opencode') {
      const execution = createOpenCodeDelegateExecution({
        capacity: options.capacity,
        prepare: (input) =>
          certification.prepare(input) as Promise<PreparedOpenCodeDelegateExecution>,
        createRuntime: (scope, callbacks) => certification.createRuntime(scope, callbacks)
      })
      return Object.freeze({
        frameworkId,
        execution,
        async assertAvailable() {
          await certification.assertProviderAvailable()
        }
      })
    }

    if (frameworkId === 'codex') {
      const codexRuntime = requireCodexRuntime(certification)
      const codex = createCodexDelegateExecution({
        capacity: options.capacity,
        runtime: codexRuntime,
        framework: certification.codexFramework,
        prepare: (input) => certification.prepare(input) as Promise<PreparedCodexDelegateExecution>,
        createRuntime: (scope, callbacks, agentProcess) =>
          certification.createRuntime(
            scope as PreparedProductionFrameworkScope,
            callbacks,
            agentProcess
          ),
        assertProviderAvailable: certification.assertProviderAvailable
      })
      return Object.freeze({
        frameworkId,
        execution: codex.execution,
        assertAvailable: codex.assertAvailable
      })
    }

    if (frameworkId === 'codebuddy') {
      const execution = createCodeBuddyDelegateExecution({
        capacity: options.capacity,
        framework: certification.codebuddyFramework,
        prepare: (input) =>
          certification.prepare(input) as Promise<PreparedCodeBuddyDelegateExecution>,
        createRuntime: (scope, callbacks, agentProcess) =>
          certification.createRuntime(scope, callbacks, agentProcess)
      })
      return Object.freeze({
        frameworkId,
        execution,
        async assertAvailable() {
          await certification.assertProviderAvailable()
        }
      })
    }

    const unsupported: never = frameworkId
    throw new Error(`Unsupported delegated-work framework: ${String(unsupported)}`)
  }
})

export { createProductionDelegatedFrameworks }
export type {
  PreparedClaudeCodeDelegateExecution,
  PreparedProductionFrameworkScope,
  ProductionDelegatedFrameworks,
  ProductionDelegatedFrameworksOptions,
  ProductionFrameworkCertification
}
