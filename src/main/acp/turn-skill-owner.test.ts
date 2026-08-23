import { describe, expect, it, vi } from 'vitest'

import { codexFramework, opencodeFramework } from '../agent-framework'
import { AcpTurnSkillOwner, followUpPromptText } from './turn-skill-owner'

describe('AcpTurnSkillOwner', () => {
  it('keeps ordinary Main turns synchronous when no Skill work can yield', () => {
    const owner = new AcpTurnSkillOwner({ requestSkillsReload: vi.fn() })

    const handle = owner.authorize({})

    expect(handle).not.toBeInstanceOf(Promise)
    expect(handle).toMatchObject({ reloadDecision: { kind: 'continue' } })
  })

  it('re-resolves Specialist scope and rejects a stale selected Skill fail-closed', async () => {
    const resolveSpecialistSkills = vi.fn(async () => ({
      kind: 'specialist' as const,
      skillIds: ['current-skill'],
      frameworkNames: ['Current Skill', 'mcp-current-connector'],
      missingSkillIds: []
    }))
    const owner = new AcpTurnSkillOwner({
      resolveSpecialistSkills,
      requestSkillsReload: vi.fn()
    })

    await expect(
      owner.authorize({ specialistId: 'specialist-1', selectedSkillIds: ['stale-skill'] })
    ).rejects.toThrow('Skill "stale-skill" is not available to the active specialist.')
    expect(resolveSpecialistSkills).toHaveBeenCalledWith('specialist-1')

    await expect(
      owner.authorize({
        specialistId: 'specialist-1',
        selectedSkillIds: ['mcp-current-connector']
      })
    ).resolves.toMatchObject({ reloadDecision: { kind: 'continue' } })
    expect(resolveSpecialistSkills).toHaveBeenCalledTimes(2)
  })

  it('transfers overlapping forced IDs and lets only the current handle restore reload state', async () => {
    const ownerRef: { current?: AcpTurnSkillOwner } = {}
    const requestSkillsReload = vi.fn(() => {
      expect(ownerRef.current?.backendPreparation()).toEqual({ forcedSkillIds: [] })
    })
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async (ids) => [...ids],
        namesForIds: async (ids) => [...ids]
      },
      requestSkillsReload
    })
    ownerRef.current = owner

    const first = await owner.authorize({ selectedSkillIds: ['first'] })
    expect(first.reloadDecision).toEqual({ kind: 'reload' })
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['first'] })

    const successor = await owner.authorize({ selectedSkillIds: ['successor'] })
    expect(successor.reloadDecision).toEqual({ kind: 'reload' })
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['successor'] })

    first.close('completed')
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['successor'] })
    expect(requestSkillsReload).not.toHaveBeenCalled()

    successor.close('failed')
    successor.close('cancelled')
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: [] })
    expect(requestSkillsReload).toHaveBeenCalledOnce()
  })

  it('keeps a newer forced authorization when an older preflight finishes last', async () => {
    const completions = new Map<string, (disabled: string[]) => void>()
    const requestSkillsReload = vi.fn()
    const olderReservation = new AbortController()
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: (ids) =>
          new Promise((resolve) => {
            completions.set(ids[0], resolve)
          }),
        namesForIds: async (ids) => [...ids]
      },
      requestSkillsReload
    })

    const olderAuthorization = owner.authorize({
      selectedSkillIds: ['older'],
      signal: olderReservation.signal
    })
    olderReservation.abort()
    const newerAuthorization = owner.authorize({ selectedSkillIds: ['newer'] })
    completions.get('newer')?.(['newer'])
    const newer = await newerAuthorization
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['newer'] })

    completions.get('older')?.(['older'])
    const older = await olderAuthorization
    expect(older.reloadDecision).toEqual({ kind: 'continue' })
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['newer'] })

    older.close('failed')
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['newer'] })
    newer.close('completed')
    expect(requestSkillsReload).toHaveBeenCalledOnce()
  })

  it('keeps an independent forced authorization valid when it finishes last', async () => {
    const completions = new Map<string, (disabled: string[]) => void>()
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: (ids) =>
          new Promise((resolve) => {
            completions.set(ids[0], resolve)
          }),
        namesForIds: async (ids) => [...ids]
      },
      requestSkillsReload: vi.fn()
    })

    const firstSession = owner.authorize({ selectedSkillIds: ['first-session'] })
    const secondSession = owner.authorize({ selectedSkillIds: ['second-session'] })
    completions.get('second-session')?.(['second-session'])
    const second = await secondSession
    expect(second.reloadDecision).toEqual({ kind: 'reload' })

    completions.get('first-session')?.(['first-session'])
    const first = await firstSession
    expect(first.reloadDecision).toEqual({ kind: 'reload' })
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['first-session'] })
  })

  it.each(['cancelled', 'reload-restored'] as const)(
    'clears forced IDs before requesting reload when the handle closes as %s',
    async (outcome) => {
      const ownerRef: { current?: AcpTurnSkillOwner } = {}
      const requestSkillsReload = vi.fn(() => {
        expect(ownerRef.current?.backendPreparation()).toEqual({ forcedSkillIds: [] })
      })
      const owner = new AcpTurnSkillOwner({
        skills: {
          needForceLoad: async (ids) => [...ids],
          namesForIds: async (ids) => [...ids]
        },
        requestSkillsReload
      })
      ownerRef.current = owner

      const handle = await owner.authorize({ selectedSkillIds: ['disabled'] })
      expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['disabled'] })
      expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['disabled'] })

      handle.close(outcome)
      handle.close(outcome)
      expect(requestSkillsReload).toHaveBeenCalledOnce()
    }
  )

  it('retains forced IDs across backend reconnect preparations until the turn closes', async () => {
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async (ids) => [...ids],
        namesForIds: async (ids) => [...ids]
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({ selectedSkillIds: ['disabled'] })

    const firstConnect = owner.backendPreparation()
    const reconnect = owner.backendPreparation()
    expect(firstConnect).toEqual({ forcedSkillIds: ['disabled'] })
    expect(reconnect).toEqual({ forcedSkillIds: ['disabled'] })

    handle.close('completed')
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: [] })
  })

  it('prepares non-Codex Skill nudges and current Specialist guidance together', async () => {
    const owner = new AcpTurnSkillOwner({
      resolveSpecialistSkills: async () => ({
        kind: 'specialist',
        skillIds: ['personal-research'],
        frameworkNames: ['Research', 'mcp-pubmed'],
        missingSkillIds: []
      }),
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => ['Research']
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({
      specialistId: 'specialist-1',
      selectedSkillIds: ['personal-research']
    })

    const prepared = await handle.prepareProvider({
      frameworkId: opencodeFramework.id,
      selectionText: 'find papers',
      promptText: 'find papers'
    })

    expect(prepared.text).toBe('Use the following skill(s) for this task: Research.\n\nfind papers')
    expect(prepared.specialistSkillGuidance).toContain('Allowed Specialist Skills for this session')
    expect(prepared.specialistSkillGuidance).toContain('mcp-pubmed')
    expect(prepared.codexSkillInputs).toEqual([])
  })

  it('presents mid-turn Skills without force-loading or requesting a reload', async () => {
    const needForceLoad = vi.fn(async (ids: string[]) => [...ids])
    const requestSkillsReload = vi.fn()
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad,
        namesForIds: async () => ['Research']
      },
      requestSkillsReload
    })

    const presented = await owner.presentFollowUp({
      frameworkId: opencodeFramework.id,
      text: 'find papers',
      selectedSkillIds: ['personal-research']
    })

    expect(needForceLoad).not.toHaveBeenCalled()
    expect(requestSkillsReload).not.toHaveBeenCalled()
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: [] })
    expect(presented.text).toBe(
      'Use the following skill(s) for this task: Research.\n\nfind papers'
    )
  })

  it('includes Specialist skill allowlist guidance in mid-turn follow-up text', async () => {
    const owner = new AcpTurnSkillOwner({
      resolveSpecialistSkills: async () => ({
        kind: 'specialist' as const,
        skillIds: ['personal-research'],
        frameworkNames: ['Research', 'mcp-pubmed'],
        missingSkillIds: []
      }),
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => ['Research']
      },
      requestSkillsReload: vi.fn()
    })

    const presented = await owner.presentFollowUp({
      frameworkId: opencodeFramework.id,
      text: 'find papers',
      selectedSkillIds: ['personal-research'],
      specialistId: 'specialist-1'
    })

    expect(presented.specialistSkillGuidance).toContain(
      'Allowed Specialist Skills for this session'
    )
    expect(presented.specialistSkillGuidance).toContain('mcp-pubmed')
    expect(followUpPromptText(presented)).toContain('Allowed Specialist Skills for this session')
    expect(followUpPromptText(presented)).toContain(
      'Use the following skill(s) for this task: Research.\n\nfind papers'
    )
  })

  it('propagates follow-up Skill preparation failures instead of dropping selected Skills', async () => {
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => {
          throw new Error('catalog unavailable')
        }
      },
      requestSkillsReload: vi.fn()
    })

    await expect(
      owner.presentFollowUp({
        frameworkId: opencodeFramework.id,
        text: 'find papers',
        selectedSkillIds: ['personal-research']
      })
    ).rejects.toThrow('catalog unavailable')
  })

  it('rejects out-of-scope follow-up Skills without force-loading', async () => {
    const needForceLoad = vi.fn(async (ids: string[]) => [...ids])
    const owner = new AcpTurnSkillOwner({
      resolveSpecialistSkills: async () => ({
        kind: 'specialist' as const,
        skillIds: ['current-skill'],
        frameworkNames: ['Current Skill'],
        missingSkillIds: []
      }),
      skills: {
        needForceLoad,
        namesForIds: async () => ['Stale']
      },
      requestSkillsReload: vi.fn()
    })

    await expect(
      owner.presentFollowUp({
        frameworkId: opencodeFramework.id,
        text: 'find papers',
        selectedSkillIds: ['stale-skill'],
        specialistId: 'specialist-1'
      })
    ).rejects.toThrow('Skill "stale-skill" is not available to the active specialist.')
    expect(needForceLoad).not.toHaveBeenCalled()
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: [] })
  })

  it('prepares an explicit Codex Skill as native input without changing prompt text', async () => {
    const namesForIds = vi.fn(async (ids: readonly string[]) => [...ids])
    const descriptorsForIds = vi.fn(async () => [
      { name: 'Research', path: '/codex/skills/research/SKILL.md' }
    ])
    const selectSkills = vi.fn(async () => [
      { name: 'automatic', path: '/codex/skills/automatic/SKILL.md' }
    ])
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds,
        descriptorsForIds
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({ selectedSkillIds: ['personal-research'] })

    const prepared = await handle.prepareProvider({
      frameworkId: codexFramework.id,
      selectionText: 'find papers',
      promptText: 'find papers',
      codex: {
        home: '/codex',
        bridgeSkillsAvailable: true,
        selectSkills
      }
    })

    expect(descriptorsForIds).toHaveBeenCalledWith(['personal-research'], '/codex')
    expect(namesForIds).not.toHaveBeenCalled()
    expect(selectSkills).not.toHaveBeenCalled()
    expect(prepared).toMatchObject({
      text: 'find papers',
      codexSkillInputs: [{ name: 'Research', path: '/codex/skills/research/SKILL.md' }]
    })
  })

  it('scopes Codex automatic selection and rejects stale selector results', async () => {
    const oldSkill = {
      name: 'mcp-old',
      description: 'Old connector',
      path: '/codex/skills/mcp-old/SKILL.md'
    }
    const currentSkill = {
      name: 'mcp-current',
      description: 'Current connector',
      path: '/codex/skills/mcp-current/SKILL.md'
    }
    const signal = new AbortController().signal
    const selectSkills = vi.fn(async () => [oldSkill, currentSkill])
    const owner = new AcpTurnSkillOwner({
      resolveSpecialistSkills: async () => ({
        kind: 'specialist',
        skillIds: [],
        frameworkNames: ['mcp-current'],
        missingSkillIds: []
      }),
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        catalogForCodexHome: async () => [oldSkill, currentSkill]
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({ specialistId: 'specialist-1' })

    const prepared = await handle.prepareProvider({
      frameworkId: codexFramework.id,
      selectionText: 'use the current connector',
      promptText: 'use the current connector',
      codex: {
        home: '/codex',
        bridgeSkillsAvailable: true,
        selectSkills,
        signal
      }
    })

    expect(selectSkills).toHaveBeenCalledWith('use the current connector', [currentSkill], signal)
    expect(prepared.codexSkillInputs).toEqual([currentSkill])
  })

  it('passes cancellation to the Codex selector and fails open when it aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const selectSkills = vi.fn(async (_text, _catalog, signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(true)
      throw new Error('aborted')
    })
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        catalogForCodexHome: async () => [
          { name: 'research', description: 'Research', path: '/skills/research/SKILL.md' }
        ]
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({})

    const prepared = await handle.prepareProvider({
      frameworkId: codexFramework.id,
      selectionText: 'find papers',
      promptText: 'find papers',
      codex: {
        bridgeSkillsAvailable: true,
        selectSkills,
        signal: controller.signal
      }
    })

    expect(selectSkills).toHaveBeenCalledOnce()
    expect(prepared.codexSkillInputs).toEqual([])
  })
})
