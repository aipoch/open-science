import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectSmokeDiagnostics, selectSmokeProcesses } from './package-smoke-diagnostics.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('package smoke failure evidence', () => {
  it('preserves zombie/live states and descendants without unrelated processes', () => {
    const table =
      '30 20 S 00:02 node\n20 10 Z 00:03 backend\n10 1 S 00:04 app\n99 1 S 00:10 unrelated'
    expect(selectSmokeProcesses(table, 10)).toBe(table.split('\n').slice(0, 3).join('\n'))
    expect(selectSmokeProcesses(table, 404)).toContain('absent')
  })
  it('collects only this desktop launch log, bounds its tail and redacts the token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smoke-diagnostics-'))
    roots.push(root)
    await mkdir(join(root, 'logs'))
    const token = 'test-token-123456789012345678901234567890'
    await writeFile(join(root, 'web-token'), token)
    await writeFile(
      join(root, 'logs', 'desktop-backend-42-100.log'),
      `old${'x'.repeat(40_000)}\ncurrent ${token}`
    )
    await writeFile(
      join(root, 'logs', 'desktop-backend-99-100.log'),
      'other launch must not appear'
    )
    const diagnostic = await collectSmokeDiagnostics(
      { configRoot: root, pid: 42, desktop: true },
      { getProcessTable: async () => '42 1 S 00:10 Open-Science' }
    )
    expect(diagnostic).toContain('42 1 S')
    expect(diagnostic).toContain('current <REDACTED>')
    expect(diagnostic).not.toContain(token)
    expect(diagnostic).not.toContain('other launch')
    expect(diagnostic).not.toContain('old')
    expect(diagnostic.length).toBeLessThan(34_000)
  })
  it('collects CLI daemon logs even after the service state has been removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-diagnostics-'))
    roots.push(root)
    await writeFile(join(root, 'cli-daemon-uuid.log'), 'shutdown step 7 complete')
    const diagnostic = await collectSmokeDiagnostics(
      { configRoot: root, pid: 42 },
      { getProcessTable: async () => '42 1 Z 00:12 node' }
    )
    expect(diagnostic).toContain('42 1 Z')
    expect(diagnostic).toContain('shutdown step 7 complete')
  })
  it('keeps missing evidence explicit without replacing the original failure', async () => {
    const diagnostic = await collectSmokeDiagnostics({
      configRoot: '/nonexistent-smoke-root',
      pid: undefined
    })
    expect(diagnostic).toContain('backend logs unavailable')
  })
})
