import { basename, dirname } from 'node:path'
import { createWindowsExecutableVerifier } from '../windows-executable-trust'

import {
  DEFAULT_MAX_CACHE_RELATIVE_PATH,
  DefaultRuntimeProvisioner,
  buildManagedRuntimeProcessEnvironment,
  caBundleEnv,
  captureMicromamba,
  chainFetchBundle,
  createLocalBundleAdapter,
  micromambaSpawnEnv,
  packageCacheCleanArgv,
  prepareNotebookWorkloadCache,
  retainMicromambaWorkingCache,
  selectMicromambaCache,
  type MicromambaRunner,
  type ProvisionerDeps
} from '@aipoch/environment'
import type { RuntimeBundleSource } from '@aipoch/environment/contracts'

import type { EnvironmentRequestContext } from '../../shared/notebook-env'
import type { NotebookLanguage } from '../../shared/notebook-language-contract'
import { createFetchBundleAdapter } from './environment-download'
import { defaultSpawn, runMicromamba, verifyExecutable } from './environment-process'
import { resolveBundleDir, resolveRuntimeCdnBase } from './environment-resources'
import { createProductionMicromambaRunner, type MicromambaRunnerDeps } from './environment-runner'
import { sandboxedPackageSpawn } from './package-process-sandbox'
import type { NotebookProcessSandbox } from './process-sandbox'

// Options for the production provisioner: `root` is `<storageRoot>/runtime` — already resolved for
// dev vs prod by the caller (contract: never re-derived here from process.env/app internals) — the
// conda `channel`, optional CDN override, and micromamba resolution overrides. The official CDN base
// is resolved centrally when no override is supplied.
export type ProductionProvisionerOptions = {
  root: string
  channel: string | (() => Promise<string>)
  processSandbox?: NotebookProcessSandbox
  micromamba?: MicromambaRunnerDeps
  // PEM CA bundle path (enterprise TLS proxy) exported into micromamba's env so an ONLINE provision /
  // named-env create verifies HTTPS against it. Offline bundle creates need no network, so this only
  // matters on the online paths.
  caBundle?: string
  cdnBase?: string
  // Forwarded to ProvisionerDeps.isPrefixBlocked: lets the notebook service veto a prefix write the
  // startup gate/UI would otherwise perform over a possibly-live orphan (see runtime-service).
  isPrefixBlocked?: (prefix: string) => boolean
  // Forwarded to ProvisionerDeps.clearPrefixBlock: an explicit user Reset clears the service's block.
  clearPrefixBlock?: (prefix: string) => void
  // Forwarded to ProvisionerDeps.clearRuntimeBlock: Reset also clears an interrupted install's runtime-ID
  // block so bound sessions aren't rejected after the env rebuilds.
  clearRuntimeBlock?: (runtimeId: string) => void
  // Forwarded to ProvisionerDeps.clearCorruptBlock: a force Reset releases just the reset prefix from the
  // global corrupt-journal barrier after moving the corrupt journal aside (other envs stay blocked).
  clearCorruptBlock?: (prefix: string) => void
  // Forwarded to ProvisionerDeps.blockPrefix: on an unconfirmed-child prefix-write failure, block the
  // prefix in-process so an in-session retry can't race the possibly-live orphan.
  blockPrefix?: (prefix: string) => void
  // Forwarded to ProvisionerDeps.isPrefixLiveUnconfirmed: lets a force Reset refuse a prefix left
  // live-unconfirmed by an interrupted install (or prefix write) this session.
  isPrefixLiveUnconfirmed?: (prefix: string) => boolean
  // Forwarded to ProvisionerDeps.withPrefixLock: shares the service's per-env install lock so a default
  // env create/repair/upgrade never runs concurrently with an install into the same env prefix.
  withPrefixLock?: <T>(envName: string, fn: () => Promise<T>) => Promise<T>
}

