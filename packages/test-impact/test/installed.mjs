import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeRevision } from '@aipoch/test-impact'
const root = mkdtempSync(join(tmpdir(), 'installed-impact-'))
try {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- This consumer runs as plain JavaScript after installation.
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(root, 'entry.ts'), "import './dependency.js'")
  writeFileSync(join(root, 'dependency.ts'), 'export const value = 1')
  git('add', '.')
  git(
    '-c',
    'core.hooksPath=',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'test(snapshot): add installed fixture'
  )
  const report = await analyzeRevision({ repository: root, revision: 'HEAD' })
  assert.equal(report.canPruneTests, false)
  assert.deepEqual(report.files.find((file) => file.path === 'entry.ts').dependencies, [
    'dependency.ts'
  ])
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@aipoch/test-impact'))), 'cli.js')
  const output = execFileSync(process.execPath, [cli, '--repository', root, '--revision', 'HEAD'], {
    encoding: 'utf8'
  })
  assert.deepEqual(JSON.parse(output), report)
  await assert.rejects(import('@aipoch/test-impact/dist/snapshot.js'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  })
  console.log('Installed API, CLI and private-export boundary passed.')
} finally {
  rmSync(root, { recursive: true, force: true })
}
