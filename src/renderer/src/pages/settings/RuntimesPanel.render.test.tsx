// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProvisionStatus } from '../../../../shared/notebook-env'
import type {
  DiscoveredInterpreter,
  EnvPackage,
  RuntimeEnablement
} from '../../../../shared/notebook-runtime'
import { createInitialNotebookEnvState, useNotebookEnvStore } from '../../stores/notebook-env-store'
import { useRuntimeSettingsStore } from '../../stores/runtime-settings-store'
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
    runnable: true,
    condaEnv: 'default-python'
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
let listPackages: ReturnType<typeof vi.fn>
let listPackageCounts: ReturnType<typeof vi.fn>
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
  useRuntimeSettingsStore.setState({
    envs: null,
    enablement: {},
    agentEnvironmentCreationEnabled: true,
    loaded: false,
    checkedAt: null,
    busy: false,
    error: null,
    packageCounts: {},
    packageCountsLoaded: {}
  })
  listEnvironments = vi.fn().mockResolvedValue({ python: pythonEnvs, r: rEnvs })
  listPackages = vi
    .fn()
    .mockImplementation(async (_language: string, envId: string): Promise<EnvPackage[]> => {
      if (envId === '/usr/bin/python3') return [{ name: 'requests', version: '2.32.3' }]
      return [
        { name: 'numpy', version: '2.1.3', build: 'py312hb2f4e1b_0', channel: 'conda-forge' },
        { name: 'pandas', version: '2.2.3', build: 'py312h1234567_0', channel: 'conda-forge' }
      ]
    })
  listPackageCounts = vi
    .fn()
    .mockImplementation(async (language: string): Promise<Record<string, number | null>> =>
      language === 'python'
        ? {
            '/data/runtime/envs/default-python-3.12/bin/python': 2,
            '/usr/bin/python3': 1
          }
        : {}
    )
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
      listPackages,
      listPackageCounts,
      getEnablement,
      getAgentEnvironmentCreationEnabled: vi.fn().mockResolvedValue(true),
      describeUsage,
      setEnvironmentEnabled,
      setAgentEnvironmentCreationEnabled: vi.fn().mockResolvedValue(true),
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

