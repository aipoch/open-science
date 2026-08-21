import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ComputeHost, CreateComputeHostRequest } from '../../shared/compute'
import { ClaudeCodeSkillMaterializer } from '../skills/materializer'
import type { BundledSkill } from '../skills/registry'
import { createComputeHandlers } from './ipc'
import type { ComputeService } from './compute-service'
import type { ComputeHostRepository } from './repository'
import { COMPUTE_SKILL_DIRECTORY } from './skill-doc'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, 'config', 'skills', COMPUTE_SKILL_DIRECTORY), 0o755).catch(
      () => undefined
    )
    await chmod(join(root, 'config', 'skills', COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 0o644).catch(
      () => undefined
    )
    await rm(root, { recursive: true, force: true })
  }
})

const host = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('SSH Compute Skill provisioning lifecycle', () => {
  it('keeps one canonical static Skill through bootstrap, refresh, and host changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-skill-provisioning-'))
    roots.push(root)
    const configDir = join(root, 'config')
    const skillsDir = join(configDir, 'skills')
    const sourceDir = join(root, 'bundled-remote-compute-ssh')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      join(sourceDir, 'SKILL.md'),
      [
        '---',
        'name: remote-compute-ssh',
        'description: Discover SSH compute hosts.',
        '---',
        '',
        '## Registered hosts',
        '',
        'Run `await host.compute.listRegistered()` to see all registered hosts.',
        '',
        '## API reference',
        '',
        'Bundled SSH guidance.'
      ].join('\n'),
      'utf8'
    )
    await mkdir(join(skillsDir, 'remote-compute-ssh'), { recursive: true })
    await writeFile(join(skillsDir, 'remote-compute-ssh', 'SKILL.md'), 'legacy duplicate')
    await mkdir(join(skillsDir, 'user-owned-skill'), { recursive: true })
    await writeFile(join(skillsDir, 'user-owned-skill', 'SKILL.md'), 'keep')

    const bundledSkill: BundledSkill = {
      id: 'remote-compute-ssh',
      name: 'remote-compute-ssh',
      displayName: 'Remote Compute (SSH)',
      description: 'Discover SSH compute hosts.',
      source: 'featured',
      updatedAt: 'v1',
      sourceDir
    }
    const hosts = [host()]
    const repository: ComputeHostRepository = {
      list: async () => hosts,
      get: async (providerId) => hosts.find((item) => item.providerId === providerId) ?? null,
      create: async (request: CreateComputeHostRequest) => {
        const created = host({
          id: 'host-2',
          providerId: `ssh:${request.sshAlias}`,
          displayName: request.sshAlias,
          sshAlias: request.sshAlias
        })
        hosts.push(created)
        return created
      },
      delete: async (providerId) => {
        const index = hosts.findIndex((item) => item.providerId === providerId)
        if (index >= 0) hosts.splice(index, 1)
      }
    } as ComputeHostRepository
    const materializer = new ClaudeCodeSkillMaterializer()
    const handlers = createComputeHandlers(
      repository,
      undefined,
      {} as ComputeService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )

    await materializer.sync(configDir, [bundledSkill])

    expect((await readdir(skillsDir)).filter((entry) => !entry.startsWith('.'))).toEqual([
      COMPUTE_SKILL_DIRECTORY,
      'user-owned-skill'
    ])
    await expect(
      readFile(join(skillsDir, 'remote-compute-ssh', 'SKILL.md'), 'utf8')
    ).rejects.toThrow()
    await expect(readFile(join(skillsDir, 'user-owned-skill', 'SKILL.md'), 'utf8')).resolves.toBe(
      'keep'
    )
    let document = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(document).toContain('name: remote-compute-ssh')
    expect(document).not.toContain('ssh:biowulf')

    await handlers.create({ sshAlias: 'lab-gpu' })
    await materializer.sync(configDir, [{ ...bundledSkill, updatedAt: 'v2' }])

    document = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(document).not.toContain('ssh:biowulf')
    expect(document).not.toContain('ssh:lab-gpu')
    expect(document).toContain('Bundled SSH guidance.')

    await handlers.delete('ssh:lab-gpu')
    await handlers.delete('ssh:biowulf')

    document = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(document).toContain('host.compute.listRegistered()')
    expect(document).not.toContain('ssh:lab-gpu')
    expect(document).not.toContain('ssh:biowulf')
  })
})
