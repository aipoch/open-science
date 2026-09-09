import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { afterEach, expect, it } from 'vitest'

import { buildManifest } from './generate-version-manifest.mjs'

const repo = process.cwd()
const require = createRequire(join(repo, 'package.json'))
const directories: string[] = []
const temporaryDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'release-publication-'))
  directories.push(dir)
  return dir
}
afterEach(() =>
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
)
const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
const config = load(readFileSync(join(repo, 'electron-builder.yml'), 'utf8')) as {
  appImage: { artifactName: string }
}
const manifest = (dir: string): ReturnType<typeof buildManifest> =>
  buildManifest({ dir, version: '0.27.0', cdnBase: 'https://cdn.example', prefix: 'open-science' })
const installer = (name: string, digest?: string): string => {
  const dir = temporaryDirectory()
  writeFileSync(join(dir, name), 'synthetic installer')
  writeFileSync(
    join(dir, 'SHA256SUMS.txt'),
    `${digest ?? sha256('synthetic installer')}  ${name}\n`
  )
  return dir
}

it('excludes local worktrees and tool state through the real packaging filter', () => {
  const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher')
  const filter = getMainFileMatchers(
    repo,
    join(temporaryDirectory(), 'out'),
    (x: string) => x,
    {},
    {
      info: {
        projectDir: repo,
        buildResourcesDir: 'build',
        config,
        isPrepackedAppAsar: false,
        debugLogger: { isEnabled: false }
      }
    },
    join(repo, 'dist'),
    false
  )[0].createFilter()
  expect(filter(join(repo, 'out/main/index.js'), { isDirectory: () => false })).toBe(true)
  for (const filename of [
    '.worktree/example/.env',
    '.worktrees/example/src/app.ts',
    '.codegraph/codegraph.db',
    '.agents/local.json'
  ]) {
    expect(filter(join(repo, filename), { isDirectory: () => false }), filename).toBe(false)
  }
})

it('includes the AppImage filename produced by the installed builder', () => {
  const { Arch, getArtifactArchName } = require('builder-util')
  const { expandMacro } = require('app-builder-lib/out/util/macroExpander')
  const name = expandMacro(
    config.appImage.artifactName,
    getArtifactArchName(Arch.x64, 'AppImage'),
    { name: 'open-science', version: '0.27.0' },
    { ext: 'AppImage', os: 'linux' }
  )
  expect(manifest(installer(name)).downloads['linux-x64-appimage']).toMatchObject({
    size: Buffer.byteLength('synthetic installer'),
    sha256: sha256('synthetic installer')
  })
})

it('rejects an installer from a different release version', () => {
  const dir = installer('aipoch-open-science-0.26.0-win-x64-setup.exe')
  expect(() => manifest(dir)).toThrow()
})

it('rejects a checksum that does not match the installer bytes', () => {
  const dir = installer('aipoch-open-science-0.27.0-win-x64-setup.exe', '0'.repeat(64))
  expect(() => manifest(dir)).toThrow()
})

const writeFeed = (dir: string, arch: string, version: string): void => {
  const name = `aipoch-open-science-${version}-mac-${arch}.zip`
  const bytes = `synthetic ${arch} zip`
  writeFileSync(join(dir, name), bytes)
  writeFileSync(
    join(dir, `${arch}-mac.yml`),
    `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${createHash('sha512').update(bytes).digest('base64')}\n    size: ${Buffer.byteLength(bytes)}\n`
  )
}
const merge = (dir: string): ReturnType<typeof spawnSync> =>
  spawnSync(process.execPath, [join(repo, 'scripts/merge-mac-feed.mjs'), dir], { encoding: 'utf8' })

it('rejects macOS feeds from different release versions', () => {
  const dir = temporaryDirectory()
  writeFeed(dir, 'arm64', '0.27.0')
  writeFeed(dir, 'x64', '0.26.0')
  expect(merge(dir).status).not.toBe(0)
})

it('does not successfully publish a macOS feed with only one architecture', () => {
  const dir = temporaryDirectory()
  writeFeed(dir, 'arm64', '0.27.0')
  writeFileSync(join(dir, 'latest-mac.yml'), readFileSync(join(dir, 'arm64-mac.yml')))
  // This is the artifact directory left by a skipped notarization plus flattening collision.
  rmSync(join(dir, 'arm64-mac.yml'))
  expect(merge(dir).status).not.toBe(0)
})