const render = async (
  title = 'Notebook runtimes',
  description = 'Enable the environments each notebook language may run in.',
  onOpenNetworkProtection?: () => void
): Promise<void> => {
  await act(async () => {
    root.render(
      <RuntimesPanel
        title={title}
        description={description}
        onOpenNetworkProtection={onOpenNetworkProtection}
      />
    )
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
  it('shows the network protection entry only when Settings provides its route', async () => {
    const onOpenNetworkProtection = vi.fn()
    ;(window.api as unknown as { settings: unknown }).settings = {
      getNotebookNetworkStatus: vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] })
    }

    await render(undefined, undefined, onOpenNetworkProtection)

    const banner = container.querySelector('[data-testid="notebook-network-protection-banner"]')
    expect(banner?.textContent).toContain('Network protection on')
    await click(banner?.querySelector('button') ?? null)
    expect(onOpenNetworkProtection).toHaveBeenCalledOnce()
  })

  it('does not add the Settings network entry to the reused onboarding panel', async () => {
    await render()

    expect(container.querySelector('[data-testid="notebook-network-protection-banner"]')).toBeNull()
  })

  it('renders caller-provided heading copy with Recheck in the same top section', async () => {
    await render('Custom runtime title', 'Custom runtime description')

    const section = container.querySelector('section[aria-label="Custom runtime title"]')
    expect(section?.querySelector('h3')?.textContent).toBe('Custom runtime title')
    expect(section?.textContent).toContain('Custom runtime description')
    const recheck = section?.querySelector<HTMLButtonElement>('[data-testid="runtimes-recheck"]')
    const checkedAt = section?.querySelector('[data-testid="runtimes-checked-at"]')
    expect(recheck?.textContent).toContain('Recheck')
    expect(recheck?.parentElement?.parentElement?.className).toContain('ml-auto')
    expect(checkedAt?.textContent).toContain('Last checked')
    expect(recheck?.nextElementSibling).toBe(checkedAt)
  })

  it('disables Recheck until the initial registry load settles', async () => {
    let resolveInitial:
      ((value: { python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }) => void) | undefined
    listEnvironments.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve
        })
    )
    await render()

    const recheck = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => /recheck/i.test(button.textContent ?? '')
    )
    expect(recheck?.disabled).toBe(true)
    await click(recheck ?? null)
    expect(listEnvironments).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveInitial?.({ python: pythonEnvs, r: rEnvs })
    })
    expect(recheck?.disabled).toBe(false)
  })

  it('shows a safe discovery failure instead of backend details and recovers on Recheck', async () => {
    const diagnostic = 'SQLITE_BUSY while reading /private/data/runtimes.db'
    listEnvironments.mockRejectedValueOnce(new Error(diagnostic))
    await render()

    expect(container.querySelector('[data-testid="runtimes-error"]')?.textContent).toBe(
      'Could not load runtimes.'
    )
    expect(container.textContent).not.toContain(diagnostic)
    expect(container.textContent).not.toContain('Detecting runtimes…')
    expect(container.querySelectorAll('[data-testid="runtime-card"]')).toHaveLength(0)

    const recheck = Array.from(container.querySelectorAll('button')).find((button) =>
      /recheck/i.test(button.textContent ?? '')
    )
    await click(recheck ?? null)

    expect(container.querySelector('[data-testid="runtimes-error"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="runtime-card"]')).toHaveLength(4)
  })

  it('does not infer default enablement when persisted enablement cannot be loaded', async () => {
    getEnablement.mockRejectedValueOnce(new Error('runtime enablement unavailable'))
    await render()

    expect(container.querySelector('[data-testid="runtimes-error"]')?.textContent).toBe(
      'Could not load runtimes.'
    )
    expect(container.textContent).not.toContain('runtime enablement unavailable')
    expect(container.querySelectorAll('[data-testid="runtime-card"]')).toHaveLength(0)
    expect(container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')).toBeNull()
  })

  it('keeps the last complete registry snapshot when Recheck fails', async () => {
    await render()
    expect(container.querySelector('[data-testid="runtime-packages-count"]')?.textContent).toBe('2')
    listEnvironments.mockRejectedValueOnce(new Error('runtime recheck unavailable'))

    const recheck = Array.from(container.querySelectorAll('button')).find((button) =>
      /recheck/i.test(button.textContent ?? '')
    )
    await click(recheck ?? null)

    expect(container.querySelector('[data-testid="runtimes-error"]')?.textContent).toBe(
      'Could not re-check runtimes.'
    )
    expect(container.textContent).not.toContain('runtime recheck unavailable')
    expect(container.querySelectorAll('[data-testid="runtime-card"]')).toHaveLength(4)
    expect(container.textContent).toContain('System Python')
    expect(container.querySelector('[data-testid="runtime-packages-count"]')?.textContent).toBe('2')
  })

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

  it('uses the theme color for Python and R managed-runtime actions', async () => {
    // Remove both managed interpreters so each language exposes the same setup action.
    listEnvironments.mockResolvedValue({ python: pythonEnvs.slice(1), r: rEnvs })
    await render()

    for (const language of ['Python', 'R']) {
      const section = container.querySelector(`section[aria-label="${language} runtime"]`)
      const setupButton = Array.from(section?.querySelectorAll('button') ?? []).find((button) =>
        /download and set up/i.test(button.textContent ?? '')
      )

      expect(setupButton?.getAttribute('data-variant')).toBe('default')
    }
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

  it('persists the Agent environment-creation toggle', async () => {
    await render()
    const toggle = container.querySelector('[aria-label="Let the Agent create environments"]')

    expect(toggle?.getAttribute('data-state')).toBe('checked')
    await click(toggle)

    expect(window.api.runtime.setAgentEnvironmentCreationEnabled).toHaveBeenCalledWith({
      enabled: false
    })
  })

  it('offers Reinstall only for the default app-managed runtime', async () => {
    const legacyManaged: DiscoveredInterpreter = {
      ...pythonEnvs[0],
      envId: '/data/runtime/envs/legacy-python/bin/python',
      interpreterPath: '/data/runtime/envs/legacy-python/bin/python',
      label: 'Legacy managed Python',
      condaEnv: 'legacy-python'
    }
    const agentCreated: DiscoveredInterpreter = {
      ...pythonEnvs[0],
      envId: '/data/runtime/envs/agent-analysis/bin/python',
      interpreterPath: '/data/runtime/envs/agent-analysis/bin/python',
      label: 'Agent analysis',
      provenance: 'agent-created',
      condaEnv: 'agent-analysis'
    }
    listEnvironments.mockResolvedValue({
      python: [pythonEnvs[0], legacyManaged, agentCreated, pythonEnvs[1]],
      r: rEnvs
    })

    await render()

    const reinstall = container.querySelector('[data-testid="runtime-reinstall-python"]')
    const packages = container.querySelector('[data-testid="runtime-packages-button"]')
    expect(reinstall).not.toBeNull()
    expect(reinstall?.getAttribute('data-variant')).toBe('outline')
    expect(reinstall?.textContent).toBe('Reinstall')
    expect(reinstall?.parentElement).toBe(packages?.parentElement)
    for (const label of ['Legacy managed Python', 'Agent analysis', 'System Python']) {
      const card = Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find(
        (candidate) => candidate.textContent?.includes(label)
      )
      expect(card?.querySelector('[data-testid="runtime-reinstall-python"]')).toBeNull()
    }
    expect(container.querySelector('[data-testid="runtime-reinstall-r"]')).toBeNull()
  })

  it('confirms a managed reinstall, forwards the exact env identity, and refreshes discovery', async () => {
    const refreshedPython: DiscoveredInterpreter = {
      ...pythonEnvs[0],
      envId: '/data/runtime/envs/default-python-new/bin/python',
      interpreterPath: '/data/runtime/envs/default-python-new/bin/python',
      label: 'Python 3.12 (reinstalled)'
    }
    listEnvironments
      .mockResolvedValueOnce({ python: pythonEnvs, r: rEnvs })
      .mockResolvedValueOnce({ python: [refreshedPython, pythonEnvs[1]], r: rEnvs })

    await render()
    await click(container.querySelector('[data-testid="runtime-reinstall-python"]'))

    const dialog = document.querySelector('[data-testid="runtime-reinstall-dialog"]')
    expect(repairBridge).not.toHaveBeenCalled()
    expect(dialog?.textContent).toContain('Active Notebook kernels will be stopped')
    expect(dialog?.textContent).toContain('idle kernels will be closed')
    expect(dialog?.textContent).toContain(
      'Notebook files, artifacts, and other data are not deleted'
    )
    expect(dialog?.textContent).toContain(
      'Packages installed after the original setup may need to be installed again.'
    )

    const confirmBtn = dialog
      ? Array.from(dialog.querySelectorAll('button')).find((button) =>
          /reinstall runtime/i.test(button.textContent ?? '')
        )
      : null
    await click(confirmBtn ?? null)

    expect(repairBridge).toHaveBeenCalledWith(
      'python',
      '/data/runtime/envs/default-python-3.12/bin/python',
      expect.any(String)
    )
    await act(async () => {})
    await act(async () => {})
    expect(container.textContent).toContain('Python 3.12 (reinstalled)')
    expect(container.textContent).not.toContain('runtime-reinstall-dialog')
  })

  it('offers the same managed reinstall flow for the default R runtime', async () => {
    const managedR: DiscoveredInterpreter = {
      language: 'r',
      provenance: 'app-managed',
      envId: '/data/runtime/envs/default-r/bin/R',
      interpreterPath: '/data/runtime/envs/default-r/bin/R',
      label: 'R 4.4.3 (managed)',
      version: '4.4.3',
      runnable: true,
      condaEnv: 'default-r'
    }
    listEnvironments.mockResolvedValue({ python: pythonEnvs, r: [managedR] })

    await render()
    await click(container.querySelector('[data-testid="runtime-reinstall-r"]'))
    const dialog = document.querySelector('[data-testid="runtime-reinstall-dialog"]')
    const confirmBtn = dialog
      ? Array.from(dialog.querySelectorAll('button')).find((button) =>
          /reinstall runtime/i.test(button.textContent ?? '')
        )
      : null
    await click(confirmBtn ?? null)

    expect(repairBridge).toHaveBeenCalledWith('r', managedR.envId, expect.any(String))
  })

  it('shows reinstall progress and disables mutation controls while the repair is active', async () => {
    let resolveRepair: (() => void) | undefined
    repairBridge.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRepair = resolve
        })
    )
    await render()
    await click(container.querySelector('[data-testid="runtime-reinstall-python"]'))
    const dialog = document.querySelector('[data-testid="runtime-reinstall-dialog"]')
    const confirmBtn = dialog
      ? Array.from(dialog.querySelectorAll('button')).find((button) =>
          /reinstall runtime/i.test(button.textContent ?? '')
        )
      : null
    await click(confirmBtn ?? null)

    const card = Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find(
      (candidate) => candidate.textContent?.includes('Python 3.12 (managed)')
    )
    expect(card?.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(card?.querySelector('[data-testid="runtime-packages-button"]')).toHaveProperty(
      'disabled',
      true
    )
    expect(
      card?.querySelector<HTMLElement>('[aria-label="Enable Python 3.12 (managed)"]')
    ).toHaveProperty('disabled', true)
    expect(
      Array.from(container.querySelectorAll('button')).find((button) =>
        /^recheck$/i.test((button.textContent ?? '').trim())
      )
    ).toHaveProperty('disabled', true)
    expect(card?.textContent).toContain('Reinstalling…')
    expect(card?.querySelector('[data-testid="runtime-reinstall-cancel-python"]')).toBeNull()
    resolveRepair?.()
    await act(async () => {})
    await act(async () => {})
  })

  it('keeps a failed reinstall out of Ready and leaves a retry action', async () => {
    repairBridge.mockRejectedValueOnce(new Error('verification failed'))
    await render()
    await click(container.querySelector('[data-testid="runtime-reinstall-python"]'))
    const dialog = document.querySelector('[data-testid="runtime-reinstall-dialog"]')
    const confirmBtn = dialog
      ? Array.from(dialog.querySelectorAll('button')).find((button) =>
          /reinstall runtime/i.test(button.textContent ?? '')
        )
      : null
    await click(confirmBtn ?? null)

    const card = Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find(
      (candidate) => candidate.textContent?.includes('Python 3.12 (managed)')
    )
    expect(card?.querySelector('[data-testid="runtime-operation-error-python"]')?.textContent).toBe(
      'Could not reinstall the runtime.'
    )
    expect(card?.querySelector('.lucide-circle-check')).toBeNull()
    expect(card?.textContent).not.toContain('Ready')
    expect(card?.querySelector('[data-testid="runtime-reinstall-python"]')).not.toBeNull()
  })

  it('does not offer package-install authorization for an agent-created environment', async () => {
    const agentCreated: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: '/data/runtime/envs/agent-analysis/bin/python',
      interpreterPath: '/data/runtime/envs/agent-analysis/bin/python',
      label: 'Agent analysis',
      version: '3.12.4',
      runnable: true
    }
    listEnvironments.mockResolvedValue({ python: [...pythonEnvs, agentCreated], r: rEnvs })

    await render()

    expect(
      container.querySelector('[aria-label="Enable Agent analysis"]')?.getAttribute('data-state')
    ).toBe('checked')
    expect(
      container.querySelector('[aria-label="Allow package install for Agent analysis"]')
    ).toBeNull()
  })

  it('lets an enabled user-owned Python environment authorize package installation', async () => {
    getEnablement.mockResolvedValue({
      enabled: { '/usr/bin/python3': true },
      installAuthorized: {}
    })
    setInstallAuthorized.mockResolvedValue({
      enabled: { '/usr/bin/python3': true },
      installAuthorized: { '/usr/bin/python3': true }
    })

    await render()

    const installToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Allow package install for System Python"]'
    )
    expect(installToggle?.disabled).toBe(false)

    await click(installToggle)

    expect(setInstallAuthorized).toHaveBeenCalledWith('python', '/usr/bin/python3', true)
  })

  it('explains that package installation is unavailable for an enabled user-owned R environment', async () => {
    getEnablement.mockImplementation(async (language: string) =>
      language === 'r'
        ? {
            enabled: { '/opt/conda/envs/bio/bin/R': true },
            installAuthorized: { '/opt/conda/envs/bio/bin/R': true }
          }
        : enablement
    )

    await render()

    const installToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Allow package install for R 4.4.1"]'
    )
    expect(installToggle?.disabled).toBe(true)
    expect(installToggle?.getAttribute('data-state')).toBe('unchecked')
    expect(container.textContent).toContain(
      'Open Science cannot install packages into user-owned R environments yet. You can still manage packages in the environment yourself.'
    )
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

  it('does not disable an enabled runtime when its live usage cannot be checked', async () => {
    describeUsage.mockRejectedValueOnce(new Error('usage query unavailable'))
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')

    await click(managedToggle)

    expect(setEnvironmentEnabled).not.toHaveBeenCalled()
    expect(managedToggle?.getAttribute('data-state')).toBe('checked')
    expect(container.querySelector('[data-testid="runtimes-error"]')?.textContent).toContain(
      'Could not check whether that runtime is in use, so it was not disabled.'
    )
  })

  it('warns before disabling a runtime that live sessions are using, then applies on confirm (WS11)', async () => {
    describeUsage.mockResolvedValue({ running: 1, idle: 0, dormant: 0 })
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')
    await click(managedToggle)

    // The impact dialog is shown and the disable is NOT applied yet.
    const dialog = document.querySelector('[data-testid="disable-impact-dialog"]')
    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('1 running')
    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(overlay?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(overlay?.className).not.toContain('backdrop-blur')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.className).toContain('p-0')
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-b border-border-300/90')
      )
    ).toBe(true)
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-t border-border-300/90')
      )
    ).toBe(true)
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
    expect(provision).toHaveBeenCalledWith('r', expect.any(String))
    // The failure surfaces on R's OWN card (per-language error), and its button offers a retry.
    expect(
      container.querySelector('[data-testid="runtimes-provision-error-r"]')?.textContent
    ).toContain('runtime CDN unavailable')
    const retryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /^retry setup$/i.test((button.textContent ?? '').trim())
    )
    expect(retryButton?.getAttribute('data-variant')).toBe('default')
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

  it('shows a clear local-desktop message when remote runtime management is restricted', async () => {
    pickInterpreter.mockRejectedValueOnce(
      new Error(
        'This action is only available in the local desktop app (runtime:pick-interpreter).'
      )
    )
    await render()
    const addBtn = Array.from(container.querySelectorAll('button')).find((button) =>
      /add interpreter/i.test(button.textContent ?? '')
    )

    await click(addBtn ?? null)

    expect(container.querySelector('[data-testid="runtimes-error"]')?.textContent).toContain(
      'only available in the local desktop app'
    )
    expect(registerInterpreter).not.toHaveBeenCalled()
  })

  it('blocks app-managed setup while the authoritative environment status is unavailable', async () => {
    ;(window.api.notebookEnv.getStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('status unavailable')
    )
    useNotebookEnvStore.setState({ statusError: 'status unavailable' })
    await render()

    const rSection = container.querySelector('section[aria-label="R runtime"]')
    const setupButton = Array.from(rSection?.querySelectorAll('button') ?? []).find((button) =>
      /download and set up/i.test(button.textContent ?? '')
    )

    expect(setupButton?.disabled).toBe(true)
    await click(setupButton ?? null)
    expect(provision).not.toHaveBeenCalled()
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
    expect(resetBtn?.getAttribute('data-variant')).toBe('default')
    await click(resetBtn ?? null)
    const dialog = document.querySelector('[data-testid="runtime-reinstall-dialog"]')
    expect(dialog?.textContent).toContain('Reset R?')
    expect(dialog?.textContent).toContain('Active Notebook kernels will be stopped')
    const confirmBtn = dialog
      ? Array.from(dialog.querySelectorAll('button')).find((b) =>
          /^reset runtime$/i.test((b.textContent ?? '').trim())
        )
      : null
    await click(confirmBtn ?? null)
    expect(repairBridge).toHaveBeenCalledWith('r', 'default-r', expect.any(String))
  })

  it('surfaces Reset in the existing managed runtime card after interrupted upgrade/install', async () => {
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
    const card = Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find(
      (candidate) => candidate.textContent?.includes('Python 3.12 (managed)')
    )
    expect(card).toBeDefined()
    expect(container.querySelector('[data-testid="runtimes-recovery-blocked-python"]')).toBeNull()
    const resetBtn = card?.querySelector('[data-testid="runtime-reset-python"]')
    expect(resetBtn).toBeDefined()
    expect(resetBtn?.getAttribute('data-variant')).toBe('default')
    await click(resetBtn ?? null)
    const dialog = document.querySelector('[data-testid="runtime-reinstall-dialog"]')
    expect(dialog?.textContent).toContain('Reset Python 3.12 (managed)?')
    const confirmBtn = dialog
      ? Array.from(dialog.querySelectorAll('button')).find((b) =>
          /^reset runtime$/i.test((b.textContent ?? '').trim())
        )
      : null
    await click(confirmBtn ?? null)
    expect(repairBridge).toHaveBeenCalledWith(
      'python',
      '/data/runtime/envs/default-python-3.12/bin/python',
      expect.any(String)
    )
  })

  it('offers Reset immediately when a failed reinstall removes the discovered runtime', async () => {
    repairBridge.mockRejectedValueOnce(new Error('rebuild failed after prefix deletion'))
    listEnvironments
      .mockResolvedValueOnce({ python: pythonEnvs, r: rEnvs })
      .mockResolvedValueOnce({ python: [pythonEnvs[1]], r: rEnvs })
    const getStatus = window.api.notebookEnv.getStatus as ReturnType<typeof vi.fn>
    getStatus
      .mockResolvedValueOnce(provisionStatus)
      .mockResolvedValueOnce({ ...provisionStatus, pythonRecoveryBlocked: true })

    await render()
    await click(container.querySelector('[data-testid="runtime-reinstall-python"]'))
    const dialog = document.querySelector('[data-testid="runtime-reinstall-dialog"]')
    const confirmBtn = dialog
      ? Array.from(dialog.querySelectorAll('button')).find((button) =>
          /reinstall runtime/i.test(button.textContent ?? '')
        )
      : null
    await click(confirmBtn ?? null)
    await act(async () => {})
    await act(async () => {})

    const resetBtn = Array.from(container.querySelectorAll('button')).find((button) =>
      /^reset runtime$/i.test((button.textContent ?? '').trim())
    )
    expect(resetBtn).toBeDefined()
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

  it('does not re-enable setup while refreshing environments after provision completes', async () => {
    let resolveRefresh:
      ((value: { python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }) => void) | undefined
    const installedR: DiscoveredInterpreter = {
      language: 'r',
      provenance: 'app-managed',
      envId: '/data/runtime/envs/default-r/bin/R',
      interpreterPath: '/data/runtime/envs/default-r/bin/R',
      label: 'R 4.4.3 (managed)',
      version: '4.4.3',
      runnable: true,
      condaEnv: 'default-r'
    }
    provision.mockResolvedValue(undefined)
    listEnvironments.mockResolvedValueOnce({ python: pythonEnvs, r: rEnvs }).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    await render()

    const setupButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /download and set up/i.test(button.textContent ?? '')
    )
    await click(setupButton ?? null)

    const finishingButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /^finishing setup…$/i.test((button.textContent ?? '').trim())
    )
    const finishingDisabled = (finishingButton as HTMLButtonElement | undefined)?.disabled
    const setupWasReenabled = container.textContent?.includes('Download and set up')

    resolveRefresh?.({ python: pythonEnvs, r: [installedR, ...rEnvs] })
    await act(async () => {})

    expect(finishingButton).toBeDefined()
    expect(finishingDisabled).toBe(true)
    expect(setupWasReenabled).toBe(false)
    expect(container.textContent).toContain('R 4.4.3 (managed)')
  })
})

