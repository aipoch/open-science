// Customize Skill workflow contract tests.
//
// These tests drive the `/customize` workflow against a FAKE `host.agents` (issue 02's contract). They
// encode the review/approval/read-back rules from design.md §7/§8/§9/§10 and the confirmation
// boundaries from PRD §6. The real SDK is wired by issue 08; this issue authorizes the Skill source
// and proves the conversational policy against a stable fake.

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { FakeHostAgents, type FakeProfileRecord } from './fake-host-agents'
import type { ConnectorReadModel } from '../agents-service'
import type { ApprovalResult } from '../../../shared/agents-contract'
import {
  buildReviewedTarget,
  draftChangedSinceConfirmation,
  explainDelete,
  explainNameChange,
  explainSwitch,
  isExplicitConfirmation,
  isStaleRevision,
  mustAskForScope,
  preferAtomicUpdate,
  renderOrdinaryReview,
  reportDelete,
  reportSwitch,
  requiresSystemPermissionCard,
  requiresTextualConfirmation,
  resolveCreateScope,
  SCOPE_CLARIFICATION
} from './workflow'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const demoProfile = (overrides: Partial<FakeProfileRecord> = {}): FakeProfileRecord => ({
  id: 'sp-1',
  name: 'Bio Expert',
  description: 'a specialist',
  systemPrompt: 'You are a bio expert.',
  iconKey: 'beaker',
  colorKey: 'green',
  enabled: true,
  unrestricted: false,
  skillIds: ['skill-a'],
  connectorIds: ['conn-a'],
  revision: 1,
  ...overrides
})

const skills = [
  {
    id: 'skill-a',
    name: 'skill-a',
    displayName: 'Skill A',
    source: 'featured',
    mainEnabled: true,
    available: true
  },
  {
    id: 'skill-b',
    name: 'skill-b',
    displayName: 'Skill B',
    source: 'featured',
    mainEnabled: true,
    available: true
  }
]

const connectors: ConnectorReadModel[] = [
  {
    id: 'conn-a',
    displayName: 'Chemistry',
    description: 'chemistry connector',
    mainEnabled: true,
    availability: 'available',
    source: 'bundled',
    tools: [{ id: 'search', description: 'search' }]
  }
]

// A recording approval gateway fake. Tests configure approve/decline and assert what the Skill asked.
const recordingGateway = (
  decision: 'approved' | 'declined'
): {
  decide: (request: {
    operation: 'update' | 'delete' | 'switch'
    summary: { name?: string; newName?: string; target?: string | null }
  }) => Promise<ApprovalResult>
  decisions: Array<Record<string, unknown>>
} => {
  const decisions: Array<Record<string, unknown>> = []
  const decide = async (
    request: {
      operation: 'update' | 'delete' | 'switch'
      summary: { name?: string; newName?: string; target?: string | null }
    } & Record<string, unknown>
  ): Promise<ApprovalResult> => {
    decisions.push(request)
    return decision === 'approved'
      ? { status: 'approved' }
      : { status: 'declined', operation: request.operation }
  }
  return { decide, decisions }
}

const switchNotifications: Array<{ sessionId: string; targetName: string | null }> = []
const switchNotifier = {
  notify: (pending: { sessionId: string; targetName: string | null }): void => {
    switchNotifications.push(pending)
  }
}

const makeSdk = (
  options: {
    profiles?: FakeProfileRecord[]
    approvalGateway?: ReturnType<typeof recordingGateway>
  } = {}
): FakeHostAgents =>
  new FakeHostAgents({
    profiles: options.profiles ?? [demoProfile()],
    skills,
    connectors,
    approvalGateway: options.approvalGateway,
    switchNotifier,
    callingSession: { sessionId: 'session-1' }
  })

