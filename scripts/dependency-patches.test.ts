import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import history from '../test/fixtures/shadcn-patch-history.json'

const require = createRequire(import.meta.url)
const patchCli = require.resolve('patch-package/index.js')
const patchName = '@shadcn+react+0.3.0.patch'
const patchPath = join(process.cwd(), 'patches', patchName)
const patchSource = readFileSync(patchPath, 'utf8').replaceAll('\r\n', '\n')
const patchLines = patchSource.split('\n')
const original = '"use client";\n' + patchLines.find((line) => line.startsWith('-import'))!.slice(1)
const patched = '"use client";\n' + patchLines.find((line) => line.startsWith('+import'))!.slice(1)
// Compact, byte-exact snapshots from the original Git patches; no Git history is needed in CI.
let historicalSource = original
const historicalVersions = history.map(({ commit, sha256, edits }) => {
  for (const [offset, length, replacement] of [...edits].reverse() as [number, number, string][]) {
    historicalSource =
      historicalSource.slice(0, offset) + replacement + historicalSource.slice(offset + length)
  }
  if (createHash('sha256').update(historicalSource).digest('hex') !== sha256) {
    throw new Error(`Corrupt historical patch fixture: ${commit}`)
  }
  return { name: commit, source: historicalSource, status: 0 }
})
let fixture: string | undefined

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
  fixture = undefined
})

describe('dependency patch installation', () => {
  it.each([
    { name: 'pristine', source: original, status: 0 },
    { name: 'already patched', source: patched, status: 0 },
    ...historicalVersions,
    {
      name: 'unknown partial patch',
      source: patched.replace('Math.min(o,n.scrollHeight)', 'o'),
      status: 1
    },
    { name: 'manual edits', source: patched.replace('var xe=8', 'var xe=9'), status: 1 },
    {
      name: 'different package version',
      source: historicalVersions[1].source,
      status: 1,
      version: '0.3.1'
    },
    { name: 'CRLF patch checkout', source: historicalVersions[1].source, status: 0, crlf: true },
    { name: 'old Windows patch output', source: historicalVersions[1].source + '\r', status: 0 },
    {
      name: 'unexpected patch baseline',
      source: historicalVersions[1].source,
      status: 1,
      corrupt: true
    }
  ])('handles $name', (scenario) => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: { postinstall: string }
    }
    const [prepareCommand, patchCommand] = scripts.postinstall.split(' && ')
    expect(prepareCommand).toBe('node scripts/prepare-shadcn-patch.mjs')
    const [command, ...args] = patchCommand.split(' ')
    expect(command).toBe('patch-package')
    expect(args).toContain('--error-on-fail')

    fixture = mkdtempSync(join(tmpdir(), 'open-science-patches-'))
    const packageDir = join(fixture, 'node_modules', '@shadcn', 'react')
    const entry = join(packageDir, 'dist', 'message-scroller', 'index.js')
    mkdirSync(join(packageDir, 'dist', 'message-scroller'), { recursive: true })
    mkdirSync(join(fixture, 'patches'))
    mkdirSync(join(fixture, 'scripts'))
    copyFileSync(
      'scripts/prepare-shadcn-patch.mjs',
      join(fixture, 'scripts', 'prepare-shadcn-patch.mjs')
    )
    writeFileSync(join(fixture, 'package.json'), '{}')
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ version: scenario.version ?? '0.3.0' })
    )
    writeFileSync(entry, scenario.source)
    writeFileSync(
      join(fixture, 'patches', patchName),
      scenario.corrupt
        ? patchSource.replace('"use client";', '"unexpected baseline";')
        : scenario.crlf
          ? patchSource.replaceAll('\n', '\r\n')
          : patchSource
    )

    // Execute the real lifecycle stages in order. CI already enables failure exits by default.
    for (let install = 0; install < 2; install++) {
      let status: number | null = null
      let output = ''
      for (const stage of [['scripts/prepare-shadcn-patch.mjs'], [patchCli, ...args]]) {
        const result = spawnSync(process.execPath, stage, {
          cwd: fixture,
          env: { ...process.env, CI: '' },
          encoding: 'utf8'
        })
        status = result.status
        output += result.stdout + result.stderr
        if (status !== 0) break
      }
      expect(status, output).toBe(scenario.status)
      const installed = readFileSync(entry, 'utf8')
      if (scenario.status === 0) {
        expect(installed.replaceAll('\r\n', '\n').replace(/\r$/, '') === patched).toBe(true)
      } else {
        expect(installed === scenario.source).toBe(true)
      }
      if (install === 1 || scenario.source === patched) {
        expect(output).not.toContain('Restored the original')
      }
    }
  })
})
