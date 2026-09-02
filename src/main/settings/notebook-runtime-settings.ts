import type { PackageMirror } from '../../shared/mirror'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeSelection } from '../../shared/notebook-runtime'
import type { SetPackageMirrorRequest } from '../../shared/settings'
import type { NotebookRuntimeSettings, NotebookRuntimeSettingsSnapshot } from './capabilities'
import type { SettingsRepository } from './repository'
import type { StoredSettings } from './types'

const cloneRuntimeSelection = (
  selection: RuntimeSelection | undefined
): RuntimeSelection | undefined => {
  if (!selection) return undefined
  if (selection.source === 'managed') return { source: 'managed' }

  return {
    ...selection,
    ...(selection.interpreterArgs ? { interpreterArgs: [...selection.interpreterArgs] } : {})
  }
}

const cloneRuntimeEnablement = (enablement: RuntimeEnablement | undefined): RuntimeEnablement => ({
  enabled: { ...enablement?.enabled },
  installAuthorized: { ...enablement?.installAuthorized }
})

const clonePackageMirror = (mirror: PackageMirror | undefined): PackageMirror => ({ ...mirror })

const toNotebookRuntimeSettingsSnapshot = (
  settings: StoredSettings,
  language: NotebookLanguage
): NotebookRuntimeSettingsSnapshot => ({
  language,
  ...(settings.notebookRuntimes?.[language]
    ? { runtimeSelection: cloneRuntimeSelection(settings.notebookRuntimes[language]) }
    : {}),
  runtimeEnablement: cloneRuntimeEnablement(settings.notebookRuntimeEnablement?.[language]),
  manualInterpreters: [...(settings.notebookManualInterpreters?.[language] ?? [])],
  packageMirror: clonePackageMirror(settings.packageMirror)
})

class NotebookRuntimeSettingsModule implements NotebookRuntimeSettings {
  constructor(private readonly repository: SettingsRepository) {}

  async getSnapshot(language: NotebookLanguage): Promise<NotebookRuntimeSettingsSnapshot> {
    return toNotebookRuntimeSettingsSnapshot(await this.repository.getSettings(), language)
  }

  async getPackageMirror(): Promise<PackageMirror> {
    return clonePackageMirror((await this.repository.getSettings()).packageMirror)
  }

  async setRuntimeSelection(
    language: NotebookLanguage,
    selection: RuntimeSelection | null
  ): Promise<RuntimeSelection | undefined> {
    const settings = await this.repository.setRuntimeSelection(language, selection)
    return cloneRuntimeSelection(settings.notebookRuntimes?.[language])
  }

  async setEnvironmentEnabled(
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ): Promise<RuntimeEnablement> {
    const settings = await this.repository.setRuntimeEnablement(language, (current) => ({
      enabled: { ...current.enabled, [envId]: enabled },
      installAuthorized: { ...current.installAuthorized }
    }))

    return cloneRuntimeEnablement(settings.notebookRuntimeEnablement?.[language])
  }

  async setInstallAuthorized(
    language: NotebookLanguage,
    envId: string,
    authorized: boolean
  ): Promise<RuntimeEnablement> {
    const settings = await this.repository.setRuntimeEnablement(language, (current) => ({
      enabled: { ...current.enabled },
      installAuthorized: { ...current.installAuthorized, [envId]: authorized }
    }))

    return cloneRuntimeEnablement(settings.notebookRuntimeEnablement?.[language])
  }

  async getAgentEnvironmentCreationEnabled(): Promise<boolean> {
    return (await this.repository.getSettings()).agentEnvironmentCreationEnabled ?? true
  }

  async setAgentEnvironmentCreationEnabled(enabled: boolean): Promise<boolean> {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Agent environment creation enabled must be a boolean.')
    }
    const settings = await this.repository.setAgentEnvironmentCreationEnabled(enabled)
    return settings.agentEnvironmentCreationEnabled ?? true
  }

  async addManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    const settings = await this.repository.setManualInterpreters(language, (current) => [
      ...current,
      path
    ])

    return [...(settings.notebookManualInterpreters?.[language] ?? [])]
  }

  async removeManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    const settings = await this.repository.setManualInterpreters(language, (current) =>
      current.filter((candidate) => candidate !== path)
    )

    return [...(settings.notebookManualInterpreters?.[language] ?? [])]
  }

  async setPackageMirror(request: SetPackageMirrorRequest): Promise<PackageMirror> {
    const settings = await this.repository.setPackageMirror(request)
    return clonePackageMirror(settings.packageMirror)
  }
}

export { NotebookRuntimeSettingsModule, toNotebookRuntimeSettingsSnapshot }
