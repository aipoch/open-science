// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProvisionStatus } from '../../../../shared/notebook-env'
import type { DiscoveredInterpreter, RuntimeEnablement } from '../../../../shared/notebook-runtime'
import { createInitialNotebookEnvState, useNotebookEnvStore } from '../../stores/notebook-env-store'
import { RuntimesPanel } from './RuntimesPanel'

let container: HTMLDivElement
let root: Root

const pythonEnvs: DiscoveredInterpreter[] = [
  {
    language: 'python',
    provenance: 'app-managed',
    envId: '/data/runtime/envs/default-python-3.12/bin/python',
    interpreterPath: '/data/runtime/envs/default-python-3.12/bin/python',
    label: 'Python 3.12 (managed)',
    version: '3.12.4',
    runnable: true
  },
  {
    language: 'python',
    provenance: 'user-own',
    envId: '/usr/bin/python3',
    interpreterPath: '/usr/bin/python3',
    label: 'System Python',
    version: '3.11.2',
    runnable: true
  }
]

const rEnvs: DiscoveredInterpreter[] = [
  {
    language: 'r',
    provenance: 'user-own',
    envId: '/opt/conda/envs/bio/bin/R',
    interpreterPath: '/opt/conda/envs/bio/bin/R',
    label: 'R 4.4.1',
    version: 'R 4.4.1',
    runnable: false,
    condaEnv: 'bio',
    detail: 'Needs jsonlite'
  }
]

let listEnvironments: ReturnType<typeof vi.fn>
let getEnablement: ReturnType<typeof vi.fn>
let describeUsage: ReturnType<typeof vi.fn>
let setEnvironmentEnabled: ReturnType<typeof vi.fn>
let setInstallAuthorized: ReturnType<typeof vi.fn>
let registerInterpreter: ReturnType<typeof vi.fn>
let pickInterpreter: ReturnType<typeof vi.fn>
let provision: ReturnType<typeof vi.fn>
let cancelBridge: ReturnType<typeof vi.fn>
let repairBridge: ReturnType<typeof vi.fn>

const provisionStatus: ProvisionStatus = {
  pythonReady: false,
  rReady: false,
  version: 0,
  provisioning: false
}

const enablement: RuntimeEnablement = { enabled: {}, installAuthorized: {} }

beforeEach(() => {
  useNotebookEnvStore.setState(createInitialNotebookEnvState())
  listEnvironments = vi.fn().mockResolvedValue({ python: pythonEnvs, r: rEnvs })
  getEnablement = vi.fn().mockResolvedValue(enablement)
  describeUsage = vi.fn().mockResolvedValue({ running: 0, idle: 0, dormant: 0 })
  setEnvironmentEnabled = vi
    .fn()
    .mockImplementation(async (_language: string, envId: string, enabled: boolean) => ({
      enabled: { ...enablement.enabled, [envId]: enabled },
      installAuthorized: { ...enablement.installAuthorized }
    }))
  setInstallAuthorized = vi
    .fn()
    .mockImplementation(async (_language: string, envId: string, authorized: boolean) => ({
      enabled: { ...enablement.enabled },
      installAuthorized: { ...enablement.installAuthorized, [envId]: authorized }
    }))
  registerInterpreter = vi.fn().mockResolvedValue(['/usr/bin/python3'])
  pickInterpreter = vi.fn().mockResolvedValue('/usr/bin/python3')
  provision = vi.fn().mockRejectedValue(new Error('runtime CDN unavailable'))
  cancelBridge = vi.fn().mockResolvedValue(undefined)
  repairBridge = vi.fn().mockResolvedValue(undefined)
  ;(window as unknown as { api: unknown }).api = {
    runtime: {
      listEnvironments,
      getEnablement,
      describeUsage,
      setEnvironmentEnabled,
      setInstallAuthorized,
      registerInterpreter,
      pickInterpreter
    },
    notebookEnv: {
      getStatus: vi.fn().mockResolvedValue(provisionStatus),
      onProgress: vi.fn(),
      provision,
      cancel: cancelBridge,
      repair: repairBridge
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<RuntimesPanel />)
  })
  // Flush the listEnvironments()/survey() microtasks.
  await act(async () => {})
  await act(async () => {})
}

