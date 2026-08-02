import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import { COMPUTE_SKILL_DIRECTORY, syncComputeSkillDoc } from './skill-doc'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sampleHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'scheduler_cluster',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: {
    ok: true,
    probedAt: '2026-08-01T00:00:00.000Z',
    exitCode: 0,
    errorTail: null
  },
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const writeCanonicalDocument = async (skillsDir: string): Promise<void> => {
  await mkdir(join(skillsDir, COMPUTE_SKILL_DIRECTORY), { recursive: true })
  await writeFile(
    join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'),
    [
      '---',
      'name: remote-compute-ssh',
      'description: Discover and use SSH compute hosts.',
      '---',
      '',
      '## Registered hosts',
      '',
      '<!-- open-science:compute-hosts:start -->',
      'Run `await host.compute.list()` to see all registered hosts.',
      '<!-- open-science:compute-hosts:end -->',
      '',
      '## API reference',
      '',
      'Use `host.compute.create()` to bind a host.'
    ].join('\n'),
    'utf8'
  )
}

describe('syncComputeSkillDoc', () => {
  it('updates the one canonical document with the current host projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-skill-doc-'))
    roots.push(root)
    const skillsDir = join(root, 'skills')
    await writeCanonicalDocument(skillsDir)

    await syncComputeSkillDoc(skillsDir, [sampleHost()])

    const doc = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(doc).toContain('ssh:biowulf')
    expect(doc).toContain('biowulf')
    expect(doc).toContain('connected')
    expect(doc).toContain('## API reference')
    expect(await readdir(skillsDir)).toEqual([COMPUTE_SKILL_DIRECTORY])
  })

  it('replaces stale host data when a host is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-skill-doc-'))
    roots.push(root)
    const skillsDir = join(root, 'skills')
    await writeCanonicalDocument(skillsDir)

    await syncComputeSkillDoc(skillsDir, [sampleHost()])
    await syncComputeSkillDoc(skillsDir, [])

    const doc = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(doc).toContain('no hosts registered yet')
    expect(doc).not.toContain('ssh:biowulf')
  })
})
