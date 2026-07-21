import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import type { ComputeHost } from '../../shared/compute'
import { renderComputeSkillDoc, syncComputeSkillDoc } from './skill-doc'

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

  it('contains Phase-3a ops: submit_job, attach_job, list_compute', () => {
    const doc = renderComputeSkillDoc([])
    expect(doc).toContain('submit_job')
    expect(doc).toContain('attach_job')
    expect(doc).toContain('list_compute')
  })

  it('does NOT contain harvest/notification ops (Phase 3b+ ops excluded)', () => {
    const doc = renderComputeSkillDoc([])
    // harvest as an option key in submit_job is fine (3a stores it); what must be absent are
    // the Phase-3b harvest operation names and the notification op.
    expect(doc).not.toContain('HarvestResult')
    expect(doc).not.toContain('wait_for_notification')
    expect(doc).not.toContain('save_artifacts')
    expect(doc).not.toContain('.result()') // attach_job().result() is Phase 3b
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

  it('teaches the JavaScript control-plane REPL, not python cells', () => {
    const doc = renderComputeSkillDoc([])
    // host.compute lives on the repl kernel now; examples are JavaScript run via repl_execute.
    expect(doc).toContain('repl_execute')
    expect(doc).toContain('```javascript')
    // No python code fences — the old python-shim examples must be gone.
    expect(doc).not.toContain('```python')
  })

  it('states that the python/r data kernels have no host.compute', () => {
    const doc = renderComputeSkillDoc([])
    expect(doc.toLowerCase()).toContain('host.compute')
    // The isolation note: data kernels cannot reach host.compute.
    expect(doc).toMatch(/python\/r|data kernel/i)
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
