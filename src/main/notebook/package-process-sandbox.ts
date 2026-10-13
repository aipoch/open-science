import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32
} from 'node:path'

import type { PackageMirror } from '../../shared/mirror'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import { validateCustomAllowedDomain } from '../../shared/notebook-network'
import { defaultSpawn } from './environment-process'
import { packageProcessTreeTerminated, type InstallSpawn } from '@aipoch/environment'
import type { InstallRequest } from '../../shared/notebook-env'
import { assertProcessTreeSupport, terminateProcessTree } from '../process-tree'
import {
  buildManagedRuntimeProcessEnvironment,
  buildNotebookKernelEnvironment,
  condaActivatedPath,
  EnvironmentSnapshotInUseError,
  type EnvironmentSnapshotProcessObserver,
  PIP_TRANSPORT_ENV_KEYS
} from '@aipoch/environment'
import type { NotebookProcessSandbox, NotebookSandboxCleanupResult } from './process-sandbox'
import { kernelExecutableReadRoot } from './kernel-executable-read-root'

type PackageProcessSandboxOptions = Readonly<{
  processSandbox: NotebookProcessSandbox
  request: InstallRequest
  runtimeRoot: string
  storageRoot: string
  mirror?: PackageMirror
  interpreter?: Readonly<{ command: string; condaPrefix?: string; library?: string }>
  platform?: NodeJS.Platform
  terminateTree?: typeof terminateProcessTree
  getGrantedLocalRoots?: () => Promise<readonly GrantedLocalRoot[]>
}>

/** Verify a captured interpreter with a private home and no package-install or network grants. */
export const verifySnapshotRuntime = async (
  processSandbox: NotebookProcessSandbox,
  prefix: string,
  argv: string[],
  signal?: AbortSignal,
  observer?: EnvironmentSnapshotProcessObserver
): Promise<string> => {
  const root = join(dirname(prefix), 'verification')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const env = buildManagedRuntimeProcessEnvironment(root, { language: 'python', prefix })
  env.PATH = condaActivatedPath(prefix, env.PATH)
  env.TMPDIR = env.TEMP = env.TMP = root
  const [command, ...args] = argv
  if (!command) throw new Error('Snapshot interpreter command is missing.')
  let retryTermination: (() => Promise<boolean>) | undefined
  let wrapped: Awaited<ReturnType<NotebookProcessSandbox['wrap']>> | undefined
  let processesTerminated = false
  let spawnAttempted = false
  const cleanupComplete = (result: NotebookSandboxCleanupResult): boolean =>
    result.processesTerminated && result.networkClosed && result.temporaryResourcesRemoved
  const retryVerificationCleanup = async (): Promise<boolean> => {
    if (!wrapped) return false
    const reaped = wrapped.requestProcessTreeTermination
      ? await wrapped.requestProcessTreeTermination()
      : wrapped.confirmProcessTreeTermination
        ? await wrapped.confirmProcessTreeTermination()
        : processesTerminated || (await retryTermination?.())
    if (!reaped) return false
    const result = await wrapped.cleanup('exit', {
      processesTerminated: true,
      ...(!spawnAttempted ? { processState: 'never-started' as const } : {}),
      ...(wrapped.confirmProcessTreeTermination
        ? { confirmTermination: wrapped.confirmProcessTreeTermination }
        : {})
    })
    return cleanupComplete(result)
  }
  const spawn = sandboxedPackageSpawn({
    processSandbox: {
      wrap: async (invocation) => {
        wrapped = await processSandbox.wrap({
          ...invocation,
          restrictToDeclaredRoots: true,
          filesystem: {
            readOnlyRoots: [prefix],
            readWriteRoots: [root],
            deniedReadRoots: [],
            deniedWriteRoots: [prefix]
          }
        })
        const prepared = wrapped
        return {
          ...prepared,
          cleanup: async (reason, outcome) => {
            if (!spawnAttempted)
              outcome = { ...outcome, processesTerminated: true, processState: 'never-started' }
            processesTerminated = outcome.processesTerminated
            const result = await prepared.cleanup(reason, outcome).catch((error: unknown) => {
              throw new EnvironmentSnapshotInUseError(error, retryVerificationCleanup)
            })
            if (!cleanupComplete(result))
              throw new EnvironmentSnapshotInUseError(undefined, retryVerificationCleanup)
            return result
          }
        }
      }
    },
    request: { language: 'python', packages: [], workspaceCwd: root },
    runtimeRoot: root,
    storageRoot: root,
    interpreter: { command, condaPrefix: prefix },
    terminateTree: async (child) => {
      retryTermination = async () => (await terminateProcessTree(child)).reaped
      return terminateProcessTree(child)
    }
  })
  let started = false
  const result = await spawn(
    command,
    args,
    env,
    (pid) => {
      started = true
      observer?.childStarted(pid)
    },
    () => {
      spawnAttempted = true
      observer?.beforeSpawn()
    },
    false,
    root,
    {
      signal,
      timeoutMs: 30_000
    }
  ).catch((error) => {
    if (error instanceof EnvironmentSnapshotInUseError) throw error
    if (started && !packageProcessTreeTerminated(error))
      throw new EnvironmentSnapshotInUseError(error, retryVerificationCleanup)
    throw error
  })
  if (result.processesTerminated === false)
    throw new EnvironmentSnapshotInUseError(undefined, retryVerificationCleanup)
  if (result.code !== 0 || result.stdoutDroppedBytes)
    throw new Error('Environment snapshot verification failed.')
  return result.stdout
}

