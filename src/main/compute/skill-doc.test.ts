import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import type { ComputeHost } from '../../shared/compute'
import { renderComputeSkillDoc, syncComputeSkillDoc, removeComputeSkillDoc } from './skill-doc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
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

let tmpDir: string
beforeEach(async () => {
  tmpDir = join(tmpdir(), `skill-doc-test-${randomUUID()}`)
  await mkdir(tmpDir, { recursive: true })
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// renderComputeSkillDoc
// ---------------------------------------------------------------------------

describe('renderComputeSkillDoc', () => {
  it('contains Phase-1 ops in the output', () => {
    const doc = renderComputeSkillDoc([])
    expect(doc).toContain('host.compute.list()')
    expect(doc).toContain('host.compute.create(')
    expect(doc).toContain('call_command')
    expect(doc).toContain('host.compute.details(')
  })

  it('does NOT contain Phase-2 ops', () => {
    const doc = renderComputeSkillDoc([])
    expect(doc).not.toContain('submit_job')
    expect(doc).not.toContain('harvest')
    expect(doc).not.toContain('wait_for_notification')
    expect(doc).not.toContain('save_artifacts')
    expect(doc).not.toContain('download')
  })

  it('lists registered hosts with provider_id and status', () => {
    const hosts = [
      sampleHost({
        providerId: 'ssh:biowulf',
        displayName: 'biowulf',
        probeResult: { ok: true, probedAt: '2026-01-01T00:00:00Z', exitCode: 0, errorTail: null }
      }),
      sampleHost({
        id: 'host-2',
        providerId: 'ssh:lab-gpu',
        displayName: 'lab-gpu',
        probeResult: {
          ok: false,
          probedAt: '2026-01-01T00:00:00Z',
          exitCode: 255,
          errorTail: 'err'
        }
      })
    ]
    const doc = renderComputeSkillDoc(hosts)
    expect(doc).toContain('ssh:biowulf')
    expect(doc).toContain('biowulf')
    expect(doc).toContain('connected')
    expect(doc).toContain('ssh:lab-gpu')
    expect(doc).toContain('probe failed')
  })

  it('shows "(no hosts registered yet)" when list is empty', () => {
    const doc = renderComputeSkillDoc([])
    expect(doc).toContain('no hosts registered yet')
  })

  it('shows "not yet probed" when probeResult is undefined', () => {
    const doc = renderComputeSkillDoc([sampleHost()])
    expect(doc).toContain('not yet probed')
  })
})

// ---------------------------------------------------------------------------
// syncComputeSkillDoc — writes the skill file
// ---------------------------------------------------------------------------

describe('syncComputeSkillDoc', () => {
  it('creates skills/remote-compute-ssh/SKILL.md', async () => {
    await syncComputeSkillDoc(tmpDir, [sampleHost()])
    const content = await readFile(join(tmpDir, 'remote-compute-ssh', 'SKILL.md'), 'utf8')
    expect(content).toContain('ssh:biowulf')
    expect(content).toContain('host.compute.list()')
  })

  it('creates the skillsDir if it does not exist', async () => {
    const nested = join(tmpDir, 'sub', 'skills')
    await syncComputeSkillDoc(nested, [])
    const content = await readFile(join(nested, 'remote-compute-ssh', 'SKILL.md'), 'utf8')
    expect(content).toContain('no hosts registered yet')
  })

  it('overwrites an existing skill doc with the updated host list', async () => {
    await syncComputeSkillDoc(tmpDir, [sampleHost()])
    const newHost = sampleHost({ id: 'h2', providerId: 'ssh:lab', displayName: 'lab' })
    await syncComputeSkillDoc(tmpDir, [sampleHost(), newHost])
    const content = await readFile(join(tmpDir, 'remote-compute-ssh', 'SKILL.md'), 'utf8')
    expect(content).toContain('ssh:lab')
  })
})

// ---------------------------------------------------------------------------
// removeComputeSkillDoc — cleans up the skill dir
// ---------------------------------------------------------------------------

describe('removeComputeSkillDoc', () => {
  it('removes remote-compute-ssh dir when it exists', async () => {
    await syncComputeSkillDoc(tmpDir, [sampleHost()])
    await removeComputeSkillDoc(tmpDir)
    // Re-reading should fail because the dir is gone.
    await expect(readFile(join(tmpDir, 'remote-compute-ssh', 'SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('is a no-op when the dir does not exist', async () => {
    // Should not throw even when dir is absent.
    await expect(removeComputeSkillDoc(tmpDir)).resolves.toBeUndefined()
  })
})
