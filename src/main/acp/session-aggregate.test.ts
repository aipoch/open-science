import type { ActiveSession, SessionConfigOption } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import { AcpSessionAggregate, type AcpSessionAggregateAttachInput } from './session-aggregate'

const providerSession = (sessionId: string): ActiveSession =>
  ({ sessionId }) as unknown as ActiveSession

const permissionProfile = (): SessionPermissionProfileState => ({
  selectedProfile: 'ask',
  effectiveProfile: 'ask',
  currentModeId: 'default',
  availableModeIds: ['default'],
  fullAccessAvailable: false
})

const attachInput = (
  sessionId: string,
  overrides: Partial<AcpSessionAggregateAttachInput> = {}
): AcpSessionAggregateAttachInput => ({
  session: providerSession(sessionId),
  cwd: '/workspace',
  projectId: 'project-1',
  frameworkId: 'claude-code',
  permissionProfile: permissionProfile(),
  ...overrides
})

describe('ACP session aggregate', () => {
  it('keeps the app session id stable while replacing the provider session', () => {
    const aggregate = new AcpSessionAggregate('app-session')
    const first = providerSession('app-session')
    const replacement = providerSession('provider-session')

    expect(aggregate.attach(attachInput('app-session', { session: first }))).toBeUndefined()
    expect(aggregate.appSessionId).toBe('app-session')
    expect(aggregate.activeSession()).toBe(first)

    expect(
      aggregate.attach(
        attachInput('provider-session', { session: replacement, frameworkId: 'codex' })
      )
    ).toBe(first)
    expect(aggregate.appSessionId).toBe('app-session')
    expect(aggregate.activeSession()).toBe(replacement)
  })

  it('keeps the Main-owned conversation Memory preference in the Session snapshot', () => {
    const aggregate = new AcpSessionAggregate('app-session')

    aggregate.attach(attachInput('provider-session', { memoryEnabled: false }))

    expect(aggregate.snapshot().memoryEnabled).toBe(false)
  })

  it('replaces provider metadata without erasing retained backend affinity', () => {
    const aggregate = new AcpSessionAggregate('app-session')
    const configOption = {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'model-1',
      options: [{ value: 'model-1', name: 'Model 1', _meta: { source: 'agent' } }]
    } satisfies SessionConfigOption
    const configOptions = [configOption]

    aggregate.attach(
      attachInput('provider-1', {
        frameworkId: 'claude-code',
        backendId: 'backend-1',
        appliedModel: 'model-1',
        configOptions
      })
    )
    configOptions[0].name = 'mutated input'
    configOptions[0].options[0]._meta.source = 'mutated input'

    const firstSnapshot = aggregate.snapshot()
    expect(firstSnapshot).toMatchObject({
      providerSessionId: 'provider-1',
      frameworkId: 'claude-code',
      backendId: 'backend-1',
      appliedModel: 'model-1'
    })
    expect(firstSnapshot.configOptions?.[0].name).toBe('Model')
    expect(firstSnapshot.configOptions?.[0]).toMatchObject({
      options: [{ _meta: { source: 'agent' } }]
    })
    expect(aggregate.snapshot()).toBe(firstSnapshot)

    expect(() => {
      Object.defineProperty(firstSnapshot.configOptions![0], 'name', { value: 'mutated snapshot' })
    }).toThrow(TypeError)
    expect(aggregate.snapshot().configOptions?.[0].name).toBe('Model')
    aggregate.attach(
      attachInput('provider-2', {
        frameworkId: 'codex',
        configOptions: null
      })
    )

    expect(aggregate.snapshot()).not.toBe(firstSnapshot)
    expect(aggregate.snapshot()).toMatchObject({
      providerSessionId: 'provider-2',
      frameworkId: 'codex',
      backendId: 'backend-1',
      appliedModel: undefined,
      configOptions: undefined
    })
  })

  it('projects mutable app affinity through defensive snapshots', () => {
    const aggregate = new AcpSessionAggregate('app-session')
    const profile: SessionPermissionProfileState = {
      selectedProfile: 'auto',
      effectiveProfile: 'auto',
      currentModeId: 'auto',
      availableModeIds: ['default', 'auto'],
      autoReviewStrategy: 'native',
      fullAccessAvailable: false
    }

    aggregate.updateLocation('/workspace', 'project-1')
    aggregate.setPermissionProfile(profile)
    aggregate.setSpecialistId('specialist-1')
    aggregate.setSpecialistPrefix('Follow the selected specialist.')
    aggregate.setSessionSetupPromptPrefix('Project Agent Context.')
    profile.availableModeIds.push('mutated-input')

    const firstSnapshot = aggregate.snapshot()
    expect(firstSnapshot).toMatchObject({
      cwd: '/workspace',
      projectId: 'project-1',
      specialistId: 'specialist-1',
      specialistPrefix: 'Follow the selected specialist.',
      sessionSetupPromptPrefix: 'Project Agent Context.',
      permissionProfile: {
        selectedProfile: 'auto',
        availableModeIds: ['default', 'auto']
      }
    })

    expect(() => {
      Object.defineProperty(firstSnapshot.permissionProfile!.availableModeIds, '0', {
        value: 'mutated-snapshot'
      })
    }).toThrow(TypeError)
    expect(aggregate.snapshot().permissionProfile?.availableModeIds).toEqual(['default', 'auto'])

    aggregate.setPermissionProfile(undefined)
    aggregate.setSpecialistId(undefined)
    aggregate.setSpecialistPrefix(undefined)
    aggregate.setSessionSetupPromptPrefix(undefined)
    expect(aggregate.snapshot()).toMatchObject({
      permissionProfile: undefined,
      specialistId: undefined,
      specialistPrefix: undefined,
      sessionSetupPromptPrefix: undefined
    })
  })

  it('revises Specialist binding only when its projected values change', () => {
    const aggregate = new AcpSessionAggregate('app-session')

    expect(aggregate.specialistBindingRevision()).toBe(0)
    aggregate.setSpecialistId('specialist-1')
    aggregate.setSpecialistPrefix('Follow the selected specialist.')
    expect(aggregate.specialistBindingRevision()).toBe(2)

    aggregate.setSpecialistId('specialist-1')
    aggregate.setSpecialistPrefix('Follow the selected specialist.')
    expect(aggregate.specialistBindingRevision()).toBe(2)

    aggregate.setSpecialistId(undefined)
    expect(aggregate.specialistBindingRevision()).toBe(3)
  })

  it('detaches provider and connection state while retaining resume affinity', () => {
    const aggregate = new AcpSessionAggregate('app-session')
    const profile: SessionPermissionProfileState = {
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      currentModeId: 'default',
      availableModeIds: ['default'],
      fullAccessAvailable: false
    }
    const attach = (sessionId: string): void => {
      aggregate.attach(
        attachInput(sessionId, {
          frameworkId: 'codex',
          backendId: 'backend-1',
          appliedModel: 'model-1',
          configOptions: [
            {
              id: 'reasoning',
              name: 'Reasoning',
              type: 'boolean',
              currentValue: true
            }
          ]
        })
      )
    }

    aggregate.updateLocation('/workspace', 'project-1')
    aggregate.setPermissionProfile(profile)
    aggregate.setSpecialistId('specialist-1')
    aggregate.setSpecialistPrefix('Use specialist instructions.')
    aggregate.setSessionSetupPromptPrefix('Project Agent Context.')
    attach('provider-1')

    aggregate.detachProvider()
    expect(aggregate.activeSession()).toBeUndefined()
    expect(aggregate.snapshot()).toMatchObject({
      providerSessionId: undefined,
      appliedModel: undefined,
      configOptions: undefined,
      cwd: '/workspace',
      projectId: 'project-1',
      permissionProfile: profile,
      frameworkId: 'codex',
      backendId: 'backend-1',
      specialistId: 'specialist-1',
      specialistPrefix: 'Use specialist instructions.',
      sessionSetupPromptPrefix: 'Project Agent Context.'
    })

    attach('provider-2')
    aggregate.detachConnection()
    expect(aggregate.snapshot()).toMatchObject({
      providerSessionId: undefined,
      appliedModel: undefined,
      configOptions: undefined,
      cwd: undefined,
      projectId: undefined,
      permissionProfile: profile,
      frameworkId: 'codex',
      backendId: 'backend-1',
      specialistId: 'specialist-1',
      specialistPrefix: 'Use specialist instructions.',
      sessionSetupPromptPrefix: 'Project Agent Context.'
    })
  })

  it('clears the applied model without detaching provider configuration', () => {
    const aggregate = new AcpSessionAggregate('app-session')
    const session = providerSession('provider-1')
    aggregate.attach(
      attachInput('provider-1', {
        session,
        frameworkId: 'opencode',
        appliedModel: 'model-1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'model-1',
            options: [{ value: 'model-1', name: 'Model 1' }]
          }
        ]
      })
    )

    aggregate.clearAppliedModel()

    expect(aggregate.activeSession()).toBe(session)
    expect(aggregate.snapshot().appliedModel).toBeUndefined()
    expect(aggregate.snapshot().configOptions).toHaveLength(1)
  })
})
