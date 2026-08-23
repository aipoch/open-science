import { DEFAULT_UPLOAD_PROJECT_ID } from '../../shared/uploads'
import type { AcpBackendGenerationOwner } from './backend-generation-owner'
import type { AcpSessionCapabilityOwner } from './session-capability-owner'
import {
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
  type SessionCapabilityPolicy
} from './session-capability-owner'
import type { AcpSessionPresentationPolicy } from './session-presentation-policy'
import type { AcpSessionRegistry } from './session-registry'

type AcpSessionEnvironmentPolicyOptions = Readonly<{
  backendGeneration: Pick<AcpBackendGenerationOwner, 'current'>
  capabilities: Pick<
    AcpSessionCapabilityOwner,
    'refreshDynamicAvailability' | 'toolingAvailability'
  >
  presentation: Pick<AcpSessionPresentationPolicy, 'applicationSystemPromptAppends'>
  registry: Pick<AcpSessionRegistry, 'lookup'>
  defaultProjectId?: string
  planSystemPromptAppend?: string
  capabilityPolicy?: SessionCapabilityPolicy
}>

// Derives current Session environment facts directly from their owners; no framework, tooling, or
// project selection is mirrored or cached here.
class AcpSessionEnvironmentPolicy {
  constructor(private readonly options: AcpSessionEnvironmentPolicyOptions) {}

  role(): SessionCapabilityPolicy['role'] {
    return (this.options.capabilityPolicy ?? CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY).role
  }

  toolingAvailability(): ReturnType<AcpSessionCapabilityOwner['toolingAvailability']> {
    const backend = this.options.backendGeneration.current
    return this.options.capabilities.toolingAvailability({
      framework: backend.framework,
      nativeMcpEnabled: backend.adapter.nativeMcpEnabled,
      bridgeMcpAliasesEnabled: backend.adapter.bridgeMcpAliasesEnabled,
      policy: this.options.capabilityPolicy ?? CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY
    })
  }

  applicationSystemPromptAppends(): readonly string[] {
    const role = this.role()
    return Object.freeze([
      ...this.options.presentation.applicationSystemPromptAppends(this.toolingAvailability(), role),
      ...(role === 'primary' && this.options.planSystemPromptAppend
        ? [this.options.planSystemPromptAppend]
        : [])
    ])
  }

  async backendSystemPromptAppends(): Promise<readonly string[]> {
    await this.options.capabilities.refreshDynamicAvailability()
    return this.applicationSystemPromptAppends()
  }

  systemPromptAppends(skillGuidance?: string): readonly string[] {
    const backend = this.options.backendGeneration.current
    return Object.freeze([
      ...this.applicationSystemPromptAppends(),
      ...backend.prompt.systemPromptAppends,
      ...(skillGuidance ? [skillGuidance] : [])
    ])
  }

  projectId(sessionId: string): string {
    return (
      this.options.registry.lookup(sessionId)?.aggregate.snapshot().projectId ??
      this.options.defaultProjectId ??
      DEFAULT_UPLOAD_PROJECT_ID
    )
  }
}

export { AcpSessionEnvironmentPolicy }
export type { AcpSessionEnvironmentPolicyOptions }