export type ProductionProvisionerDeps = {
  runner?: MicromambaRunner
  fetchBundle?: ProvisionerDeps<EnvironmentRequestContext>['fetchBundle']
  runArgv?: ProvisionerDeps<EnvironmentRequestContext>['runArgv']
  maintainCache?: ProvisionerDeps<EnvironmentRequestContext>['maintainCache']
  // Narrow subprocess seam for the default maintenance adapter's argv/environment contract test.
  runCacheMaintenance?: typeof runMicromamba
  // Narrow subprocess seam for the default provisioning adapter's argv/environment contract test.
  runMicromamba?: typeof runMicromamba
  verify?: ProvisionerDeps<EnvironmentRequestContext>['verify']
  retainWorkingCache?: ProvisionerDeps<EnvironmentRequestContext>['retainWorkingCache']
  captureExplicitLock?: ProvisionerDeps<EnvironmentRequestContext>['captureExplicitLock']
}

// Wires the real micromamba binary, CDN fetch, subprocess runner and interpreter verification into a
// DefaultRuntimeProvisioner. Not unit-tested for real I/O (network/subprocess-bound); the orchestration
// it drives is already covered via injected deps in provisioner.test.ts / provisioner.upgrade.test.ts.
export const createProductionProvisioner = (
  opts: ProductionProvisionerOptions,
  deps: ProductionProvisionerDeps = {}
): DefaultRuntimeProvisioner<EnvironmentRequestContext> => {
  // Pass the caller's resolved runtime root without guessing its storage directory name. Retain
  // explicit host home overrides for existing embeddings; the package never derives product paths.
  const derivedHome = dirname(dirname(opts.root))
  const runner =
    deps.runner ??
    createProductionMicromambaRunner({
      verifySignature: createWindowsExecutableVerifier(),
      runtimeRoot: opts.micromamba?.home ? undefined : opts.root,
      home: derivedHome,
      ...opts.micromamba
    })
  if (!runner) {
    throw new Error(
      'micromamba binary not found (set OPEN_SCIENCE_MICROMAMBA_BIN or ship it as a resource)'
    )
  }
  // A packaged/dropped-in local bundle takes precedence. Shipped apps then fetch exactly one verified
  // language pack from the official CDN (or OPEN_SCIENCE_ENV_CDN_BASE) and always create from its lock.
  const bundleDir = resolveBundleDir({ resourcesPath: opts.micromamba?.resourcesPath })
  const cdnBase = resolveRuntimeCdnBase(opts.cdnBase)
  const bundleSource: RuntimeBundleSource = {
    kind:
      opts.cdnBase !== undefined || process.env.OPEN_SCIENCE_ENV_CDN_BASE !== undefined
        ? 'override'
        : 'official',
    baseUrl: cdnBase
  }
  // CA-bundle vars injected into every provisioning subprocess (no-op when unset), so an online
  // create/verify behind an enterprise TLS proxy trusts the custom CA.
  const caEnv = caBundleEnv(opts.caBundle)
  const fetchBundle =
    deps.fetchBundle ??
    chainFetchBundle([
      createLocalBundleAdapter(opts.root, bundleDir),
      createFetchBundleAdapter(opts.root, cdnBase)
    ])
  return new DefaultRuntimeProvisioner<EnvironmentRequestContext>({
    root: opts.root,
    mm: runner.initialPath,
    channel: opts.channel,
    bundleSource,
    fetchBundle: async (...args) => {
      await runner.resolve()
      return fetchBundle(...args)
    },
    runArgv: async (
      argv,
      signal,
      onChild,
      onBeforeSpawn,
      runCache,
      maxCacheRelativePath,
      sandboxRequest
    ) => {
      const selected = await runner.resolve()
      const selectedArgv = [selected, ...argv.slice(1)]
      if (deps.runArgv) {
        return deps.runArgv(
          selectedArgv,
          signal,
          onChild,
          onBeforeSpawn,
          runCache,
          maxCacheRelativePath
        )
      }
      const workloadCacheEnv = prepareNotebookWorkloadCache(opts.root)
      const env = {
        ...micromambaSpawnEnv(
          opts.root,
          opts.caBundle,
          {
            selectCache: () =>
              runCache ??
              selectMicromambaCache(
                opts.root,
                maxCacheRelativePath ?? DEFAULT_MAX_CACHE_RELATIVE_PATH
              )
          },
          maxCacheRelativePath ?? DEFAULT_MAX_CACHE_RELATIVE_PATH
        ),
        ...workloadCacheEnv
      }
      if (opts.processSandbox && sandboxRequest) {
        const result = await sandboxedPackageSpawn({
          processSandbox: opts.processSandbox,
          request: {
            ...sandboxRequest,
            ...sandboxRequest.context,
            workspaceCwd: sandboxRequest.cwd
          },
          runtimeRoot: opts.root,
          storageRoot: dirname(opts.root)
        })(
          selectedArgv[0]!,
          selectedArgv.slice(1),
          env,
          onChild,
          onBeforeSpawn,
          undefined,
          undefined,
          { signal }
        )
        if (result.code !== 0) throw new Error(result.stderr || 'micromamba exited unsuccessfully')
        return
      }
      return (deps.runMicromamba ?? runMicromamba)(
        selectedArgv,
        env,
        signal,
        onChild,
        onBeforeSpawn
      )
    },
    nativeSpawn: (request, interpreter) =>
      opts.processSandbox
        ? sandboxedPackageSpawn({
            processSandbox: opts.processSandbox,
            request: { ...request, ...request.context, workspaceCwd: request.cwd },
            runtimeRoot: opts.root,
            storageRoot: dirname(opts.root),
            interpreter
          })
        : defaultSpawn,
    maintainCache:
      deps.maintainCache ??
      (async (runCache, onBeforeSpawn, onChild, signal) => {
        const selected = await runner.resolve()
        const workloadCacheEnv = prepareNotebookWorkloadCache(opts.root)
        await (deps.runCacheMaintenance ?? runMicromamba)(
          packageCacheCleanArgv(selected),
          {
            ...micromambaSpawnEnv(opts.root, opts.caBundle, {
              selectCache: () => runCache
            }),
            ...workloadCacheEnv,
            MAMBA_ROOT_PREFIX: opts.root,
            CONDA_PKGS_DIRS: runCache.path
          },
          signal,
          onChild,
          onBeforeSpawn
        )
      }),
    retainWorkingCache:
      deps.retainWorkingCache ??
      (deps.runArgv || process.platform !== 'win32'
        ? undefined
        : (root, operationId) => retainMicromambaWorkingCache(root, {}, operationId)),
    captureExplicitLock:
      deps.captureExplicitLock ??
      (deps.runArgv
        ? undefined
        : async (prefix) => {
            const selected = await runner.resolve()
            return captureMicromamba(
              [selected, '--no-rc', 'list', '--prefix', prefix, '--explicit', '--md5'],
              micromambaSpawnEnv(opts.root, opts.caBundle)
            )
          }),
    verify:
      deps.verify ??
      ((bin, prefix) => {
        const language: NotebookLanguage = ['r', 'r.exe'].includes(basename(bin).toLowerCase())
          ? 'r'
          : 'python'
        return verifyExecutable(bin, {
          prefix,
          env: buildManagedRuntimeProcessEnvironment(opts.root, {
            language,
            prefix,
            platform: opts.micromamba?.platform,
            sourceEnv: { ...process.env, ...caEnv }
          }),
          platform: opts.micromamba?.platform,
          completeEnv: true
        })
      }),
    isPrefixBlocked: opts.isPrefixBlocked,
    clearPrefixBlock: opts.clearPrefixBlock,
    clearRuntimeBlock: opts.clearRuntimeBlock,
    clearCorruptBlock: opts.clearCorruptBlock,
    blockPrefix: opts.blockPrefix,
    isPrefixLiveUnconfirmed: opts.isPrefixLiveUnconfirmed,
    withPrefixLock: opts.withPrefixLock
  })
}