const packageMirrorHosts = (mirror: PackageMirror | undefined): string[] => {
  const hosts = [mirror?.condaChannel, mirror?.pypiIndex, mirror?.cranMirror].flatMap((value) => {
    const hasAsciiWhitespaceOrControl = [...(value ?? '')].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x20 || codePoint === 0x7f
    })
    if (!value || hasAsciiWhitespaceOrControl) return []
    try {
      const url = new URL(value)
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
        return []
      }
      const normalized = validateCustomAllowedDomain(url.hostname)
      return normalized.ok ? [normalized.hostname] : []
    } catch {
      return []
    }
  })
  return [...new Set(hosts)]
}

const PACKAGE_ENV_KEYS = [
  'CONDA_PKGS_DIRS',
  'CONDA_ENVS_PATH',
  'MAMBA_ROOT_PREFIX',
  'HOME',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'R_USER',
  'R_LIBS_USER',
  'PYTHONNOUSERSITE',
  'CONDA_SSL_VERIFY',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  ...PIP_TRANSPORT_ENV_KEYS,
  'CURL_CA_BUNDLE',
  'CONDA_PREFIX',
  'VIRTUAL_ENV',
  'POETRY_VIRTUALENVS_CREATE',
  'UV_PROJECT_ENVIRONMENT',
  'UV_PYTHON_DOWNLOADS',
  'OPEN_SCIENCE_NOTEBOOK_CACHE_DIR',
  'UV_CACHE_DIR',
  'HF_HUB_CACHE',
  'HF_DATASETS_CACHE',
  'HF_XET_CACHE',
  'HF_ASSETS_CACHE',
  'TORCH_HOME',
  'TORCHINDUCTOR_CACHE_DIR',
  'TORCH_EXTENSIONS_DIR',
  'PYTORCH_KERNEL_CACHE_PATH',
  'TRITON_CACHE_DIR',
  'NUMBA_CACHE_DIR',
  'MPLCONFIGDIR',
  'R_USER_CACHE_DIR'
] as const

const PACKAGE_WRITE_PATH_KEYS = [
  'CONDA_PKGS_DIRS',
  'MAMBA_ROOT_PREFIX',
  'OPEN_SCIENCE_NOTEBOOK_CACHE_DIR'
] as const

const packageEnvironment = (
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv => {
  const env = buildNotebookKernelEnvironment(platform, source)
  const packageSource =
    platform === 'win32'
      ? Object.fromEntries(Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]))
      : source
  for (const key of PACKAGE_ENV_KEYS) {
    if (packageSource[key] !== undefined) env[key] = packageSource[key]
  }
  // Only forward the owner's explicit request to disable user pip configuration.
  const nullDevice = platform === 'win32' ? 'nul' : '/dev/null'
  if (packageSource.PIP_CONFIG_FILE === nullDevice) env.PIP_CONFIG_FILE = nullDevice
  if (pipReportRoot(packageSource.PIP_REPORT, platform)) env.PIP_REPORT = packageSource.PIP_REPORT
  return env
}

const externalEnvironmentRoot = (
  interpreter: PackageProcessSandboxOptions['interpreter'],
  language: InstallRequest['language'],
  platform: NodeJS.Platform
): string | undefined => {
  if (!interpreter) return undefined
  const absolute = platform === 'win32' ? win32.isAbsolute : isAbsolute
  if (interpreter.condaPrefix && absolute(interpreter.condaPrefix)) return interpreter.condaPrefix
  if (!absolute(interpreter.command)) return undefined
  if (language === 'r' && platform === 'win32')
    return kernelExecutableReadRoot(interpreter.command, 'r', platform)
  return dirname(dirname(interpreter.command))
}