type Workflow = { jobs: Record<string, { steps: Array<{ name: string; run?: string }> }> }
const workflowStep = (filename: string, job: string, name: string): string => {
  const workflow = load(readFileSync(join(repo, '.github/workflows', filename), 'utf8')) as Workflow
  const script = workflow.jobs[job].steps.find((step) => step.name === name)?.run
  if (!script) throw new Error(`Missing workflow step: ${name}`)
  return script
}

// The real workflow shell runs against an isolated filesystem object store. No credentials,
// network, installer execution or production source seam is involved.
const objectStore = (): { cwd: string; env: NodeJS.ProcessEnv; remote: string } => {
  const cwd = temporaryDirectory()
  const bin = join(cwd, 'bin')
  const remote = join(cwd, 'remote')
  mkdirSync(bin)
  mkdirSync(remote)
  symlinkSync(join(repo, 'scripts'), join(cwd, 'scripts'), 'dir')
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = process.env.TEST_OBJECT_STORE;
fs.appendFileSync(path.join(root, 'operations.jsonl'), JSON.stringify(args) + '\\n');
const local = p => p.startsWith('s3://') ? path.join(root, p.slice(5)) : p;
if (args[0] === 's3api' && args[1] === 'head-object') {
  if (process.env.TEST_FAIL_INSPECT === 'true') { console.error('An error occurred (403): Forbidden'); process.exit(1); }
  const file = path.join(root, args[args.indexOf('--bucket') + 1], args[args.indexOf('--key') + 1]);
  if (!fs.existsSync(file)) { console.error('An error occurred (404) when calling HeadObject: Not Found'); process.exit(1); }
  process.exit(0);
}
if (args[0] !== 's3' || args[1] !== 'cp') throw Error('Unsupported AWS test operation');
if (args[3].startsWith('s3://') && args[3].endsWith(process.env.TEST_FAIL_UPLOAD || '\\0')) {console.error('Upload interrupted'); process.exit(1);}
const source = local(args[2]), target = local(args[3]);
fs.mkdirSync(path.dirname(target), {recursive:true}); fs.copyFileSync(source, target);
`,
    { mode: 0o755 }
  )
  return {
    cwd,
    remote,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_OBJECT_STORE: remote,
      S3_BUCKET: 'test-bucket',
      S3_PREFIX: 'open-science/app/stable',
      VERSION: '1'
    }
  }
}

it.skipIf(process.platform === 'win32')(
  'keeps the newer stable pointer when an older release is mirrored',
  () => {
    const { cwd, remote, env } = objectStore()
    const script = workflowStep('mirror-to-website.yml', 'mirror', 'Upload version.json')
    mkdirSync(join(cwd, 'dist-assets'))
    for (const version of ['0.27.0', '0.26.0']) {
      for (const name of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml'])
        writeFileSync(join(cwd, 'dist-assets', name), `version: ${version}\n`)
      writeFileSync(join(cwd, 'version.json'), JSON.stringify({ version }))
      const result = spawnSync('bash', ['-eu', '-c', script], { cwd, env, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }
    expect(
      JSON.parse(
        readFileSync(join(remote, 'test-bucket/open-science/app/stable/version.json'), 'utf8')
      ).version
    ).toBe('0.27.0')
  }
)

it.skipIf(process.platform === 'win32')(
  'preserves published runtime bytes when the same version is restaged',
  () => {
    const { cwd, remote, env } = objectStore()
    const workflow = load(
      readFileSync(join(repo, '.github/workflows/stage-runtime-bundle.yml'), 'utf8')
    ) as Workflow
    const job = Object.keys(workflow.jobs).find((key) =>
      workflow.jobs[key].steps?.some((step) => step.name === 'Upload bundle to CDN')
    )!
    const script = workflowStep('stage-runtime-bundle.yml', job, 'Upload bundle to CDN').replaceAll(
      '${{ matrix.subdir }}',
      'linux-64'
    )
    const local = join(cwd, 'resources/default-envs')
    mkdirSync(local, { recursive: true })
    for (const bytes of ['original archive', 'changed archive']) {
      writeFileSync(join(local, 'python-3.12.tar.zst'), bytes)
      writeFileSync(join(local, 'manifest.json'), JSON.stringify({ sha256: sha256(bytes) }))
      const result = spawnSync('bash', ['-eu', '-c', script], { cwd, env, encoding: 'utf8' })
      if (bytes === 'original archive') expect(result.status, result.stderr).toBe(0)
    }
    expect(
      readFileSync(
        join(remote, 'test-bucket/open-science/runtime-bundle/1/linux-64/python-3.12.tar.zst'),
        'utf8'
      )
    ).toBe('original archive')
  }
)

it.skipIf(process.platform === 'win32')(
  'does not replace certified public installers during standalone notarization',
  () => {
    const { cwd, remote, env } = objectStore()
    const name = 'aipoch-open-science-0.27.0-mac-arm64.dmg'
    mkdirSync(join(cwd, 'mac'))
    writeFileSync(join(remote, name), 'certified original')
    writeFileSync(
      join(remote, 'RELEASE-CERTIFICATION.json'),
      JSON.stringify({ sha256: sha256('certified original') })
    )
    writeFileSync(join(cwd, 'mac', name), 'stapled replacement')
    writeFileSync(
      join(cwd, 'bin', 'gh'),
      `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'release' || args[1] !== 'upload') throw Error('Unexpected GitHub operation');
