export {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  addRepairRequired,
  assertSafeEnvName,
  clearRepairRequired,
  condaActivatedPath,
  envDirectoryName,
  envPrefix,
  isProtectedIdentityRepairRequired,
  isRepairRequired,
  legacyDefaultEnvPrefix,
  logicalEnvNameFromDirectory,
  managedRepairRegistryKey,
  normalizeRuntimeArchitecture,
  pkgsCache,
  pythonBin,
  pythonReady,
  rBin,
  rLibraryDir,
  rReady,
  rScriptBin,
  readReadyMarker,
  readRepairRequiredReason,
  repairRegistryPath,
  resolveEnvName,
  runtimeRoot,
  windowsDefaultEnvPrefixReserve,
  writeRReadyMarker,
  writeReadyMarker
} from './runtime-paths'
export {
  WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES,
  WINDOWS_CACHE_TRUSTED_OWNER_SIDS,
  micromambaCacheLockKey,
  micromambaWorkingCachePaths,
  removeMicromambaCacheForRoot,
  selectMicromambaCache
} from './micromamba-cache'
export { validateAndSeedPackIntoCache } from './pack-content'
export {
  caBundleEnv,
  createFromLockArgv,
  micromambaSpawnEnv,
  normalizeExplicitLock,
  resolveMicromamba,
  resolveMicromambaLocations,
  type MicromambaDeps
} from './micromamba'
export {
  BASE_PYTHON_PACKAGES,
  BASE_R_PACKAGES,
  DefaultRuntimeProvisioner,
  planStartupAction,
  type FetchedBundle,
  type ProvisionerDeps,
  type RuntimeProvisioner,
  type RuntimeRepairOptions
} from './provisioner'
export {
  CHILD_UNCONFIRMED,
  captureMicromamba,
  createExecutableVerifier,
  createMicromambaExecutor,
  isChildUnconfirmedError,
  killAndConfirmExit
} from './provisioner-runtime'
export {
  captureNotebookEnvironmentLock,
  decodeNotebookEnvironmentLock,
  parseCondaPackageNames,
  parseNotebookEnvironmentLock
} from './environment-lock'
export {
  nativeLockRestoreState,
  renvRestoreExpression,
  restoreNativeEnvironmentLock
} from './native-lock-restoration'
export { serializeProvisioner } from './environment-operation-foundation'
export {
  notebookWorkloadCacheEnv,
  notebookWorkloadCacheRoot,
  prepareNotebookWorkloadCache,
  removeNotebookWorkloadCache
} from './notebook-workload-cache-paths'
export {
  EnvironmentManifestPublicationError,
  EnvironmentStateTracker,
  type EnvironmentCaptureTarget,
  type PackageInspectionResult
} from './environment-state-tracker'
export { discoverExternalRLibraries, resolveExternalRLibrary } from './external-r-library'
export { NotebookRecoveryCoordinator } from './recovery-coordinator'
export { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
export {
  type DiscoveredInterpreter,
  type DownloadProgress,
  type ProvisionProgress,
  type ProvisionStatus
} from './contracts'
export {
  EnvironmentLeaseManager,
  type EnvironmentLease,
  type EnvironmentLeaseMode
} from './environment-lease-manager'
export {
  createInstallSpawn,
  installPackages,
  packageProcessTreeTerminated,
  type InstallDeps,
  type InstallRequest,
  type InstallResult,
  type InstallSpawn,
  type SupervisedInstallSpawn
} from './package-manager'
export {
  PIP_TRANSPORT_ENV_KEYS,
  buildManagedRuntimeProcessEnvironment,
  buildNotebookKernelEnvironment,
  buildNotebookShellEnvironment,
  environmentPathRoots,
  normalizeRProcessLocale,
  notebookTrustBundleEnvironment
} from './process-environment'
export { readProcessStartToken } from './operation-recovery'
export {
  RuntimeOperationJournal,
  bootTokenProvesReboot,
  isValidBootToken,
  operationJournalPath,
  readBootToken,
  recordSpawnIntentSync
} from './operation-journal'
export {
  defaultDiscoveryDeps,
  discoverInterpreters,
  rscriptFor,
  windowsCondaPrefixForR
} from './environment-discovery'
export { rKernelProtocolProbe } from './r-command'
export {
  managedNotebookWorkingCache,
  retainMicromambaWorkingCache,
  type MicromambaWorkingCacheRetainer
} from './windows-micromamba-working-cache'
export { EnvironmentPackageMutationOwner } from './package-mutation'
export {
  createMicromambaRunnerResolver,
  micromambaRunnerCachePath,
  type MicromambaRunner,
  type MicromambaRunnerCandidate
} from './windows-micromamba-runner'
export { withExclusiveCacheLock, withSharedCacheLocks } from './pkgs-cache-lock'
export { verifyRestoredEnvironment } from './restored-environment-verification'
export { listEnvPackages } from './package-listing'
export {
  findPythonCommand,
  probeInterpreterVersion,
  resolvePythonCommand,
  type PythonCommand,
  validateNotebookHelperExports
} from './python-command'
export { extractPackArchive } from './pack-archive'
export { exportRuntimeLocks } from './runtime-relocation'
export {
  DEFAULT_MAX_CACHE_RELATIVE_PATH,
  DEFAULT_MAX_ENV_RELATIVE_PATH,
  PACK_PATH_BUDGET_FILE
} from './bundle-manifest'
export { createFetchBundleAdapter } from './language-pack-fetch'
export { chainFetchBundle, createLocalBundleAdapter, type BundleDirDeps } from './bundle-local'
export { packageCacheCleanArgv } from './micromamba-cache-maintenance'
export type { EnvironmentProcessHost, ProcessTreeKillResult } from './process-host'