const absolutePath = (value: string | undefined, platform = process.platform): string[] =>
  value && (platform === 'win32' ? win32.isAbsolute(value) : isAbsolute(value)) ? [value] : []

const inside = (root: string, candidate: string, platform: NodeJS.Platform): boolean => {
  const path = platform === 'win32' ? win32 : { resolve, sep }
  const normalizedRoot = path.resolve(root)
  const normalizedCandidate = path.resolve(candidate)
  const compare = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  return (
    compare(normalizedCandidate) === compare(normalizedRoot) ||
    compare(normalizedCandidate).startsWith(`${compare(normalizedRoot)}${path.sep}`)
  )
}

const packageWriteRoots = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] => {
  const separator = platform === 'win32' ? win32.delimiter : delimiter
  const cacheRoots = PACKAGE_WRITE_PATH_KEYS.flatMap((key) =>
    (env[key] ?? '')
      .split(separator)
      .map((path) => path.trim())
      .filter((path) => (platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)))
      .filter(existsSync)
  )
  // pip writes its installation report outside the environment into an owner-created
  // private temporary directory. Authorize that directory, not the whole OS temp root.
  const reportRoot = pipReportRoot(env.PIP_REPORT, platform)
  return [...cacheRoots, ...(reportRoot ? [reportRoot] : [])]
}

const pipReportRoot = (
  report: string | undefined,
  platform: NodeJS.Platform
): string | undefined => {
  const path = platform === 'win32' ? win32 : { isAbsolute, dirname, basename, resolve }
  if (!report || !path.isAbsolute(report) || path.basename(report) !== 'report.json')
    return undefined
  const root = path.dirname(report)
  const parent = path.resolve(path.dirname(root))
  const temporaryRoot = path.resolve(tmpdir())
  if (
    (platform === 'win32'
      ? parent.toLowerCase() !== temporaryRoot.toLowerCase()
      : parent !== temporaryRoot) ||
    !/^open-science-pip-report-[A-Za-z0-9_-]+$/u.test(path.basename(root))
  )
    return undefined
  try {
    const stat = lstatSync(root)
    return stat.isDirectory() && !stat.isSymbolicLink() ? root : undefined
  } catch {
    return undefined
  }
}

