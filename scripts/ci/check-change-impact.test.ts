import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { findWindowsRoutingGaps } from './check-change-impact.mjs'

const roots: string[] = []
const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'change-impact-'))
  roots.push(root)
  for (const directory of ['src/main', 'src/preload', 'src/shared']) {
    mkdirSync(join(root, directory), { recursive: true })
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('change-impact Windows routing guard', () => {
  it('finds nested production gaps in each source root and ignores tests and neutral source', () => {
    const root = fixture({
      'src/main/new/helper.ts': "process.platform === 'win32'",
      'src/preload/new-bridge.ts': 'const options = { windowsHide: true }',
      'src/shared/new-view.tsx': 'process.env.APPDATA',
      'src/main/windows.ts': "process.platform === 'win32'",
      'src/main/neutral.ts': "process.platform === 'linux'",
      'src/main/new/helper.test.ts': "process.platform === 'win32'",
      'src/shared/new-view.spec.tsx': 'process.env.APPDATA',
      'src/main/readme.md': 'powershell'
    })
    expect(findWindowsRoutingGaps(root)).toEqual([
      'src/main/new/helper.ts',
      'src/preload/new-bridge.ts',
      'src/shared/new-view.tsx'
    ])
  })

  it('reproduces the release failure when the two registrations are removed', () => {
    const paths = [
      'src/main/legacy-service-termination.ts',
      'src/main/update/channel-certification.ts'
    ]
    const root = fixture(
      Object.fromEntries(paths.map((path) => [path, "process.platform === 'win32'"]))
    )
    const manifest = JSON.parse(readFileSync('scripts/ci/change-impact.json', 'utf8'))
    expect(findWindowsRoutingGaps(root, manifest)).toEqual([])
    const rule = manifest.rules.find((rule: { id: string }) => rule.id === 'windows_sensitive')
    rule.paths = rule.paths.filter((path: string) => !paths.includes(path))
    expect(findWindowsRoutingGaps(root, manifest)).toEqual(paths)
  })

  it.each(['e2e_functional_windows', 'e2e_workspace_windows'])(
    'rejects a registered source when the %s lane is lost',
    (lane) => {
      const root = fixture({ 'src/main/windows.ts': "process.platform === 'win32'" })
      const manifest = JSON.parse(readFileSync('scripts/ci/change-impact.json', 'utf8'))
      manifest.laneOrder = manifest.laneOrder.filter((entry: string) => entry !== lane)
      expect(findWindowsRoutingGaps(root, manifest)).toEqual(['src/main/windows.ts'])
    }
  )

  it('runs the CLI without dependencies and reports actionable paths on failure', () => {
    const root = fixture({ 'src/main/windows.ts': "process.platform === 'win32'" })
    const run = (): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [resolve('scripts/ci/check-change-impact.mjs')], {
        cwd: root,
        encoding: 'utf8'
      })
    const passed = run()
    expect(passed.status).toBe(0)
    expect(passed.stdout).toContain('routing passed')

    writeFileSync(join(root, 'src/shared/unregistered.ts'), 'process.env.APPDATA')
    const failed = run()
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('src/shared/unregistered.ts')
    expect(failed.stderr).toContain('scripts/ci/change-impact.json')
    expect(failed.stderr).toContain('windows_sensitive')
  })

  it('fails closed when a source root cannot be read', () => {
    const root = fixture({})
    rmSync(join(root, 'src/preload'), { recursive: true })
    const result = spawnSync(process.execPath, [resolve('scripts/ci/check-change-impact.mjs')], {
      cwd: root,
      encoding: 'utf8'
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ENOENT')
  })
})
