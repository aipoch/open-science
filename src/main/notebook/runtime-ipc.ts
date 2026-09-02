import { dialog } from 'electron'

import { ipcMainHandle } from '../ipc-handler-registry'
import { createLogger, diagnosticErrorFields } from '../logger'

import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeSelection } from '../../shared/notebook-runtime'
import type { RuntimeSelectionWorkflows } from './runtime-selection-workflows'

const log = createLogger('notebook:runtime-ipc')

const parseAgentEnvironmentCreationEnabled = (value: unknown): boolean => {
  if (typeof value !== 'boolean') {
    throw new TypeError('Agent environment creation enabled must be a boolean.')
  }
  return value
}

export type RuntimeIpcOptions = {
  // Injectable for tests; production defaults to the Electron native open-file dialog.
  showOpenDialog?: () => Promise<string | null>
}

// Registers renderer-callable runtime-selection commands while keeping native host interaction in
// the Electron adapter. Application ordering and state ownership live behind the workflow interface.
const registerRuntimeIpcHandlers = (
  workflows: RuntimeSelectionWorkflows,
  options: RuntimeIpcOptions = {}
): void => {
  ipcMainHandle('runtime:survey', () => workflows.survey())

  ipcMainHandle('runtime:list-environments', () => workflows.listEnvironments())

  ipcMainHandle(
    'runtime:list-packages',
    (_event, request: { language: NotebookLanguage; envId: string }) =>
      workflows.listPackages(request)
  )

  ipcMainHandle('runtime:list-package-counts', (_event, request: { language: NotebookLanguage }) =>
    workflows.listPackageCounts(request)
  )

  ipcMainHandle(
    'runtime:set-selection',
    (_event, request: { language: NotebookLanguage; selection: RuntimeSelection | null }) =>
      workflows.setSelection(request)
  )

  ipcMainHandle('runtime:get-enablement', (_event, request: { language: NotebookLanguage }) =>
    workflows.getEnablement(request)
  )

  ipcMainHandle('runtime:get-agent-environment-creation-enabled', () =>
    workflows.getAgentEnvironmentCreationEnabled()
  )

  ipcMainHandle(
    'runtime:describe-usage',
    (_event, request: { language: NotebookLanguage; envId: string }) =>
      workflows.describeUsage(request)
  )

  ipcMainHandle(
    'runtime:set-environment-enabled',
    (
      _event,
      request: { language: NotebookLanguage; envId: string; enabled: boolean; force?: boolean }
    ) => workflows.setEnvironmentEnabled(request)
  )

  ipcMainHandle(
    'runtime:set-install-authorized',
    (_event, request: { language: NotebookLanguage; envId: string; authorized: boolean }) =>
      workflows.setInstallAuthorized(request)
  )

  ipcMainHandle(
    'runtime:set-agent-environment-creation-enabled',
    (_event, request: { enabled?: unknown }) =>
      workflows.setAgentEnvironmentCreationEnabled({
        enabled: parseAgentEnvironmentCreationEnabled(request?.enabled)
      })
  )

  ipcMainHandle('runtime:pick-interpreter', async (): Promise<string | null> => {
    try {
      if (options.showOpenDialog) return await options.showOpenDialog()
      const result = await dialog.showOpenDialog({ properties: ['openFile'] })
      return result.filePaths[0] ?? null
    } catch (err) {
      // Never let a picker failure surface as a raw rejection to the renderer; the choose action
      // becomes a no-op instead.
      log.error('pick interpreter failed', diagnosticErrorFields(err))
      return null
    }
  })

  ipcMainHandle(
    'runtime:register-interpreter',
    (_event, request: { language: NotebookLanguage; path: string }) => workflows.register(request)
  )

  ipcMainHandle(
    'runtime:unregister-interpreter',
    (_event, request: { language: NotebookLanguage; path: string }) => workflows.unregister(request)
  )
}

export { registerRuntimeIpcHandlers }
