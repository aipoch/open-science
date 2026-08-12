import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { PackageMirror } from '../../../shared/mirror'
import type {
  AppIconVariant,
  ProjectFilesFilterPreference,
  ReasoningEffort,
  SettingsSnapshot
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
  | 'setNotificationsEnabled'
  | 'setConversationSkillImportEnabled'
  | 'setClosePreference'
  | 'setAppIconVariant'
  | 'setProjectFilesFilter'
  | 'setDefaultPermissionProfile'
  | 'markOnboardingComplete'
  | 'setPackageMirror'
>

type CommandMocks = { [Command in keyof PreferencesCommands]: Mock }

type TestStore = SettingsPreferencesActions & {
  onboardingCompletedAt?: number
  packageMirror?: PackageMirror
  reasoningEffort: ReasoningEffort
  notificationsEnabled: boolean
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
  claudeManaged: false,
  opencodeManaged: false,
  codexManaged: false,
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
    setReasoningEffort: vi.fn(({ effort }) => save('reasoningEffort', effort)),
    setNotificationsEnabled: vi.fn(({ enabled }) => save('notificationsEnabled', enabled)),
    setConversationSkillImportEnabled: vi.fn(({ enabled }) =>
      save('conversationSkillImportEnabled', enabled)
    ),
    setClosePreference: vi.fn(({ preference }) => save('closePreference', preference)),
    setAppIconVariant: vi.fn(({ variant }) => save('appIconVariant', variant)),
    setProjectFilesFilter: vi.fn(({ filter }) => save('projectFilesFilter', filter)),
    setDefaultPermissionProfile: vi.fn(({ profile }) => save('defaultPermissionProfile', profile)),
    markOnboardingComplete: vi.fn().mockResolvedValue(snapshot({ onboardingCompletedAt: 42 })),
    setPackageMirror: vi.fn((mirror) => Promise.resolve(mirror))
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
      packageMirror: next.packageMirror,
      reasoningEffort: next.reasoningEffort,
      notificationsEnabled: next.notificationsEnabled,
      conversationSkillImportEnabled: next.conversationSkillImportEnabled,
      closePreference: next.closePreference,
      appIconVariant: next.appIconVariant,
      projectFilesFilter: next.projectFilesFilter,
      defaultPermissionProfile: next.defaultPermissionProfile ?? 'ask'
    })
  })
  const store = createStore<TestStore>((set, get) => ({
    reasoningEffort: 'default',
    notificationsEnabled: true,
    conversationSkillImportEnabled: true,
    closePreference: undefined,
    appIconVariant: 'light',
    projectFilesFilter: undefined,
    defaultPermissionProfile: 'ask',

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
    await store.getState().setConversationSkillImportEnabled(false)
    await store.getState().setClosePreference('minimize')
    await store.getState().setAppIconVariant('dark')
    await store.getState().setProjectFilesFilter({ sourceMode: 'local', localRootId: 'root-1' })
    await store.getState().setDefaultPermissionProfile('auto')

    expect(commands.setReasoningEffort).toHaveBeenCalledWith({ effort: 'high' })
    expect(commands.setNotificationsEnabled).toHaveBeenCalledWith({ enabled: false })
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

    expect(reconcileSnapshot).toHaveBeenCalledTimes(7)
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
    await store.getState().setPackageMirror({})
    expect(store.getState().packageMirror).toBeUndefined()
  })
})
