import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('Windows development runtime setup', () => {
  it('checks runtime preparation before every standard development entry point', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
    for (const entry of ['predev', 'predev:web', 'predev:headless']) {
      expect(scripts[entry]).toContain('node scripts/check-windows-notebook-runtime.mjs')
    }
  })

  it('rejects missing, incomplete and outdated Windows assets with setup instructions', async () => {
    const { checkWindowsNotebookRuntime } = await import('./check-windows-notebook-runtime.mjs')
    const root = mkdtempSync(join(tmpdir(), 'dev-runtime-'))
    const runtime = join(root, 'packages/notebook-network-sandbox/vendor/windows-runtime')
    const options = { root, platform: 'win32', architecture: 'x64' }
    try {
      expect(() => checkWindowsNotebookRuntime({ ...options, platform: 'linux' })).not.toThrow()
      expect(() => checkWindowsNotebookRuntime(options)).toThrow('pwsh -File')
      for (const file of [
        'node/node.exe',
        'node/node_modules/npm/bin/npm-cli.js',
        'powershell/pwsh.exe'
      ]) {
        const path = join(runtime, 'x64', file)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, '')
      }
      const versions = { node: '1.2.3', powershell: '4.5.6' }
      writeFileSync(
        join(runtime, 'sources.json'),
        JSON.stringify({
          node: { version: versions.node },
          powershell: { version: versions.powershell }
        })
      )
      expect(() => checkWindowsNotebookRuntime(options)).toThrow('pwsh -File')
      writeFileSync(join(runtime, 'x64/build.json'), JSON.stringify({ ...versions, node: '0.0.0' }))
      expect(() => checkWindowsNotebookRuntime(options)).toThrow('out of date')
      writeFileSync(join(runtime, 'x64/build.json'), JSON.stringify(versions))
      expect(() => checkWindowsNotebookRuntime(options)).toThrow('out of date')
      writeFileSync(
        join(runtime, 'x64/build.json'),
        JSON.stringify({ ...versions, patches: ['node-appcontainer-package-scope-v1'] })
      )
      expect(() => checkWindowsNotebookRuntime(options)).toThrow('out of date')
      writeFileSync(
        join(runtime, 'x64/build.json'),
        JSON.stringify({
          ...versions,
          patches: ['node-appcontainer-package-scope-v1', 'npm-appcontainer-shared-prefix-v1']
        })
      )
      expect(() => checkWindowsNotebookRuntime(options)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
