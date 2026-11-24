import type { ProvisionStatus } from '@aipoch/environment'
import { probeLinuxIsolation } from '@aipoch/notebook-network-sandbox'
import type { NotebookMemoryPolicyState } from '../../shared/notebook-memory'
import type { NotebookNetworkStatus } from '../../shared/notebook-network'
import type { TaskNotebookReadiness, TaskReadinessCheck } from '../../shared/task-api'

const ready = { status: 'ready' } as const
const unconfirmed = { status: 'unconfirmed', reason: 'notebook_evidence_unavailable' } as const

async function observe<T>(work: Promise<unknown>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return (await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        // Memory sampling has its own five second deadline. Observe it long enough to get its result.
        timer = setTimeout(() => resolve(undefined), 6_000)
      })
    ])) as T | undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function environmentCheck(status?: ProvisionStatus): TaskNotebookReadiness['environment'] {
  if (!status) return unconfirmed
  const languageCheck = (installed: boolean, needsRecovery?: boolean): TaskReadinessCheck =>
    needsRecovery || status.recovery?.corruptJournal
      ? { status: 'blocked', reason: 'notebook_environment_recovery_required' }
      : installed
        ? ready
        : status.provisioning
          ? { status: 'checking', reason: 'notebook_environment_preparing' }
          : { status: 'blocked', reason: 'notebook_environment_missing' }
  const python = languageCheck(
    status.pythonReady,
    status.pythonRepairRequired || status.pythonRecoveryBlocked
  )
  const r = languageCheck(status.rReady, status.rRepairRequired || status.rRecoveryBlocked)
  const check: TaskReadinessCheck =
    python.status === 'ready' || r.status === 'ready'
      ? ready
      : python.status === 'checking' || r.status === 'checking'
        ? { status: 'checking', reason: 'notebook_environment_preparing' }
        : { status: 'blocked', reason: 'notebook_language_required' }
  return {
    ...check,
    pythonReady: python.status === 'ready',
    rReady: r.status === 'ready',
    python,
    r
  }
}

async function networkChecks(
  platform: NodeJS.Platform,
  network?: NotebookNetworkStatus
): Promise<Pick<TaskNotebookReadiness, 'dependencies' | 'sandbox'>> {
  switch (network?.kind) {
    case 'ready': {
      const probe = platform === 'linux' ? await probeLinuxIsolation() : 'ready'
      return {
        dependencies: ready,
        sandbox:
          probe === 'unconfirmed'
            ? { status: 'unconfirmed', reason: 'notebook_linux_isolation_unconfirmed' }
            : probe === 'namespaces-unavailable'
              ? { status: 'blocked', reason: 'notebook_linux_namespaces_unavailable' }
              : probe === 'procfs-unavailable'
                ? { status: 'blocked', reason: 'notebook_linux_private_procfs_unavailable' }
                : ready
      }
    }
    case 'checking':
      return {
        dependencies: { status: 'checking', reason: 'notebook_sandbox_preparing' },
        sandbox: { status: 'checking' }
      }
    case 'setupRequired':
      if (platform === 'win32') {
        return {
          dependencies: { status: 'blocked', reason: 'notebook_sandbox_unavailable' },
          sandbox: { status: 'blocked', reason: 'notebook_sandbox_unavailable' }
        }
      }
      if (network.reasons.includes('linuxBubblewrapMissing')) {
        return {
          dependencies: { status: 'blocked', reason: 'notebook_bubblewrap_missing' },
          sandbox: { status: 'blocked' }
        }
      }
      break
    case 'error':
      if (platform === 'win32') {
        return {
          dependencies: {
            status: 'unconfirmed',
            reason: 'notebook_windows_isolation_unconfirmed'
          },
          sandbox: { status: 'unconfirmed', reason: 'notebook_windows_isolation_unconfirmed' }
        }
      }
      if (network.reason === 'trustBundleInvalid') {
        return {
          dependencies: { status: 'blocked', reason: 'notebook_trust_bundle_invalid' },
          sandbox: { status: 'unconfirmed' }
        }
      }
      break
    case 'unsupported':
      return {
        dependencies: { status: 'unconfirmed' },
        sandbox: { status: 'unconfirmed', reason: 'notebook_platform_unconfirmed' }
      }
    case undefined:
      return { dependencies: unconfirmed, sandbox: unconfirmed }
  }
  return {
    dependencies: { status: 'unconfirmed' },
    sandbox: { status: 'blocked', reason: 'notebook_sandbox_unavailable' }
  }
}

function memoryCheck(state?: NotebookMemoryPolicyState): TaskNotebookReadiness['memoryPolicy'] {
  if (!state) return unconfirmed
  const check: TaskReadinessCheck =
    state.status === 'healthy'
      ? ready
      : state.status === 'pressured' && state.reason === 'mac-memory-recovering'
        ? { status: 'checking', reason: 'notebook_memory_recovering' }
        : {
            status: 'blocked',
            reason:
              state.status === 'pressured'
                ? 'notebook_memory_pressure'
                : state.diagnostic === 'linux-procfs'
                  ? 'notebook_linux_procfs_unavailable'
                  : state.diagnostic === 'linux-cgroup-visibility'
                    ? 'notebook_linux_cgroup_unavailable'
                    : 'notebook_memory_policy_unavailable'
          }
  return { ...check, source: state.source, executionScope: state.executionScope }
}

export async function readTaskNotebookReadiness(
  invoke: (
    channel:
      | 'notebook-env:status'
      | 'settings:get-notebook-network-status'
      | 'notebook:memory-policy-state',
    ...args: unknown[]
  ) => Promise<unknown>
): Promise<TaskNotebookReadiness | undefined> {
  const platform = process.platform
  const [environment, network, memory] = await Promise.all([
    observe<ProvisionStatus>(invoke('notebook-env:status')),
    // The Settings owner performs the bounded platform compatibility probe without changing setup.
    observe<NotebookNetworkStatus>(invoke('settings:get-notebook-network-status')),
    observe<NotebookMemoryPolicyState>(invoke('notebook:memory-policy-state', {}))
  ])
  if (!environment && !network && !memory) return undefined
  return {
    platform,
    environment: environmentCheck(environment),
    ...(await networkChecks(platform, network)),
    memoryPolicy: memoryCheck(memory)
  }
}
