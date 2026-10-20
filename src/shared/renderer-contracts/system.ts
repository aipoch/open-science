import type { PackageOperationSnapshot } from '../session-package'
import { RUNTIME_STARTUP_CHANNELS, type RuntimeStartupState } from '../runtime-startup'
import {
  DESKTOP_RUNTIME_RECOVERY_CHANNELS,
  type DesktopRuntimeRecoveryState
} from '../desktop-runtime-recovery'
// Ordered fragments keep the public registration order when capabilities interleave.
import type { RendererFailureReport } from '../diagnostics'

import type { LogFileStatus, OpenLogFileResult, RevealLogFileResult } from '../logs'

import { NETWORK_SYSTEM_RESUMED_CHANNEL, type NetworkInfo } from '../network'

import type { CliLauncherStatus } from '../cli'

import type { DatabaseStartupState } from '../database-startup'

import type {
  InitializeLocalePreferenceRequest,
  LocalePreferenceSnapshot,
  SetLocalePreferenceRequest
} from '../locale'

import { DATABASE_STARTUP_CHANNELS } from '../database-startup'

import {
  callable,
  LOCAL,
  ELECTRON,
  type AcpListener,
  type RemoveListener,
  ELECTRON_EVENT,
  SEND,
  WEB,
  RUNTIME_VALIDATED
} from './definition'

export const cliGetStatusContracts = {
  'cli.getStatus': callable<() => Promise<CliLauncherStatus>>()('cli', ['cli:get-status']),
  'cli.install': callable<() => Promise<CliLauncherStatus>>()('cli', ['cli:install', LOCAL]),
  'cli.uninstall': callable<() => Promise<CliLauncherStatus>>()('cli', ['cli:uninstall', LOCAL])
} as const

export const databaseStartupGetStateContracts = {
  'packagePresentation.getState': callable<() => Promise<PackageOperationSnapshot | null>>()(
    'sessions',
    ['package-presentation:get-state', ELECTRON],
    { optionalRoot: true }
  ),
  'packagePresentation.onStateChanged': callable<
    (listener: AcpListener<PackageOperationSnapshot | null>) => RemoveListener
  >()('sessions', ['package-presentation:changed', ELECTRON_EVENT], { optionalRoot: true }),
  'packagePresentation.cancelTransfer': callable<(id: string) => Promise<void>>()(
    'sessions',
    ['package-presentation:cancel-transfer', ELECTRON],
    { optionalRoot: true }
  ),
  'runtimeStartup.getState': callable<() => Promise<RuntimeStartupState>>()(
    'runtime-startup',
    [RUNTIME_STARTUP_CHANNELS.getState, ELECTRON],
    { optionalRoot: true }
  ),
  'runtimeStartup.stopAndContinue': callable<() => Promise<RuntimeStartupState>>()(
    'runtime-startup',
    [RUNTIME_STARTUP_CHANNELS.stopAndContinue, ELECTRON],
    { optionalRoot: true }
  ),
  'runtimeStartup.recover': callable<() => Promise<RuntimeStartupState>>()(
    'runtime-startup',
    [RUNTIME_STARTUP_CHANNELS.recover, ELECTRON],
    { optionalRoot: true }
  ),
  'runtimeStartup.quit': callable<() => Promise<void>>()(
    'runtime-startup',
    [RUNTIME_STARTUP_CHANNELS.quit, ELECTRON],
    { optionalRoot: true }
  ),
  'runtimeStartup.onStateChanged': callable<
    (listener: AcpListener<RuntimeStartupState>) => RemoveListener
  >()('runtime-startup', [RUNTIME_STARTUP_CHANNELS.onStateChanged, ELECTRON_EVENT], {
    optionalRoot: true
  }),
  'desktopRuntime.getState': callable<() => Promise<DesktopRuntimeRecoveryState>>()(
    'desktop-runtime',
    [DESKTOP_RUNTIME_RECOVERY_CHANNELS.getState, ELECTRON],
    { optionalRoot: true }
  ),
  'desktopRuntime.reconnect': callable<() => Promise<DesktopRuntimeRecoveryState>>()(
    'desktop-runtime',
    [DESKTOP_RUNTIME_RECOVERY_CHANNELS.reconnect, ELECTRON],
    { optionalRoot: true }
  ),
  'desktopRuntime.reconciled': callable<(epoch: number, success: boolean) => Promise<void>>()(
    'desktop-runtime',
    [DESKTOP_RUNTIME_RECOVERY_CHANNELS.reconciled, ELECTRON],
    { optionalRoot: true }
  ),
  'desktopRuntime.quit': callable<() => Promise<void>>()(
    'desktop-runtime',
    [DESKTOP_RUNTIME_RECOVERY_CHANNELS.quit, ELECTRON],
    { optionalRoot: true }
  ),
  'desktopRuntime.onStateChanged': callable<
    (listener: AcpListener<DesktopRuntimeRecoveryState>) => RemoveListener
  >()('desktop-runtime', [DESKTOP_RUNTIME_RECOVERY_CHANNELS.stateChanged, ELECTRON_EVENT], {
    optionalRoot: true
  }),
  'databaseStartup.getState': callable<() => Promise<DatabaseStartupState>>()('database-startup', [
    DATABASE_STARTUP_CHANNELS.getState,
    ELECTRON
  ]),
  'databaseStartup.onStateChanged': callable<
    (listener: AcpListener<DatabaseStartupState>) => RemoveListener
  >()('database-startup', [DATABASE_STARTUP_CHANNELS.stateChanged, ELECTRON_EVENT]),
  'databaseStartup.quit': callable<() => Promise<void>>()('database-startup', [
    DATABASE_STARTUP_CHANNELS.quit,
    ELECTRON
  ]),
  'databaseStartup.retry': callable<() => Promise<DatabaseStartupState>>()('database-startup', [
    DATABASE_STARTUP_CHANNELS.retry,
    ELECTRON
  ]),
  'diagnostics.reportRendererFailure': callable<(report: RendererFailureReport) => void>()(
    'diagnostics',
    ['diagnostics:renderer-failure', SEND],
    { optionalRoot: true }
  )
} as const

