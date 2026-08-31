import { vi, type Mock } from 'vitest'

import type { ApprovalGateway, ApprovalResult } from '../../shared/agents-contract'
import type { SpecialistView } from '../../shared/specialist'
import type { SpecialistService } from '../specialist/service'
import type { SessionBindingService } from '../specialist/session-binding'
import { AgentsService, type AgentsCatalogSource } from './agents-service'
import {
  CompletionGateCoordinator,
  createCompletionGateSwitchNotifier,
  type CompletionDisposition,
  type CompletionGateRuntime,
  type ToolCompletionEnvelope
} from './completion-gate'
import {
  CompletionHandoffLifecycle,
  InMemoryCompletionHandoffRepository
} from './completion-handoff-lifecycle'

const catalog: AgentsCatalogSource = {
  listSkillCatalog: async () => [],
  getConnectors: async () => ({ enabledIds: [], autoAllowIds: [] })
}

export const approvedSpecialist = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
  id: 'specialist-approved',
  name: 'Approved Specialist',
  displayName: 'Approved Specialist',
  description: '',
  systemPrompt: '',
  enabled: true,
  capabilityMode: 'selected',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1,
  ...overrides
})

export const deferred = <T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

type HarnessOptions = {
  approval?: ApprovalResult
  initialProfile?: SpecialistView
  onApproval?: (
    current: SpecialistView | undefined,
    approvalIndex: number
  ) => SpecialistView | undefined
  approvalGateway?: ApprovalGateway
  runtime?: CompletionGateRuntime
  coordinator?: CompletionGateCoordinator
  lifecycle?: CompletionHandoffLifecycle
  deliverToOldPrompt?: (envelope: ToolCompletionEnvelope) => Promise<void>
}

export type CompletionGateAgentHarness = {
  agents: AgentsService
  calls: string[]
  coordinator: CompletionGateCoordinator
  lifecycle: CompletionHandoffLifecycle
  continuations: CapturedHandoff[]
  deliverToOldPrompt: Mock<(envelope: ToolCompletionEnvelope) => Promise<void>>
  persistBinding: Mock<(sessionId: string, specialistId: string | undefined) => Promise<void>>
}

export type CapturedHandoff = Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>

export const createCompletionGateAgentHarness = (
  options: HarnessOptions = {}
): CompletionGateAgentHarness => {
  let currentProfile: SpecialistView | undefined = options.initialProfile ?? approvedSpecialist()
  let approvalCount = 0
  const specialistService = {
    getByName: vi.fn(async (name: string) => {
      if (!currentProfile || currentProfile.name !== name) {
        throw new Error(`Specialist "${name}" not found.`)
      }
      return currentProfile
    }),
    getById: vi.fn(async (id: string) => {
      if (!currentProfile || currentProfile.id !== id) {
        throw new Error(`Specialist "${id}" not found.`)
      }
      return currentProfile
    }),
    resolveRunnableByName: vi.fn(async (name: string) => {
      if (!currentProfile || currentProfile.name !== name) {
        throw new Error(`Runnable Specialist "${name}" not found.`)
      }
      return currentProfile
    }),
    resolveRunnableById: vi.fn(async (id: string) => {
      if (!currentProfile || currentProfile.id !== id) {
        throw new Error(`Runnable Specialist "${id}" not found.`)
      }
      return currentProfile
    }),
    list: vi.fn(async () => (currentProfile ? [currentProfile] : []))
  } as unknown as SpecialistService
  const defaultApprovalGateway: ApprovalGateway = {
    decide: vi.fn(async () => {
      approvalCount += 1
      if (options.onApproval) {
        currentProfile = options.onApproval(currentProfile, approvalCount)
      }
      return options.approval ?? { status: 'approved' as const }
    })
  }
  const approvalGateway = options.approvalGateway ?? defaultApprovalGateway
  const calls: string[] = []
  const continuations: CapturedHandoff[] = []
  const defaultRuntime: CompletionGateRuntime = {
    stopOldPrompt: async () => {
      calls.push('stop-old-prompt')
    },
    waitForOwnershipRelease: async () => {
      calls.push('ownership-released')
    },
    reconfigure: async ({ targetName }) => {
      calls.push(`reconfigure:${targetName}`)
    },
    continueAsApproved: async (handoff) => {
      continuations.push(handoff)
      calls.push(`provider-request:${handoff.targetName}`)
    },
    reportHandoffFailure: async () => undefined
  }
  const runtime = options.runtime ?? defaultRuntime
  // The harness mirrors production ownership: one lifecycle is both the approval projection and
  // the coordinator's durable authority. Tests can replace the runtime, but cannot accidentally
  // certify a second, callback-only lifecycle.
  const lifecycle =
    options.lifecycle ??
    new CompletionHandoffLifecycle(new InMemoryCompletionHandoffRepository(), runtime)
  const coordinator = options.coordinator ?? new CompletionGateCoordinator(runtime, lifecycle)
  const persistBinding: CompletionGateAgentHarness['persistBinding'] = vi.fn(async () => undefined)
  const sessionBinding = {
    getBinding: vi.fn(() => undefined),
    setBinding: vi.fn()
  } as unknown as SessionBindingService
  const agents = new AgentsService({
    specialistService,
    catalog,
    approvalGateway,
    approvalLifecycle: lifecycle,
    sessionBinding,
    persistSessionSpecialist: persistBinding,
    switchNotifier: createCompletionGateSwitchNotifier(coordinator)
  })
  const deliverToOldPrompt = vi.fn(
    options.deliverToOldPrompt ??
      (async (envelope: ToolCompletionEnvelope) => {
        // Deliberately adversarial: delivery immediately permits another old-identity provider request.
        void envelope
        calls.push('provider-request:old')
      })
  )

  return {
    agents,
    calls,
    coordinator,
    lifecycle,
    continuations,
    deliverToOldPrompt,
    persistBinding
  }
}
