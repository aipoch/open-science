import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { COMPUTE_SKILL_DIRECTORY, COMPUTE_SKILL_ID } from './skill-doc'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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
      'Run `await host.compute.listRegistered()` to see all registered hosts.',
      '',
      '## API reference',
      '',
      'Use `host.compute.create()` to bind a host.'
    ].join('\n'),
    'utf8'
  )
}

describe('Remote Compute Skill document', () => {
  it('documents only camelCase compute calls and inputs while preserving return fields', async () => {
    const doc = await readFile(
      join(__dirname, '..', '..', '..', 'resources', 'skills', 'remote-compute-ssh', 'SKILL.md'),
      'utf8'
    )

    for (const name of [
      'listHosts',
      'listRegistered',
      'listPreferred',
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
    expect(doc).toContain('execution_mode')
    expect(doc).toContain("status: 'queued' | 'submitted'")
    expect(doc).toContain('scheduler_job_id?')
    expect(doc).toContain('last_poll_error?')
    expect(doc).toContain('r.featured_files')
    expect(doc).not.toMatch(
      /\b(?:list_compute|call_command|submit_job|attach_job|set_concurrency_limit|login_shell|timeout_seconds|old_text|dst_filename|remote_path|max_file_mb|max_total_mb)\b/
    )
    expect(doc).not.toMatch(/\bhost\.compute\.(?:list|listCompute|listEnabled)\(/)
    expect(doc).not.toContain('open-science:compute-hosts')
    expect(doc).not.toContain('Every registered Compute Host is available')
    expect(doc).toContain("role === 'selected'")
    expect(doc).toContain('`last_probe_ok`, `probe_failed`, or `not_probed`')
    expect(doc).not.toContain('`connected`, `probe_failed`, or `not_probed`')
  })

  it('documents deterministic named environments and explicit Slurm execution', async () => {
    const doc = await readFile(
      join(__dirname, '..', '..', '..', 'resources', 'skills', 'remote-compute-ssh', 'SKILL.md'),
      'utf8'
    )

    expect(doc).toContain('configured execution mode')
    expect(doc).toContain('~/.openscience/environments/<name>.sh')
    expect(doc).toContain('Compute Environment Setup')
    expect(doc).toMatch(/prepare exact setup, repair, and removal instructions/)
    expect(doc).toMatch(/user-managed activation after they apply the plan/)
    expect(doc).not.toContain('Skill and create or repair it')
    expect(doc).toContain('Do not call `sbatch`, `squeue`, or `scancel`')
  })

  it('ships the environment setup Skill with the public Host API contract', async () => {
    const doc = await readFile(
      join(__dirname, '..', '..', '..', 'resources', 'skills', 'compute-env-setup', 'SKILL.md'),
      'utf8'
    )

    expect(doc).toContain('name: compute-env-setup')
    expect(doc).toContain('host.compute.details')
    expect(doc).toContain('compute.callCommand')
    expect(doc).toContain('compute.submitJob')
    expect(doc).toContain('configured for Slurm')
    expect(doc).toContain('user-managed durable resources')
    expect(doc).toContain('must not execute commands that create, replace, or remove')
    expect(doc).toContain('do not submit that installation through Open Science')
    expect(doc).not.toContain('Stage that file as a normal job input')
    expect(doc).toMatch(/matching idempotent\s+removal command/)
    expect(doc).toContain(
      'Record only facts established by host documentation or an explicit check'
    )
    expect(doc).toContain('does not by itself prove that home')
    expect(doc).toContain(
      'do not infer `sudo`, package-manager, network, quota, or administrator permissions'
    )
    expect(doc).toContain("this witness's observations")
    expect(doc).not.toMatch(/\b(?:compute_details|call_command|submit_job)\b/u)
  })

  it('documents the safe local input boundary for job submission', async () => {
    const doc = await readFile(
      join(__dirname, '..', '..', '..', 'resources', 'skills', 'remote-compute-ssh', 'SKILL.md'),
      'utf8'
    )

    expect(doc).toContain('`src` is relative to the Agent Session workspace')
    expect(doc).toMatch(/same workspace used by file\s+writing tools/)
    expect(doc).toMatch(/Do not pass arbitrary absolute local\s+paths/)
    expect(doc).toContain('`host.artifactPath(versionId)`')
    expect(doc).toMatch(/registered Session\s+input/)
    expect(doc).toContain('inside the Notebook Session')
    expect(doc).toMatch(/separate from the\s+Agent Session workspace/)
    expect(doc).toMatch(/do not\s+copy files between app-managed directories/)
    expect(doc).not.toContain('host.files.stageExternalInput')
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
      expect(doc).toContain('Retain the exact returned `job_id`')
      expect(doc).toMatch(/\.status\(\)` or `\.result\(\)/u)
      expect(doc).toContain('non-blocking')
      expect(doc).toContain('follow-up was `suppressed`')
      expect(doc).toContain('`committed`')
      expect(doc).toContain('later analysis turn')
      expect(doc).not.toMatch(/peek once|query once|result read once|do not poll|never poll/i)
      expect(doc).not.toContain('wait_for_notification')
      expect(doc).not.toMatch(/\b(?:submit_job|dst_filename|timeout_seconds|attach_job)\b/)
    }
  })

  it('keeps the canonical Agent-facing Compute Skill static too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-skill-doc-agent-facing-'))
    roots.push(root)
    const skillsDir = join(root, 'skills')
    await writeCanonicalDocument(skillsDir, COMPUTE_SKILL_ID)

    const doc = await readFile(join(skillsDir, COMPUTE_SKILL_ID, 'SKILL.md'), 'utf8')
    expect(doc).not.toContain('ssh:biowulf')
    expect(doc).toContain('host.compute.listRegistered()')
    expect(await readdir(skillsDir)).toEqual([COMPUTE_SKILL_ID])
  })
})
