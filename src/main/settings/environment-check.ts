import { arch as hostArchitecture } from 'node:os'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  AgentFrameworkId,
  ClaudeDetectResult,
  EnvironmentCheckItem,
  EnvironmentCheckResult,
  ManagedClaudeRegistry
} from '../../shared/settings'
import { MINIMUM_CODEX_ACP_VERSION } from '../../shared/codex-runtime'
import { findPythonCommand, type PythonCommand } from '../notebook/python-command'
import { netFetchStandard } from '../skills/net-fetch'
import { getManagedPlatform } from './managed-claude'
import { detectAvx2, resolveOpencodePlatform } from './managed-opencode'
import { resolveManagedCodexPlatform } from './managed-codex'

const REGISTRY_URLS: Record<ManagedClaudeRegistry, string> = {
  npmjs: 'https://registry.npmjs.org',
  npmmirror: 'https://registry.npmmirror.com'
}

const REGISTRY_LABELS: Record<ManagedClaudeRegistry, string> = {
  npmjs: 'official npm registry',
  npmmirror: 'China-friendly npmmirror'
}

// The npm package path probed per framework to gauge registry reachability for its managed install.
const REGISTRY_PROBE_PATHS: Record<AgentFrameworkId, string> = {
  'claude-code': '/@anthropic-ai%2fclaude-code/latest',
  opencode: '/opencode-ai/latest',
  codebuddy: '/@tencent-ai%2fcodebuddy-code/2.138.0',
  codex: '/@agentclientprotocol%2fcodex-acp/latest'
}
const REGISTRY_PROBE_TIMEOUT_MS = 5_000

type RegistryProbe = (registry: ManagedClaudeRegistry, packagePath?: string) => Promise<number>

export type EnvironmentCheckDeps = {
  platform?: NodeJS.Platform
  architecture?: string
  verifyStorage?: (storageRoot: string) => Promise<void>
  resolveManagedPlatform?: () => unknown
  findPython?: () => Promise<PythonCommand | undefined>
  probeRegistry?: RegistryProbe
  detectAvx2?: () => boolean
  now?: () => number
}

const platformLabel = (platform: NodeJS.Platform): string => {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'

  return platform
}

