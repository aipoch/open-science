import { beforeEach, describe, expect, it } from 'vitest'

import { createInitialSessionState, useSessionStore } from './session-store'

describe('new Session details claim eligibility', () => {
  beforeEach(() => useSessionStore.setState(createInitialSessionState()))

  it('waits through a hidden control and preserves durable eligibility for Main to claim', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      projectId: 'project-1',
      content: 'Save this as a skill',
      turnIntent: 'save-as-skill'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      sessionDetailsGenerationEligible: true
    })
    expect(useSessionStore.getState().sessions[0]?.sessionDetailsGeneration).toBeUndefined()

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Analyze the observations'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'Analyze the observations',
      description: '',
      sessionDetailsSource: 'fallback',
      sessionDetailsGenerationEligible: true
    })
    expect(useSessionStore.getState().sessions[0]?.sessionDetailsGeneration).toBeUndefined()
  })

  it('leaves a new root Session description empty after its first visible message', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      projectId: 'project-1',
      content: 'Describe these observations'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'Describe these observations',
      description: '',
      sessionDetailsSource: 'fallback'
    })
  })

  it('does not make a hydrated legacy Session eligible for generation', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'legacy',
        projectId: 'project-1',
        title: 'Legacy title',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }
    ])

    expect(useSessionStore.getState().sessions[0]?.description).toBe('')

    useSessionStore.getState().appendUserMessage({
      sessionId: 'legacy',
      content: 'A later user message'
    })

    expect(useSessionStore.getState().sessions[0]?.sessionDetailsGeneration).toBeUndefined()
  })
})
