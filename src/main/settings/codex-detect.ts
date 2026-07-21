import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { createLogger } from '../logger'
import { augmentedPathEnv } from './shell-path'
import { stripCodexCredentialEnv } from './process-tree'
import { terminateProcessTree } from '../process-tree'

const execFileAsync = promisify(execFile)

const log = createLogger('codex-detect')

// A runnable adapter that reports a version can still be unpaired with a working native Codex; only a
// live ACP initialize proves the first session will start. Bounded so detection never hangs.
const ACP_SMOKE_TIMEOUT_MS = 15_000

export type CodexDetectResult = {
  adapterPath: string
  adapterVersion: string
  managedCodexPath?: string
  managedCodexVersion?: string
}

export type CodexDetectDeps = {
  env: NodeJS.ProcessEnv
  homePath: string
  platform: NodeJS.Platform
  isRunnable: (path: string) => Promise<boolean>
  getAdapterVersion: (path: string) => Promise<string | undefined>
  getCodexVersion: (path: string) => Promise<string | undefined>
  // Spawns the adapter and performs a real ACP initialize handshake. Resolves true only when the
  // adapter (and the native Codex it resolves) answers with a valid protocol version.
  smokeInitialize: (path: string, opts?: { codexPath?: string }) => Promise<boolean>
  resolveNpmBinDirs: () => Promise<string[]>
  extraDirs?: string[]
  managedAdapterPath?: string
  managedCodexPath?: string
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

const parseVersion = (output: string): string | undefined => {
  const match = output.match(/\d+\.\d+\.\d+[\w.-]*/)

  return match?.[0]
}

const collectCandidateDirs = async (deps: CodexDetectDeps): Promise<string[]> => {
  const p = pathFor(deps.platform)
  const pathDirs = (deps.env.PATH ?? '').split(p.delimiter).filter(Boolean)
  const npmDirs = await deps.resolveNpmBinDirs().catch(() => [])
  const wellKnown =
    deps.platform === 'win32'
      ? deps.env.APPDATA
        ? [p.join(deps.env.APPDATA, 'npm')]
        : []
      : ['/opt/homebrew/bin', '/usr/local/bin']

  return Array.from(
    new Set([
      ...pathDirs,
      p.join(deps.homePath, '.local', 'bin'),
      ...(deps.extraDirs ?? []),
      ...wellKnown,
      ...npmDirs
    ])
  )
}

const detectCodex = async (
  deps: CodexDetectDeps = createDefaultDetectDeps()
): Promise<CodexDetectResult | undefined> => {
  const p = pathFor(deps.platform)
  const dirs = await collectCandidateDirs(deps)
  const names =
    deps.platform === 'win32'
      ? ['codex-acp.cmd', 'codex-acp.exe', 'codex-acp.bat', 'codex-acp']
      : ['codex-acp']
  const candidates = dirs.flatMap((dir) => names.map((name) => p.join(dir, name)))

  if (deps.managedAdapterPath) candidates.push(deps.managedAdapterPath)

  for (const adapterPath of Array.from(new Set(candidates))) {
    if (!(await deps.isRunnable(adapterPath))) continue

    const versionOutput = await deps.getAdapterVersion(adapterPath)
    const adapterVersion = versionOutput ? parseVersion(versionOutput) : undefined
    if (!adapterVersion) continue

    const result: CodexDetectResult = { adapterPath, adapterVersion }
    if (adapterPath === deps.managedAdapterPath && deps.managedCodexPath) {
      const codexOutput = await deps.getCodexVersion(deps.managedCodexPath)
      const managedCodexVersion = codexOutput ? parseVersion(codexOutput) : undefined
      // The app-managed runtime is one pinned pair. Never advertise only the adapter: without its
      // native binary, ACP initialization can succeed but the first session cannot start.
      if (!managedCodexVersion) continue
      result.managedCodexPath = deps.managedCodexPath
      result.managedCodexVersion = managedCodexVersion
    }

    // A version string is not enough: an adapter with a missing or mismatched native Codex passes
    // `--version` but fails the first real session. Gate "ready" on a live ACP initialize so PATH/npm/
    // manual installs are held to the same bar as the managed pair.
    const smokeOk = await deps.smokeInitialize(
      adapterPath,
      result.managedCodexPath ? { codexPath: result.managedCodexPath } : undefined
    )
    if (!smokeOk) continue

    return result
  }

  return undefined
}

// Performs detailed component-level detection for Codex, checking native CLI and ACP adapter
// independently. Returns diagnostic information even when full pairing fails, so the UI can
// distinguish "adapter missing" from "native Codex missing" from "both present but incompatible".
const detectCodexComponents = async (
  deps: CodexDetectDeps = createDefaultDetectDeps()
): Promise<{
  nativeCliFound: boolean
  nativeCliPath?: string
  nativeCliVersion?: string
  adapterFound: boolean
  adapterPath?: string
  adapterVersion?: string
  adapterFailureReason?: 'version-probe-failed' | 'smoke-test-failed'
}> => {
  const p = pathFor(deps.platform)

  // Check for adapter first
  const dirs = await collectCandidateDirs(deps)
  const adapterNames =
    deps.platform === 'win32'
      ? ['codex-acp.cmd', 'codex-acp.exe', 'codex-acp.bat', 'codex-acp']
      : ['codex-acp']
  const adapterCandidates = dirs.flatMap((dir) => adapterNames.map((name) => p.join(dir, name)))

  if (deps.managedAdapterPath) adapterCandidates.push(deps.managedAdapterPath)

  let adapterFound = false
  let adapterPath: string | undefined
  let adapterVersion: string | undefined
  let adapterFailureReason: 'version-probe-failed' | 'smoke-test-failed' | undefined

  for (const candidate of Array.from(new Set(adapterCandidates))) {
    if (!(await deps.isRunnable(candidate))) continue

    const versionOutput = await deps.getAdapterVersion(candidate)
    const version = versionOutput ? parseVersion(versionOutput) : undefined

    if (!version) {
      // Adapter exists but version probe failed - record this for diagnostics. Mark as found
      // so service.ts can distinguish "present but broken" from "completely missing".
      if (!adapterPath) {
        adapterFound = true
        adapterPath = candidate
        adapterFailureReason = 'version-probe-failed'
      }
      continue
    }

    // Version probe succeeded - now check if smoke test passes
    const smokeOk = await deps.smokeInitialize(candidate)
    if (smokeOk) {
      adapterFound = true
      adapterPath = candidate
      adapterVersion = version
      adapterFailureReason = undefined
      break
    } else {
      // Smoke test failed - adapter exists but can't initialize. Mark as found with failure.
      if (!adapterPath) {
        adapterFound = true
        adapterPath = candidate
        adapterVersion = version
        adapterFailureReason = 'smoke-test-failed'
      }
    }
  }

  // Check for native Codex independently
  const nativeCodex = await detectNativeCodex(deps)

  return {
    nativeCliFound: !!nativeCodex,
    nativeCliPath: nativeCodex?.path,
    nativeCliVersion: nativeCodex?.version,
    adapterFound,
    adapterPath,
    adapterVersion,
    adapterFailureReason
  }
}

// Launches the adapter and drives one ACP initialize round-trip, returning true only on a valid
// response. Mirrors the managed pair verifier but tolerates any launch shape (a `.js` entry run under
// the bundled Node, or a native/`.cmd` wrapper on PATH) and resolves as soon as initialize succeeds.
const runAcpInitializeSmoke =
  (platform: NodeJS.Platform) =>
  async (adapterPath: string, opts: { codexPath?: string } = {}): Promise<boolean> => {
    let codexHome: string
    try {
      codexHome = await mkdtemp(path.join(tmpdir(), 'os-codex-smoke-'))
    } catch {
      return false
    }

    const isJavaScript = adapterPath.toLowerCase().endsWith('.js')
    const useShell = platform === 'win32' && /\.(cmd|bat)$/i.test(adapterPath)
    const command = isJavaScript ? process.execPath : useShell ? `"${adapterPath}"` : adapterPath
    const args = isJavaScript ? [adapterPath] : []
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'open-science', version: '0.0.0' }
      }
    })

    try {
      return await new Promise<boolean>((resolve) => {
        let settled = false
        let buffer = ''
        const child = spawn(command, args, {
          windowsHide: true,
          shell: useShell,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            ...stripCodexCredentialEnv(augmentedPathEnv(process.env)),
            ...(isJavaScript ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
            NO_BROWSER: '1',
            CODEX_HOME: codexHome,
            ...(opts.codexPath ? { CODEX_PATH: opts.codexPath } : {})
          }
        })

        const finish = (ok: boolean): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          child.stdin.destroy()
          // Reap the adapter AND its Codex grandchild while the parent is still alive (on success this
          // runs the moment initialize answers), awaiting the robust tree teardown before resolving. A
          // degraded reap (taskkill fallback / surviving descendant) is logged so a leaked grandchild is
          // not silently swallowed by the smoke check.
          void terminateProcessTree(child, undefined, log)
            .then((result) => {
              if (!result.reaped) {
                log.warn(
                  'ACP initialize check could not confirm the Codex process tree was fully reaped'
                )
              }
            })
            .finally(() => resolve(ok))
        }
        const timer = setTimeout(() => finish(false), ACP_SMOKE_TIMEOUT_MS)

        const consume = (line: string): void => {
          const trimmed = line.trim()
          if (!trimmed) return
          try {
            const message = JSON.parse(trimmed) as {
              id?: unknown
              result?: { protocolVersion?: unknown }
            }
            // codex-acp stops its Codex child when stdin closes, so end it once initialize answers.
            if (message.id === 1) finish(message.result?.protocolVersion === 1)
          } catch {
            // Non-JSON stdout (banners, logs) is not a valid ACP response.
          }
        }

        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk
          for (;;) {
            const newline = buffer.indexOf('\n')
            if (newline < 0) break
            consume(buffer.slice(0, newline))
            buffer = buffer.slice(newline + 1)
          }
        })
        child.once('error', () => finish(false))
        child.once('exit', () => {
          if (buffer.trim()) consume(buffer)
          finish(false)
        })
        child.stdin.write(`${initialize}\n`, (error) => {
          if (error) finish(false)
        })
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true }).catch(() => {})
    }
  }