// Writes and removes a uniquely-named sentinel inside the exact directory used by the managed
// runtime. This verifies the permission Open Science actually needs without requesting admin access
// or touching a system-owned installation directory.
const verifyStorageAccess = async (storageRoot: string): Promise<void> => {
  await mkdir(storageRoot, { recursive: true })
  const sentinel = join(
    storageRoot,
    `.environment-check-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )

  try {
    await writeFile(sentinel, 'open-science', { encoding: 'utf8', flag: 'wx' })
  } finally {
    await rm(sentinel, { force: true }).catch(() => undefined)
  }
}

// Uses Electron's Chromium network stack so this observes the configured System, Manual, or Direct
// proxy mode. A HEAD request keeps the required source check lightweight.
const probeRegistryReachability: RegistryProbe = async (registry, packagePath = '') => {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REGISTRY_PROBE_TIMEOUT_MS)

  try {
    const response = await netFetchStandard(`${REGISTRY_URLS[registry]}${packagePath}`, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} while checking ${registry}`)
    return Date.now() - startedAt
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out while checking ${registry}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const inspectRegistry = async (
  registry: ManagedClaudeRegistry,
  probe: RegistryProbe,
  packagePath: string
): Promise<{ registry: ManagedClaudeRegistry; latencyMs?: number }> => {
  try {
    return { registry, latencyMs: await probe(registry, packagePath) }
  } catch {
    return { registry }
  }
}

const runEnvironmentCheck = async ({
  storageRoot,
  agentFrameworkId,
  frameworks,
  encryptionAvailable,
  deps = {}
}: {
  storageRoot: string
  // The framework the user selected; only its runtime gates readiness/auto-install.
  agentFrameworkId: AgentFrameworkId
  // Every framework's runtime, checked and shown together (in display order). Each carries its label
  // and detection result in the shared shape.
  frameworks: { id: AgentFrameworkId; label: string; runtime: ClaudeDetectResult }[]
  encryptionAvailable: boolean
  deps?: EnvironmentCheckDeps
}): Promise<EnvironmentCheckResult> => {
  // The selected framework's runtime drives the required gate; the others are shown for context only.
  const selected = frameworks.find((framework) => framework.id === agentFrameworkId)
  const selectedRuntime = selected?.runtime ?? { found: false }
  const selectedLabel = selected?.label ?? 'Agent'
  const platform = deps.platform ?? process.platform
  const architecture = deps.architecture ?? hostArchitecture()
  const verifyStorage = deps.verifyStorage ?? verifyStorageAccess
  // Gauge managed-install availability with the SELECTED framework's own platform map, not always
  // Claude's, so an arch opencode has no package for isn't reported as auto-installable (and vice versa).
  const resolveManagedPlatform =
    deps.resolveManagedPlatform ??
    (() => {
      if (agentFrameworkId === 'opencode') return resolveOpencodePlatform()
      if (agentFrameworkId === 'codex') return resolveManagedCodexPlatform()
      return getManagedPlatform()
    })
  const findPython = deps.findPython ?? findPythonCommand
  const probeRegistry = deps.probeRegistry ?? probeRegistryReachability
  const detectAvx2Cap = deps.detectAvx2 ?? detectAvx2
  const now = deps.now ?? Date.now

  // opencode ships a `-baseline` build for a non-AVX2 x64 host, so such a machine is still fully
  // auto-installable — reflect the true capability with an informational note rather than a warning.
  const opencodeBaselineNote =
    agentFrameworkId === 'opencode' && architecture === 'x64' && !detectAvx2Cap()

  const [systemCheck, storageCheck, python] = await Promise.all([
    Promise.resolve().then<EnvironmentCheckItem>(() => {
      try {
        resolveManagedPlatform()
        return {
          id: 'system',
          label: 'System compatibility',
          status: 'passed',
          summary: opencodeBaselineNote
            ? `${platformLabel(platform)} ${architecture} is supported — the baseline build will be installed.`
            : `${platformLabel(platform)} ${architecture} is supported.`,
          detail: opencodeBaselineNote
            ? 'This CPU lacks AVX2, so automatic setup installs the app-managed baseline runtime. No administrator access is required.'
            : 'Automatic setup uses an app-managed runtime and does not require administrator access.',
          presentation: {
            kind: opencodeBaselineNote ? 'system-baseline-supported' : 'system-supported',
            platform: platformLabel(platform),
            architecture
          }
        }
      } catch (error) {
        // An already-runnable runtime can still be used even if this architecture has no managed
        // package. Only a machine that also lacks the runtime is blocked from automatic setup.
        return {
          id: 'system',
          label: 'System compatibility',
          status: selectedRuntime.found ? 'warning' : 'failed',
          summary: selectedRuntime.found
            ? `${platformLabel(platform)} ${architecture} can use the detected ${selectedLabel} runtime.`
            : `${platformLabel(platform)} ${architecture} has no automatic installer package.`,
          detail:
            error instanceof Error
              ? error.message
              : 'Install a compatible agent runtime, then choose Check again.',
          presentation: selectedRuntime.found
            ? {
                kind: 'system-detected-runtime',
                platform: platformLabel(platform),
                architecture,
                runtime: selectedLabel
              }
            : {
                kind: 'system-no-installer',
                platform: platformLabel(platform),
                architecture
              }
        }
      }
    }),
    verifyStorage(storageRoot)
      .then<EnvironmentCheckItem>(() => ({
        id: 'storage',
        label: 'App storage permission',
        status: 'passed',
        summary: 'Open Science can write to its private data folder.',
        detail: storageRoot,
        presentation: { kind: 'storage-writable' }
      }))
      .catch<EnvironmentCheckItem>((error) => ({
        id: 'storage',
        label: 'App storage permission',
        status: 'failed',
        summary: 'Open Science cannot write to its private data folder.',
        detail:
          error instanceof Error
            ? `${storageRoot} — ${error.message}`
            : `${storageRoot} — grant write access, then check again.`,
        presentation: { kind: 'storage-unwritable' }
      })),
    findPython().catch(() => undefined)
  ])

  let recommendedRegistry: ManagedClaudeRegistry | undefined
  let networkCheck: EnvironmentCheckItem

  if (selectedRuntime.found) {
    networkCheck = {
      id: 'install-network',
      label: 'Installation network',
      status: 'passed',
      summary: `No download is needed because ${selectedLabel} is already installed.`,
      presentation: { kind: 'install-network-runtime-present', runtime: selectedLabel }
    }
  } else {
    const registryResults = await Promise.all([
      inspectRegistry('npmjs', probeRegistry, REGISTRY_PROBE_PATHS[agentFrameworkId]),
      inspectRegistry('npmmirror', probeRegistry, REGISTRY_PROBE_PATHS[agentFrameworkId])
    ])
    const reachable = registryResults
      .filter(
        (result): result is { registry: ManagedClaudeRegistry; latencyMs: number } =>
          result.latencyMs !== undefined
      )
      .sort((left, right) => left.latencyMs - right.latencyMs)

    recommendedRegistry = reachable[0]?.registry
    networkCheck = recommendedRegistry
      ? {
          id: 'install-network',
          label: 'Installation network',
          status: 'passed',
          summary: `${REGISTRY_LABELS[recommendedRegistry]} is the fastest reachable source.`,
          detail: `Measured ${reachable[0].latencyMs} ms. The other trusted source remains available as an automatic fallback.`,
          presentation: {
            kind: 'install-network-registry-available',
            registry: recommendedRegistry,
            latencyMs: reachable[0].latencyMs
          }
        }
      : {
          id: 'install-network',
          label: 'Installation network',
          status: 'failed',
          summary: 'Neither the official registry nor the China-friendly mirror is reachable.',
          detail: 'Check the network, proxy, VPN, or firewall, then run the check again.',
          presentation: { kind: 'install-network-unreachable' }
        }
  }

  const secureStorageCheck: EnvironmentCheckItem = encryptionAvailable
    ? {
        id: 'secure-storage',
        label: 'Secure credential storage',
        status: 'passed',
        summary: 'The operating-system credential vault is available.',
        presentation: { kind: 'secure-storage-available' }
      }
    : {
        id: 'secure-storage',
        label: 'Secure credential storage',
        status: 'warning',
        summary: 'The operating-system credential vault is unavailable.',
        detail:
          'Unlock or authorize the system keychain before saving API keys. Keyless runtimes can continue setup.',
        presentation: { kind: 'secure-storage-unavailable' }
      }

  // Notebooks run in an app-managed Python environment (provisioned on demand), so a system Python 3
  // is NOT required — it is only an optional interpreter the user can point notebooks at instead.
  // Both branches are therefore "passed": its absence is not a limitation, so it must not raise an
  // amber warning that makes the (fully functional) managed default look broken.
  const pythonCheck: EnvironmentCheckItem = python
    ? {
        id: 'python',
        label: 'Python for Notebook',
        status: 'passed',
        summary:
          'A system Python 3 was detected. Notebooks can optionally use it instead of the app-managed environment.',
        detail: [python.command, ...python.baseArgs].join(' ')
      }
    : {
        id: 'python',
        label: 'Python for Notebook',
        status: 'passed',
        summary:
          'Notebooks run in an app-managed Python environment. A system Python 3 is optional and was not found.'
      }

  // One runtime row per framework, shown together. Only the SELECTED framework's absence is a failure
  // (it blocks Continue); a non-selected framework that's missing is an informational warning, so the
  // user isn't forced to install both.
  const runtimeChecks: EnvironmentCheckItem[] = frameworks.flatMap(({ id, label, runtime }) => {
    // For Codex with detailed component info, show separate rows for native CLI and adapter
    if (id === 'codex' && runtime.codexComponents) {
      const {
        nativeCliFound,
        nativeCliPath,
        nativeCliVersion,
        adapterFound,
        adapterPath,
        adapterVersion,
        adapterFailureReason
      } = runtime.codexComponents
      const isSelected = id === agentFrameworkId

      const nativeCheck: EnvironmentCheckItem = {
        id: 'agent',
        label: 'Codex native CLI',
        status: nativeCliFound ? 'passed' : isSelected ? 'failed' : 'warning',
        summary: nativeCliFound
          ? nativeCliVersion
            ? `Codex CLI ${nativeCliVersion} is installed.`
            : 'Codex CLI is installed.'
          : isSelected
            ? 'Native Codex CLI is not installed.'
            : 'Native Codex CLI is not installed (optional — only needed if you switch to Codex).',
        detail: nativeCliPath
      }

      // Adapter with a failure reason is marked as found but non-functional - treat as failed
      const adapterWorking = adapterFound && !adapterFailureReason

      const adapterCheck: EnvironmentCheckItem = {
        id: 'agent',
        label: 'Codex ACP adapter',
        status: adapterWorking ? 'passed' : isSelected ? 'failed' : 'warning',
        summary: adapterWorking
          ? `Codex ACP adapter ${adapterVersion} is ready.`
          : adapterFound && adapterFailureReason
            ? adapterFailureReason === 'smoke-test-failed'
              ? `Codex ACP adapter ${adapterVersion} failed to initialize.`
              : adapterFailureReason === 'unsupported-version'
                ? `Codex ACP adapter ${adapterVersion} must be updated to ${MINIMUM_CODEX_ACP_VERSION} or later.`
                : `Codex ACP adapter exists but version detection failed.`
            : isSelected
              ? 'Codex ACP adapter is not installed.'
              : 'Codex ACP adapter is not installed (optional — only needed if you switch to Codex).',
        detail: adapterPath
      }

      return [nativeCheck, adapterCheck]
    }

    // For other frameworks or when Codex doesn't have component info, show single runtime row
    if (runtime.found) {
      return [
        {
          id: 'agent',
          label: `${label} runtime`,
          status: 'passed',
          summary: runtime.version ? `${label} ${runtime.version} is ready.` : `${label} is ready.`,
          detail: runtime.path
        }
      ]
    }

    const isSelected = id === agentFrameworkId

    // Use diagnostic detail when available (e.g., "native Codex exists but adapter is missing")
    const summary = runtime.diagnostic
      ? runtime.diagnostic
      : isSelected
        ? `${label} is not installed yet.`
        : `${label} is not installed (optional — only needed if you switch to it).`

    return [
      {
        id: 'agent',
        label: `${label} runtime`,
        status: isSelected ? 'failed' : 'warning',
        summary,
        detail:
          isSelected && !runtime.diagnostic
            ? 'Automatic setup installs a self-contained runtime without Node.js, npm, or admin access.'
            : undefined
      }
    ]
  })

  const checks = [
    systemCheck,
    storageCheck,
    secureStorageCheck,
    networkCheck,
    pythonCheck,
    ...runtimeChecks
  ]
  const passedIds = new Set(
    checks.filter((check) => check.status === 'passed').map((check) => check.id)
  )

  return {
    checkedAt: now(),
    platform,
    architecture,
    checks,
    ready: checks.every((check) => check.status !== 'failed'),
    canAutoInstall:
      !selectedRuntime.found &&
      passedIds.has('system') &&
      passedIds.has('storage') &&
      passedIds.has('install-network'),
    recommendedRegistry,
    agentFrameworkId,
    runtime: selectedRuntime
  }
}

export { REGISTRY_URLS, probeRegistryReachability, runEnvironmentCheck, verifyStorageAccess }
