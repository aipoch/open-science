import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeInstallationUpdateRecord } from './installation-protection'
import type { RuntimeStartupOptions } from '../runtime-startup-options'

const state = vi.hoisted(() => ({
  record: undefined as NativeInstallationUpdateRecord | undefined,
  ticketOptions: undefined as RuntimeStartupOptions | undefined,
  ownerActive: false,
  released: 0
}))
vi.mock('./installation-protection', () => ({
  acquireNativeInstallationUpdate: vi.fn((location, input) => {
    if (state.record) throw new Error('busy')
    state.record = {
      ...input,
      schema: 1,
      phase: 'preparing',
      installationRoot: location.installationRoot
    }
    state.ownerActive = true
  }),
  advanceNativeInstallationUpdate: vi.fn(() => {
    if (!state.record) throw new Error('missing')
    state.record.phase = 'handoff'
  }),
  claimNativeInstallationUpdateRecovery: vi.fn(() => {
    if (state.ownerActive) return undefined
    state.ownerActive = true
    let released = false
    return () => {
      if (!released) {
        state.ownerActive = false
        state.released++
        released = true
      }
    }
  }),
  readNativeInstallationUpdate: vi.fn(() => state.record),
  readInstallationStartupOptions: vi.fn(() => state.ticketOptions),
  releaseNativeInstallationUpdate: vi.fn(() => {
    state.record = undefined
    state.ownerActive = false
  }),
  settleNativeInstallationUpdateStartup: vi.fn(() => {
    state.record = undefined
    state.ownerActive = false
  }),
  verifyInstallationManifestAsync: vi.fn(async () => false)
}))
import { releaseNativeInstallationUpdate } from './installation-protection'
import {
  ensureMacRecoveryArtifact,
  prepareMacUpdateHandoff,
  readMacUpdateStartupOptions,
  recoverMacUpdateHandoff
} from './mac-update-handoff'

