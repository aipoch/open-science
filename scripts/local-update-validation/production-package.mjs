/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runCommand } from './build.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const within = (root, path) => {
  const value = relative(root, path)
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}
const externalMarkers = [
  '.local-update-validation-owner.json',
  'Local update service must bind IPv4 loopback.',
  'Local update validation attachment. No private research data.',
  'macOS local update validation (external development tool)'
]
const adapterMarkers = [
  'OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG',
  'local-update-credential-sandbox',
  'LocalMacDownloadUpdater',
  'Native installation is disabled in this validation build.'
]

function inspectMemberName(name, production) {
  const normalized = name.replaceAll('\\', '/')
  if (/(?:^|\/)(?:scripts|docs)\/local-update-validation(?:[/.]|$)/.test(normalized))
    throw new Error(`External validation tooling entered an application package: ${name}`)
  if (production && /(?:^|\/)local-update-validation(?:[/.]|$)/.test(normalized))
    throw new Error(`Test-only module entered the production package: ${name}`)
}

// ASAR is an uncompressed container. Streaming its complete bytes inspects packed source contents;
// listPackage independently inspects all virtual paths, including empty files and linked entries.
async function inspectFile(path, forbidden) {
  const hash = createHash('sha256')
  const needles = forbidden.map((text) => ({ text, bytes: Buffer.from(text) }))
  const overlap = Math.max(...needles.map(({ bytes }) => bytes.length)) - 1
  let tail = Buffer.alloc(0)
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    hash.update(chunk)
    const searchable = Buffer.concat([tail, chunk])
    for (const { text, bytes } of needles)
      if (searchable.includes(bytes))
        throw new Error(`Forbidden validation code in ${path}: ${text}`)
    tail = searchable.subarray(Math.max(0, searchable.length - overlap))
  }
  return { size, sha256: hash.digest('hex') }
}

/** Inspect the entire .app, including app.asar, unpacked dependencies and the separate backend. */
export async function inspectApplicationPackage(appPath, { production, asar }) {
  const root = resolve(appPath)
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error('Application package inspection requires its canonical directory.')
  const files = []
  const archives = []
  const forbidden = production ? [...externalMarkers, ...adapterMarkers] : externalMarkers
  const walk = async (directory) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const member = relative(root, path).split(sep).join('/')
      inspectMemberName(member, production)
      const entry = await lstat(path)
      if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        if (
          isAbsolute(target) ||
          !within(root, resolve(dirname(path), target)) ||
          !within(root, await realpath(path))
        )
          throw new Error(`Application symlink escapes its package: ${member}`)
        files.push({ path: member, kind: 'symlink', target })
      } else if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        if (name.endsWith('.asar')) {
          const members = asar.listPackage(path).sort()
          for (const item of members) inspectMemberName(item, production)
          archives.push({
            path: member,
            entries: members.length,
            namesSha256: digest(JSON.stringify(members))
          })
        }
        files.push({
          path: member,
          kind: 'file',
          mode: entry.mode & 0o777,
          ...(await inspectFile(path, forbidden))
        })
      } else throw new Error(`Unsupported application package entry: ${member}`)
    }
  }
  await walk(root)
  if (!archives.some((archive) => archive.path === 'Contents/Resources/app.asar'))
    throw new Error('Application package is missing Contents/Resources/app.asar.')
  const desktop = JSON.parse(
    asar.extractFile(join(root, 'Contents/Resources/app.asar'), 'package.json')
  )
  const backend = JSON.parse(
    await readFile(join(root, 'Contents/Resources/backend/package.json'), 'utf8')
  )
  if (!desktop.version || desktop.version !== backend.version)
    throw new Error('Inspected desktop and backend versions must agree.')
  return {
    app: root,
    version: desktop.version,
    treeSha256: digest(JSON.stringify(files)),
    files,
    archives,
    externalProgramExcluded: true,
    ...(production ? { testAdapterExcluded: true, runtimeActivationInputExcluded: true } : {})
  }
}

