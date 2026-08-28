import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { codeBuddyFramework, codexFramework, opencodeFramework } from '../agent-framework'
import { ClaudeCodeSkillMaterializer } from '../skills/materializer'
import { AcpTurnSkillOwner, followUpPromptText } from './turn-skill-owner'

const reloadTestScope = {
  kind: 'specialist' as const,
  skillIds: [
    'first',
    'successor',
    'older',
    'newer',
    'first-session',
    'second-session',
    'disabled',
    'personal-research'
  ],
  frameworkNames: [],
  missingSkillIds: []
}

describe('AcpTurnSkillOwner', () => {
  it('keeps ordinary Main turns synchronous when no Skill work can yield', () => {
    const owner = new AcpTurnSkillOwner({ requestSkillsReload: vi.fn() })

    const handle = owner.authorize({})

    expect(handle).not.toBeInstanceOf(Promise)
    expect(handle).toMatchObject({ reloadDecision: { kind: 'continue' } })
  })

  it.each([codexFramework, opencodeFramework])(
    'revokes earlier Specialist scope on every Main %s turn without reloading',
    async (framework) => {
      const requestSkillsReload = vi.fn()
      const owner = new AcpTurnSkillOwner({ requestSkillsReload })

      const handle = owner.authorize({})
      if (handle instanceof Promise) throw new Error('Main authorization must stay synchronous.')
      const prepared = await handle.prepareProvider({
        frameworkId: framework.id,
        selectionText: 'continue',
        promptText: 'continue'
      })

      expect(prepared.skillScopeGuidance).toContain('Current agent: Main Agent.')
      expect(prepared.skillScopeGuidance).toContain(
        'earlier Specialist identity and Specialist-specific Skill or Connector scope'
      )
      expect(requestSkillsReload).not.toHaveBeenCalled()
    }
  )

  it('does not label a restricted session as Main Agent or authorize Skills', async () => {
    const owner = new AcpTurnSkillOwner({ requestSkillsReload: vi.fn() })
    const handle = owner.authorize({ role: 'side-chat' })
    if (handle instanceof Promise)
      throw new Error('Restricted authorization must stay synchronous.')

    const prepared = await handle.prepareProvider({
      frameworkId: codexFramework.id,
      selectionText: 'continue',
      promptText: 'continue'
    })

    expect(prepared.skillScopeGuidance).toBeUndefined()
    expect(prepared.text).toBe('continue')
    expect(() =>
      owner.authorize({ role: 'reviewer', selectedSkillIds: ['unexpected-skill'] })
    ).toThrow('Skills are not available to this session.')
  })

  it('rejects a Main-disabled Skill instead of force-loading it for Main Agent', async () => {
    const owner = new AcpTurnSkillOwner({
      resolveSpecialistSkills: async () => reloadTestScope,
      skills: {
        needForceLoad: async (ids) => [...ids],
        namesForIds: async (ids) => [...ids]
      },
      requestSkillsReload: vi.fn()
    })

    await expect(owner.authorize({ selectedSkillIds: ['specialist-only'] })).rejects.toThrow(
      'Skill "specialist-only" is not available to Main Agent.'
    )
    await expect(
      owner.presentFollowUp({
        frameworkId: codexFramework.id,
        text: 'continue',
        selectedSkillIds: ['specialist-only']
      })
    ).rejects.toThrow('Skill "specialist-only" is not available to Main Agent.')
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

    const first = await owner.authorize({
      specialistId: 'specialist-1',
      selectedSkillIds: ['first']
    })
    expect(first.reloadDecision).toEqual({ kind: 'reload' })
    expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['first'] })

    const successor = await owner.authorize({
      specialistId: 'specialist-1',
      selectedSkillIds: ['successor']
    })
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
      resolveSpecialistSkills: async () => reloadTestScope,
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
      specialistId: 'specialist-1',
      selectedSkillIds: ['older'],
      signal: olderReservation.signal
    })
    olderReservation.abort()
    const newerAuthorization = owner.authorize({
      specialistId: 'specialist-1',
      selectedSkillIds: ['newer']
    })
    await vi.waitFor(() => expect(completions.has('newer')).toBe(true))
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
      resolveSpecialistSkills: async () => reloadTestScope,
      skills: {
        needForceLoad: (ids) =>
          new Promise((resolve) => {
            completions.set(ids[0], resolve)
          }),
        namesForIds: async (ids) => [...ids]
      },
      requestSkillsReload: vi.fn()
    })

    const firstSession = owner.authorize({
      specialistId: 'specialist-1',
      selectedSkillIds: ['first-session']
    })
    const secondSession = owner.authorize({
      specialistId: 'specialist-1',
      selectedSkillIds: ['second-session']
    })
    await vi.waitFor(() => expect(completions.has('second-session')).toBe(true))
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
        resolveSpecialistSkills: async () => reloadTestScope,
        skills: {
          needForceLoad: async (ids) => [...ids],
          namesForIds: async (ids) => [...ids]
        },
        requestSkillsReload
      })
      ownerRef.current = owner

      const handle = await owner.authorize({
        specialistId: 'specialist-1',
        selectedSkillIds: ['disabled']
      })
      expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['disabled'] })
      expect(owner.backendPreparation()).toEqual({ forcedSkillIds: ['disabled'] })

      handle.close(outcome)
      handle.close(outcome)
      expect(requestSkillsReload).toHaveBeenCalledOnce()
    }
  )

  it('retains forced IDs across backend reconnect preparations until the turn closes', async () => {
    const owner = new AcpTurnSkillOwner({
      resolveSpecialistSkills: async () => reloadTestScope,
      skills: {
        needForceLoad: async (ids) => [...ids],
        namesForIds: async (ids) => [...ids]
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({
      specialistId: 'specialist-1',
      selectedSkillIds: ['disabled']
    })

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
    expect(prepared.skillScopeGuidance).toContain('<open_science_specialist_skill_scope>')
    expect(prepared.skillScopeGuidance).toContain(
      'supersedes and revokes every earlier Specialist Skill or Connector scope'
    )
    expect(prepared.skillScopeGuidance).toContain(
      'This list does not grant tool or Connector permissions.'
    )
    expect(prepared.skillScopeGuidance).toContain('mcp-pubmed')
    expect(prepared.codexSkillInputs).toEqual([])
  })

  it('presents mid-turn Skills without force-loading or requesting a reload', async () => {
    const needForceLoad = vi.fn(async (ids: string[]) => [...ids])
    const requestSkillsReload = vi.fn()
    const owner = new AcpTurnSkillOwner({
      resolveSpecialistSkills: async () => reloadTestScope,
      skills: {
        needForceLoad,
        namesForIds: async () => ['Research']
      },
      requestSkillsReload
    })

    const presented = await owner.presentFollowUp({
      frameworkId: opencodeFramework.id,
      text: 'find papers',
      selectedSkillIds: ['personal-research'],
      specialistId: 'specialist-1'
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

    expect(presented.skillScopeGuidance).toContain('<open_science_specialist_skill_scope>')
    expect(presented.skillScopeGuidance).toContain('mcp-pubmed')
    expect(followUpPromptText(presented)).toContain('<open_science_specialist_skill_scope>')
    expect(followUpPromptText(presented)).toContain(
      'Use the following skill(s) for this task: Research.\n\nfind papers'
    )
  })

  it('preserves the active CodeBuddy Skill route when a follow-up has no Skill chip', async () => {
    const selectSkills = vi.fn(async () => [])
    const catalogForCodeBuddyRoot = vi.fn(async () => [])
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        catalogForCodeBuddyRoot
      },
      requestSkillsReload: vi.fn()
    })

    const presented = await owner.presentFollowUp({
      frameworkId: codeBuddyFramework.id,
      text: 'continue the current search',
      selectedSkillIds: [],
      codebuddy: { root: '/skills', selectorAvailable: true, selectSkills }
    })

    expect(presented).toEqual({ text: 'continue the current search', codexSkillInputs: [] })
    expect(catalogForCodeBuddyRoot).not.toHaveBeenCalled()
    expect(selectSkills).not.toHaveBeenCalled()
  })

  it('loads an explicitly selected CodeBuddy Skill for a live follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codebuddy-follow-up-skill-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const skillPath = join(root, '.claude', 'skills', 'mcp-pubmed', 'SKILL.md')
    await mkdir(join(root, '.claude', 'skills', 'mcp-pubmed'), { recursive: true })
    await writeFile(skillPath, 'FOLLOW_UP_SKILL_SENTINEL', 'utf8')
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => ['mcp-pubmed']
      },
      requestSkillsReload: vi.fn()
    })

    const presented = await owner.presentFollowUp({
      frameworkId: codeBuddyFramework.id,
      text: 'use PubMed for the follow-up',
      selectedSkillIds: ['mcp-pubmed'],
      codebuddy: { root, selectorAvailable: true, selectSkills: async () => [] }
    })

    expect(presented.skillActivityInputs).toEqual([{ name: 'mcp-pubmed', path: skillPath }])
    expect(presented.skillScopeGuidance).toContain('FOLLOW_UP_SKILL_SENTINEL')
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

  it('pre-routes a CodeBuddy connector and exposes only that Skill for the turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codebuddy-turn-skill-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const pubmedPath = join(root, '.claude', 'skills', 'mcp-pubmed', 'SKILL.md')
    await mkdir(join(root, '.claude', 'skills', 'mcp-pubmed'), { recursive: true })
    await writeFile(
      pubmedPath,
      [
        '---',
        'name: mcp-pubmed',
        'description: Search PubMed literature.',
        'source: connector',
        '---',
        '',
        'PUBMED_ROUTE_SENTINEL: call host.mcp("pubmed", "search_articles", args).',
        'PACKAGE_DIR=${CLAUDE_SKILL_DIR}'
      ].join('\n')
    )
    const pubmed = {
      name: 'mcp-pubmed',
      description: 'Search PubMed literature.',
      path: pubmedPath,
      source: 'connector' as const
    }
    const biomart = {
      name: 'mcp-biomart',
      description: 'Query Ensembl BioMart.',
      path: '/codebuddy/.claude/skills/mcp-biomart/SKILL.md',
      source: 'connector' as const
    }
    const selectSkills = vi.fn(async () => [pubmed])
    const catalogForCodeBuddyRoot = vi.fn(async () => [biomart, pubmed])
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        catalogForCodeBuddyRoot
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({})

    const requestText = 'Use PubMed to review recent studies of circadian metabolism.'
    const prepared = await handle.prepareProvider({
      frameworkId: codeBuddyFramework.id,
      selectionText: requestText,
      promptText: requestText,
      codebuddy: {
        root,
        selectorAvailable: true,
        selectSkills
      }
    })

    expect(catalogForCodeBuddyRoot).toHaveBeenCalledWith(root)
    expect(selectSkills).toHaveBeenCalledWith(requestText, [biomart, pubmed], undefined, undefined)
    expect(prepared.skillRuntimeAllowlist).toEqual([])
    expect(prepared.codexSkillInputs).toEqual([])
    expect(prepared.skillActivityInputs).toEqual([{ name: 'mcp-pubmed', path: pubmedPath }])
    expect(prepared.skillScopeGuidance).toContain('mcp-pubmed')
    expect(prepared.skillScopeGuidance).toContain('already loaded by Open Science')
    expect(prepared.skillScopeGuidance).toContain('PUBMED_ROUTE_SENTINEL')
    expect(prepared.skillScopeGuidance).toContain(
      'PACKAGE_DIR=${CODEBUDDY_CONFIG_DIR}/skill-runtime/.claude/skills/mcp-pubmed'
    )
    expect(prepared.skillScopeGuidance).toContain(
      'Resolve every relative reference, script, or asset path'
    )
    expect(prepared.skillScopeGuidance).not.toContain('${CLAUDE_SKILL_DIR}')
    expect(prepared.skillScopeGuidance).not.toContain(root)
    expect(prepared.skillScopeGuidance).not.toContain(
      'Before any Notebook or Connector call, call `mcp__skills__load_skill`'
    )
    expect(prepared.skillScopeGuidance).toContain('Do not use Notebook `host.skills`')
    expect(prepared.skillScopeGuidance).toContain('do not guess Connector names or methods')
    expect(prepared.text).toBe(requestText)
  })

  it('loads a selected CodeBuddy Skill from its Agent-facing projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codebuddy-projected-skill-'))
    const sourceDir = join(root, 'source')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      join(sourceDir, 'SKILL.md'),
      '---\nname: paper-review\ndescription: Review papers.\n---\n\nPROJECTED_SKILL_SENTINEL',
      'utf8'
    )
    await new ClaudeCodeSkillMaterializer().sync(
      join(root, '.claude'),
      [
        {
          id: 'featured-paper-review',
          name: 'paper-review',
          displayName: 'Paper review',
          description: 'Review papers.',
          source: 'featured',
          updatedAt: '',
          sourceDir
        }
      ],
      { directoryLayout: 'agent-facing' }
    )
    const projectedPath = join(root, '.claude', 'skills', 'paper-review', 'SKILL.md')
    onTestFinished(async () => {
      await chmod(projectedPath, 0o644)
      await chmod(join(root, '.claude', 'skills', 'paper-review'), 0o755)
      await rm(root, { recursive: true, force: true })
    })
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => ['paper-review'],
        catalogForCodeBuddyRoot: async () => [
          {
            name: 'paper-review',
            description: 'Review papers.',
            path: projectedPath
          }
        ]
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({ selectedSkillIds: ['featured-paper-review'] })

    const prepared = await handle.prepareProvider({
      frameworkId: codeBuddyFramework.id,
      selectionText: 'review papers',
      promptText: 'review papers',
      codebuddy: { root, selectorAvailable: false, selectSkills: async () => [] }
    })

    expect(prepared.skillActivityInputs).toEqual([{ name: 'paper-review', path: projectedPath }])
    expect(prepared.skillScopeGuidance).toContain('PROJECTED_SKILL_SENTINEL')
  })

  it('stops CodeBuddy before dispatch when its projected Skill document cannot be loaded', async () => {
    const pubmed = {
      name: 'mcp-pubmed',
      description: 'Search PubMed literature.',
      path: '/missing/.claude/skills/mcp-pubmed/SKILL.md',
      source: 'connector' as const
    }
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        catalogForCodeBuddyRoot: async () => [pubmed]
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({})

    await expect(
      handle.prepareProvider({
        frameworkId: codeBuddyFramework.id,
        selectionText: 'use pubmed',
        promptText: 'use pubmed',
        codebuddy: {
          root: '/missing',
          selectorAvailable: true,
          selectSkills: async () => [pubmed]
        }
      })
    ).rejects.toThrow('CodeBuddy Skill routing failed (document-error).')
  })

  it('stops CodeBuddy before dispatch when semantic Skill selection fails', async () => {
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        catalogForCodeBuddyRoot: async () => [
          {
            name: 'literature-review',
            description: 'Search and review literature.',
            path: '/skills/literature-review/SKILL.md'
          }
        ]
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({})

    await expect(
      handle.prepareProvider({
        frameworkId: codeBuddyFramework.id,
        selectionText: 'find the latest papers',
        promptText: 'find the latest papers',
        codebuddy: {
          root: '/skills',
          selectorAvailable: true,
          selectSkills: async () => {
            throw new Error('missing-function-call')
          }
        }
      })
    ).rejects.toThrow('CodeBuddy Skill routing failed (selector-error).')
  })

  it('continues CodeBuddy when the selector validly chooses no Skill', async () => {
    const selectSkills = vi.fn(async () => [])
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        catalogForCodeBuddyRoot: async () => [
          {
            name: 'literature-review',
            description: 'Search and review literature.',
            path: '/skills/literature-review/SKILL.md'
          }
        ]
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({})

    const prepared = await handle.prepareProvider({
      frameworkId: codeBuddyFramework.id,
      selectionText: 'explain this local function',
      promptText: 'explain this local function',
      codebuddy: {
        root: '/skills',
        selectorAvailable: true,
        selectSkills
      }
    })

    expect(selectSkills).toHaveBeenCalledTimes(2)
    expect((selectSkills.mock.calls[1] as unknown as [string])[0]).toContain(
      '<open_science_skill_route_verification>'
    )
    expect(prepared.skillActivityInputs).toEqual([])
    expect(prepared.skillScopeGuidance).toContain('No Skill is routed for this turn.')
  })

  it('loads a CodeBuddy Skill when empty-route confirmation finds a false negative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codebuddy-turn-skill-confirm-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const skillDirectory = join(root, '.claude', 'skills', 'mcp-pubmed')
    const pubmedPath = join(skillDirectory, 'SKILL.md')
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(pubmedPath, 'PUBMED_ROUTE_SENTINEL')
    const pubmed = {
      name: 'mcp-pubmed',
      description: 'Search PubMed literature.',
      path: pubmedPath,
      source: 'connector' as const
    }
    const selectSkills = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([pubmed])
    const owner = new AcpTurnSkillOwner({
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        catalogForCodeBuddyRoot: async () => [pubmed]
      },
      requestSkillsReload: vi.fn()
    })
    const handle = await owner.authorize({})

    const prepared = await handle.prepareProvider({
      frameworkId: codeBuddyFramework.id,
      selectionText: 'find recent biomedical papers',
      promptText: 'find recent biomedical papers',
      codebuddy: { root, selectorAvailable: true, selectSkills }
    })

    expect(selectSkills).toHaveBeenCalledTimes(2)
    expect(selectSkills.mock.calls[1]?.[0]).toContain('<open_science_skill_route_verification>')
    expect(prepared.skillActivityInputs).toEqual([{ name: 'mcp-pubmed', path: pubmedPath }])
    expect(prepared.skillScopeGuidance).toContain('PUBMED_ROUTE_SENTINEL')
  })
})
