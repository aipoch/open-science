import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import { COMPUTE_SKILL_DIRECTORY, COMPUTE_SKILL_ID, syncComputeSkillDoc } from './skill-doc'

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

const writeCanonicalDocument = async (
  skillsDir: string,
  directoryName = COMPUTE_SKILL_DIRECTORY
): Promise<void> => {
  await mkdir(join(skillsDir, directoryName), { recursive: true })
  await writeFile(
    join(skillsDir, directoryName, 'SKILL.md'),
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
  it('documents only camelCase compute calls and inputs while preserving return fields', async () => {
    const doc = await readFile(
      join(__dirname, '..', '..', '..', 'resources', 'skills', 'remote-compute-ssh', 'SKILL.md'),
      'utf8'
    )

    for (const name of [
      'listCompute',
      'callCommand',
      'submitJob',
      'attachJob',
      'setConcurrencyLimit',
      'loginShell',
      'timeoutSeconds',
      'oldText',
      'dstFilename',
      'remotePath',
      'maxFileMb',
      'maxTotalMb'
    ]) {
      expect(doc).toContain(name)
    }
    expect(doc).toContain('job.job_id')
    expect(doc).toContain('r.featured_files')
    expect(doc).not.toMatch(
      /\b(?:list_compute|call_command|submit_job|attach_job|set_concurrency_limit|login_shell|timeout_seconds|old_text|dst_filename|remote_path|max_file_mb|max_total_mb)\b/
    )
  })

  it('keeps bundled model-compute examples on the camelCase contract', async () => {
    const skillsRoot = join(__dirname, '..', '..', '..', 'resources', 'skills')
    for (const skillId of ['borzoi', 'evo2', 'fair-esm2', 'scgpt']) {
      const doc = await readFile(join(skillsRoot, skillId, 'SKILL.md'), 'utf8')
      expect(doc).toContain('submitJob')
      expect(doc).toContain('dstFilename')
      expect(doc).toContain('timeoutSeconds')
      expect(doc).toContain('attachJob')
      expect(doc).toContain('job_id')
      expect(doc).not.toMatch(/\b(?:submit_job|dst_filename|timeout_seconds|attach_job)\b/)
    }
  })

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

  it('updates the canonical Agent-facing Compute Skill without an os- directory marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-skill-doc-agent-facing-'))
    roots.push(root)
    const skillsDir = join(root, 'skills')
    await writeCanonicalDocument(skillsDir, COMPUTE_SKILL_ID)

    await syncComputeSkillDoc(skillsDir, [sampleHost()], 'agent-facing')

    const doc = await readFile(join(skillsDir, COMPUTE_SKILL_ID, 'SKILL.md'), 'utf8')
    expect(doc).toContain('ssh:biowulf')
    expect(doc).toContain('connected')
    expect(await readdir(skillsDir)).toEqual([COMPUTE_SKILL_ID])
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
