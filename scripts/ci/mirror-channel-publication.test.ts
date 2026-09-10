import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

const feeds = ['latest.yml', 'latest-linux.yml', 'latest-mac.yml', 'arm64-mac.yml', 'x64-mac.yml']
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Run the real workflow command and real publication script against a filesystem AWS substitute.
// It never invokes the actual AWS CLI, downloads a release, or executes an installer.
function fixture(): {
  root: string
  channel: string
  current: (version: string) => void
  stage: (version: string) => void
  snapshot: () => Record<string, string>
  run: (version: string, mode?: string, failKey?: string) => void
} {
  const root = mkdtempSync(join(tmpdir(), 'mirror-channel-test-'))
  roots.push(root)
  const bin = join(root, 'bin'),
    storage = join(root, 'storage')
  const channel = join(storage, 'fixture-bucket', 'stable')
  symlinkSync(join(process.cwd(), 'scripts'), join(root, 'scripts'), 'dir')
  mkdirSync(bin)
  mkdirSync(channel, { recursive: true })
  mkdirSync(join(root, 'dist-assets'))
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [service, operation, source, destination] = process.argv.slice(2);
if (service !== 's3' || !['cp', 'sync'].includes(operation)) throw new Error('Unexpected AWS command');
const local = value => value.startsWith('s3://') ? path.join(process.env.FIXTURE_STORAGE, value.slice(5)) : value;
if (process.env.FAIL_KEY && destination === 's3://fixture-bucket/stable/' + process.env.FAIL_KEY) {
  process.stderr.write('Injected upload failure'); process.exit(1);
}
if (destination === '-') process.stdout.write(fs.readFileSync(local(source)));
else {
 const target = local(destination);
 fs.mkdirSync(path.dirname(target), {recursive:true});
 fs.cpSync(local(source), target, {recursive: operation === 'sync'});
}
`,
    { mode: 0o755 }
  )
  const current = (version: string): void => {
    writeFileSync(join(channel, 'version.json'), JSON.stringify({ version }) + '\n')
    for (const name of feeds) writeFileSync(join(channel, name), `version: ${version}\n`)
  }
  const stage = (version: string): void => {
    writeFileSync(join(root, 'version.json'), JSON.stringify({ version }) + '\n')
    writeFileSync(join(root, 'dist-assets', 'installer.deb'), 'fixture installer')
    for (const name of feeds)
      writeFileSync(
        join(root, 'dist-assets', name),
        `version: ${version}\nfiles:\n  - url: releases/${version}/installer.deb\n    size: 17\n`
      )
  }
  const snapshot = (): Record<string, string> =>
    Object.fromEntries(
      ['version.json', ...feeds].map((name) => [name, readFileSync(join(channel, name), 'utf8')])
    )
  const run = (version: string, mode = 'backfill', failKey = ''): void => {
    const workflow = load(readFileSync('.github/workflows/mirror-to-website.yml', 'utf8')) as {
      jobs: { mirror: { steps: Array<{ name: string; run?: string }> } }
    }
    const steps = workflow.jobs.mirror.steps
    const start = steps.findIndex((step) => step.name === 'Sync installers to versioned path')
    expect(start).toBeGreaterThanOrEqual(0)
    for (const step of steps.slice(start)) {
      if (!step.run) continue
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        cwd: root,
        // Do not inherit host AWS environment or credentials. PATH begins with the only AWS used.
        env: {
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          FIXTURE_STORAGE: storage,
          S3_BUCKET: 'fixture-bucket',
          S3_PREFIX: 'stable',
          VERSION: version,
          MODE: mode,
          FAIL_KEY: failKey
        },
        stdio: 'pipe'
      })
    }
  }
  current('2.0.0')
  return { root, channel, current, stage, snapshot, run }
}

describe.skipIf(process.platform === 'win32')('website channel publication', () => {
  it('preserves newer channel entry bytes when mirroring an older release', () => {
    const f = fixture(),
      before = f.snapshot()
    f.stage('1.9.0')
    f.run('1.9.0')
    expect(readFileSync(join(f.channel, 'releases', '1.9.0', 'installer.deb'), 'utf8')).toBe(
      'fixture installer'
    )
    expect(f.snapshot()).toEqual(before)
  })
  it('only promotes on explicit intent and makes same-version retries idempotent', () => {
    const f = fixture(),
      before = f.snapshot()
    f.stage('2.1.0')
    f.run('2.1.0')
    expect(f.snapshot()).toEqual(before)
    f.run('2.1.0', 'promote')
    const promoted = f.snapshot()
    expect(JSON.parse(promoted['version.json']).version).toBe('2.1.0')
    for (const name of feeds)
      expect((load(promoted[name]) as { version: string }).version).toBe('2.1.0')
    f.run('2.1.0', 'promote')
    expect(f.snapshot()).toEqual(promoted)
  })
  it('does not let a delayed older promotion overwrite a newer completed promotion', () => {
    const f = fixture()
    f.stage('3.0.0')
    f.run('3.0.0', 'promote')
    const before = f.snapshot()
    f.stage('2.1.0')
    f.run('2.1.0', 'promote')
    expect(f.snapshot()).toEqual(before)
  })
  it('rejects a promotion with a missing platform before channel writes', () => {
    const f = fixture(),
      before = f.snapshot()
    f.stage('2.1.0')
    rmSync(join(f.root, 'dist-assets', 'latest-mac.yml'))
    expect(() => f.run('2.1.0', 'promote')).toThrow()
    expect(f.snapshot()).toEqual(before)
  })
  it.each(['malformed', 'missing'])('fails closed when current metadata is %s', (kind) => {
    const f = fixture()
    f.stage('2.1.0')
    const file = join(f.channel, 'version.json')
    if (kind === 'missing') rmSync(file)
    else writeFileSync(file, 'not JSON')
    const previousFeed = readFileSync(join(f.channel, 'latest.yml'), 'utf8')
    expect(() => f.run('2.1.0', 'promote')).toThrow()
    expect(readFileSync(join(f.channel, 'latest.yml'), 'utf8')).toBe(previousFeed)
  })
  it('repairs a partial upload by retrying the same version and prevents an intervening downgrade', () => {
    const f = fixture()
    f.stage('3.0.0')
    expect(() => f.run('3.0.0', 'promote', 'latest-linux.yml')).toThrow()
    const partial = f.snapshot()
    expect(JSON.parse(partial['version.json']).version).toBe('2.0.0')
    expect((load(partial['arm64-mac.yml']) as { version: string }).version).toBe('3.0.0')
    f.stage('2.1.0')
    f.run('2.1.0', 'promote')
    expect(f.snapshot()).toEqual(partial)
    f.stage('3.0.0')
    f.run('3.0.0', 'promote')
    expect(JSON.parse(f.snapshot()['version.json']).version).toBe('3.0.0')
  })
})
