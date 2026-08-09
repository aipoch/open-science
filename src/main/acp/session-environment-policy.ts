import { DEFAULT_UPLOAD_PROJECT_NAME } from '../../shared/uploads'
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
  defaultProjectName?: string
  planSystemPromptAppend?: string
  capabilityPolicy?: SessionCapabilityPolicy
}>

// Derives current Session environment facts directly from their owners; no framework, tooling, or
// project selection is mirrored or cached here.
class AcpSessionEnvironmentPolicy {
  constructor(private readonly options: AcpSessionEnvironmentPolicyOptions) {}

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
    return Object.freeze([
      ...this.options.presentation.applicationSystemPromptAppends(this.toolingAvailability()),
      ...(this.options.planSystemPromptAppend ? [this.options.planSystemPromptAppend] : [])
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

  projectName(sessionId: string): string {
    return (
      this.options.registry.lookup(sessionId)?.aggregate.snapshot().projectName ??
      this.options.defaultProjectName ??
      DEFAULT_UPLOAD_PROJECT_NAME
    )
  }
}

export { AcpSessionEnvironmentPolicy }
export type { AcpSessionEnvironmentPolicyOptions }
