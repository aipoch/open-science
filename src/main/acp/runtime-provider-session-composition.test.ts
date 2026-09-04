import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeOptions } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimeLifecycleOwners } from './runtime-lifecycle-composition'
import {
  composeAcpRuntimeProviderSessionOwners,
  type AcpRuntimeProviderSessionOwners
} from './runtime-provider-session-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

describe('ACP Runtime Provider Session composition', () => {
  it('uses a five-minute default resume inactivity budget', () => {
    const options = { appVersion: 'test', defaultCwd: '/workspace' }
    const base = composeAcpRuntimeBaseOwners(options)
    const session = composeAcpRuntimeSessionOwners(options, base)
    const lifecycle = composeAcpRuntimeLifecycleOwners(options, base, session, {
      connect: vi.fn(async () => session.publication.getSnapshot()),
      disconnect: vi.fn(async () => session.publication.getSnapshot()),
      openAgentConnection: vi.fn(async () => {
        throw new Error('not called during composition')
      })
    })
    const owners = composeAcpRuntimeProviderSessionOwners(options, base, session, lifecycle, {
      clearUserChoiceProvenanceForSession: vi.fn(),
      releasePromptResourcesForSession: vi.fn()
    })
    const dependencies = (
      owners.providerSessionResumer as unknown as { deps: { resumeTimeoutMs: number } }
    ).deps

    expect(dependencies.resumeTimeoutMs).toBe(5 * 60_000)
  })

  it('builds a fresh frozen graph without invoking host operations', async () => {
    const options = { appVersion: 'test', defaultCwd: '/workspace' }
    const create = (): {
      base: ReturnType<typeof composeAcpRuntimeBaseOwners>
      lifecycle: ReturnType<typeof composeAcpRuntimeLifecycleOwners>
      owners: AcpRuntimeProviderSessionOwners
    } => {
      const base = composeAcpRuntimeBaseOwners(options)
      const session = composeAcpRuntimeSessionOwners(options, base)
      const lifecycleHost = {
        connect: vi.fn(async () => session.publication.getSnapshot()),
        disconnect: vi.fn(async () => session.publication.getSnapshot()),
        openAgentConnection: vi.fn(async () => {
          throw new Error('not called during composition')
        })
      }
      const lifecycle = composeAcpRuntimeLifecycleOwners(options, base, session, lifecycleHost)
      const owners = composeAcpRuntimeProviderSessionOwners(options, base, session, lifecycle, {
        clearUserChoiceProvenanceForSession: vi.fn(),
        releasePromptResourcesForSession: vi.fn()
      })

      expect(lifecycleHost.connect).not.toHaveBeenCalled()
      expect(lifecycleHost.disconnect).not.toHaveBeenCalled()
      expect(lifecycleHost.openAgentConnection).not.toHaveBeenCalled()
      return { base, lifecycle, owners }
    }

    const first = create()
    const second = create()

    expect(Object.isFrozen(first.owners)).toBe(true)
    expect(first.owners.providerSessionCreator).not.toBe(second.owners.providerSessionCreator)
    expect(first.owners.providerSessionResumer).not.toBe(second.owners.providerSessionResumer)
    expect(first.owners.sessionReplacement).not.toBe(second.owners.sessionReplacement)
    expect(first.owners.sessionDeletion).not.toBe(second.owners.sessionDeletion)

    const barrier = vi
      .spyOn(first.lifecycle.modelChanges, 'barrier', 'get')
      .mockReturnValueOnce(Promise.resolve())
      .mockReturnValue(undefined)
    const withOperation = vi.spyOn(first.base.generationActivity, 'withOperation')
    await first.owners.sessionDeletion.delete('detached-session')
    expect(barrier).toHaveBeenCalledTimes(2)
    expect(withOperation).toHaveBeenCalledOnce()
  })

  it('forwards the project Agent Context resolver into the creator, adopter, and resumer deps', () => {
    const resolveProjectAgentContext: AcpRuntimeOptions['resolveProjectAgentContext'] = vi.fn(
      async () => undefined
    )
    const options: AcpRuntimeOptions = {
      appVersion: 'test',
      defaultCwd: '/workspace',
      resolveProjectAgentContext
    }
    const base = composeAcpRuntimeBaseOwners(options)
    const session = composeAcpRuntimeSessionOwners(options, base)
    const lifecycle = composeAcpRuntimeLifecycleOwners(options, base, session, {
      connect: vi.fn(async () => session.publication.getSnapshot()),
      disconnect: vi.fn(async () => session.publication.getSnapshot()),
      openAgentConnection: vi.fn(async () => {
        throw new Error('not called during composition')
      })
    })
    const owners = composeAcpRuntimeProviderSessionOwners(options, base, session, lifecycle, {
      clearUserChoiceProvenanceForSession: vi.fn(),
      releasePromptResourcesForSession: vi.fn()
    })

    // deps is constructor-private; the composition contract is that each workflow holds the exact
    // option function, so the assertion reads the stored deps through a structural cast.
    type AgentContextDeps = {
      deps: { resolveProjectAgentContext?: AcpRuntimeOptions['resolveProjectAgentContext'] }
    }
    const creatorDeps = (owners.providerSessionCreator as unknown as AgentContextDeps).deps
    const resumerDeps = (owners.providerSessionResumer as unknown as AgentContextDeps).deps
    const adopterDeps = (resumerDeps as unknown as { adopter: unknown })
      .adopter as unknown as AgentContextDeps

    expect(creatorDeps.resolveProjectAgentContext).toBe(resolveProjectAgentContext)
    expect(adopterDeps.deps.resolveProjectAgentContext).toBe(resolveProjectAgentContext)
    expect(resumerDeps.resolveProjectAgentContext).toBe(resolveProjectAgentContext)
  })
})
