import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { PackageMirror } from '../../../shared/mirror'
import type { NetworkProxySettings } from '../../../shared/network-proxy'
import {
  DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  type NotebookNetworkSettings
} from '../../../shared/notebook-network'
import type {
  AppIconVariant,
  ProjectFilesFilterPreference,
  ReasoningEffort,
  ReviewerModelConfiguration,
  SessionDetailsModelConfiguration,
  SettingsSnapshot,
  SubagentModelConfiguration,
  VisionModelConfiguration
} from '../../../shared/settings'
import type { CloseActionPreference } from '../../../shared/window-controls'
import type { PermissionProfileId } from '../../../shared/permission-profiles'
import {
  createSettingsPreferencesSlice,
  type SettingsPreferencesActions
} from './settings-preferences-slice'
import { createSettingsWriteCoordinator } from './settings-write-coordinator'

type PreferencesCommands = Pick<
  Window['api']['settings'],
  | 'setReasoningEffort'
  | 'getSettings'
  | 'setReviewerModel'
  | 'setSessionDetailsModel'
  | 'setSubagentModel'
  | 'setVisionModel'
  | 'setNotificationsEnabled'
  | 'setShowNotificationContent'
  | 'setConversationSkillImportEnabled'
  | 'setClosePreference'
  | 'setAppIconVariant'
  | 'setProjectFilesFilter'
  | 'setDefaultPermissionProfile'
  | 'markOnboardingComplete'
  | 'setPackageMirror'
  | 'setNetworkProxy'
  | 'setNotebookNetwork'
>

type CommandMocks = Required<{ [Command in keyof PreferencesCommands]: Mock }>

type TestStore = SettingsPreferencesActions & {
  onboardingCompletedAt?: number
  networkProxy?: NetworkProxySettings
  packageMirror?: PackageMirror
  notebookNetwork: NotebookNetworkSettings
  reasoningEffort: ReasoningEffort
  reviewerModel?: ReviewerModelConfiguration
  reviewerModelPending?: boolean
  sessionDetailsModel?: SessionDetailsModelConfiguration
  sessionDetailsModelPending?: boolean
  subagentModel?: SubagentModelConfiguration
  subagentModelPending?: boolean
  visionModel?: VisionModelConfiguration
  visionModelPending?: boolean
  notificationsEnabled: boolean
  showNotificationContent: boolean
  conversationSkillImportEnabled: boolean
  closePreference: CloseActionPreference | undefined
  appIconVariant: AppIconVariant
  projectFilesFilter: ProjectFilesFilterPreference | undefined
  defaultPermissionProfile: PermissionProfileId

  settingsWriteError: string | undefined
}