describe('RuntimesPanel packages dialog', () => {
  const setInputValue = (input: HTMLInputElement, value: string): void => {
    // React's onChange reads value via the synthetic event; the native setter bypasses its tracking.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const flush = async (): Promise<void> => {
    await act(async () => {})
    await act(async () => {})
  }

  const cardWith = (text: string): Element | undefined =>
    Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find((card) =>
      card.textContent?.includes(text)
    )

  it('shows a Packages button on runnable env cards only, then a count badge per env', async () => {
    await render()
    // Runnable: managed python + System Python. The non-runnable R conda card has no button.
    expect(
      cardWith('Python 3.12 (managed)')?.querySelector('[data-testid="runtime-packages-button"]')
    ).not.toBeNull()
    expect(
      cardWith('System Python')?.querySelector('[data-testid="runtime-packages-button"]')
    ).not.toBeNull()
    expect(cardWith('R 4.4.1')?.querySelector('[data-testid="runtime-packages-button"]')).toBeNull()

    // Counts land lazily after the panel loads: ONE bulk listPackageCounts call for python (the
    // only language with runnable envs here) — no per-env listPackages calls for badges.
    await flush()
    expect(listPackageCounts).toHaveBeenCalledWith('python')
    expect(listPackageCounts).toHaveBeenCalledTimes(1)
    expect(listPackageCounts).not.toHaveBeenCalledWith('r')
    expect(listPackages).not.toHaveBeenCalled()
    const managedBadge = cardWith('Python 3.12 (managed)')?.querySelector(
      '[data-testid="runtime-packages-count"]'
    )
    const systemBadge = cardWith('System Python')?.querySelector(
      '[data-testid="runtime-packages-count"]'
    )
    expect(managedBadge?.textContent).toBe('2')
    expect(systemBadge?.textContent).toBe('1')
  })

  it('omits the count badge when the bulk count fetch fails (no card-level error UI)', async () => {
    listPackageCounts.mockRejectedValue(new Error('discovery failed'))
    await render()
    await flush()
    expect(container.querySelector('[data-testid="runtime-packages-count"]')).toBeNull()
    expect(container.querySelector('[data-testid="runtimes-error"]')).toBeNull()
  })

  it('omits a badge for envs whose count came back null in the bulk response', async () => {
    listPackageCounts.mockResolvedValue({
      '/data/runtime/envs/default-python-3.12/bin/python': 2,
      '/usr/bin/python3': null
    })
    await render()
    await flush()
    expect(
      cardWith('Python 3.12 (managed)')?.querySelector('[data-testid="runtime-packages-count"]')
        ?.textContent
    ).toBe('2')
    expect(
      cardWith('System Python')?.querySelector('[data-testid="runtime-packages-count"]')
    ).toBeNull()
  })

  it('opens the dialog with package rows and conda columns, and the filter narrows rows', async () => {
    await render()
    await flush()
    const button = cardWith('Python 3.12 (managed)')?.querySelector(
      '[data-testid="runtime-packages-button"]'
    )
    await click(button ?? null)

    const dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.className).toContain('p-0')
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-b border-border-300/90')
      )
    ).toBe(true)
    expect(dialog?.textContent).toContain('Packages in Python 3.12 (managed)')
    expect(dialog?.textContent).toContain('/data/runtime/envs/default-python-3.12/bin/python')
    expect(document.querySelectorAll('[data-testid="runtime-package-row"]').length).toBe(2)
    // Conda-style listing: Build/Channel columns + the conda/pypi summary.
    expect(dialog?.textContent).toContain('Build')
    expect(dialog?.textContent).toContain('Channel')
    expect(dialog?.textContent).toContain('py312hb2f4e1b_0')
    expect(dialog?.textContent).toContain('2 of 2 · 2 conda, 0 pypi')

    const filter = document.querySelector<HTMLInputElement>(
      '[data-testid="runtime-packages-filter"]'
    )
    expect(filter).not.toBeNull()
    filter?.blur()
    const shortcutEvent = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      cancelable: true
    })
    await act(async () => window.dispatchEvent(shortcutEvent))
    expect(shortcutEvent.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(filter)
    expect(filter?.getAttribute('aria-keyshortcuts')).toBe('Control+K')

    await act(async () => setInputValue(filter!, 'nump'))
    expect(document.querySelectorAll('[data-testid="runtime-package-row"]').length).toBe(1)
    expect(dialog?.textContent).toContain('1 of 2 · 2 conda, 0 pypi')
  })

  it('shows name/version only (no conda columns or summary) for pip-style listings', async () => {
    await render()
    await flush()
    const button = cardWith('System Python')?.querySelector(
      '[data-testid="runtime-packages-button"]'
    )
    await click(button ?? null)

    const dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(document.querySelectorAll('[data-testid="runtime-package-row"]').length).toBe(1)
    expect(dialog?.textContent).toContain('requests')
    expect(dialog?.textContent).not.toContain('Build')
    expect(dialog?.textContent).toContain('1 of 1')
    expect(dialog?.textContent).not.toContain('conda')
  })

  it('shows an error with retry when the dialog fetch fails, and recovers on retry', async () => {
    await render()
    await flush()
    listPackages.mockRejectedValueOnce(new Error('micromamba list failed'))
    const button = cardWith('Python 3.12 (managed)')?.querySelector(
      '[data-testid="runtime-packages-button"]'
    )
    await click(button ?? null)

    const dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(dialog?.textContent).toContain('micromamba list failed')
    const retry = Array.from(document.querySelectorAll('button')).find((b) =>
      /^retry$/i.test((b.textContent ?? '').trim())
    )
    await click(retry ?? null)
    await flush()
    expect(document.querySelectorAll('[data-testid="runtime-package-row"]').length).toBe(2)
  })

  it('shows the conda env name badge for app-owned conda envs, without duplicating it for user-own', async () => {
    const condaEnvs: DiscoveredInterpreter[] = [
      {
        language: 'python',
        provenance: 'app-managed',
        envId: '/data/runtime/envs/default-python/bin/python',
        interpreterPath: '/data/runtime/envs/default-python/bin/python',
        label: 'Python 3.12 (managed)',
        version: '3.12.4',
        runnable: true,
        condaEnv: 'default-python'
      },
      {
        language: 'python',
        provenance: 'user-own',
        envId: '/opt/conda/envs/bio/bin/python',
        interpreterPath: '/opt/conda/envs/bio/bin/python',
        label: 'conda: bio',
        version: '3.11.2',
        runnable: true,
        condaEnv: 'bio'
      }
    ]
    listEnvironments.mockResolvedValue({ python: condaEnvs, r: [] })
    await render()
    await flush()

    const occurrences = (dialog: Element | null, text: string): number =>
      (dialog?.textContent ?? '').split(text).length - 1

    // App-owned conda env: provenance badge is "App-managed", so the conda name gets its own badge.
    await click(
      cardWith('Python 3.12 (managed)')?.querySelector('[data-testid="runtime-packages-button"]') ??
        null
    )
    let dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(dialog?.textContent).toContain('App-managed')
    expect(occurrences(dialog, 'Conda: default-python')).toBe(1)

    // Close, then the user-own conda env: providerType() already yields "Conda: bio" as the
    // provenance badge — the name must appear exactly once (no duplicate second badge).
    const closeBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      /^close$/i.test((b.textContent ?? '').trim())
    )
    await click(closeBtn ?? null)
    await click(
      cardWith('conda: bio')?.querySelector('[data-testid="runtime-packages-button"]') ?? null
    )
    dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(occurrences(dialog, 'Conda: bio')).toBe(1)
  })
})
