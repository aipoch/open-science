import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { terminateProcessTree } from '../process-tree'
import { codexFramework } from '../agent-framework/codex'
import type { AgentFramework, AgentSpawnInput } from '../agent-framework/types'
import {
  DELEGATED_WORK_CERTIFICATION_JOURNEYS,
  assertDelegatedWorkCertified,
  evaluateDelegatedWorkCertification,
  type NativeDelegationAudit
} from './certification'
import {
  createAcpDelegateExecution,
  type AcpDelegateExecutionCallbacks,
  type AcpDelegateRuntime,
  type DelegateExecutionCapability,
  type DelegateExecutionProvenance
} from './acp-execution'
import type { DelegateExecution, DelegateExecutionInput } from './execution-port'

type CodexRuntimeIdentity = Readonly<{
  nativeVersion: string
  adapterVersion: string
}>

type PreparedCodexDelegateExecution = Readonly<{
  executionId: string
  provenance: DelegateExecutionProvenance
  workspace: Readonly<{ cwd: string }>
  runtimeHome: string
  capability: DelegateExecutionCapability
  spawn: AgentSpawnInput
  releaseResources?(): Promise<void> | void
  disposeResources?(): Promise<void> | void
}>

type CodexDelegateExecutionOptions = Readonly<{
  capacity: number
  runtime: CodexRuntimeIdentity
  framework?: Pick<AgentFramework, 'spawn'>
  prepare(
    input: DelegateExecutionInput
  ): Promise<PreparedCodexDelegateExecution> | PreparedCodexDelegateExecution
  createRuntime(
    scope: PreparedCodexDelegateExecution,
    callbacks: AcpDelegateExecutionCallbacks,
    agentProcess: ChildProcessWithoutNullStreams
  ): AcpDelegateRuntime
  assertProviderAvailable?(): Promise<void> | void
}>

type CodexDelegateExecution = Readonly<{
  execution: DelegateExecution
  nativeEntryPoints: readonly NativeDelegationAudit[]
  assertAvailable(): Promise<void>
}>

/**
 * Pin reviewed identities independently of the download target: an upgrade must not implicitly
 * certify its tool inventory. 0.157.1 was audited with ACP 1.6.2 and agents.enabled=false;
 * features.multi_agent{,_v2}=false alone does not override the new models' native delegation.
 * Upstream: rust-v0.157.1 codex-rs/core/src/config/mod.rs::multi_agent_version_override.
 */
const getCodexNativeDelegationAudit = (
  identity: CodexRuntimeIdentity
): readonly NativeDelegationAudit[] => {
  const reviewed = identity.nativeVersion === '0.157.1' && identity.adapterVersion === '1.6.2'
  if (!reviewed) {
    return Object.freeze(
      (['task', 'agent', 'multi-agent'] as const).map((entryPoint) =>
        Object.freeze({ entryPoint, status: 'unknown' as const })
      )
    )
  }
  return Object.freeze([
    Object.freeze({ entryPoint: 'task', status: 'not-present' }),
    Object.freeze({ entryPoint: 'agent', status: 'not-present' }),
    Object.freeze({ entryPoint: 'multi-agent', status: 'disabled' })
  ])
}

const assertCodexScopeIsolated = (
  scope: PreparedCodexDelegateExecution,
  identity: CodexRuntimeIdentity
): void => {
  assertCodexLaunchIsolated(scope.spawn, scope.runtimeHome, identity)
}

const assertCodexLaunchIsolated = (
  spawn: AgentSpawnInput,
  runtimeHome: string,
  identity: CodexRuntimeIdentity
): void => {
  const audit = getCodexNativeDelegationAudit(identity)
  if (audit.some(({ status }) => status !== 'disabled' && status !== 'not-present')) {
    throw new Error('Codex native delegation entry points are not certified for this runtime.')
  }
  if (spawn.env.CODEX_HOME !== runtimeHome || spawn.env.HOME !== runtimeHome) {
    throw new Error('Codex delegated execution requires an isolated runtime home.')
  }
  let config: {
    agents?: { enabled?: unknown }
    features?: { multi_agent?: unknown; multi_agent_v2?: unknown }
  }
  try {
    config = JSON.parse(spawn.env.CODEX_CONFIG ?? '') as typeof config
  } catch {
    throw new Error('Codex delegated execution requires an auditable CODEX_CONFIG.')
  }
  if (
    config.agents?.enabled !== false ||
    config.features?.multi_agent !== false ||
    config.features.multi_agent_v2 !== false
  ) {
    throw new Error('Codex native multi-agent features must be disabled.')
  }
}

const createCodexDelegateExecution = (
  options: CodexDelegateExecutionOptions
): CodexDelegateExecution => {
  const nativeEntryPoints = getCodexNativeDelegationAudit(options.runtime)
  const certification = evaluateDelegatedWorkCertification({
    frameworkId: 'codex',
    journeys: Object.fromEntries(
      DELEGATED_WORK_CERTIFICATION_JOURNEYS.map((journey) => [journey, { status: 'passed' }])
    ),
    nativeEntryPoints
  })
  const prepared = new WeakMap<object, PreparedCodexDelegateExecution>()
  const issuedRuntimeHomes = new Set<string>()
  const issuedRuntimes = new WeakSet<object>()
  const execution = createAcpDelegateExecution({
    capacity: options.capacity,
    async prepare(input) {
      const scope = await options.prepare(input)
      assertCodexScopeIsolated(scope, options.runtime)
      if (issuedRuntimeHomes.has(scope.runtimeHome)) {
        throw new Error('Codex delegated execution cannot reuse a runtime home.')
      }
      issuedRuntimeHomes.add(scope.runtimeHome)
      const wrapped = Object.freeze({ ...scope, frameworkId: 'codex' })
      prepared.set(wrapped, scope)
      return wrapped
    },
    assertFrameworkNativeDelegationDisabled(scope) {
      const codexScope = prepared.get(scope)
      if (!codexScope) throw new Error('unknown Codex delegated execution scope')
      assertCodexScopeIsolated(codexScope, options.runtime)
    },
    createRuntime(scope, callbacks) {
      const codexScope = prepared.get(scope)
      if (!codexScope) throw new Error('unknown Codex delegated execution scope')
      const agentProcess = (options.framework ?? codexFramework).spawn(codexScope.spawn)
      let runtime: AcpDelegateRuntime
      try {
        runtime = options.createRuntime(codexScope, callbacks, agentProcess)
      } catch (error) {
        void terminateProcessTree(agentProcess)
        throw error
      }
      if (issuedRuntimes.has(runtime)) {
        void terminateProcessTree(agentProcess)
        throw new Error('Codex delegated execution requires an independent runtime connection.')
      }
      issuedRuntimes.add(runtime)
      return runtime
    }
  })

  return Object.freeze({
    execution,
    nativeEntryPoints,
    async assertAvailable() {
      assertDelegatedWorkCertified(certification)
      await options.assertProviderAvailable?.()
    }
  })
}

export {
  assertCodexLaunchIsolated,
  assertCodexScopeIsolated,
  createCodexDelegateExecution,
  getCodexNativeDelegationAudit
}
export type {
  CodexDelegateExecution,
  CodexDelegateExecutionOptions,
  CodexRuntimeIdentity,
  PreparedCodexDelegateExecution
}
