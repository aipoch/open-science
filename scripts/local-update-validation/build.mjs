/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, openSync, closeSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setBuildVersion, validateVersions } from './source.mjs'
import { inspectApplicationPackage, verifyProductionPackage } from './production-package.mjs'

export async function fileIdentity(path) {
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk)
    sha512.update(chunk)
  }
  return {
    size: (await stat(path)).size,
    sha256: sha256.digest('hex'),
    sha512: sha512.digest('base64')
  }
}

export async function runCommand(
  command,
  args,
  { cwd, logPath, env = process.env, detached = false }
) {
  const fd = openSync(logPath, 'a', 0o600)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env, detached, stdio: ['ignore', fd, fd] })
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              new Error(`${command} ${args.join(' ')} failed (${signal ?? code}). See ${logPath}`)
            )
      )
    })
  } finally {
    closeSync(fd)
  }
}

/** Independently exercise the test-channel archive verifier without starting either application. */
export async function verifyManualValidationArchive(runRoot, build, env) {
  const directory = join(runRoot, 'builds', 'a')
  const require = createRequire(join(directory, 'package.json'))
  const output = join(directory, '.scratch', 'manual-artifact-verifier.cjs')
  await require('esbuild').build({
    absWorkingDir: directory,
    entryPoints: ['src/main/local-update-validation/manual-installer.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    target: 'node24'
  })
  const cache = join(runRoot, 'artifact-inspection-cache')
  await mkdir(cache)
  const zip = build.b.files.find((file) => file.name.endsWith('.zip'))
  const path = join(cache, zip.name)
  await cp(join(build.b.directory, zip.name), path, { errorOnExist: true, force: false })
  const artifact = {
    platform: 'darwin',
    format: 'zip',
    arch: build.arch,
    version: build.versionB,
    path,
    size: zip.size,
    algorithm: 'sha512',
    checksum: zip.sha512
  }
  const config = {
    updateCacheRoot: cache,
    targetArtifact: {
      version: build.versionB,
      arch: build.arch,
      size: zip.size,
      sha512: zip.sha512
    }
  }
  const input = join(runRoot, 'manual-artifact-inspection.json')
  await writeFile(input, JSON.stringify({ artifact, config }, null, 2))
  await runCommand(
    process.execPath,
    [
      '-e',
      `const { artifact, config } = require(process.argv[2]);
     require(process.argv[1]).inspectValidationManualInstaller(artifact, config).catch(error => { console.error(error); process.exitCode = 1 });`,
      output,
      input
    ],
    { cwd: directory, logPath: join(runRoot, 'manual-artifact-inspection.log'), env }
  )
  const proof = {
    schema: 1,
    snapshotId: build.snapshotId,
    version: build.versionB,
    arch: build.arch,
    sha512: zip.sha512,
    size: zip.size,
    verifiedAt: new Date().toISOString(),
    checksum: true,
    archivePaths: true,
    adHocSignature: true,
    targetIdentity: true,
    backendVersion: true,
    executableArchitecture: true,
    applicationStarted: false,
    nativeInstallInvoked: false
  }
  await writeFile(
    join(runRoot, 'manual-artifact-inspection-result.json'),
    JSON.stringify(proof, null, 2)
  )
  return proof
}

export async function buildPair(runRoot, { versionA, versionB, snapshotId }) {
  validateVersions(versionA, versionB)
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw new Error('Local update validation builds require native macOS arm64/x64.')
  const env = {
    ...process.env,
    OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION: '1',
    OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CREDENTIALS: 'sandbox',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    MACOSX_DEPLOYMENT_TARGET: '12.0'
  }
  for (const key of Object.keys(env))
    if (
      /^(CSC_LINK|CSC_KEY_PASSWORD|APPLE_|OPEN_SCIENCE_(?!LOCAL_UPDATE_VALIDATION(?:_CREDENTIALS)?$))/.test(
        key
      )
    )
      delete env[key]
  const build = {
    schema: 1,
    snapshotId,
    versionA,
    versionB,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    credentialMode: 'sandbox',
    boundaryVerified: false,
    cacheReused: false,
    preparation: [
      'fresh snapshot copy per version',
      'repository npm-ci (including postinstall/Prisma/pinned native dependencies)',
      'real production/test main bundle boundary tests in the captured A build',
      'pinned micromamba',
      'pinned Node runtime',
      'repository build:mac + beforePack backend staging'
    ],
    // No build/dependency cache is reused. Download caches remain verified by repository resource scripts.
    overrides: {
      appId: 'com.aipoch.open-science.local-update-validation',
      testBuild: true,
      macTarget: 'zip',
      signing: 'repository-ad-hoc-hook',
      icon: 'build/icon.icns'
    }
  }
  await writeFile(join(runRoot, 'build.json'), `${JSON.stringify(build, null, 2)}\n`)
  for (const [key, version] of [
    ['a', versionA],
    ['b', versionB]
  ]) {
    const directory = join(runRoot, 'builds', key)
    const output = join(runRoot, 'artifacts', key)
    await cp(join(runRoot, 'source'), directory, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false
    })
    await setBuildVersion(directory, version)
    await mkdir(join(directory, '.scratch'), { recursive: true })
    await mkdir(output, { recursive: true })
    const configPath = join(directory, '.scratch', 'local-update-builder.json')
    await writeFile(
      configPath,
      JSON.stringify(
        {
          extends: join(directory, 'electron-builder.yml'),
          appId: build.overrides.appId,
          directories: { output },
          mac: { target: ['zip'], identity: null, icon: 'build/icon.icns' },
          publish: { provider: 'generic', url: 'http://127.0.0.1:9', channel: 'latest' }
        },
        null,
        2
      )
    )
    const logPath = join(runRoot, `build-${key}.log`)
    const command = async (binary, args) =>
      runCommand(binary, args, { cwd: directory, logPath, env })
    console.log(`Preparing ${key.toUpperCase()} ${version}; log: ${logPath}`)
    await command(process.execPath, ['scripts/ci/npm-ci.mjs'])
    // npm versions with blocked install scripts still need the repository's explicit preparation.
    await command('npm', ['run', 'postinstall'])
    if (key === 'a') {
      const boundaryReport = join(runRoot, 'build-boundary-tests.json')
      await command(process.execPath, [
        'node_modules/vitest/vitest.mjs',
        'run',
        'src/main/local-update-validation/build-boundary.test.ts',
        '--reporter=json',
        '--outputFile',
        boundaryReport
      ])
      build.productionMainBundleVerified = true
      build.productionMainBundleReport = boundaryReport
      build.productionFullPackageVerified = false
      await writeFile(join(runRoot, 'build.json'), `${JSON.stringify(build, null, 2)}\n`)
    }
    await command(process.execPath, [
      'scripts/fetch-micromamba.mjs',
      process.arch === 'arm64' ? 'osx-arm64' : 'osx-64',
      `resources/bin/mac/${process.arch}/micromamba`
    ])
    await command('npm', ['run', 'stage:node-runtime'])
    await command('npm', [
      'run',
      'build:mac',
      '--',
      '--publish',
      'never',
      `--${process.arch}`,
      '--config',
      configPath
    ])
    const app = join(output, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Open-Science.app')
    const resources = join(app, 'Contents', 'Resources')
    const require = createRequire(join(directory, 'package.json'))
    const asar = require('@electron/asar')
    const archive = join(resources, 'app.asar')
    const entries = asar.listPackage(archive)
    if (
      entries.some((entry) =>
        /(?:^|[/\\])(?:scripts|docs)[/\\]local-update-validation(?:[/\\.]|$)/.test(entry)
      )
    )
      throw new Error(
        'External local-update-validation program leaked into the application package.'
      )
    const desktopVersion = JSON.parse(asar.extractFile(archive, 'package.json').toString()).version
    const backendVersion = JSON.parse(
      await readFile(join(resources, 'backend', 'package.json'), 'utf8')
    ).version
    if (desktopVersion !== version || backendVersion !== version)
      throw new Error(`Desktop/backend version mismatch for ${key.toUpperCase()}.`)
    const files = []
    for (const name of (await readdir(output)).sort()) {
      if (!/\.(?:zip|dmg|blockmap)$/.test(name)) continue
      files.push({ name, ...(await fileIdentity(join(output, name))) })
    }
    if (!files.some((file) => file.name.endsWith('.zip')))
      throw new Error(`Missing ${key.toUpperCase()} ZIP update artifact.`)
    build[key] = {
      version,
      snapshotId,
      directory: output,
      app,
      files,
      desktopVersion,
      backendVersion,
      externalProgramExcluded: true
    }
    await writeFile(join(runRoot, 'build.json'), `${JSON.stringify(build, null, 2)}\n`)
  }
  build.productionPackage = await verifyProductionPackage({
    runRoot,
    preparedDirectory: join(runRoot, 'builds', 'a'),
    snapshotId,
    version: versionA,
    validationApps: [build.a.app, build.b.app]
  })
  build.manualArtifactVerification = await verifyManualValidationArchive(runRoot, build, env)
  build.productionFullPackageVerified =
    build.productionPackage.productionFullPackageVerified === true
  build.boundaryVerified =
    build.productionFullPackageVerified &&
    build.productionMainBundleVerified === true &&
    build.a.externalProgramExcluded === true &&
    build.b.externalProgramExcluded === true
  await writeFile(join(runRoot, 'build.json'), `${JSON.stringify(build, null, 2)}\n`)
  return build
}

export async function verifyArtifacts(build) {
  if (!build.boundaryVerified || !build.productionFullPackageVerified)
    throw new Error('Complete production/test package boundaries must be verified before launch.')
  const require = createRequire(join(build.a.directory, '../../builds/a/package.json'))
  const asar = require('@electron/asar')
  for (const previous of [
    ...build.productionPackage.validationPackages,
    build.productionPackage.production
  ]) {
    const current = await inspectApplicationPackage(previous.app, {
      production: previous.app === build.productionPackage.production.app,
      asar
    })
    if (current.treeSha256 !== previous.treeSha256)
      throw new Error(`Application package changed after verification: ${previous.app}`)
  }
  for (const key of ['a', 'b']) {
    if (!build[key]?.files?.length)
      throw new Error('Both builds must complete before a scenario can start.')
    for (const file of build[key].files) {
      const actual = await fileIdentity(join(build[key].directory, file.name))
      if (['sha256', 'sha512', 'size'].some((field) => actual[field] !== file[field]))
        throw new Error(`Artifact no longer matches captured identity: ${file.name}`)
    }
  }
}