const bytes = Buffer.from('fixture archive: original target only')
const sha512 = createHash('sha512').update(bytes).digest('base64')
const targetManifest = {
  version: '1.0.9',
  files: { 'Contents/MacOS/Open-Science': 'verified-file-hash' }
}
let root: string
let input: Parameters<typeof prepareMacUpdateHandoff>[1]
beforeEach(async () => {
  vi.clearAllMocks()
  state.record = undefined
  state.ticketOptions = undefined
  state.ownerActive = false
  state.released = 0
  root = await realpath(await mkdtemp(join(tmpdir(), 'mac-update-handoff-')))
  const applicationPath = join(root, 'installation.app')
  const profilePath = join(root, 'profile')
  const configRoot = join(root, 'config')
  const dataRoot = join(root, 'research')
  await Promise.all([applicationPath, profilePath, configRoot, dataRoot].map((path) => mkdir(path)))
  await writeFile(join(dataRoot, 'persisted.txt'), 'protected scientific result')
  const installerPath = join(root, 'updater-owned.zip')
  await writeFile(installerPath, bytes)
  input = {
    applicationPath,
    profilePath,
    installerPath,
    installerUrl: 'https://updates.example/1.0.9-arm64.zip',
    targetVersion: '1.0.9',
    startupOptions: {
      configRoot,
      dataRoot,
      profilePath,
      port: 0,
      host: '127.0.0.1',
      credentialStore: 'file'
    }
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function admitted(): ReturnType<typeof prepareMacUpdateHandoff> {
  return prepareMacUpdateHandoff(root, input, {
    installerSha512: sha512,
    inspectArtifact: vi.fn(async () => targetManifest)
  })
}
async function orphaned(): ReturnType<typeof prepareMacUpdateHandoff> {
  const handoff = await admitted()
  handoff.handoff()
  state.ownerActive = false // Model the OS releasing the original process's SQLite lock on exit.
  return handoff
}

describe('Mac electron-updater durable handoff', () => {
  it('reads the original profile synchronously when a crash leaves only the startup ticket', () => {
    state.ticketOptions = input.startupOptions
    expect(state.record).toBeUndefined()
    expect(readMacUpdateStartupOptions({ installationRoot: input.applicationPath })).toEqual(
      input.startupOptions
    )
  })
  it('retains a checksum verified copy and reads the original profile before startup', async () => {
    const handoff = await admitted()
    expect(state.record?.channel).toBe('mac-electron-updater')
    expect(state.record?.phase).toBe('preparing')
    expect(readMacUpdateStartupOptions({ installationRoot: input.applicationPath })).toEqual(
      input.startupOptions
    )
    const request = JSON.parse(
      await readFile(join(state.record!.handoffDirectory, 'request.json'), 'utf8')
    )
    await rm(input.installerPath)
    expect(await readFile(request.installerPath)).toEqual(bytes)
    handoff.handoff()
    handoff.cancel()
    expect(state.record?.phase).toBe('handoff')
    expect(releaseNativeInstallationUpdate).not.toHaveBeenCalled()
  })

  it('cancels admission before Squirrel submission without touching profile/data', async () => {
    const handoff = await admitted()
    const directory = state.record!.handoffDirectory
    handoff.cancel()
    expect(state.record).toBeUndefined()
    await expect(readFile(join(directory, 'request.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(join(input.startupOptions.dataRoot, 'persisted.txt'), 'utf8')).toBe(
      'protected scientific result'
    )
  })

  it('rejects a wrong package and mismatched profiles before acquiring update authority', async () => {
    await writeFile(input.installerPath, 'wrong update')
    await expect(admitted()).rejects.toThrow('checksum')
    expect(state.record).toBeUndefined()
    await writeFile(input.installerPath, bytes)
    input.startupOptions.profilePath = input.startupOptions.dataRoot
    await expect(admitted()).rejects.toThrow('profile')
    expect(state.record).toBeUndefined()
  })

  it('does not race a live handoff owner', async () => {
    await admitted()
    expect(
      await recoverMacUpdateHandoff(
        { installationRoot: input.applicationPath },
        { runningVersion: '1.0.8' }
      )
    ).toEqual({ state: 'busy' })
  })

  it('does not clear a stale marker until the exact target is verified and readiness is published', async () => {
    await orphaned()
    const verifyManifest = vi.fn(async () => true)
    const result = await recoverMacUpdateHandoff(
      { installationRoot: input.applicationPath },
      { runningVersion: '1.0.9', verifyManifest }
    )
    expect(result.state).toBe('ready')
    expect(state.record).toBeDefined()
    if (result.state !== 'ready') throw new Error('expected ready')
    expect(result.request.startupOptions).toEqual(input.startupOptions)
    result.settleBeforeLaunch()
    await result.completeAfterReady()
    expect(verifyManifest).toHaveBeenCalledTimes(2)
    expect(state.record).toBeUndefined()
  })

  it('uses a fresh verification deadline when readiness follows an expired recovery attempt', async () => {
    await orphaned()
    const initial = new AbortController()
    const signals: AbortSignal[] = []
    const result = await recoverMacUpdateHandoff(
      { installationRoot: input.applicationPath },
      {
        runningVersion: '1.0.9',
        signal: initial.signal,
        verifyManifest: async (_root, _manifest, signal) => {
          signal!.throwIfAborted()
          signals.push(signal!)
          return true
        }
      }
    )
    if (result.state !== 'ready') throw new Error('expected ready')
    result.settleBeforeLaunch()
    initial.abort(new Error('original verification deadline expired'))
    await result.completeAfterReady()
    expect(signals).toHaveLength(2)
    expect(signals[1]).not.toBe(signals[0])
  })

  it('keeps protection if target files change before readiness', async () => {
    await orphaned()
    const directory = state.record!.handoffDirectory
    const verifyManifest = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const result = await recoverMacUpdateHandoff(
      { installationRoot: input.applicationPath },
      { runningVersion: '1.0.9', verifyManifest }
    )
    if (result.state !== 'ready') throw new Error('expected ready')
    result.settleBeforeLaunch()
    await expect(result.completeAfterReady()).rejects.toThrow('changed')
    // The startup ticket now owns admission; incomplete readiness must retain the bound request.
    expect(JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')).targetVersion).toBe(
      '1.0.9'
    )
    result.dispose()
    expect(state.ownerActive).toBe(false)
  })

  it('reuses a valid retained ZIP for the original target without consulting latest', async () => {
    await orphaned()
    const fetchImpl = vi.fn()
    const result = await recoverMacUpdateHandoff(
      { installationRoot: input.applicationPath },
      {
        runningVersion: '1.0.8',
        fetchImpl,
        inspectArtifact: vi.fn(async () => targetManifest)
      }
    )
    expect(result.state).toBe('resume')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(state.record).toBeDefined()
    if (result.state === 'resume') {
      expect(result.request.targetVersion).toBe('1.0.9')
      result.dispose()
    }
  })

  it('rejects changed persisted request bytes before using its profile or archive URL', async () => {
    await orphaned()
    const file = join(state.record!.handoffDirectory, 'request.json')
    const request = JSON.parse(await readFile(file, 'utf8'))
    request.targetVersion = '1.0.10'
    await writeFile(file, JSON.stringify(request))
    expect(() => readMacUpdateStartupOptions({ installationRoot: input.applicationPath })).toThrow(
      'changed'
    )
    await expect(
      recoverMacUpdateHandoff(
        { installationRoot: input.applicationPath },
        { runningVersion: '1.0.8' }
      )
    ).rejects.toThrow('changed')
    expect(state.record).toBeDefined()
    expect(state.ownerActive).toBe(false)
  })

  it('rejects a recovered application that differs from the bound target manifest', async () => {
    await orphaned()
    await expect(
      recoverMacUpdateHandoff(
        { installationRoot: input.applicationPath },
        {
          runningVersion: '1.0.8',
          inspectArtifact: vi.fn(async () => ({ version: '1.0.9', files: { wrong: 'payload' } }))
        }
      )
    ).rejects.toThrow('original target')
    expect(state.record).toBeDefined()
    expect(state.ownerActive).toBe(false)
  })
})

describe('original Mac update package recovery', () => {
  it.each(['missing', 'corrupt'])(
    'reacquires a %s cache from the original source with bounded transient retries',
    async (kind) => {
      if (kind === 'missing') await rm(input.installerPath)
      else await writeFile(input.installerPath, 'corrupt')
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error('network temporarily unavailable'))
        .mockResolvedValueOnce(new Response(bytes))
      expect(
        await ensureMacRecoveryArtifact({ ...input, installerSha512: sha512 }, { fetchImpl })
      ).toBe('downloaded')
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(fetchImpl).toHaveBeenLastCalledWith(
        input.installerUrl,
        expect.objectContaining({ redirect: 'error' })
      )
      expect(await readFile(input.installerPath)).toEqual(bytes)
    }
  )

  it('rejects wrong downloaded bytes and leaves the old context after three attempts', async () => {
    await rm(input.installerPath)
    const fetchImpl = vi.fn(async () => new Response('different target'))
    await expect(
      ensureMacRecoveryArtifact({ ...input, installerSha512: sha512 }, { fetchImpl })
    ).rejects.toThrow('three attempts')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    await expect(readFile(input.installerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