const snapshot = (patch: Partial<SettingsSnapshot> = {}): SettingsSnapshot => ({
  claude: {},
  activeProviderId: undefined,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  opencode: {},
  codex: {},
  codebuddy: {},
  claudeManaged: false,
  opencodeManaged: false,
  codexManaged: false,
  codebuddyManaged: false,
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light',
  defaultPermissionProfile: 'ask',
  ...patch
})

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} => {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

// Preference writes accumulate like the real settings.json: a later command's snapshot still
// carries earlier writes, so reconcile never clobbers a sibling preference back to its default.
const createCommands = (persisted: Partial<SettingsSnapshot>): CommandMocks => {
  const save = <K extends keyof SettingsSnapshot>(
    key: K,
    value: SettingsSnapshot[K]
  ): Promise<SettingsSnapshot> =>
    Promise.resolve(snapshot({ ...persisted, [key]: (persisted[key] = value) }))

  return {
    getSettings: vi.fn(() => Promise.resolve(snapshot(persisted))),
    setReasoningEffort: vi.fn(({ effort }) => save('reasoningEffort', effort)),
    setReviewerModel: vi.fn(({ configuration }) => save('reviewerModel', configuration)),
    setSessionDetailsModel: vi.fn(({ configuration }) =>
      save('sessionDetailsModel', configuration)
    ),
    setSubagentModel: vi.fn(({ configuration }) => save('subagentModel', configuration)),
    setVisionModel: vi.fn(({ configuration }) => save('visionModel', configuration)),
    setNotificationsEnabled: vi.fn(({ enabled }) => save('notificationsEnabled', enabled)),
    setShowNotificationContent: vi.fn(({ enabled }) => save('showNotificationContent', enabled)),
    setConversationSkillImportEnabled: vi.fn(({ enabled }) =>
      save('conversationSkillImportEnabled', enabled)
    ),
    setClosePreference: vi.fn(({ preference }) => save('closePreference', preference)),
    setAppIconVariant: vi.fn(({ variant }) => save('appIconVariant', variant)),
    setProjectFilesFilter: vi.fn(({ filter }) => save('projectFilesFilter', filter)),
    setDefaultPermissionProfile: vi.fn(({ profile }) => save('defaultPermissionProfile', profile)),
    markOnboardingComplete: vi.fn(() => {
      persisted.onboardingCompletedAt = 42
      return Promise.resolve(snapshot(persisted))
    }),
    setPackageMirror: vi.fn((mirror) => {
      persisted.packageMirror = mirror
      return Promise.resolve(mirror)
    }),
    setNetworkProxy: vi.fn((settings) => {
      persisted.networkProxy = settings
      return Promise.resolve(settings)
    }),
    setNotebookNetwork: vi.fn((settings) => {
      const saved = {
        allowedDomains: settings.allowedDomains,
        disabledOpenScienceDomainGroups: settings.disabledOpenScienceDomainGroups,
        disabledOpenScienceDomains: settings.disabledOpenScienceDomains
      }
      persisted.notebookNetwork = saved
      return Promise.resolve(saved)
    })
  }
}

const createHarness = (): {
  commands: CommandMocks
  reconcileSnapshot: Mock
  store: StoreApi<TestStore>
} => {
  const persisted: Partial<SettingsSnapshot> = {}
  const commands = createCommands(persisted)
  const reconcileSnapshot = vi.fn((next: SettingsSnapshot) => {
    store.setState({
      onboardingCompletedAt: next.onboardingCompletedAt,
      networkProxy: next.networkProxy,
      packageMirror: next.packageMirror,
      notebookNetwork: next.notebookNetwork ?? DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      reasoningEffort: next.reasoningEffort,
      reviewerModel: next.reviewerModel,
      sessionDetailsModel: next.sessionDetailsModel,
      subagentModel: next.subagentModel,
      visionModel: next.visionModel,
      notificationsEnabled: next.notificationsEnabled,
      showNotificationContent: next.showNotificationContent ?? false,
      conversationSkillImportEnabled: next.conversationSkillImportEnabled,
      closePreference: next.closePreference,
      appIconVariant: next.appIconVariant,
      projectFilesFilter: next.projectFilesFilter,
      defaultPermissionProfile: next.defaultPermissionProfile ?? 'ask'
    })
  })
  const store = createStore<TestStore>((set, get) => ({
    reasoningEffort: 'default',
    reviewerModelPending: false,
    sessionDetailsModelPending: false,
    subagentModelPending: false,
    visionModelPending: false,
    notificationsEnabled: true,
    showNotificationContent: false,
    conversationSkillImportEnabled: true,
    closePreference: undefined,
    appIconVariant: 'light',
    projectFilesFilter: undefined,
    defaultPermissionProfile: 'ask',
    notebookNetwork: DEFAULT_NOTEBOOK_NETWORK_SETTINGS,

    settingsWriteError: undefined,
    ...createSettingsPreferencesSlice({
      getState: get,
      setState: (patch) => set(patch),
      getCommands: () => commands as unknown as PreferencesCommands,
      reconcileSnapshot,
      writeCoordinator: createSettingsWriteCoordinator((settingsWriteError) =>
        set({ settingsWriteError })
      )
    })
  }))

  return { commands, reconcileSnapshot, store }
}

describe('settings preferences slice', () => {
  let commands: CommandMocks
  let reconcileSnapshot: Mock
  let store: StoreApi<TestStore>

  beforeEach(() => {
    vi.restoreAllMocks()
    ;({ commands, reconcileSnapshot, store } = createHarness())
  })

  it('forwards preference writes and reconciles each returned snapshot', async () => {
    await store.getState().setReasoningEffort('high')
    await store.getState().setNotificationsEnabled(false)
    await store.getState().setShowNotificationContent(true)
    await store.getState().setConversationSkillImportEnabled(false)
    await store.getState().setClosePreference('minimize')
    await store.getState().setAppIconVariant('dark')
    await store.getState().setProjectFilesFilter({ sourceMode: 'local', localRootId: 'root-1' })
    await store.getState().setDefaultPermissionProfile('auto')

    expect(commands.setReasoningEffort).toHaveBeenCalledWith({ effort: 'high' })
    expect(commands.setNotificationsEnabled).toHaveBeenCalledWith({ enabled: false })
    expect(commands.setShowNotificationContent).toHaveBeenCalledWith({ enabled: true })
    expect(commands.setConversationSkillImportEnabled).toHaveBeenCalledWith({ enabled: false })
    expect(commands.setClosePreference).toHaveBeenCalledWith({ preference: 'minimize' })
    expect(commands.setAppIconVariant).toHaveBeenCalledWith({ variant: 'dark' })
    expect(commands.setProjectFilesFilter).toHaveBeenCalledWith({
      filter: { sourceMode: 'local', localRootId: 'root-1' }
    })
    expect(store.getState().projectFilesFilter).toEqual({
      sourceMode: 'local',
      localRootId: 'root-1'
    })
    expect(commands.setDefaultPermissionProfile).toHaveBeenCalledWith({ profile: 'auto' })

    expect(reconcileSnapshot).toHaveBeenCalledTimes(8)
  })

  it('applies immediately, then rolls back and exposes the unchanged failure copy', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const pending = deferred<SettingsSnapshot>()
    commands.setReasoningEffort.mockReturnValue(pending.promise)

    const write = store.getState().setReasoningEffort('max')
    expect(store.getState().reasoningEffort).toBe('max')

    pending.reject(new Error('ipc down'))
    await write

    expect(store.getState().reasoningEffort).toBe('default')
    expect(store.getState().settingsWriteError).toBe('Could not save reasoning effort. Try again.')
    expect(consoleError).toHaveBeenCalledWith('Failed to set reasoning effort', expect.any(Error))
  })

  it('serializes same-key writes and keeps the last confirmed value when the newer write fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = deferred<SettingsSnapshot>()
    commands.setReasoningEffort
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('newer failure'))

    const olderWrite = store.getState().setReasoningEffort('high')
    const newerWrite = store.getState().setReasoningEffort('max')

    expect(commands.setReasoningEffort).toHaveBeenCalledTimes(1)
    first.resolve(snapshot({ reasoningEffort: 'high' }))
    await Promise.all([olderWrite, newerWrite])

    expect(commands.setReasoningEffort).toHaveBeenCalledTimes(2)
    expect(store.getState().reasoningEffort).toBe('high')
    expect(store.getState().settingsWriteError).toBe('Could not save reasoning effort. Try again.')
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('keeps onboarding and package-mirror settlement non-optimistic', async () => {
    await store.getState().completeOnboarding()
    await store.getState().setPackageMirror({ pypiIndex: 'https://mirror.example/simple' })

    expect(store.getState().onboardingCompletedAt).toBe(42)
    expect(store.getState().packageMirror).toEqual({
      pypiIndex: 'https://mirror.example/simple'
    })

    commands.setPackageMirror.mockResolvedValueOnce({})
    commands.getSettings.mockResolvedValueOnce(snapshot({ onboardingCompletedAt: 42 }))
    await store.getState().setPackageMirror({})
    expect(store.getState().packageMirror).toBeUndefined()
  })

  it('persists scenario model preferences and clears their pending flags', async () => {
    const reviewer = {
      mode: 'fixed',
      providerId: 'provider-1',
      model: 'reviewer-model',
      reasoningEffort: 'high'
    } as const satisfies ReviewerModelConfiguration
    const sessionDetails = {
      mode: 'inherit',
      reasoningEffort: 'low'
    } as const satisfies SessionDetailsModelConfiguration
    const subagent = {
      mode: 'fixed',
      providerId: 'provider-1',
      model: 'subagent-model',
      reasoningEffort: 'medium'
    } as const satisfies SubagentModelConfiguration
    const vision = {
      providerId: 'provider-1',
      model: 'vision-model',
      reasoningEffort: 'default'
    } as const satisfies VisionModelConfiguration

    const reviewerWrite = store.getState().setReviewerModel(reviewer)
    expect(store.getState().reviewerModelPending).toBe(true)
    await reviewerWrite

    const sessionDetailsWrite = store.getState().setSessionDetailsModel(sessionDetails)
    expect(store.getState().sessionDetailsModelPending).toBe(true)
    await sessionDetailsWrite

    const subagentWrite = store.getState().setSubagentModel(subagent)
    expect(store.getState().subagentModelPending).toBe(true)
    await subagentWrite

    const visionWrite = store.getState().setVisionModel(vision)
    expect(store.getState().visionModelPending).toBe(true)
    await visionWrite

    expect(commands.setReviewerModel).toHaveBeenCalledWith({ configuration: reviewer })
    expect(commands.setSessionDetailsModel).toHaveBeenCalledWith({ configuration: sessionDetails })
    expect(commands.setSubagentModel).toHaveBeenCalledWith({ configuration: subagent })
    expect(commands.setVisionModel).toHaveBeenCalledWith({ configuration: vision })
    expect(store.getState()).toMatchObject({
      reviewerModel: reviewer,
      reviewerModelPending: false,
      sessionDetailsModel: sessionDetails,
      sessionDetailsModelPending: false,
      subagentModel: subagent,
      subagentModelPending: false,
      visionModel: vision,
      visionModelPending: false
    })
  })

  it('refreshes settings and reports each rejected non-optimistic model write', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    commands.setReviewerModel.mockRejectedValueOnce(new Error('reviewer rejected'))
    commands.setSubagentModel.mockRejectedValueOnce(new Error('subagent rejected'))
    commands.setVisionModel.mockRejectedValueOnce(new Error('vision rejected'))

    await store.getState().setReviewerModel({ mode: 'inherit' })
    await store.getState().setSubagentModel({ mode: 'inherit' })
    await store.getState().setVisionModel(undefined)

    expect(commands.getSettings).toHaveBeenCalledTimes(3)
    expect(reconcileSnapshot).toHaveBeenCalledTimes(3)
    expect(store.getState()).toMatchObject({
      reviewerModelPending: false,
      subagentModelPending: false,
      visionModelPending: false
    })
    expect(store.getState().settingsWriteError).toContain('Could not save Reviewer model.')
    expect(store.getState().settingsWriteError).toContain('Could not save Subagent model.')
    expect(store.getState().settingsWriteError).toContain('Could not save Vision model.')
    expect(consoleError).toHaveBeenCalledTimes(3)
  })

  it('ignores a stale Reviewer model completion after a newer write settles', async () => {
    const older = deferred<SettingsSnapshot>()
    const newer = deferred<SettingsSnapshot>()
    commands.setReviewerModel.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)

    const olderWrite = store.getState().setReviewerModel({ mode: 'inherit' })
    const fixed = {
      mode: 'fixed',
      providerId: 'provider-1',
      model: 'reviewer-model',
      reasoningEffort: 'high'
    } as const satisfies ReviewerModelConfiguration
    const newerWrite = store.getState().setReviewerModel(fixed)

    newer.resolve(snapshot({ reviewerModel: fixed }))
    await newerWrite
    older.resolve(snapshot({ reviewerModel: { mode: 'inherit' } }))
    await olderWrite

    expect(store.getState().reviewerModel).toEqual(fixed)
    expect(store.getState().reviewerModelPending).toBe(false)
    expect(reconcileSnapshot).toHaveBeenCalledOnce()
  })

  it('persists network proxy settings and fails closed when the command is unavailable', async () => {
    const proxy = {
      mode: 'manual',
      server: 'http://127.0.0.1:1086',
      bypassRules: 'localhost'
    } as const satisfies NetworkProxySettings

    await store.getState().setNetworkProxy(proxy)

    expect(commands.setNetworkProxy).toHaveBeenCalledWith(proxy)
    expect(store.getState().networkProxy).toEqual(proxy)

    commands.setNetworkProxy = undefined as unknown as Mock
    await expect(store.getState().setNetworkProxy({ mode: 'direct' })).rejects.toThrow(
      'Network proxy settings are unavailable.'
    )
  })

  it('persists Notebook network settings as one global policy', async () => {
    const notebookNetwork = {
      allowedDomains: ['data.example.org'],
      disabledOpenScienceDomainGroups: ['literature'],
      disabledOpenScienceDomains: ['rest.uniprot.org']
    } as const satisfies NotebookNetworkSettings

    await expect(
      store.getState().setNotebookNetwork(notebookNetwork, ['baseline.example.org'])
    ).resolves.toEqual(notebookNetwork)

    expect(commands.setNotebookNetwork).toHaveBeenCalledWith({
      ...notebookNetwork,
      baseAllowedDomains: ['baseline.example.org']
    })
    expect(store.getState().notebookNetwork).toEqual(notebookNetwork)

    commands.setNotebookNetwork = undefined as unknown as Mock
    await expect(store.getState().setNotebookNetwork(notebookNetwork)).rejects.toThrow(
      'Notebook network settings are unavailable.'
    )
  })
})