const normalizeDarwinRepodataCachePermissions = (
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
  platform: NodeJS.Platform
): void => {
  if (platform !== 'darwin') return
  const managedRoot = resolve(runtimeRoot)
  for (const packageRoot of (env.CONDA_PKGS_DIRS ?? '').split(delimiter)) {
    if (!isAbsolute(packageRoot)) continue
    const fromManagedRoot = relative(managedRoot, resolve(packageRoot))
    if (fromManagedRoot.startsWith('..') || isAbsolute(fromManagedRoot)) continue
    // The configured storage path may itself contain a symlink. Resolve that trusted
    // anchor once; links beneath it must never redirect this unsandboxed preparation.
    mkdirSync(managedRoot, { recursive: true })
    const physicalRoot = join(realpathSync(managedRoot), fromManagedRoot)
    const cache = join(physicalRoot, 'cache')
    // Node has no mkdirat: validate each parent before creation and recheck the
    // resulting physical path. Permission changes below are descriptor-bound.
    const ensureDirectory = (path: string): void => {
      try {
        const state = lstatSync(path)
        if (!state.isDirectory() || state.isSymbolicLink() || realpathSync(path) !== path) {
          throw new Error(`Managed Micromamba repodata cache is not a trusted directory: ${path}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        ensureDirectory(dirname(path))
        mkdirSync(path, { mode: 0o755 })
        ensureDirectory(path)
      }
    }
    ensureDirectory(cache)
    const fd = openSync(cache, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const state = fstatSync(fd)
      const current = lstatSync(cache)
      if (
        !state.isDirectory() ||
        state.dev !== current.dev ||
        state.ino !== current.ino ||
        realpathSync(cache) !== cache
      ) {
        throw new Error(`Managed Micromamba repodata cache is not a trusted directory: ${cache}`)
      }
      // Micromamba can leave cache/ setgid. Seatbelt denies clearing that bit even
      // with file-write-mode, so repair it before entering the production sandbox.
      // Operate on the validated descriptor, never on a path that can be replaced.
      if ((state.mode & 0o2000) !== 0) fchmodSync(fd, state.mode & 0o5777)
      const after = lstatSync(cache)
      if (after.dev !== state.dev || after.ino !== state.ino || realpathSync(cache) !== cache) {
        throw new Error(`Managed Micromamba repodata cache changed during preparation: ${cache}`)
      }
    } finally {
      closeSync(fd)
    }
  }
}

/** Routes manage_packages workers through the same network/filesystem boundary as Notebook code. */
export const sandboxedPackageSpawn =
  (options: PackageProcessSandboxOptions): InstallSpawn =>
  async (
    command,
    args,
    env,
    onChild,
    onBeforeSpawn,
    captureCondaJson,
    requestedCwd,
    spawnOptions
  ) => {
    spawnOptions?.signal?.throwIfAborted()
    const { processSandbox, request, runtimeRoot } = options
    const platform = options.platform ?? process.platform
    assertProcessTreeSupport(platform)
    const grantedRoots = options.getGrantedLocalRoots ? await options.getGrantedLocalRoots() : []
    const projectedEnv = packageEnvironment(env ?? {}, platform)
    const externalR = request.language === 'r' && Boolean(options.interpreter?.library)
    // External R consent covers one library and the workload cache, never managed environments
    // or inherited Conda/Mamba roots. Keep the default cwd readable without granting writes.
    const cacheWriteRoots = externalR
      ? absolutePath(projectedEnv.OPEN_SCIENCE_NOTEBOOK_CACHE_DIR, platform).filter(existsSync)
      : packageWriteRoots(projectedEnv, platform)
    normalizeDarwinRepodataCachePermissions(projectedEnv, runtimeRoot, platform)
    const workspaceCwd =
      request.workspaceCwd && isAbsolute(request.workspaceCwd) ? request.workspaceCwd : runtimeRoot
    const cwd =
      requestedCwd && isAbsolute(requestedCwd) && inside(workspaceCwd, requestedCwd, platform)
        ? requestedCwd
        : workspaceCwd
    const sandboxed = await processSandbox.wrap({
      executable: command,
      args,
      env: projectedEnv,
      cwd,
      commandText: JSON.stringify([command, ...args]),
      sessionId: request.sessionId ?? 'notebook-package-manager',
      projectId: request.projectId ?? 'notebook-package-manager',
      runtime: request.language,
      allowedNetworkHosts: packageMirrorHosts(options.mirror),
      signal: spawnOptions?.signal,
      superviseProcessTree: platform === 'win32',
      filesystem: {
        readOnlyRoots: [
          ...grantedRoots.map((root) => root.path),
          ...(externalR ? [runtimeRoot] : []),
          ...absolutePath(dirname(command)),
          ...absolutePath(request.workspaceCwd),
          ...(options.interpreter?.library
            ? absolutePath(
                externalEnvironmentRoot(options.interpreter, request.language, platform),
                platform
              )
            : [])
        ],
        readWriteRoots: [
          ...grantedRoots.filter((root) => root.access === 'rw').map((root) => root.path),
          ...(externalR ? [] : [runtimeRoot]),
          ...absolutePath(
            options.interpreter?.library ??
              externalEnvironmentRoot(options.interpreter, request.language, platform),
            platform
          ),
          ...cacheWriteRoots
        ],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })
    let endExecution: (() => void) | undefined
    let ended = false
    let processesTerminated = false
    try {
      spawnOptions?.signal?.throwIfAborted()
      endExecution = sandboxed.beginExecution?.()
      const result = await defaultSpawn(
        sandboxed.executable,
        [...sandboxed.args],
        sandboxed.env,
        onChild,
        onBeforeSpawn,
        captureCondaJson ?? args.includes('--json'),
        cwd,
        spawnOptions,
        options.terminateTree,
        platform,
        sandboxed.confirmProcessTreeTermination
      )
      endExecution?.()
      ended = true
      processesTerminated = result.processesTerminated ?? true
      return { ...result, stderr: sandboxed.annotateStderr(result.stderr) }
    } catch (error) {
      if (packageProcessTreeTerminated(error)) {
        processesTerminated = true
        if (sandboxed.confirmProcessTreeTermination) {
          await sandboxed.confirmProcessTreeTermination().catch(() => false)
        }
      } else if (!ended && sandboxed.confirmProcessTreeTermination) {
        processesTerminated = await sandboxed.confirmProcessTreeTermination().catch(() => false)
      }
      throw error
    } finally {
      if (!ended) endExecution?.()
      await sandboxed.cleanup(ended ? 'exit' : 'spawn-failed', {
        processesTerminated,
        ...(sandboxed.confirmProcessTreeTermination
          ? { confirmTermination: sandboxed.confirmProcessTreeTermination }
          : {})
      })
    }
  }