describe('customize Skill: bundled source', () => {
  const skillPath = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'resources',
    'skills',
    'customize',
    'SKILL.md'
  )

  it('ships a SKILL.md with public name customize', async () => {
    const raw = await readFile(skillPath, 'utf8')
    expect(raw).toMatch(/^---[\s\S]*?^name:\s*customize$/m)
  })

  it('documents the host.agents SDK surface', async () => {
    const raw = await readFile(skillPath, 'utf8')
    for (const method of [
      'host.agents.list(',
      'host.agents.get(',
      'host.agents.create(',
      'host.agents.update(',
      'host.agents.switch(',
      'host.agents.delete(',
      'host.agents.list_skills(',
      'host.agents.list_connectors('
    ]) {
      expect(raw).toContain(method)
    }
  })

  it('routes Skill requests to the internal native Skill Creator without using Artifacts', async () => {
    const raw = await readFile(skillPath, 'utf8')
    expect(raw).toContain("host.skills.read('skill-creator')")
    expect(raw).toContain('not Artifacts')
    expect(raw).toContain('create or revise the Skill first')
  })

  it('documents identity-first, bounded, composable Specialist authoring and offers switching', async () => {
    const raw = await readFile(skillPath, 'utf8')
    expect(raw).toContain('You are {display_name}')
    expect(raw).toMatch(/what\s+(?:the\s+)?Specialist\s+does not do/i)
    expect(raw).toMatch(/heavy how-to.*Skills/i)
    expect(raw).toMatch(/after.*exists.*offer.*switch/is)
  })

  it('is activated in the Featured manifest (issue 08 turns on the live journey)', async () => {
    const manifestRaw = await readFile(
      join(__dirname, '..', '..', '..', '..', 'resources', 'skills', 'manifest.json'),
      'utf8'
    )
    const manifest = JSON.parse(manifestRaw) as { skills: Array<{ id: string; name: string }> }
    const entry = manifest.skills.find((skill) => skill.id === 'customize')
    expect(entry).toBeDefined()
    // The Featured entry ships under the Title Case display name, matching every other bundled
    // skill's naming style. Activation identity (manifest id === SKILL.md frontmatter name) is
    // guarded separately by the bundled-skill nudge-identity suite.
    expect(entry?.name).toBe('Customize')
  })
})

describe('customize Skill: static rejection of forbidden architecture', () => {
  const skillPath = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'resources',
    'skills',
    'customize',
    'SKILL.md'
  )

  const forbidden = [
    {
      label: 'python SDK',
      needle: /host\.agents.*python|python.*host\.agents/is,
      except: /do not use python/i
    },
    {
      label: 'management MCP',
      needle: /management mcp|host\.mcp\(\).*agents/i,
      except: /do not.*management mcp|never.*host\.mcp/i
    },
    {
      label: 'Customize Profile',
      needle: /customize (specialist\/)?profile/i,
      except: /do not.*customize profile|no customize profile/i
    },
    {
      label: 'duplicate operations',
      needle: /deduplicate|duplicate (specialist|operation)/i,
      except: /do not.*duplicate|no duplicate/i
    },
    {
      label: 'per-Specialist environments',
      needle: /per-specialist environment/i,
      except: /no per-specialist environment|do not.*per-specialist/i
    },
    {
      label: 'automatic retry',
      needle: /retry (the )?(declined|stale|privileged)/i,
      except: /do not.*retry|never.*retry|no automatic retry/i
    },
    {
      label: 'hard-isolation claim',
      needle: /hard (security )?isolation|secure boundary/i,
      except: /not a (hard )?security boundary|workflow guidance/i
    }
  ]

  // Reads the body once and asserts that every forbidden concept, when present, appears only inside a
  // sentence that explicitly negates it (do not / never / no / not). The Skill may name what to avoid,
  // but must never prescribe the forbidden architecture as a positive instruction.
  it('does not prescribe forbidden architecture', async () => {
    const body = await readFile(skillPath, 'utf8')
    // Split into sentences on period + newline boundaries, keeping a little context for list items.
    const sentences = body.split(/(?<=\.)\s+|\n+/)
    const negation =
      /\b(do not|don't|never|must not|no |not |not configured|absent|forbidden|without|do not use|do not look|are not|is not)\b/i
    for (const rule of forbidden) {
      const hits = sentences.filter((sentence) => new RegExp(rule.needle, 'i').test(sentence))
      for (const hit of hits) {
        if (!negation.test(hit)) {
          throw new Error(
            `forbidden "${rule.label}" prescribed without negation in: "${hit.trim()}"`
          )
        }
      }
    }
  })

  it('uses only JavaScript host.agents (no python data-kernel access)', async () => {
    const body = await readFile(skillPath, 'utf8')
    // The Skill must state it operates in the JavaScript control-plane REPL only.
    expect(body.toLowerCase()).toMatch(/javascript/)
  })
})

describe('customize Skill: scope clarification', () => {
  it('asks for Full or Selected when scope is unspecified and never silently grants Full', () => {
    expect(resolveCreateScope({})).toBe('unspecified')
    expect(mustAskForScope('unspecified')).toBe(true)
    expect(SCOPE_CLARIFICATION).toMatch(/full access/i)
    expect(SCOPE_CLARIFICATION).toMatch(/selected/i)
    expect(SCOPE_CLARIFICATION).toMatch(/not assume full/i)
  })

  it('treats explicit full or supplied arrays as decided', () => {
    expect(resolveCreateScope({ unrestricted: true })).toBe('full')
    expect(resolveCreateScope({ skill_names: ['skill-a'] })).toBe('selected')
    expect(resolveCreateScope({ connector_names: ['conn-a'] })).toBe('selected')
  })
})

