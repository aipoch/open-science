import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const patchCli = require.resolve('patch-package/index.js')
const patchName = '@shadcn+react+0.3.0.patch'
const patchPath = join(process.cwd(), 'patches', patchName)
const patchLines = readFileSync(patchPath, 'utf8').split('\n')
const original = '"use client";\n' + patchLines.find((line) => line.startsWith('-import'))!.slice(1)
const patched = '"use client";\n' + patchLines.find((line) => line.startsWith('+import'))!.slice(1)
let fixture: string | undefined

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
  fixture = undefined
})

describe('dependency patch installation', () => {
  it.each([
    ['pristine', original, 0],
    ['already patched', patched, 0],
    ['stale patch', patched.replace('Math.min(o,n.scrollHeight)', 'o'), 1]
  ] as const)('handles a %s installation', (_name, source, expectedStatus) => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: { postinstall: string }
    }
    const [command, ...args] = scripts.postinstall.split(' && ')[0].split(' ')
    expect(command).toBe('patch-package')
    expect(args).toContain('--error-on-fail')

    fixture = mkdtempSync(join(tmpdir(), 'open-science-patches-'))
    const packageDir = join(fixture, 'node_modules', '@shadcn', 'react')
    const entry = join(packageDir, 'dist', 'message-scroller', 'index.js')
    mkdirSync(join(packageDir, 'dist', 'message-scroller'), { recursive: true })
    mkdirSync(join(fixture, 'patches'))
    writeFileSync(join(fixture, 'package.json'), '{}')
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: '0.3.0' }))
    writeFileSync(entry, source)
    copyFileSync(patchPath, join(fixture, 'patches', patchName))

    // Explicitly exercise local installs: CI already enables failure exits by default.
    const result = spawnSync(process.execPath, [patchCli, ...args], {
      cwd: fixture,
      env: { ...process.env, CI: '' },
      encoding: 'utf8'
    })

    expect(result.status, result.stdout + result.stderr).toBe(expectedStatus)
    expect(readFileSync(entry, 'utf8')).toBe(expectedStatus === 0 ? patched : source)
  })
})
