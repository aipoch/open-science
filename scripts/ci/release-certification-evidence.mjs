/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLATFORMS = ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']
const DISTRIBUTABLE = /\.(?:AppImage|deb|dmg|exe|zip)$/
const CHECK_STATES = ['passed', 'not-applicable']

const argumentValue = (argv, name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const sha256 = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

const artifactEvidence = async (directory) => {
  const names = (await readdir(directory)).filter((name) => DISTRIBUTABLE.test(name)).sort()
  if (names.length === 0) throw new Error(`No distributables found in ${directory}.`)
  return Promise.all(
    names.map(async (name) => ({ name, sha256: await sha256(join(directory, name)) }))
  )
}

const writePlatformEvidence = async ({ argv, environment = process.env }) => {
  const platform = argumentValue(argv, '--platform')
  const artifactDirectoryArgument = argumentValue(argv, '--artifact-dir')
  const outputArgument = argumentValue(argv, '--output')
  const electronP0 = argumentValue(argv, '--electron-p0')
  const visualRegression = argumentValue(argv, '--visual-regression')
  const packageSmoke = argumentValue(argv, '--package-smoke')
  const authenticode = argumentValue(argv, '--authenticode')
  if (
    !PLATFORMS.includes(platform) ||
    !artifactDirectoryArgument ||
    !outputArgument ||
    !CHECK_STATES.includes(electronP0) ||
    !CHECK_STATES.includes(visualRegression) ||
    !['passed', 'not-applicable'].includes(packageSmoke) ||
    !['passed', 'not-required', 'not-applicable'].includes(authenticode)
  ) {
    throw new Error(
      'Usage: --platform <platform> --artifact-dir <path> --output <path> ' +
        '--electron-p0 <passed|not-applicable> ' +
        '--visual-regression <passed|not-applicable> ' +
        '--package-smoke <passed|not-applicable> ' +
        '--authenticode <passed|not-required|not-applicable>'
    )
  }
  const artifactDirectory = resolve(artifactDirectoryArgument)
  const output = resolve(outputArgument)
  if (!environment.GITHUB_SHA || !environment.GITHUB_RUN_ID || !environment.GITHUB_RUN_ATTEMPT) {
    throw new Error('Release certification evidence requires GitHub run identity variables.')
  }

  const evidence = {
    schemaVersion: 1,
    platform,
    source: {
      repository: environment.GITHUB_REPOSITORY,
      ref: environment.GITHUB_REF,
      sha: environment.GITHUB_SHA,
      runId: environment.GITHUB_RUN_ID,
      runAttempt: environment.GITHUB_RUN_ATTEMPT
    },
    checks: {
      electronP0,
      visualRegression,
      packageSmoke,
      authenticode
    },
    artifacts: await artifactEvidence(artifactDirectory)
  }
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return evidence
}

const writeWindowsUpdateEvidence = async ({ argv, environment = process.env }) => {
  const outputArgument = argumentValue(argv, '--output')
  const currentTag = argumentValue(argv, '--current-tag')
  const previousTag = argumentValue(argv, '--previous-tag')
  const status = argumentValue(argv, '--status')
  const reason = argumentValue(argv, '--reason')
  const updaterObservationPath = argumentValue(argv, '--updater-observation')
  if (!outputArgument || !currentTag || !['passed', 'failed', 'not-applicable'].includes(status)) {
    throw new Error(
      'Usage: --output <path> --current-tag <tag> [--previous-tag <tag>] ' +
        '--status <passed|failed|not-applicable> [--updater-observation <path>]'
    )
  }
  if (status === 'passed' && !previousTag) {
    throw new Error('A passed Windows update drill requires the previous stable tag.')
  }
  if (status === 'passed' && !updaterObservationPath) {
    throw new Error('A passed Windows update drill requires differential updater observation.')
  }
  if (status === 'not-applicable' && reason !== 'no-previous-stable-release') {
    throw new Error('A non-applicable Windows update drill requires an approved reason.')
  }
  if (status === 'failed' && (!previousTag || !reason)) {
    throw new Error('A failed Windows update drill requires the previous tag and failure reason.')
  }
  if (!environment.GITHUB_SHA || !environment.GITHUB_RUN_ID || !environment.GITHUB_RUN_ATTEMPT) {
    throw new Error('Windows update evidence requires GitHub run identity variables.')
  }

  const check = status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'not-applicable'
  let updater
  if (updaterObservationPath) {
    updater = JSON.parse(await readFile(resolve(updaterObservationPath), 'utf8'))
    if (
      updater.schemaVersion !== 1 ||
      updater.mode !== 'electron-updater-differential' ||
      updater.feedRequests < 1 ||
      updater.blockmapRequests < 2 ||
      updater.rangeRequests < 1 ||
      updater.fullInstallerRequests !== 0 ||
      updater.downloadedInstallerBytes < 1 ||
      updater.downloadedInstallerBytes >= updater.installerBytes ||
      updater.versionedFeed !== true ||
      updater.previousInstallerCacheVerified !== true ||
      typeof updater.previousVersion !== 'string' ||
      typeof updater.currentVersion !== 'string' ||
      updater.previousVersion === updater.currentVersion
    ) {
      throw new Error('Windows updater observation does not prove a differential download.')
    }
    if (
      `v${updater.currentVersion}` !== currentTag ||
      `v${updater.previousVersion}` !== previousTag
    ) {
      throw new Error('Windows updater observation versions do not match the release tags.')
    }
  }
  const evidence = {
    schemaVersion: 1,
    kind: 'windows-update-drill',
    source: {
      sha: environment.GITHUB_SHA,
      runId: environment.GITHUB_RUN_ID,
      runAttempt: environment.GITHUB_RUN_ATTEMPT
    },
    currentTag,
    previousTag: previousTag || undefined,
    status,
    checks: {
      authenticode: 'not-required',
      electronUpdater: check,
      incrementalDownload: check,
      feedCompatibility: check,
      silentInstall: check,
      processLock: check,
      rollback: check,
      restart: check
    },
    ...(updater ? { updater } : {}),
    ...(status !== 'passed' ? { reason } : {})
  }
  await writeFile(resolve(outputArgument), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return evidence
}

const aggregateEvidence = async ({ argv }) => {
  const directoryArgument = argumentValue(argv, '--directory')
  const outputArgument = argumentValue(argv, '--output')
  const expectedSha = argumentValue(argv, '--expected-sha')
  const requireWindowsUpdate = argv.includes('--require-windows-update')
  if (!directoryArgument || !outputArgument || !expectedSha) {
    throw new Error(
      'Usage: --directory <path> --output <path> --expected-sha <sha> ' +
        '[--require-windows-update]'
    )
  }
  const directory = resolve(directoryArgument)
  const output = resolve(outputArgument)

  const names = (await readdir(directory))
    .filter((name) =>
      /^certification-(?:linux-x64|macos-arm64|macos-x64|windows-x64)\.json$/.test(name)
    )
    .sort()
  const records = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')))
  )
  const byPlatform = new Map(records.map((record) => [record.platform, record]))
  const missing = PLATFORMS.filter((platform) => !byPlatform.has(platform))
  if (missing.length > 0 || records.length !== PLATFORMS.length) {
    throw new Error(
      `Incomplete release certification evidence; missing: ${missing.join(', ') || 'none'}.`
    )
  }

  for (const platform of PLATFORMS) {
    const record = byPlatform.get(platform)
    const expectedPortableCheck = platform === 'macos-arm64' ? 'passed' : 'not-applicable'
    if (
      record.schemaVersion !== 1 ||
      record.source?.sha !== expectedSha ||
      record.checks?.electronP0 !== expectedPortableCheck ||
      record.checks?.visualRegression !== expectedPortableCheck ||
      !Array.isArray(record.artifacts) ||
      record.artifacts.length === 0
    ) {
      throw new Error(`Invalid release certification evidence for ${platform}.`)
    }
    for (const artifact of record.artifacts) {
      const artifactPath = join(directory, artifact.name)
      if ((await sha256(artifactPath).catch(() => undefined)) !== artifact.sha256) {
        throw new Error(`Release artifact digest does not match evidence: ${artifact.name}.`)
      }
    }
    if (record.checks.packageSmoke !== 'passed') {
      throw new Error(`Package smoke did not pass for ${platform}.`)
    }
  }
  let windowsUpdate
  if (requireWindowsUpdate) {
    const updatePath = join(directory, 'certification-windows-update.json')
    windowsUpdate = JSON.parse(await readFile(updatePath, 'utf8').catch(() => 'null'))
    const passedChecks =
      windowsUpdate?.status === 'passed' &&
      windowsUpdate.updater?.schemaVersion === 1 &&
      windowsUpdate.updater?.mode === 'electron-updater-differential' &&
      windowsUpdate.updater?.feedRequests >= 1 &&
      windowsUpdate.updater?.blockmapRequests >= 2 &&
      windowsUpdate.updater?.rangeRequests >= 1 &&
      windowsUpdate.updater?.fullInstallerRequests === 0 &&
      windowsUpdate.updater?.downloadedInstallerBytes >= 1 &&
      windowsUpdate.updater?.downloadedInstallerBytes < windowsUpdate.updater?.installerBytes &&
      windowsUpdate.updater?.versionedFeed === true &&
      windowsUpdate.updater?.previousInstallerCacheVerified === true &&
      typeof windowsUpdate.updater?.previousVersion === 'string' &&
      typeof windowsUpdate.updater?.currentVersion === 'string' &&
      windowsUpdate.updater?.previousVersion !== windowsUpdate.updater?.currentVersion &&
      `v${windowsUpdate.updater?.currentVersion}` === windowsUpdate.currentTag &&
      `v${windowsUpdate.updater?.previousVersion}` === windowsUpdate.previousTag &&
      [
        'electronUpdater',
        'incrementalDownload',
        'feedCompatibility',
        'silentInstall',
        'processLock',
        'rollback',
        'restart'
      ].every((check) => windowsUpdate.checks?.[check] === 'passed')
    const firstRelease =
      windowsUpdate?.status === 'not-applicable' &&
      windowsUpdate.reason === 'no-previous-stable-release'
    if (
      windowsUpdate?.schemaVersion !== 1 ||
      windowsUpdate?.kind !== 'windows-update-drill' ||
      windowsUpdate?.source?.sha !== expectedSha ||
      (!passedChecks && !firstRelease)
    ) {
      throw new Error('Invalid or incomplete stable Windows update drill evidence.')
    }
  }

  const report = {
    schemaVersion: 1,
    sourceSha: expectedSha,
    platforms: PLATFORMS.map((platform) => byPlatform.get(platform)),
    ...(requireWindowsUpdate ? { releaseChecks: { windowsUpdate } } : {})
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

const main = async () => {
  const argv = process.argv.slice(2)
  if (argv[0] === 'write') await writePlatformEvidence({ argv: argv.slice(1) })
  else if (argv[0] === 'write-windows-update') {
    await writeWindowsUpdateEvidence({ argv: argv.slice(1) })
  } else if (argv[0] === 'aggregate') await aggregateEvidence({ argv: argv.slice(1) })
  else throw new Error('Expected release certification evidence command: write or aggregate.')
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

export { aggregateEvidence, artifactEvidence, writePlatformEvidence, writeWindowsUpdateEvidence }