const click = async (el: Element | null): Promise<void> => {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('RuntimesPanel', () => {
  it('renders a card per detected env with version and interpreter path', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('Python 3.12 (managed)')
    expect(text).toContain('3.12.4')
    expect(text).toContain('/data/runtime/envs/default-python-3.12/bin/python')
    expect(text).toContain('System Python')
    expect(text).toContain('/usr/bin/python3')
    // R conda env card, including its provider/type and readiness gap.
    expect(text).toContain('R 4.4.1')
    expect(text).toContain('Conda: bio')
    expect(text).toContain('Needs jsonlite')
    // One card per detected env, plus a first-position app-managed setup card for the language whose
    // managed env is not provisioned yet (R here): python (managed 3.12 + System) + R (managed setup +
    // R 4.4.1) = 4 cards.
    expect(container.querySelectorAll('[data-testid="runtime-card"]').length).toBe(4)
  })

  it('enable toggle calls setEnvironmentEnabled with the env id', async () => {
    await render()
    const toggle = container.querySelector<HTMLElement>('[aria-label="Enable System Python"]')
    await click(toggle)
    // user-own defaults OFF, so toggling turns it ON (no force on enable).
    expect(setEnvironmentEnabled).toHaveBeenCalledWith(
      'python',
      '/usr/bin/python3',
      true,
      undefined
    )
  })

  it('defaults user-own envs to disabled and app-managed to enabled', async () => {
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')
    const userToggle = container.querySelector('[aria-label="Enable System Python"]')
    expect(managedToggle?.getAttribute('data-state')).toBe('checked')
    expect(userToggle?.getAttribute('data-state')).toBe('unchecked')
  })

  it('surfaces the "cannot disable the last enabled runtime" error inline', async () => {
    setEnvironmentEnabled.mockRejectedValueOnce(
      new Error('Cannot disable the last enabled runtime for python.')
    )
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')
    await click(managedToggle)
    expect(container.querySelector('[data-testid="runtimes-error"]')?.textContent).toContain(
      'Cannot disable the last enabled runtime'
    )
  })

  it('warns before disabling a runtime that live sessions are using, then applies on confirm (WS11)', async () => {
    describeUsage.mockResolvedValue({ running: 1, idle: 0, dormant: 0 })
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')
    await click(managedToggle)

    // The impact dialog is shown and the disable is NOT applied yet.
    const dialog = document.querySelector('[data-testid="disable-impact-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('1 running')
    expect(setEnvironmentEnabled).not.toHaveBeenCalled()

    // Confirming applies the disable to the bound runtime.
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      /disable after current work/i.test(b.textContent ?? '')
    )
    await click(confirmBtn ?? null)
    // "Disable after current work" = drain (no force).
    expect(setEnvironmentEnabled).toHaveBeenCalledWith(
      'python',
      '/data/runtime/envs/default-python-3.12/bin/python',
      false,
      undefined
    )
  })

  it('offers force-stop when a cell is running and disables with force on confirm (WS10)', async () => {
    describeUsage.mockResolvedValue({ running: 1, idle: 0, dormant: 0 })
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')
    await click(managedToggle)

    // With a running cell, the dialog offers "Stop running work" (force-stop).
    const forceBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      /stop running work/i.test(b.textContent ?? '')
    )
    expect(forceBtn).toBeDefined()
    await click(forceBtn ?? null)
    expect(setEnvironmentEnabled).toHaveBeenCalledWith(
      'python',
      '/data/runtime/envs/default-python-3.12/bin/python',
      false,
      true
    )
  })

  it('exposes app-managed acquisition with a failed CDN attempt and retry affordance', async () => {
    await render()
    const setupBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /download and set up/i.test(b.textContent ?? '')
    )
    await click(setupBtn ?? null)
    expect(provision).toHaveBeenCalledWith('r')
    // The failure surfaces on R's OWN card (per-language error), and its button offers a retry.
    expect(
      container.querySelector('[data-testid="runtimes-provision-error-r"]')?.textContent
    ).toContain('runtime CDN unavailable')
    expect(container.textContent).toContain('Retry setup')
  })

  it('adds an interpreter via the picker and enables the new external env', async () => {
    await render()
    const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /add interpreter/i.test(b.textContent ?? '')
    )
    // First matching Add button is Python's.
    await click(addBtn ?? null)
    expect(pickInterpreter).toHaveBeenCalledOnce()
    // The picked path is added to the discovery catalog (not the removed setSelection path).
    expect(registerInterpreter).toHaveBeenCalledWith('python', '/usr/bin/python3')
    // The picked path matches a detected env, so it is enabled (Add-interpreter's direct 3-arg call).
    expect(setEnvironmentEnabled).toHaveBeenCalledWith('python', '/usr/bin/python3', true)
  })

  it('shows a determinate progress bar + Cancel in the app-managed setup card while downloading', async () => {
    await render()
    // R has no provisioned managed env, so its section shows the app-managed SETUP card (which carries
    // the progress bar + Cancel). Drive the mirrored provisioning state into "preparing" at 30% for R.
    act(() =>
      useNotebookEnvStore.setState({
        byLang: {
          r: {
            preparing: true,
            progress: {
              phase: 'download',
              message: 'Downloading managed R runtime (30%)',
              progress: 0.3,
              language: 'r'
            }
          }
        }
      })
    )
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('aria-valuenow')).toBe('30')
    expect(container.textContent).toContain('Downloading managed R runtime (30%)')
    // The download is cancelable, not a locked state.
    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^cancel$/i.test((b.textContent ?? '').trim())
    )
    expect(cancelBtn).toBeDefined()
    await click(cancelBtn ?? null)
    expect(cancelBridge).toHaveBeenCalled()
  })

  it('surfaces Reset in the app-managed SETUP card when a language is recovery-blocked', async () => {
    await render()
    // R has no provisioned managed env -> its section shows the setup card. A recovery-blocked error
    // must turn the primary action into "Reset runtime" (not "Retry setup") wired to repair.
    act(() =>
      useNotebookEnvStore.setState({
        byLang: {
          r: {
            preparing: false,
            error: 'RUNTIME_RECOVERY_BLOCKED: a previous operation was interrupted'
          }
        }
      })
    )
    const resetBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^reset runtime$/i.test((b.textContent ?? '').trim())
    )
    expect(resetBtn).toBeDefined()
    await click(resetBtn ?? null)
    expect(repairBridge).toHaveBeenCalledWith('r')
  })

  it('surfaces Reset even when a runnable managed env is still present (interrupted upgrade/install)', async () => {
    await render()
    // Python HAS a runnable app-managed env, so the normal card renders — but an interrupted
    // upgrade/install may have quarantined its prefix. The recovery entry must still be reachable, or
    // the user could never clear the block while the interpreter exists.
    act(() =>
      useNotebookEnvStore.setState({
        byLang: {
          python: {
            preparing: false,
            error: 'RUNTIME_RECOVERY_BLOCKED: a previous operation was interrupted'
          }
        }
      })
    )
    const notice = container.querySelector('[data-testid="runtimes-recovery-blocked-python"]')
    expect(notice).not.toBeNull()
    const resetBtn = Array.from(notice?.querySelectorAll('button') ?? []).find((b) =>
      /^reset runtime$/i.test((b.textContent ?? '').trim())
    )
    expect(resetBtn).toBeDefined()
    await click(resetBtn ?? null)
    expect(repairBridge).toHaveBeenCalledWith('python')
  })

  it('keeps Cancel clickable while a real Download-and-set-up is in flight (not locked by busy)', async () => {
    // A provision that stays pending, so the setup is genuinely mid-flight when we look for Cancel.
    let resolveProvision: (() => void) | undefined
    provision.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveProvision = r
        })
    )
    await render()
    const downloadBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /download and set up/i.test(b.textContent ?? '')
    )
    await click(downloadBtn ?? null) // kicks off provision; provisioningLang set immediately

    // Download is replaced by an ENABLED Cancel (not a disabled, locked button).
    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^cancel$/i.test((b.textContent ?? '').trim())
    )
    expect(cancelBtn).toBeDefined()
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(false)
    await click(cancelBtn ?? null)
    expect(cancelBridge).toHaveBeenCalled()

    resolveProvision?.()
  })
})