const isRunnableFile =
  (platform: NodeJS.Platform) =>
  async (candidate: string): Promise<boolean> => {
    try {
      await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  }

const runVersion =
  (platform: NodeJS.Platform, adapter: boolean) =>
  async (candidate: string): Promise<string | undefined> => {
    try {
      const isJavaScript = adapter && candidate.toLowerCase().endsWith('.js')
      const executable = isJavaScript ? process.execPath : candidate
      const args = isJavaScript ? [candidate, '--version'] : ['--version']
      const useShell = platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)
      const { stdout } = await execFileAsync(useShell ? `"${executable}"` : executable, args, {
        timeout: 10_000,
        shell: useShell,
        windowsHide: true,
        env: {
          ...augmentedPathEnv(process.env),
          ...(isJavaScript ? { ELECTRON_RUN_AS_NODE: '1', NO_BROWSER: '1' } : {})
        }
      })

      return parseVersion(stdout)
    } catch {
      return undefined
    }
  }

const resolveNpmBinDirs = (platform: NodeJS.Platform) => async (): Promise<string[]> => {
  try {
    const useShell = platform === 'win32'
    const { stdout } = await execFileAsync('npm', ['prefix', '-g'], {
      timeout: 10_000,
      shell: useShell,
      windowsHide: true,
      env: augmentedPathEnv()
    })
    const prefix = stdout.trim()
    if (!prefix) return []

    return platform === 'win32' ? [prefix] : [pathFor(platform).join(prefix, 'bin')]
  } catch {
    return []
  }
}

