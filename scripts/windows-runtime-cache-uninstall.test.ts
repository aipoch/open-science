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

import { micromambaWorkingCachePaths } from '../src/main/notebook/micromamba-cache'

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

const runOutput = (executable: string, args: string[], env?: NodeJS.ProcessEnv): string => {
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
  return result.stdout.trim()
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
    PUBLIC: '',
    PSModulePath: [
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, 'WindowsPowerShell', 'Modules')
        : undefined,
      process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
        : undefined
    ]
      .filter(Boolean)
      .join(';')
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
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot is unavailable.')
  run(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(process.cwd(), 'build', 'windows-runtime-cache-uninstall.ps1')
    ],
    fixture.env
  )
}

const inspectTrust = (fixture: Fixture): string => {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot is unavailable.')
  const script = join(process.cwd(), 'build', 'windows-runtime-cache-uninstall.ps1').replace(
    /'/g,
    "''"
  )
  const parent = fixture.managedParent.replace(/'/g, "''")
  const cache = fixture.cachePath.replace(/'/g, "''")
  const runtimeRoot = realpathSync.native(fixture.runtimeRoot).replace(/'/g, "''")
  const identity = fixture.userIdentity.replace(/'/g, "''")
  return runOutput(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `. '${script}' -LoadFunctionsOnly; [pscustomobject]@{ Parent = (Test-TrustedManagedParent '${parent}' '${identity}'); Cache = (Test-TrustedCache '${cache}' '${runtimeRoot}' '${identity}'); Leaf = (Get-WorkingCacheLeaf '${runtimeRoot}' '${identity}') } | ConvertTo-Json -Compress`
    ],
    fixture.env
  )
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
