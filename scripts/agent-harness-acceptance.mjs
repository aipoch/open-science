/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const recoveryFiles = [
  'agent-harness-recovery.integration.test.ts',
  'agent-harness-journal-crash.integration.test.ts'
]
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
function files(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name),
        stat = lstatSync(path)
      assert.ok(!stat.isSymbolicLink(), `Symlink is not an isolated input: ${path}`)
      if (stat.isDirectory()) return files(path)
      assert.ok(stat.isFile(), `Unsupported input: ${path}`)
      return [path]
    })
}
export function verifyTests(report, expectedFiles) {
  assert.equal(report.success, true, 'Test runner failed')
  assert.ok(report.numTotalTests > 0, 'No tests ran')
  assert.equal(report.numPassedTests, report.numTotalTests, 'Failed or skipped tests')
  assert.equal(report.numFailedTests, 0)
  assert.equal(report.numPendingTests, 0)
  assert.deepEqual(
    report.testResults.map((r) => r.name.replaceAll('\\', '/').split('/').at(-1)).sort(),
    [...expectedFiles].sort(),
    'Test files omitted'
  )
  assert.ok(report.testResults.every((r) => r.assertionResults.every((t) => t.status === 'passed')))
  return {
    files: report.testResults.length,
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    skipped: 0
  }
}
export function verifyArchive(archive, bytes, expectedFiles) {
  assert.equal(
    createHash('sha1').update(bytes).digest('hex'),
    archive.shasum,
    'Tarball SHA1 mismatch'
  )
  assert.equal(
    'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    archive.integrity,
    'Tarball integrity mismatch'
  )
  assert.deepEqual(
    archive.files.map((f) => f.path).sort(),
    [...expectedFiles].sort(),
    'Unexpected or missing packed files'
  )
  return {
    filename: archive.filename,
    sha256: sha256(bytes),
    integrity: archive.integrity,
    files: archive.files
  }
}

