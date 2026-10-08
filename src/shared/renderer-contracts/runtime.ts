// Ordered fragments keep the public registration order when capabilities interleave.
import type { LocalModelCapability, LocalModelSnapshot } from '../local-models'

import type { NotebookLanguage } from '../notebook'

import type {
  DiscoveredInterpreter,
  EnvPackage,
  RuntimeEnablement,
  RuntimeUsage
} from '../notebook-runtime'

import {
  callable,
  WEB,
  RUNTIME_LANGUAGE_ENV,
  RUNTIME_LANGUAGE,
  type RemoveListener,
  EVENT,
  LOCAL,
  RUNTIME_INTERPRETER,
  RUNTIME_INSTALL_AUTH,
  RUNTIME_ENABLEMENT
} from './definition'

export const runtimeDescribeUsageContracts = {
  'runtime.describeUsage': callable<
    (language: NotebookLanguage, envId: string) => Promise<RuntimeUsage>
  >()('runtime', ['runtime:describe-usage', WEB, RUNTIME_LANGUAGE_ENV]),
  'runtime.getAgentEnvironmentCreationEnabled': callable<() => Promise<boolean>>()('runtime', [
    'runtime:get-agent-environment-creation-enabled',
    WEB
  ]),
  'runtime.getEnablement': callable<(language: NotebookLanguage) => Promise<RuntimeEnablement>>()(
    'runtime',
    ['runtime:get-enablement', WEB, RUNTIME_LANGUAGE]
  ),
  'runtime.listEnvironments': callable<
    () => Promise<{ python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }>
  >()('runtime', ['runtime:list-environments']),
  'runtime.listPackageCounts': callable<
    (language: NotebookLanguage) => Promise<Record<string, number | null>>
  >()('runtime', ['runtime:list-package-counts', WEB, RUNTIME_LANGUAGE]),
  'runtime.listPackages': callable<
    (language: NotebookLanguage, envId: string) => Promise<EnvPackage[]>
  >()('runtime', ['runtime:list-packages', WEB, RUNTIME_LANGUAGE_ENV]),
  'runtime.onPolicyChanged': callable<(listener: () => void) => RemoveListener>()('runtime', [
    'runtime:policy-changed',
    EVENT
  ]),
  'runtime.pickInterpreter': callable<() => Promise<string | null>>()('runtime', [
    'runtime:pick-interpreter',
    LOCAL
  ]),
  'runtime.registerInterpreter': callable<
    (language: NotebookLanguage, path: string) => Promise<string[]>
  >()('runtime', ['runtime:register-interpreter', LOCAL, RUNTIME_INTERPRETER]),
  'runtime.setSandboxAccess': callable<
    (
      language: NotebookLanguage,
      envId: string,
      authorized: boolean
    ) => Promise<{ cancelled: boolean }>
  >()('runtime', ['runtime:set-sandbox-access', LOCAL, RUNTIME_INSTALL_AUTH]),
  'runtime.setAgentEnvironmentCreationEnabled': callable<
    (request: { enabled: boolean }) => Promise<boolean>
  >()('runtime', ['runtime:set-agent-environment-creation-enabled', LOCAL]),
  'runtime.setEnvironmentEnabled': callable<
    (
      language: NotebookLanguage,
      envId: string,
      enabled: boolean,
      force?: boolean
    ) => Promise<RuntimeEnablement>
  >()('runtime', ['runtime:set-environment-enabled', LOCAL, RUNTIME_ENABLEMENT]),
  'runtime.setInstallAuthorized': callable<
    (
      language: NotebookLanguage,
      envId: string,
      authorized: boolean,
      library?: string
    ) => Promise<RuntimeEnablement>
  >()('runtime', ['runtime:set-install-authorized', LOCAL, RUNTIME_INSTALL_AUTH]),
  'runtime.unregisterInterpreter': callable<
    (language: NotebookLanguage, path: string) => Promise<string[]>
  >()('runtime', ['runtime:unregister-interpreter', LOCAL, RUNTIME_INTERPRETER])
} as const

export const localModelsGetSnapshotContracts = {
  'localModels.getSnapshot': callable<
    (capability?: LocalModelCapability) => Promise<LocalModelSnapshot>
  >()('local-models', ['local-models:get-snapshot', LOCAL]),
  'localModels.install': callable<
    (capability?: LocalModelCapability) => Promise<LocalModelSnapshot>
  >()('local-models', ['local-models:install', LOCAL]),
  'localModels.cancel': callable<
    (capability?: LocalModelCapability) => Promise<LocalModelSnapshot>
  >()('local-models', ['local-models:cancel', LOCAL]),
  'localModels.remove': callable<
    (capability?: LocalModelCapability) => Promise<LocalModelSnapshot>
  >()('local-models', ['local-models:remove', LOCAL])
} as const