for (const file of args.slice(3, args.indexOf('--repo'))) {
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(process.env.TEST_OBJECT_STORE, path.basename(file)));
}
`,
      { mode: 0o755 }
    )
    const workflow = load(
      readFileSync(join(repo, '.github/workflows/notarize-mac.yml'), 'utf8')
    ) as Workflow
    // Exercise the existing public-release write boundary using final stapled bytes as input.
    // Real Apple signing is outside this test; GitHub's filesystem effect is the only substitute.
    const upload = workflow.jobs.notarize.steps.find(
      (step) => step.name === 'Clobber stapled assets onto the release'
    )
    if (upload?.run) {
      const result = spawnSync(
        'bash',
        ['-eu', '-c', upload.run.replaceAll('${{ inputs.tag }}', 'v0.27.0')],
        {
          cwd,
          env: { ...env, GITHUB_REPOSITORY: 'example/test' },
          encoding: 'utf8'
        }
      )
      expect(result.status, result.stderr).toBe(0)
    }
    const certification = JSON.parse(
      readFileSync(join(remote, 'RELEASE-CERTIFICATION.json'), 'utf8')
    )
    expect(sha256(readFileSync(join(remote, name), 'utf8'))).toBe(certification.sha256)
  }
)

it('packages required runtime files without local tool directories in a harmless ASAR sample', async () => {
  const { cpSync, existsSync } = await import('node:fs')
  const { createPackage, listPackage } = require('@electron/asar')
  const source = temporaryDirectory(),
    staged = temporaryDirectory(),
    dest = join(temporaryDirectory(), 'app.asar')
  const keep = ['out/main/index.js', 'resources/start.py', 'resources/native/addon.node']
  const reject = [
    '.worktree/copy/.env',
    'nested/.worktree/copy/main.js',
    '.codegraph/index.db',
    'nested/.agents/state.json',
    '.worktrees/old/main.js'
  ]
  for (const name of [...keep, ...reject]) {
    mkdirSync(join(source, name, '..'), { recursive: true })
    writeFileSync(join(source, name), 'harmless test fixture')
  }
  const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher')
  const filter = getMainFileMatchers(
    source,
    staged,
    (value: string) => value,
    {},
    {
      info: {
        projectDir: source,
        buildResourcesDir: 'build',
        config,
        isPrepackedAppAsar: false,
        debugLogger: { isEnabled: false }
      }
    },
    join(source, 'dist'),
    false
  )[0].createFilter()
  cpSync(source, staged, {
    recursive: true,
    filter: (file) => file === source || filter(file, require('node:fs').statSync(file))
  })
  for (const name of reject) expect(existsSync(join(staged, name)), name).toBe(false)
  await createPackage(staged, dest)
  const contents = listPackage(dest).map((name: string) => name.replaceAll('\\', '/'))
  for (const name of keep) expect(contents).toContain(`/${name}`)
  expect(contents.some((name: string) => /\.(worktrees?|codegraph|agents)(\/|$)/.test(name))).toBe(
    false
  )
})

it('rejects duplicate AppImage spellings instead of selecting an arbitrary download', () => {
  const dir = installer('aipoch-open-science-0.27.0-linux-x64.AppImage')
  const other = 'aipoch-open-science-0.27.0-linux-x86_64.AppImage'
  writeFileSync(join(dir, other), 'synthetic installer')
  writeFileSync(
    join(dir, 'SHA256SUMS.txt'),
    `${sha256('synthetic installer')}  aipoch-open-science-0.27.0-linux-x64.AppImage\n${sha256('synthetic installer')}  ${other}\n`
  )
  expect(() => manifest(dir)).toThrow(/Duplicate installer/)
})

it('rejects duplicate checksums and zero-byte installers', () => {
  const name = 'aipoch-open-science-0.27.0-win-x64-setup.exe'
  const dir = installer(name)
  const sums = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8')
  writeFileSync(join(dir, 'SHA256SUMS.txt'), sums + sums)
  expect(() => manifest(dir)).toThrow(/Duplicate SHA256/)
  writeFileSync(join(dir, name), '')
  writeFileSync(join(dir, 'SHA256SUMS.txt'), `${sha256('')}  ${name}\n`)
  expect(() => manifest(dir)).toThrow(/Empty/)
})

it('merges matching native macOS ZIPs and refuses tampered feed bytes', () => {
  const dir = temporaryDirectory()
  writeFeed(dir, 'arm64', '0.27.0')
  writeFeed(dir, 'x64', '0.27.0')
  const result = merge(dir)
  expect(result.status, String(result.stderr)).toBe(0)
  const feed = load(readFileSync(join(dir, 'latest-mac.yml'), 'utf8')) as { files: unknown[] }
  expect(feed.files).toHaveLength(2)
  writeFileSync(join(dir, 'aipoch-open-science-0.27.0-mac-x64.zip'), 'tampered bytes')
  const tampered = merge(dir)
  expect(tampered.status).not.toBe(0)
  expect(String(tampered.stderr)).toMatch(/mismatch/)
})

it('allows a non-mac local merge directory without manufacturing a feed', () => {
  expect(merge(temporaryDirectory()).status).toBe(0)
})

it('keeps sparse dry-run validation explicit while checking feed versions and sizes', () => {
  const name = 'aipoch-open-science-0.27.0-win-x64-setup.exe'
  const dir = installer(name, '0'.repeat(64))
  const options = {
    dir,
    version: '0.27.0',
    cdnBase: 'https://cdn.example',
    prefix: 'open-science',
    metadataOnly: true
  }
  expect(buildManifest(options).downloads['win-x64']).toBeDefined()
  expect(() => buildManifest({ ...options, metadataOnly: false })).toThrow(/SHA256 mismatch/)
  writeFileSync(join(dir, 'latest.yml'), `version: 0.26.0\nfiles: []\n`)
  expect(() => buildManifest(options)).toThrow(/Invalid update feed/)
})

it.skipIf(process.platform === 'win32')(
  'rejects the retired notarization dispatch before credential or asset operations',
  () => {
    const script = workflowStep(
      'notarize-mac.yml',
      'notarize',
      'Require unpublished build artifacts'
    )
    expect(
      spawnSync('bash', ['-eu', '-c', script], {
        env: { ...process.env, FROM_RUN: 'false' },
        encoding: 'utf8'
      })
    ).toMatchObject({ status: 1 })
    expect(
      spawnSync('bash', ['-eu', '-c', script], {
        env: { ...process.env, FROM_RUN: 'true' },
        encoding: 'utf8'
      })
    ).toMatchObject({ status: 0 })
    const raw = readFileSync(join(repo, '.github/workflows/notarize-mac.yml'), 'utf8')
    expect(raw).not.toContain('gh release upload')
    expect(raw).not.toContain('contents: write')
  }
)

const stageRuntime = (fixture: ReturnType<typeof objectStore>): ReturnType<typeof spawnSync> => {
  const script = workflowStep(
    'stage-runtime-bundle.yml',
    'stage',
    'Upload bundle to CDN'
  ).replaceAll('${{ matrix.subdir }}', 'linux-64')
  return spawnSync('bash', ['-eu', '-c', script], { ...fixture, encoding: 'utf8' })
}
const runtimeFixture = (): ReturnType<typeof objectStore> => {
  const fixture = objectStore()
  mkdirSync(join(fixture.cwd, 'resources/default-envs'), { recursive: true })
  writeFileSync(join(fixture.cwd, 'resources/default-envs/python-3.12.tar.zst'), 'archive')
  writeFileSync(
    join(fixture.cwd, 'resources/default-envs/manifest.json'),
    JSON.stringify({ sha256: sha256('archive') })
  )
  return fixture
}

it.skipIf(process.platform === 'win32')(
  'resumes an interrupted runtime upload and makes an identical retry a no-op',
  () => {
    const fixture = runtimeFixture()
    fixture.env.TEST_FAIL_UPLOAD = '/manifest.json'
    expect(stageRuntime(fixture).status).not.toBe(0)
    delete fixture.env.TEST_FAIL_UPLOAD
    expect(stageRuntime(fixture).status).toBe(0)
    writeFileSync(join(fixture.remote, 'operations.jsonl'), '')
    expect(stageRuntime(fixture).status).toBe(0)
    const operations = readFileSync(join(fixture.remote, 'operations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(operations.some((args) => args[0] === 's3' && args[3].startsWith('s3://'))).toBe(false)
  }
)

it.skipIf(process.platform === 'win32')(
  'does not treat an inaccessible runtime object as absent',
  () => {
    const fixture = runtimeFixture()
    fixture.env.TEST_FAIL_INSPECT = 'true'
    const result = stageRuntime(fixture)
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toMatch(/Cannot inspect/)
    const operations = readFileSync(join(fixture.remote, 'operations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(operations.some((args) => args[0] === 's3')).toBe(false)
  }
)

it.skipIf(process.platform === 'win32')(
  'refuses a changed runtime manifest before uploading any extra pack',
  () => {
    const fixture = runtimeFixture()
    expect(stageRuntime(fixture).status).toBe(0)
    writeFileSync(join(fixture.cwd, 'resources/default-envs/r-4.4.tar.zst'), 'new archive')
    writeFileSync(join(fixture.cwd, 'resources/default-envs/manifest.json'), '{"changed":true}')
    writeFileSync(join(fixture.remote, 'operations.jsonl'), '')
    const result = stageRuntime(fixture)
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toMatch(/immutable/)
    const operations = readFileSync(join(fixture.remote, 'operations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(operations.some((args) => args[0] === 's3' && args[3].startsWith('s3://'))).toBe(false)
  }
)

it.skipIf(process.platform === 'win32')(
  'recovers a partially promoted channel without allowing an older queued run to roll its feeds back',
  () => {
    const fixture = objectStore()
    const { cwd, remote, env } = fixture
    const script = workflowStep('mirror-to-website.yml', 'mirror', 'Upload version.json')
    mkdirSync(join(cwd, 'dist-assets'))
    const promote = (version: string): ReturnType<typeof spawnSync> => {
      writeFileSync(join(cwd, 'version.json'), JSON.stringify({ version }))
      for (const name of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml'])
        writeFileSync(join(cwd, 'dist-assets', name), `version: ${version}\n`)
      return spawnSync('bash', ['-eu', '-c', script], { cwd, env, encoding: 'utf8' })
    }
    expect(promote('0.26.0').status).toBe(0)
    env.TEST_FAIL_UPLOAD = '/version.json'
    expect(promote('0.27.0').status).not.toBe(0)
    delete env.TEST_FAIL_UPLOAD
    expect(promote('0.26.0').status).toBe(0)
    const channel = join(remote, 'test-bucket/open-science/app/stable')
    expect(
      (load(readFileSync(join(channel, 'latest.yml'), 'utf8')) as { version: string }).version
    ).toBe('0.27.0')
    expect(promote('0.27.0').status).toBe(0)
    expect(JSON.parse(readFileSync(join(channel, 'version.json'), 'utf8')).version).toBe('0.27.0')
  },
  30000
)