const createDefaultDetectDeps = (): CodexDetectDeps => {
  const platform = process.platform

  return {
    env: process.env,
    homePath: homedir(),
    platform,
    isRunnable: isRunnableFile(platform),
    getAdapterVersion: runVersion(platform, true),
    getCodexVersion: runVersion(platform, false),
    smokeInitialize: runAcpInitializeSmoke(platform),
    resolveNpmBinDirs: resolveNpmBinDirs(platform)
  }
}

// Checks for a native Codex CLI when the adapter is missing. Used to provide accurate diagnostic
// messages distinguishing "adapter missing" from "Codex not installed at all".
//
// Searches the SAME directory set that collectCandidateDirs + the ACP smoke test use (raw PATH plus
// the augmented well-known dirs: ~/.local/bin, Homebrew, /usr/local, npm global bin). Without this,
// an adapter could pass its handshake by resolving codex through the augmented PATH while this probe,
// scanning only the narrower raw PATH, reported the native CLI as missing and blocked Continue.
const detectNativeCodex = async (
  deps: Pick<
    CodexDetectDeps,
    'platform' | 'env' | 'homePath' | 'getCodexVersion' | 'resolveNpmBinDirs' | 'extraDirs'
  > = createDefaultDetectDeps()
): Promise<{ path: string; version: string } | undefined> => {
  const p = pathFor(deps.platform)
  const wellKnown: string[] = []

  // Check common native Codex installation paths
  if (deps.platform === 'darwin') {
    wellKnown.push('/Applications/ChatGPT.app/Contents/Resources/codex')
  } else if (deps.platform === 'win32') {
    const localAppData = deps.env.LOCALAPPDATA
    if (localAppData) {
      wellKnown.push(p.join(localAppData, 'Programs', 'ChatGPT', 'codex.exe'))
    }
  }

  // Search raw PATH plus the augmented dirs, mirroring collectCandidateDirs so this probe agrees
  // with the adapter's own codex resolution during the smoke test.
  const pathDirs = (deps.env.PATH ?? '').split(p.delimiter).filter(Boolean)
  const npmDirs = deps.resolveNpmBinDirs ? await deps.resolveNpmBinDirs().catch(() => []) : []
  const augmentedDirs =
    deps.platform === 'win32'
      ? deps.env.APPDATA
        ? [p.join(deps.env.APPDATA, 'npm')]
        : []
      : ['/opt/homebrew/bin', '/usr/local/bin']

  const searchDirs = Array.from(
    new Set([
      ...pathDirs,
      p.join(deps.homePath ?? '', '.local', 'bin'),
      ...(deps.extraDirs ?? []),
      ...augmentedDirs,
      ...npmDirs
    ])
  ).filter(Boolean)

  const names = deps.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']
  const pathCandidates = searchDirs.flatMap((dir) => names.map((name) => p.join(dir, name)))

  const candidates = Array.from(new Set([...wellKnown, ...pathCandidates]))

  for (const codexPath of candidates) {
    const versionOutput = await deps.getCodexVersion(codexPath)
    const version = versionOutput ? parseVersion(versionOutput) : undefined
    if (version) {
      return { path: codexPath, version }
    }
  }

  return undefined
}

export {
  collectCandidateDirs,
  createDefaultDetectDeps,
  detectCodex,
  detectCodexComponents,
  detectNativeCodex,
  parseVersion,
  runAcpInitializeSmoke
}
