import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { micromambaWorkingCachePaths } from '@aipoch/environment'

import { runUninstallHelper } from './fixtures/windows-uninstall-helper'

type Fixture = {
  sandbox: string
  runtimeRoot: string
  managedParent: string
  cachePath: string
  env: NodeJS.ProcessEnv
  userIdentity: string
}

const roots: string[] = []

const run = (executable: string, args: string[], env?: NodeJS.ProcessEnv): void => {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: env ?? process.env,
    timeout: 30_000
  })
  if (result.status !== 0) {
    throw new Error(
      `${executable} exited with ${String(result.status)}: ${result.stderr || result.stdout}`
    )
  }
}

const hardenDirectory = (path: string): void => {
  const identity = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\')
  if (!identity) throw new Error('Windows test identity is unavailable.')
  run('icacls.exe', [
    path,
    '/inheritance:r',
    '/grant:r',
    `${identity}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F'
  ])
}

const makeFixture = (): Fixture => {
  const sandbox = mkdtempSync(join(tmpdir(), 'open-science-uninstall-cache-'))
  roots.push(sandbox)
  const profile = join(sandbox, 'profile')
  const dataRoot = join(sandbox, 'data')
  const runtimeRoot = join(dataRoot, 'runtime')
  const configuredTemp = join(sandbox, 'temp')
  const configuredTmp = join(sandbox, 'tmp')
  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(configuredTemp)
  mkdirSync(configuredTmp)
  mkdirSync(join(profile, '.open-science'), { recursive: true })
  writeFileSync(
    join(profile, '.open-science', 'settings.json'),
    `${JSON.stringify({ dataRoot })}\n`
  )

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: profile,
    TEMP: configuredTemp,
    TMP: configuredTmp,
    PUBLIC: ''
  }
  const userIdentity = [env.USERDOMAIN, env.USERNAME].filter(Boolean).join('\\')
  const managedParent = join(realpathSync.native(configuredTemp), 'OpenScienceTmp')
  const cachePath = micromambaWorkingCachePaths(runtimeRoot, {
    platform: 'win32',
    env
  }).find(
    (candidate) =>
      win32
        .dirname(candidate)
        .localeCompare(managedParent, undefined, { sensitivity: 'accent' }) === 0
  )
  if (!cachePath || !userIdentity) throw new Error('Could not resolve the Windows cache fixture.')
  return { sandbox, runtimeRoot, managedParent, cachePath, env, userIdentity }
}

const writeParentMarker = (fixture: Fixture): void => {
  mkdirSync(fixture.managedParent, { recursive: true })
  writeFileSync(
    join(fixture.managedParent, '.open-science-temp.json'),
    `${JSON.stringify({
      schema: 1,
      kind: 'micromamba-working-cache-parent',
      userIdentity: fixture.userIdentity
    })}\n`
  )
  hardenDirectory(fixture.managedParent)
}

const writeCache = (
  fixture: Fixture,
  canonicalRoot = realpathSync.native(fixture.runtimeRoot)
): void => {
  mkdirSync(fixture.cachePath, { recursive: true })
  writeFileSync(
    join(fixture.cachePath, '.open-science-cache.json'),
    `${JSON.stringify({
      schema: 1,
      canonicalRoot: canonicalRoot.toLowerCase(),
      userIdentity: fixture.userIdentity
    })}\n`
  )
  writeFileSync(join(fixture.cachePath, 'payload.bin'), 'cache payload')
  hardenDirectory(fixture.cachePath)
}

const runUninstaller = (fixture: Fixture): void => {
  const result = runUninstallHelper(['runtime-cache'], fixture.env)
  if (result.status !== 0)
    throw new Error(`runtime-cache exited with ${String(result.status)}: ${result.stderr}`)
}

const inspectTrust = (fixture: Fixture): string => {
  const result = runUninstallHelper(
    [
      'test-inspect-cache',
      '--parent',
      fixture.managedParent,
      '--cache',
      fixture.cachePath,
      '--runtime-root',
      realpathSync.native(fixture.runtimeRoot),
      '--identity',
      fixture.userIdentity
    ],
    fixture.env
  )
  if (result.status !== 0) throw new Error(`test-inspect-cache failed: ${result.stderr}`)
  const { Parent, Cache, Leaf } = JSON.parse(result.stdout)
  return JSON.stringify({ Parent, Cache, Leaf })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('Windows runtime cache uninstaller', () => {
  it('removes a marker-owned working cache and its empty managed parent idempotently', () => {
    const fixture = makeFixture()
    writeParentMarker(fixture)
    writeCache(fixture)

    expect(JSON.parse(inspectTrust(fixture))).toEqual({
      Parent: true,
      Cache: true,
      Leaf: win32.basename(fixture.cachePath)
    })

    runUninstaller(fixture)

    expect(existsSync(fixture.cachePath)).toBe(false)
    expect(existsSync(fixture.managedParent)).toBe(false)
    expect(() => runUninstaller(fixture)).not.toThrow()
  })

  it('removes a cache when the configured runtime root is behind a junction', () => {
    const fixture = makeFixture()
    const aliasDataRoot = join(fixture.sandbox, 'data-alias')
    symlinkSync(join(fixture.sandbox, 'data'), aliasDataRoot, 'junction')
    writeFileSync(
      join(fixture.env.USERPROFILE!, '.open-science', 'settings.json'),
      `${JSON.stringify({ dataRoot: aliasDataRoot })}\n`
    )
    writeParentMarker(fixture)
    writeCache(fixture)

    runUninstaller(fixture)

    expect(existsSync(fixture.cachePath)).toBe(false)
    expect(existsSync(fixture.managedParent)).toBe(false)
    expect(existsSync(fixture.runtimeRoot)).toBe(true)
  })

  it('retries removal of a marker-only managed parent left by an interrupted cleanup', () => {
    const fixture = makeFixture()
    writeParentMarker(fixture)

    runUninstaller(fixture)

    expect(existsSync(fixture.managedParent)).toBe(false)
  })

  it('preserves a cache whose ownership marker does not match the runtime root', () => {
    const fixture = makeFixture()
    writeParentMarker(fixture)
    writeCache(fixture, join(fixture.sandbox, 'foreign-runtime'))

    runUninstaller(fixture)

    expect(existsSync(join(fixture.cachePath, 'payload.bin'))).toBe(true)
    expect(existsSync(fixture.managedParent)).toBe(true)
  })

  it('preserves a marker-matching cache that grants a foreign principal write access', () => {
    const fixture = makeFixture()
    writeParentMarker(fixture)
    writeCache(fixture)
    run('icacls.exe', [fixture.cachePath, '/grant', '*S-1-1-0:(OI)(CI)M'])

    expect(JSON.parse(inspectTrust(fixture))).toEqual({
      Parent: true,
      Cache: false,
      Leaf: win32.basename(fixture.cachePath)
    })

    runUninstaller(fixture)

    expect(existsSync(join(fixture.cachePath, 'payload.bin'))).toBe(true)
    expect(existsSync(fixture.managedParent)).toBe(true)
  })

  it('preserves a reparse-point cache and its target', () => {
    const fixture = makeFixture()
    writeParentMarker(fixture)
    const target = join(fixture.sandbox, 'foreign-target')
    mkdirSync(target)
    writeFileSync(join(target, 'payload.bin'), 'foreign payload')
    symlinkSync(target, fixture.cachePath, 'junction')

    runUninstaller(fixture)

    expect(existsSync(fixture.cachePath)).toBe(true)
    expect(existsSync(join(target, 'payload.bin'))).toBe(true)
    expect(existsSync(fixture.managedParent)).toBe(true)
  })
})