export const githubGetStarsContracts = {
  'github.getStars': callable<() => Promise<number | null>>()('github', ['github:get-stars'])
} as const

export const lifecycleClaimRuntimeWriterContracts = {
  'lifecycle.claimRuntimeWriter': callable<
    () => Promise<import('../runtime-writer').RuntimeWriterLease>
  >()('lifecycle', [
    'lifecycle:claim-runtime-writer',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'lifecycle.getClientId': callable<() => Promise<string>>()('lifecycle', ['lifecycle:client-id']),
  'locale.initialize': callable<
    (request: InitializeLocalePreferenceRequest) => Promise<LocalePreferenceSnapshot>
  >()('locale', ['locale:initialize', ELECTRON]),
  'locale.onChanged': callable<
    (listener: AcpListener<LocalePreferenceSnapshot>) => RemoveListener
  >()('locale', ['locale:changed', ELECTRON_EVENT]),
  'locale.setPreference': callable<
    (request: SetLocalePreferenceRequest) => Promise<LocalePreferenceSnapshot>
  >()('locale', ['locale:set-preference', ELECTRON])
} as const

export const logsGetStatusContracts = {
  'logs.getStatus': callable<() => Promise<LogFileStatus>>()('logs', ['logs:get-status', LOCAL]),
  'logs.openFile': callable<() => Promise<OpenLogFileResult>>()('logs', ['logs:open-file', LOCAL]),
  'logs.revealInFolder': callable<() => Promise<RevealLogFileResult>>()('logs', [
    'logs:reveal-in-folder',
    LOCAL
  ])
} as const

export const networkCheckConnectivityContracts = {
  'network.onSystemResumed': callable<(listener: () => void) => RemoveListener>()('network', [
    NETWORK_SYSTEM_RESUMED_CHANNEL,
    ELECTRON_EVENT
  ]),
  'network.checkConnectivity': callable<() => Promise<boolean>>()('network', [
    'network:check-connectivity',
    ELECTRON
  ]),
  'network.getInfo': callable<() => Promise<NetworkInfo>>()('network', [
    'network:get-info',
    ELECTRON
  ])
} as const