export function parseOutputArgument(args, defaultOutput) {
  if (args.length === 0) return defaultOutput
  if (args.length === 2 && args[0] === '--output' && args[1]) return args[1]
  // npm 10 on Windows consumes the `--output` option when invoking a script and
  // forwards only its value. Accept that normalized form while still rejecting
  // arbitrary flags and ambiguous arguments.
  if (args.length === 1 && !args[0].startsWith('-')) return args[0]
  throw new Error('Expected --output <empty directory>')
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return undefined
  }
}
export function runAcceptance(output) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('Run through npm run check:agent-harness-standalone')
  output = resolve(output)
  assert.ok(
    !existsSync(output) || readdirSync(output).length === 0,
    'Evidence directory must be empty'
  )
  mkdirSync(output, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'agent-harness-acceptance-'))
  const build = join(work, 'build'),
    source = join(build, 'source'),
    consumer = join(work, 'consumer')
  const fixture = join(root, 'scripts/fixtures/agent-harness')
  const evidence = {
    schemaVersion: 1,
    status: 'failed',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    checks: [],
    inputs: {},
    tests: {}
  }
  // No host model credentials, NODE_PATH, NODE_OPTIONS or application runtime configuration.
  const env = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'SystemRoot',
      'COMSPEC',
      'TEMP',
      'TMP',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'CI',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY'
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  )
  env.npm_config_cache = join(work, 'npm-cache')
  const save = (name, value) =>
    writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
  const input = (from, to) => {
    assert.ok(lstatSync(from).isFile() && !lstatSync(from).isSymbolicLink())
    evidence.inputs[relative(root, from).replaceAll('\\', '/')] = sha256(readFileSync(from))
    if (to) {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
  const run = (name, command, args, cwd) => {
    console.log(`START ${name}`)
    try {
      const result = execFileSync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 600000,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      writeFileSync(join(output, name + '.log'), result)
      evidence.checks.push({ name, passed: true })
      console.log(`PASS ${name}`)
      return result
    } catch (error) {
      writeFileSync(
        join(output, name + '.log'),
        String(error.stdout ?? '') + String(error.stderr ?? '')
      )
      evidence.checks.push({ name, passed: false, status: error.status, signal: error.signal })
      throw error
    }
  }
  const npm = (name, args, cwd) => run(name, process.execPath, [npmCli, ...args], cwd)
  try {
    const packageRoot = join(root, 'packages/agent-harness')
    for (const file of [
      ...files(join(packageRoot, 'src')),
      ...[
        'package.json',
        'tsc.cjs',
        'tsconfig.json',
        'tsconfig.test.json',
        'vitest.config.ts',
        'README.md',
        'SUPPORT.md',
        'LICENSE'
      ].map((f) => join(packageRoot, f))
    ])
      input(file, join(source, relative(packageRoot, file)))
    for (const name of [
      'consumer.mjs',
      'consumer.ts',
      'package.json',
      'package-lock.json',
      'vitest.config.ts'
    ])
      input(join(fixture, name), join(build, name))
    for (const file of recoveryFiles)
      input(join(root, 'scripts', file), join(build, 'acceptance', file))
    input(fileURLToPath(import.meta.url))
    input(join(root, '.github/workflows/agent-harness.yml'))
    const meta = json(join(source, 'package.json')),
      testMeta = json(join(build, 'package.json'))
    assert.equal(meta.name, '@aipoch/agent-harness')
    assert.equal(Object.keys(meta.dependencies ?? {}).length, 0, 'Unexpected runtime dependency')
    for (const [name, version] of Object.entries(meta.devDependencies))
      assert.equal(
        testMeta.devDependencies[name],
        version,
        `Update locked acceptance dependency ${name}`
      )
    const status = git([
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      ...Object.keys(evidence.inputs)
    ])
    evidence.source = {
      commit: git(['rev-parse', 'HEAD']) ?? null,
      dirty: status === undefined ? null : Boolean(status),
      package: { name: meta.name, version: meta.version }
    }
    evidence.ci = Object.fromEntries(
      [
        'GITHUB_REPOSITORY',
        'GITHUB_SHA',
        'GITHUB_RUN_ID',
        'GITHUB_RUN_ATTEMPT',
        'GITHUB_WORKFLOW',
        'RUNNER_OS',
        'RUNNER_ARCH'
      ]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]])
    )
    save('source-manifest.json', evidence.inputs)
    copyFileSync(join(build, 'package-lock.json'), join(output, 'build-dependency-lock.json'))
    npm('install-build', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], build)
    evidence.toolchain = Object.fromEntries(
      Object.keys(testMeta.devDependencies).map((name) => [
        name,
        json(join(build, 'node_modules', name, 'package.json')).version
      ])
    )
    npm('typecheck', ['run', 'typecheck'], source)
    npm('build', ['run', 'build'], source)
    npm(
      'package-tests',
      [
        'test',
        '--',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${join(output, 'package-tests.json')}`
      ],
      source
    )
    evidence.tests.package = verifyTests(
      json(join(output, 'package-tests.json')),
      files(join(source, 'src'))
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => f.split(/[\\/]/).at(-1))
    )
    const compiled = Object.fromEntries(
      files(join(source, 'dist')).map((f) => [
        relative(source, f).replaceAll('\\', '/'),
        sha256(readFileSync(f))
      ])
    )
    save('compiled-hashes.json', compiled)
    const [archive] = JSON.parse(
      npm('pack', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], source)
    )
    const tarball = join(output, archive.filename)
    evidence.archive = verifyArchive(archive, readFileSync(tarball), [
      ...Object.keys(compiled),
      ...meta.files.filter((f) => f !== 'dist'),
      'package.json'
    ])
    mkdirSync(consumer)
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'agent-harness-installed-consumer', private: true, type: 'module' })
    )
    npm(
      'install-consumer',
      ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball],
      consumer
    )
    const installed = join(consumer, 'node_modules/@aipoch/agent-harness')
    const installedFiles = files(installed)
    assert.deepEqual(
      installedFiles.map((f) => relative(installed, f).replaceAll('\\', '/')).sort(),
      archive.files.map((f) => f.path).sort()
    )
    for (const f of installedFiles)
      assert.equal(
        sha256(readFileSync(f)),
        sha256(readFileSync(join(source, relative(installed, f)))),
        'Installed bytes differ from source/build'
      )
    for (const name of ['consumer.mjs', 'consumer.ts'])
      copyFileSync(join(fixture, name), join(consumer, name))
    run('consumer', process.execPath, ['consumer.mjs'], consumer)
    run(
      'consumer-types',
      process.execPath,
      [
        join(build, 'node_modules/typescript/lib/tsc.js'),
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        'consumer.ts'
      ],
      consumer
    )
    evidence.publicApi = {
      exports: meta.exports,
      declarations: Object.fromEntries(
        Object.entries(compiled).filter(([f]) => f.endsWith('.d.ts'))
      )
    }
    npm(
      'install-recovery-consumer',
      ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball],
      build
    )
    npm(
      'recovery-tests',
      [
        'test',
        '--',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${join(output, 'recovery-tests.json')}`
      ],
      build
    )
    evidence.tests.recovery = verifyTests(json(join(output, 'recovery-tests.json')), recoveryFiles)
    for (const [file, hash] of Object.entries(evidence.inputs))
      assert.equal(
        sha256(readFileSync(join(root, file))),
        hash,
        `Input changed during acceptance: ${file}`
      )
    evidence.status = 'passed'
  } finally {
    save('verification.json', evidence)
    rmSync(work, { recursive: true, force: true })
  }
  return evidence
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  runAcceptance(
    parseOutputArgument(
      args,
      join(
        root,
        'out/agent-harness-acceptance',
        `${process.platform}-${process.arch}-${process.version}`
      )
    )
  )
}