describe('customize Skill: live read + complete draft', () => {
  it('reads live Profiles plus Skill/Connector catalogs before proposing a target state', async () => {
    const sdk = makeSdk()
    const [profile] = await sdk.list()
    const skillCatalog = await sdk.list_skills()
    const connectorCatalog = await sdk.list_connectors()
    expect(profile.name).toBe('Bio Expert')
    expect(skillCatalog.map((entry) => entry.id)).toContain('skill-a')
    expect(connectorCatalog.map((entry) => entry.id)).toContain('conn-a')
    const target = buildReviewedTarget(profile)
    expect(target.capabilityMode).toBe('selected')
  })

  it('ordinary review shows every required field and tool-scope absence', () => {
    const target = buildReviewedTarget({
      id: 'sp-1',
      name: 'Bio Expert',
      displayName: 'Bio Expert',
      description: 'a specialist',
      systemPrompt: 'FULL INSTRUCTIONS',
      iconKey: 'beaker',
      colorKey: 'green',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['skill-a'], connectorIds: ['conn-a'], connectorTools: [] },
      revision: 1
    })
    const review = renderOrdinaryReview(target, ['description'])
    for (const required of [
      'Name: Bio Expert',
      'Description: a specialist',
      'Full system instructions:',
      'FULL INSTRUCTIONS',
      'Icon: beaker',
      'Color: green',
      'Enabled: yes',
      'Mode: selected',
      'Skills: skill-a',
      'Connectors: conn-a',
      'Connector tool scope: not configured'
    ]) {
      expect(review).toContain(required)
    }
    expect(review).toContain('Changed fields: description')
  })
})

describe('customize Skill: revision + stale-draft handling', () => {
  it('a stale revision invalidates confirmation and requires a fresh read/review', () => {
    expect(isStaleRevision(1, 2)).toBe(true)
    expect(isStaleRevision(2, 2)).toBe(false)
  })

  it('a changed draft invalidates prior confirmation', () => {
    expect(draftChangedSinceConfirmation({ a: 1 }, undefined)).toBe(true)
    expect(draftChangedSinceConfirmation({ a: 1 }, { a: 1 })).toBe(false)
    expect(draftChangedSinceConfirmation({ a: 2 }, { a: 1 })).toBe(true)
  })

  it('update with a stale revision fails without merge or retry', async () => {
    const sdk = makeSdk()
    await expect(
      sdk.update('Bio Expert', { description: 'changed', revision: 99 })
    ).rejects.toThrow(/host\.agents\.update:.*stale revision/i)
  })
})

describe('customize Skill: atomic update preference', () => {
  it('multi-field ordinary change produces one atomic update patch', () => {
    const live = buildReviewedTarget({
      id: 'sp-1',
      name: 'Bio Expert',
      displayName: 'Bio Expert',
      description: 'old',
      systemPrompt: 'old prompt',
      iconKey: 'beaker',
      colorKey: 'green',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['skill-a'], connectorIds: ['conn-a'], connectorTools: [] },
      revision: 1
    })
    const target: typeof live = {
      ...live,
      description: 'new',
      systemPrompt: 'new prompt',
      skillIds: ['skill-a', 'skill-b']
    }
    const plan = preferAtomicUpdate(target, live)
    expect(plan.kind).toBe('atomic-update')
    expect(plan.patch.description).toBe('new')
    expect(plan.patch.system_prompt).toBe('new prompt')
    expect(plan.patch.skill_names).toEqual(['skill-a', 'skill-b'])
    // connector unchanged => not present in patch
    expect(plan.patch.connector_names).toBeUndefined()
  })

  it('applies the atomic patch in a single update call that returns read-back', async () => {
    const sdk = makeSdk()
    const before = await sdk.get('Bio Expert')
    const plan = preferAtomicUpdate(
      { ...buildReviewedTarget(before), description: 'updated description' },
      buildReviewedTarget(before)
    )
    const result = await sdk.update('Bio Expert', { ...plan.patch, revision: before.revision })
    expect(result.description).toBe('updated description')
    expect(result.revision).toBe(before.revision + 1)
  })
})

