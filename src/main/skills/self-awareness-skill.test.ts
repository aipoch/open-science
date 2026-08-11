import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SkillRegistry } from './registry'

const skillsRoot = join(__dirname, '..', '..', '..', 'resources', 'skills')

describe('self-awareness bundled Skill', () => {
  it('is an internal runtime Skill with host.capabilities trigger metadata', async () => {
    const skill = (await new SkillRegistry(skillsRoot).list()).find(
      (entry) => entry.id === 'self-awareness'
    )

    expect(skill).toMatchObject({
      id: 'self-awareness',
      name: 'self-awareness',
      displayName: 'Self-awareness',
      source: 'featured',
      exposure: 'internal'
    })
    expect(skill?.description).toContain('host.capabilities()')
    expect(skill?.description).toMatch(/JavaScript control REPL/i)
  })

  it('documents the shipped eight-key JavaScript contract and read limits', async () => {
    const body = await new SkillRegistry(skillsRoot).body('self-awareness')

    for (const phrase of [
      'repl_execute',
      'await host.capabilities()',
      'exactly eight boolean keys',
      '`mcp`',
      '`compute`',
      '`agents`',
      '`skills`',
      '`artifacts`',
      '`lineage`',
      '`frames`',
      '`llm`',
      'caps.compute === true',
      'caps.artifacts === true',
      'caps.frames === true',
      'await host.artifacts(options)',
      'await host.artifactPath',
      'await host.frames.list(options)',
      'await host.frames.get(frameId, options)',
      'current Project',
      'exact full Frame ID',
      'active Branch',
      'private reasoning',
      'Version ID',
      'collisions',
      'never content',
      'fresh frozen projection',
      'caps.lineage === true',
      'caps.llm === true',
      'await host.llm',
      'await host.lineage.graph(versionId)',
      'await host.lineage.get(versionId)',
      '`versionId`',
      '`sessionId`',
      '`contentType`',
      '`maxDepth`',
      '`maxNodes`',
      '`rootsOnly`',
      '`branchId`',
      'graph discovery',
      'session-bound control token',
      'another Session',
      'cross-Project edges',
      'storage keys',
      'Python/R `host`',
      'same feature change'
    ]) {
      expect(body).toContain(phrase)
    }
    expect(body).not.toMatch(
      /host\.artifact_path|`(?:version_id|session_id|content_type|max_depth|max_nodes|roots_only|branch_id)`/
    )
    expect(body).not.toMatch(/host\.(query|artifact_read)/)
  })
})