/** Reuse only a prepared tree whose source still matches this run, apart from version overrides. */
export async function verifyPreparedSource(runRoot, preparedDirectory, snapshotId, version) {
  if (resolve(preparedDirectory) !== join(resolve(runRoot), 'builds', 'a'))
    throw new Error("Production packaging may reuse only this run's prepared A directory.")
  const source = JSON.parse(await readFile(join(runRoot, 'source.json'), 'utf8'))
  if (source.snapshotId !== snapshotId || digest(JSON.stringify(source.files)) !== snapshotId)
    throw new Error('Production build source receipt does not match the requested snapshot.')
  for (const record of source.files) {
    const path = resolve(preparedDirectory, record.path)
    if (!within(preparedDirectory, path))
      throw new Error('Source receipt escaped prepared directory.')
    const entry = await lstat(path)
    if (record.kind === 'symlink') {
      if (!entry.isSymbolicLink() || (await readlink(path)) !== record.target)
        throw new Error(`Prepared source symlink changed: ${record.path}`)
      continue
    }
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error(`Prepared source changed: ${record.path}`)
    const bytes = await readFile(path)
    if (record.path === 'package.json' || record.path === 'package-lock.json') {
      const original = await readFile(join(runRoot, 'source', record.path))
      if (digest(original) !== record.sha256)
        throw new Error('Frozen source package metadata changed.')
      const expected = JSON.parse(original)
      expected.version = version
      if (expected.packages?.['']) expected.packages[''].version = version
      if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(expected))
        throw new Error(`Unexpected prepared package override: ${record.path}`)
    } else if (digest(bytes) !== record.sha256 || !!(entry.mode & 0o111) !== record.executable)
      throw new Error(`Prepared source changed: ${record.path}`)
  }
  return {
    snapshotId,
    filesCompared: source.files.length,
    allowedOverrides: ['package.json version', 'package-lock.json version']
  }
}

export function productionBuildEnvironment(environment = process.env) {
  const env = {
    ...environment,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    MACOSX_DEPLOYMENT_TARGET: '12.0'
  }
  for (const key of Object.keys(env))
    if (/^(OPEN_SCIENCE_|CSC_LINK|CSC_KEY_PASSWORD|APPLE_)/.test(key)) delete env[key]
  env.OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION = '0'
  return env
}

/** Called after both validation packages are complete. Never launches an application. */
export async function verifyProductionPackage({
  runRoot,
  preparedDirectory,
  snapshotId,
  version,
  validationApps
}) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw new Error('Production package validation requires native macOS.')
  if (!Array.isArray(validationApps) || validationApps.length !== 2)
    throw new Error('Both completed A and B applications are required before production packaging.')
  const source = await verifyPreparedSource(runRoot, preparedDirectory, snapshotId, version)
  const require = createRequire(join(preparedDirectory, 'package.json'))
  const asar = require('@electron/asar')
  const validations = []
  for (const app of validationApps) {
    if (!within(join(runRoot, 'artifacts'), resolve(app)))
      throw new Error('Validation package escaped this run.')
    validations.push(await inspectApplicationPackage(app, { production: false, asar }))
  }
  const output = join(runRoot, 'artifacts', 'production')
  await mkdir(output, { recursive: false })
  const configPath = join(preparedDirectory, '.scratch', 'production-boundary-builder.json')
  // Keep the ordinary appId, publish configuration, resources, hooks and file filters. The icon
  // fallback and unsigned directory target avoid requiring Icon Composer, credentials or a DMG.
  await writeFile(
    configPath,
    JSON.stringify(
      {
        extends: join(preparedDirectory, 'electron-builder.yml'),
        directories: { output },
        mac: { identity: null, icon: 'build/icon.icns', notarize: false }
      },
      null,
      2
    )
  )
  const logPath = join(runRoot, 'build-production.log')
  await runCommand(
    'npm',
    [
      'run',
      'build:mac',
      '--',
      '--dir',
      '--publish',
      'never',
      `--${process.arch}`,
      '--config',
      configPath
    ],
    {
      cwd: preparedDirectory,
      logPath,
      env: productionBuildEnvironment()
    }
  )
  await verifyPreparedSource(runRoot, preparedDirectory, snapshotId, version)
  const production = await inspectApplicationPackage(
    join(output, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Open-Science.app'),
    { production: true, asar }
  )
  if (production.version !== version)
    throw new Error('Production package version differs from prepared A.')
  for (const previous of validations) {
    const current = await inspectApplicationPackage(previous.app, { production: false, asar })
    if (current.treeSha256 !== previous.treeSha256)
      throw new Error('Production packaging modified an existing validation application.')
  }
  const receiptPath = join(runRoot, 'production-package-verification.json')
  const receipt = {
    schema: 1,
    snapshotId,
    verifiedAt: new Date().toISOString(),
    productionFullPackageVerified: true,
    source,
    production,
    validationPackages: validations,
    reuse: {
      directory: preparedDirectory,
      inputs: ['same-snapshot prepared npm dependencies', 'pinned verified native resources'],
      regenerated: ['desktop bundles', 'backend', 'package staging'],
      existingValidationPackagesUnchanged: true
    },
    overrides: {
      icon: 'build/icon.icns',
      signing: 'repository ad-hoc hook',
      target: 'directory',
      testDefine: false
    },
    applicationLaunched: false,
    logPath,
    receiptPath
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  // Keep the complete per-file manifests in the evidence file, without multiplying that payload
  // into build.json and every periodically rewritten scenario report.
  const summary = ({ files, ...identity }) => ({ ...identity, fileCount: files.length })
  return {
    ...receipt,
    production: summary(production),
    validationPackages: validations.map(summary)
  }
}
