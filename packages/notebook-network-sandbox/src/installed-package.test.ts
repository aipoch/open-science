import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('loads the installed sandbox without reaching outside its package for configuration', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'installed-notebook-sandbox-'))
  try {
    // Materialize the local file dependency as npm does (not a source-tree symlink). No sibling
    // application src/ tree is present, so an out-of-package relative import cannot be concealed.
    const installed = join(fixture, 'node_modules', '@aipoch', 'notebook-network-sandbox')
    mkdirSync(join(fixture, 'node_modules', '@aipoch'), { recursive: true })
    cpSync(fileURLToPath(new URL('..', import.meta.url)), installed, { recursive: true })
    const entry = join(fixture, 'entry.ts')
    writeFileSync(
      entry,
      `
      import { NotebookNetworkSandbox } from '@aipoch/notebook-network-sandbox'
      import { createRuntimeConfig } from './node_modules/@aipoch/notebook-network-sandbox/src/config.js'
      const config = createRuntimeConfig({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: ${JSON.stringify(join(fixture, 'resources'))} },
        packaged: false
      }, 'x64', { OPEN_SCIENCE_STORAGE_ROOT: ${JSON.stringify(join(fixture, 'config'))} })
      console.log(JSON.stringify({ loaded: typeof NotebookNetworkSandbox, root: config.windowsOwnershipRoot }))
    `
    )
    const bundle = join(fixture, 'entry.cjs')
    buildSync({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs'
    })
    const result = JSON.parse(execFileSync(process.execPath, [bundle], { encoding: 'utf8' }))
    expect(result).toEqual({
      loaded: 'function',
      root: join(fixture, 'config', 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
