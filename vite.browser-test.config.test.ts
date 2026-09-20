import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

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
    const run = spawnSync(
      process.execPath,
      [
        join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
        'build',
        '--config',
        resolve('vite.browser-test.config.ts')
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
