import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

it.each([
  'diagnostics',
  'providers',
  'skills',
  'environment',
  'compute',
  'notebook-analysis',
  'reproducibility',
  'specialists'
])(
  'bundles named imports from the local %s CommonJS package',
  (name) => {
    const root = mkdtempSync(join(tmpdir(), 'open-science-browser-commonjs-'))
    try {
      const fixtureRoot = join(root, 'e2e/browser/fixture')
      const packageRoot = join(root, 'packages', name, 'dist')
      mkdirSync(fixtureRoot, { recursive: true })
      mkdirSync(packageRoot, { recursive: true })
      writeFileSync(join(packageRoot, 'index.js'), 'exports.fixtureValue = "local package export"')
      writeFileSync(
        join(fixtureRoot, 'index.html'),
        '<title>local package</title><script type="module" src="./main.js"></script>'
      )
      writeFileSync(
        join(fixtureRoot, 'main.js'),
        `import { fixtureValue } from '../../../packages/${name}/dist/index.js'; document.body.textContent = fixtureValue`
      )
      const run = spawnSync(
        process.execPath,
        [
          join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
          'build',
          '--config',
          resolve('e2e/vite.browser-test.config.ts')
        ],
        { cwd: root, encoding: 'utf8', timeout: 20_000 }
      )
      expect(run.status, run.stderr).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000
)

it('builds newly added browser fixture pages without falling back to the default page', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-science-browser-entry-'))
  const fixtureRoot = join(root, 'e2e/browser/fixture')
  mkdirSync(fixtureRoot, { recursive: true })
  try {
    // Exercise the real build with a new page alongside the original explicit entry list.
    for (const name of ['index', 'csv-preview', 'message-clipboard', 'media-privacy']) {
      writeFileSync(
        join(fixtureRoot, `${name}.html`),
        `<!doctype html><html><head><title>${name}</title></head><body>${name}</body></html>`
      )
    }
    writeFileSync(
      join(fixtureRoot, 'media-privacy.html'),
      '<title>media-privacy</title><script type="module" src="./main.js"></script>'
    )
    writeFileSync(
      join(fixtureRoot, 'main.js'),
      "new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })"
    )
    writeFileSync(
      join(fixtureRoot, 'worker.js'),
      "self.onmessage = async () => self.postMessage((await import('./lazy.js')).value)"
    )
    writeFileSync(join(fixtureRoot, 'lazy.js'), "export const value = 'lazy worker dependency'")
    const run = spawnSync(
      process.execPath,
      [
        join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
        'build',
        '--config',
        resolve('e2e/vite.browser-test.config.ts')
      ],
      { cwd: root, encoding: 'utf8', timeout: 20_000 }
    )
    expect(run.status, run.stderr).toBe(0)
    expect(readFileSync(join(root, 'out/browser-tests/media-privacy.html'), 'utf8')).toContain(
      '<title>media-privacy</title>'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