describe('customize Skill: confirmation boundaries', () => {
  it('create and ordinary update require textual confirmation, not a system card', () => {
    expect(requiresTextualConfirmation('create')).toBe(true)
    expect(requiresTextualConfirmation('ordinary-update')).toBe(true)
    expect(requiresSystemPermissionCard('create')).toBe(false)
    expect(requiresSystemPermissionCard('ordinary-update')).toBe(false)
  })

  it('name-changing update, delete, switch use the system card as the only authorization point', () => {
    expect(requiresSystemPermissionCard('name-changing-update')).toBe(true)
    expect(requiresSystemPermissionCard('delete')).toBe(true)
    expect(requiresSystemPermissionCard('switch')).toBe(true)
    expect(requiresTextualConfirmation('name-changing-update')).toBe(false)
    expect(requiresTextualConfirmation('delete')).toBe(false)
    expect(requiresTextualConfirmation('switch')).toBe(false)
  })

  it('recognizes explicit textual confirmation', () => {
    expect(isExplicitConfirmation('yes')).toBe(true)
    expect(isExplicitConfirmation('Confirm')).toBe(true)
    expect(isExplicitConfirmation('no, wait')).toBe(false)
  })
})

describe('customize Skill: create read-back', () => {
  it('creates with explicit selected arrays and reads back', async () => {
    const sdk = makeSdk({ profiles: [] })
    const created = await sdk.create({
      name: 'New',
      description: 'd',
      system_prompt: 'p',
      skill_names: ['skill-a'],
      connector_names: ['conn-a']
    })
    expect(created.capabilityMode).toBe('selected')
    expect(created.selectedCapabilities.skillIds).toEqual(['skill-a'])
    // read-back via get
    const readBack = await sdk.get('New')
    expect(readBack.name).toBe('New')
    expect(readBack.revision).toBe(1)
  })
})

describe('customize Skill: capability update read-back', () => {
  it('update to Full preserves selected config, update to Selected replaces supplied collection', async () => {
    const sdk = makeSdk()
    const before = await sdk.get('Bio Expert')
    const toFull = await sdk.update('Bio Expert', { unrestricted: true, revision: before.revision })
    expect(toFull.capabilityMode).toBe('full')
    // switching back to Selected with a new skill set
    const toSelected = await sdk.update('Bio Expert', {
      skill_names: ['skill-b'],
      revision: toFull.revision
    })
    expect(toSelected.capabilityMode).toBe('selected')
    expect(toSelected.selectedCapabilities.skillIds).toEqual(['skill-b'])
  })
})

describe('customize Skill: stale re-review', () => {
  it('re-reads and rebuilds the draft when the revision changed mid-review', async () => {
    const sdk = makeSdk()
    const firstRead = await sdk.get('Bio Expert')
    // a concurrent mutation bumps the revision
    await sdk.update('Bio Expert', { enabled: false, revision: firstRead.revision })
    // the stale revision the Skill carried must fail closed
    await expect(
      sdk.update('Bio Expert', { description: 'late edit', revision: firstRead.revision })
    ).rejects.toThrow(/stale revision/i)
    // the Skill re-reads and reviews again
    const fresh = await sdk.get('Bio Expert')
    expect(fresh.revision).toBe(firstRead.revision + 1)
  })
})

describe('customize Skill: approved privileged operations', () => {
  it('approved name-changing update applies atomically via the system card', async () => {
    const gateway = recordingGateway('approved')
    const sdk = makeSdk({ approvalGateway: gateway })
    const before = await sdk.get('Bio Expert')
    const result = await sdk.update('Bio Expert', {
      name: 'Renamed',
      description: 'new desc',
      revision: before.revision
    })
    expect(result.name).toBe('Renamed')
    expect(result.description).toBe('new desc')
    expect(gateway.decisions[0]).toMatchObject({ operation: 'update' })
    expect(gateway.decisions[0].summary).toMatchObject({ name: 'Bio Expert', newName: 'Renamed' })
    // old name no longer resolves
    await expect(sdk.get('Bio Expert')).rejects.toThrow(/not found/i)
  })

  it('approved delete removes the profile', async () => {
    const gateway = recordingGateway('approved')
    const sdk = makeSdk({ approvalGateway: gateway })
    const before = await sdk.get('Bio Expert')
    const result = await sdk.delete('Bio Expert', { revision: before.revision })
    expect(result.status).toBe('deleted')
    await expect(sdk.get('Bio Expert')).rejects.toThrow(/not found/i)
  })

  it('approved switch persists a next-message binding', async () => {
    switchNotifications.length = 0
    const gateway = recordingGateway('approved')
    const sdk = makeSdk({ approvalGateway: gateway })
    const result = (await sdk.switch('Bio Expert')) as {
      status: 'switched'
      sessionBinding: { sessionId: string; targetName: string | null }
    }
    expect(result.status).toBe('switched')
    expect(result.sessionBinding).toMatchObject({
      sessionId: 'session-1',
      targetName: 'Bio Expert'
    })
    expect(switchNotifications[0]).toMatchObject({ targetName: 'Bio Expert' })
  })

  it('approved switch to Main (null) persists a Main binding', async () => {
    switchNotifications.length = 0
    const gateway = recordingGateway('approved')
    const sdk = makeSdk({ approvalGateway: gateway })
    const result = (await sdk.switch(null)) as {
      status: 'switched'
      sessionBinding: { sessionId: string; targetName: string | null }
    }
    expect(result.status).toBe('switched')
    expect(result.sessionBinding.targetName).toBeNull()
    expect(switchNotifications[0].targetName).toBeNull()
  })
})

describe('customize Skill: declined privileged operations', () => {
  it('declined name-changing update leaves every field unchanged and is not retried', async () => {
    const gateway = recordingGateway('declined')
    const sdk = makeSdk({ approvalGateway: gateway })
    const before = await sdk.get('Bio Expert')
    const result = (await sdk.update('Bio Expert', {
      name: 'Renamed',
      revision: before.revision
    })) as unknown as { status: string; operation: string }
    expect(result.status).toBe('declined')
    expect(result.operation).toBe('update')
    // nothing changed
    const unchanged = await sdk.get('Bio Expert')
    expect(unchanged.revision).toBe(before.revision)
    expect(gateway.decisions).toHaveLength(1) // not retried
  })

  it('declined delete is reported as a user decision and not retried', async () => {
    const gateway = recordingGateway('declined')
    const sdk = makeSdk({ approvalGateway: gateway })
    const result = (await sdk.delete('Bio Expert')) as {
      status: 'declined'
      operation: 'delete'
    }
    expect(result.status).toBe('declined')
    expect(result.operation).toBe('delete')
    // still present
    const still = await sdk.get('Bio Expert')
    expect(still.name).toBe('Bio Expert')
    expect(gateway.decisions).toHaveLength(1)
  })

  it('declined switch is reported as a user decision and not retried', async () => {
    const gateway = recordingGateway('declined')
    const sdk = makeSdk({ approvalGateway: gateway })
    const result = (await sdk.switch('Bio Expert')) as {
      status: 'declined'
      operation: 'switch'
    }
    expect(result.status).toBe('declined')
    expect(result.operation).toBe('switch')
    expect(sdk.getPendingBinding()).toBeUndefined()
    expect(gateway.decisions).toHaveLength(1)
  })
})

describe('customize Skill: reporting', () => {
  it('switch reports automatic continuation after the current control tool', () => {
    expect(reportSwitch('Bio Expert')).toMatch(/continue this task automatically/i)
    expect(reportSwitch('Bio Expert')).toMatch(/current control tool/i)
  })

  it('switch to Main reports Main Agent as the target', () => {
    expect(reportSwitch(null)).toMatch(/Main Agent/)
  })

  it('delete reports bound conversations become unavailable, not switched to Main', () => {
    const msg = reportDelete('Bio Expert')
    expect(msg).toMatch(/unavailable/i)
    expect(msg).toMatch(/not.*Main Agent/i)
  })

  it('privileged explanations name the impending action', () => {
    expect(explainSwitch('Bio Expert', 'Other')).toMatch(/continues automatically/i)
    expect(explainNameChange('A', 'B')).toMatch(/rename.*A.*B/i)
    expect(explainDelete('A')).toMatch(/delete.*A/i)
    expect(explainDelete('A')).toMatch(/unavailable/i)
  })
})

describe('customize Skill: catalog resolution + sanitized errors', () => {
  it('rejects ambiguous names and tells the caller to use the stable id', async () => {
    const sdk = new FakeHostAgents({
      profiles: [],
      skills: [
        {
          id: 's1',
          name: 'dup',
          displayName: 'Dup',
          source: 'featured',
          mainEnabled: true,
          available: true
        },
        {
          id: 's2',
          name: 'dup',
          displayName: 'Dup',
          source: 'featured',
          mainEnabled: true,
          available: true
        }
      ],
      connectors: []
    })
    await expect(sdk.list_skills('dup')).rejects.toThrow(/host\.agents\.list_skills:.*multiple/i)
  })

  it('errors are sanitized and prefixed host.agents.<method>:', async () => {
    const sdk = makeSdk()
    await expect(sdk.get('Missing')).rejects.toThrow(/^host\.agents\.get:/)
  })

  it('never returns secret material from the connector catalog', async () => {
    const sdk = makeSdk()
    const catalog = await sdk.list_connectors()
    const serialized = JSON.stringify(catalog)
    expect(serialized).not.toMatch(/secret|token|apiKey|password/i)
  })
})
