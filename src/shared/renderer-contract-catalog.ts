import {
  composeRendererContractCatalog,
  defineRendererContractGroup,
  type RendererContractGroup,
  type RendererContractSeed,
  type RendererParameterCodec,
  type RendererSurfaceProfile
} from './renderer-contract'

const WEB = 'web'
const LOCAL = 'local'
const EVENT = 'event'
const DORMANT_EVENT = 'dormant-event'
const CLOSE_PANE_EVENT = 'close-pane-event'
const ELECTRON = 'electron'
const MAPPED_ELECTRON = 'mapped-electron'
const SEND = 'send'
const WINDOW_FIND_READY = 'window-find-ready'
const ELECTRON_EVENT = 'electron-event'
const NATIVE = 'native'
const MAPPED_NATIVE = 'mapped-native'
const DELEGATED_NATIVE = 'delegated-native'

const POSITIONAL = 'positional'
const DEFAULT_EMPTY = 'default-empty-object'
const DEFAULT_EMPTY_ABSENT_ONLY = 'default-empty-object-absent-only'
const OPTIONAL_ARGUMENT_SLOT = 'optional-argument-slot'
const STORAGE_PARENT = 'storage-parent-object'
const STORAGE_ROOT = 'storage-data-root-object'
const RUNTIME_SELECTION = 'runtime-selection-object'
const RUNTIME_LANGUAGE_ENV = 'runtime-language-environment-object'
const RUNTIME_LANGUAGE = 'runtime-language-object'
const RUNTIME_ENABLEMENT = 'runtime-enablement-object'
const RUNTIME_INSTALL_AUTH = 'runtime-install-authorization-object'
const RUNTIME_INTERPRETER = 'runtime-interpreter-path-object'
const NATIVE_FILE_UPLOAD = 'native-file-upload-request'
const SESSION_SAVE = 'session-save-optional-argument'
const SESSION_SAVE_JSON = 'session-save-json-undefined'

// prettier-ignore
type ContractProfile = typeof WEB | typeof LOCAL | typeof EVENT | typeof DORMANT_EVENT | typeof CLOSE_PANE_EVENT | typeof ELECTRON | typeof MAPPED_ELECTRON | typeof SEND | typeof WINDOW_FIND_READY | typeof ELECTRON_EVENT | typeof NATIVE | typeof MAPPED_NATIVE | typeof DELEGATED_NATIVE

// prettier-ignore
type ContractEntry = readonly [member: string, channel: string | null, profile?: ContractProfile, electronCodec?: RendererParameterCodec, webCodec?: RendererParameterCodec]

// prettier-ignore
const CLOSE_PANE_LIFECYCLE = { activateChannel: 'shortcut:close-active-pane-ready', activate: 'after-subscribe', deactivateChannel: 'shortcut:close-active-pane-unready', deactivate: 'after-unsubscribe' } as const
// prettier-ignore
const WINDOW_FIND_LIFECYCLE = { activateChannel: 'shortcut:window-find-ready', activate: 'on-call', deactivateChannel: 'shortcut:window-find-unready', deactivate: 'on-dispose' } as const

const surface = <Value>(
  electron: Value,
  localWeb: Value,
  remoteWeb: Value
): RendererSurfaceProfile<Value> => ({ electron, localWeb, remoteWeb })

const expandEntry = (
  publicRoot: string,
  [member, channel, profile = WEB, electronCodec, webCodec]: ContractEntry
): RendererContractSeed => {
  const isWebRequest = profile === WEB || profile === LOCAL
  const isDormantEvent = profile === DORMANT_EVENT || profile === CLOSE_PANE_EVENT
  const isWebEvent = profile === EVENT || isDormantEvent
  const isElectronEvent = profile === ELECTRON_EVENT
  const isNative = profile === NATIVE || profile === MAPPED_NATIVE || profile === DELEGATED_NATIVE
  const kind = isWebEvent || isElectronEvent ? 'event' : 'method'
  const defaultElectronCodec =
    kind === 'event' ? 'event-listener' : profile === NATIVE ? 'surface-native' : POSITIONAL
  const defaultWebCodec = isNative ? 'surface-native' : defaultElectronCodec
  const localInstallation = isWebRequest
    ? 'web-rpc'
    : isWebEvent
      ? 'web-event'
      : isNative
        ? 'browser-native'
        : 'unavailable'
  const localDispatch = isWebRequest
    ? 'direct-application-request'
    : isWebEvent
      ? 'web-event-subscription'
      : profile === DELEGATED_NATIVE
        ? 'browser-native-with-direct-application-request'
        : isNative
          ? 'surface-native'
          : 'none'
  const electronDispatch =
    profile === SEND || profile === WINDOW_FIND_READY
      ? 'electron-ipc-send'
      : kind === 'event'
        ? 'electron-ipc-subscription'
        : profile === NATIVE
          ? 'surface-native'
          : 'electron-ipc-request'

  return {
    publicPath: publicRoot ? `${publicRoot}.${member}` : member,
    channel,
    kind,
    parameterCodec: {
      electron: electronCodec ?? defaultElectronCodec,
      web: webCodec ?? electronCodec ?? defaultWebCodec
    },
    surfaceInstallation: surface(
      'preload',
      localInstallation,
      profile === LOCAL ? 'rejecting-stub' : localInstallation
    ),
    dispatchPolicy: surface(
      electronDispatch,
      localDispatch,
      profile === LOCAL ? 'rejecting-stub' : localDispatch
    ),
    eventDeliverability: surface(
      kind === 'event' ? 'electron-ipc' : 'not-event',
      profile === EVENT
        ? 'application-event'
        : isDormantEvent
          ? 'installed-undelivered'
          : kind === 'event'
            ? 'unavailable'
            : 'not-event',
      profile === EVENT
        ? 'application-event'
        : isDormantEvent
          ? 'installed-undelivered'
          : kind === 'event'
            ? 'unavailable'
            : 'not-event'
    ),
    authorityFlow: surface(
      kind === 'event' || profile === NATIVE ? 'none' : 'electron-sender',
      isWebRequest || profile === DELEGATED_NATIVE ? 'caller-context' : 'none',
      profile === WEB || profile === DELEGATED_NATIVE ? 'caller-context' : 'none'
    ),
    lifecycleDispatch:
      profile === CLOSE_PANE_EVENT
        ? CLOSE_PANE_LIFECYCLE
        : profile === WINDOW_FIND_READY
          ? WINDOW_FIND_LIFECYCLE
          : undefined,
    mapProjection:
      isWebRequest ||
      profile === MAPPED_ELECTRON ||
      profile === MAPPED_NATIVE ||
      profile === DELEGATED_NATIVE
        ? 'invoke'
        : isWebEvent
          ? 'event'
          : 'none'
  }
}

const group = (
  capability: string,
  publicRoot: string,
  entries: readonly ContractEntry[]
): RendererContractGroup =>
  defineRendererContractGroup(
    capability,
    entries.map((entry) => expandEntry(publicRoot, entry))
  )

// Compact tuple manifest: [member, channel, surface profile?, Electron codec?, Web codec?].
// prettier-ignore
export const RENDERER_CONTRACT_GROUPS = Object.freeze([
  group('acp', 'acp', [
    ['onEvent', 'acp:event', EVENT], ['onPermissionRequest', 'acp:permission-request', EVENT], ['onState', 'acp:state', EVENT], ['cancel', 'acp:cancel'],
    ['compactSession', 'acp:compact-session'], ['connect', 'acp:connect', WEB, DEFAULT_EMPTY, DEFAULT_EMPTY_ABSENT_ONLY], ['createSession', 'acp:create-session', WEB, DEFAULT_EMPTY, DEFAULT_EMPTY_ABSENT_ONLY],
    ['deleteSession', 'acp:delete-session'], ['disconnect', 'acp:disconnect'], ['getState', 'acp:get-state'], ['getPlanProjection', 'acp:get-plan-projection'],
    ['resetSessionContext', 'acp:reset-session-context'], ['respondToPermission', 'acp:respond-permission'], ['resumeSession', 'acp:resume-session'],
    ['respondPlan', 'acp:respond-plan'], ['revokePermissionGrant', 'acp:revoke-permission-grant'], ['sendPrompt', 'acp:send-prompt'], ['setPermissionProfile', 'acp:set-permission-profile'],
  ]),
  group('artifacts', 'artifacts', [
    ['finalizeRunArtifacts', 'artifacts:finalize-run'], ['getLineage', 'artifacts:get-lineage'], ['getVersionExecution', 'artifacts:get-version-execution'],
    ['getVersionMessages', 'artifacts:get-version-messages'], ['getVersionProvenance', 'artifacts:get-version-provenance'],
    ['getVersionReview', 'artifacts:get-version-review'], ['listProjectFiles', 'artifacts:list-project-files'], ['openFile', 'artifacts:open-file', LOCAL],
    ['readPreview', 'artifacts:read-preview'], ['reconcilePendingArtifacts', 'artifacts:reconcile-pending'],
    ['resolveVersionDescriptors', 'artifacts:resolve-version-descriptors'],
  ]),
  group('cli', 'cli', [
    ['getStatus', 'cli:get-status'], ['install', 'cli:install', LOCAL], ['uninstall', 'cli:uninstall', LOCAL],
  ]),
  group('compute', 'compute', [
    ['onApprovalRequest', 'compute:approval-request', EVENT], ['onJobUpdated', 'compute:job-updated', EVENT], ['bookmarksGet', 'compute:bookmarks:get'],
    ['bookmarksSet', 'compute:bookmarks:set'], ['concurrencySet', 'compute:concurrency:set'], ['create', 'compute:create'], ['delete', 'compute:delete'],
    ['detailsGet', 'compute:details:get'], ['detailsSave', 'compute:details:save'], ['download', 'compute:download', LOCAL],
    ['enabledHostsGet', 'compute:enabled-hosts:get'], ['enabledHostsSet', 'compute:enabled-hosts:set'], ['get', 'compute:get'],
    ['jobsList', 'compute:jobs:list'], ['jobsMarkConsumed', 'compute:jobs:mark-consumed'], ['jobsPendingNotification', 'compute:jobs:pending-notification'],
    ['list', 'compute:list'], ['listDir', 'compute:list-dir'], ['probe', 'compute:probe'], ['respondApproval', 'compute:approval-respond'],
    ['revealInFolder', 'compute:reveal-in-folder', LOCAL], ['scratchSet', 'compute:scratch:set'], ['sshConfigAliases', 'compute:ssh-config-aliases'],
  ]),
  group('diagnostics', 'diagnostics', [
    ['reportRendererFailure', 'diagnostics:renderer-failure', SEND],
  ]),
  group('github', 'github', [
    ['getStars', 'github:get-stars'],
  ]),
  group('handoff', 'handoff', [
    ['list', 'handoff-lifecycle:list', ELECTRON], ['onChanged', 'handoff-lifecycle:changed', ELECTRON_EVENT], ['retry', 'handoff-lifecycle:retry', ELECTRON],
  ]),
  group('lifecycle', 'lifecycle', [
    ['getClientId', 'lifecycle:client-id'],
  ]),
  group('local-fs', 'localFs', [
    ['getRoots', 'local-fs:get-roots', LOCAL], ['listDir', 'local-fs:list-dir', LOCAL], ['openPath', 'local-fs:open-path', LOCAL],
    ['readPreview', 'local-fs:read-preview', LOCAL], ['reveal', 'local-fs:reveal', LOCAL],
  ]),
  group('logs', 'logs', [
    ['getPath', 'logs:get-path'], ['openFile', 'logs:open-file', LOCAL], ['revealInFolder', 'logs:reveal-in-folder', LOCAL],
  ]),
  group('notebook', 'notebook', [
    ['onAvailable', 'notebook:available', EVENT], ['onChanged', 'notebook:changed', EVENT], ['appendCodeCell', 'notebook:append-code-cell'],
    ['beginCodeCell', 'notebook:begin-code-cell'], ['execute', 'notebook:execute'], ['exportIpynb', 'notebook:export-ipynb', LOCAL],
    ['exportIpynbAll', 'notebook:export-ipynb-all', LOCAL], ['finishCodeCell', 'notebook:finish-code-cell'], ['getReference', 'notebook:reference'],
    ['readInputPreview', 'notebook:read-input-preview'], ['restart', 'notebook:restart'], ['runCell', 'notebook:run-cell'], ['shutdown', 'notebook:shutdown'],
    ['state', 'notebook:state'],
  ]),
  group('notebook-environment', 'notebookEnv', [
    ['onProgress', 'notebook-env:progress', DORMANT_EVENT], ['cancel', 'notebook-env:cancel', LOCAL, OPTIONAL_ARGUMENT_SLOT, POSITIONAL], ['getStatus', 'notebook-env:status'],
    ['provision', 'notebook-env:provision', LOCAL], ['repair', 'notebook-env:repair', LOCAL],
  ]),
  group('notifications', 'notifications', [
    ['onOpenSession', 'notifications:open-session', DORMANT_EVENT], ['onViewProbe', 'notifications:probe-unread-view', DORMANT_EVENT],
    ['peekPendingOpenSession', 'notifications:peek-pending-open-session'], ['syncViewState', 'notifications:sync-unread-view', SEND],
    ['takePendingOpenSession', 'notifications:take-pending-open-session'],
  ]),
  group('office-preview', 'officePreview', [
    ['attachFrame', 'office-preview:attach-frame', ELECTRON], ['close', 'office-preview:close', ELECTRON], ['onState', 'office-preview:state', ELECTRON_EVENT],
    ['open', 'office-preview:open', ELECTRON], ['reportState', 'office-preview:report-state', SEND],
  ]),
  group('permissions', 'permissions', [
    ['onChanged', 'permissions:changed', EVENT], ['extendUndo', 'permissions:extend-undo'], ['list', 'permissions:list'], ['restore', 'permissions:restore'],
    ['revoke', 'permissions:revoke'],
  ]),
  group('platform-file-save', '', [
    ['getRuntimeVersions', null, NATIVE], ['saveBlobFile', 'file:save-blob', MAPPED_NATIVE], ['saveManagedFile', 'file:save-managed', DELEGATED_NATIVE],
    ['saveSessionArtifacts', 'file:save-session-artifacts', MAPPED_ELECTRON],
  ]),
  group('preview', 'preview', [
    ['delete', 'preview:delete'], ['load', 'preview:load'], ['save', 'preview:save'],
  ]),
  group('preview-resources', 'previewResources', [
    ['acquire', 'preview-resources:acquire'], ['readRange', 'preview-resources:read-range'], ['release', 'preview-resources:release'],
  ]),
  group('project-files', 'projectFiles', [
    ['onChanged', 'project-files:changed', EVENT], ['getOverview', 'project-files:get-overview'], ['listArtifactGroups', 'project-files:list-artifact-groups'],
    ['listFiles', 'project-files:list-files'], ['repairIndex', 'project-files:repair-index'], ['searchArtifacts', 'project-files:search-artifacts'],
  ]),
  group('projects', 'projects', [
    ['onCreated', 'project:created', EVENT], ['onDeleted', 'project:deleted', EVENT], ['onUpdated', 'project:updated', EVENT], ['create', 'projects:create'],
    ['delete', 'projects:delete'], ['get', 'projects:get'], ['list', 'projects:list'], ['update', 'projects:update'],
  ]),
  group('remote-access', 'remoteAccess', [
    ['onChanged', 'remote-access:changed', EVENT], ['approve', 'remote-access:approve'], ['detect', 'remote-access:detect'],
    ['disable', 'remote-access:disable'], ['getSnapshot', 'remote-access:get-snapshot'], ['reject', 'remote-access:reject'],
    ['revokeBrowser', 'remote-access:revoke-browser'], ['setMode', 'remote-access:set-mode'],
  ]),
  group('reviewer', 'reviewer', [
    ['onFixLoopEnd', 'reviewer:fix-loop-end', EVENT], ['onFixLoopStart', 'reviewer:fix-loop-start', EVENT],
    ['onSuppressNextAutoReview', 'reviewer:suppress-next-auto-review', EVENT], ['onUpdated', 'reviewer:updated', EVENT],
    ['abortFixLoop', 'reviewer:abort-fix-loop'], ['getForSession', 'reviewer:get-for-session'], ['run', 'reviewer:run'],
  ]),
  group('runtime', 'runtime', [
    ['describeUsage', 'runtime:describe-usage', WEB, RUNTIME_LANGUAGE_ENV, POSITIONAL],
    ['getEnablement', 'runtime:get-enablement', WEB, RUNTIME_LANGUAGE, POSITIONAL], ['listEnvironments', 'runtime:list-environments'],
    ['listPackageCounts', 'runtime:list-package-counts', WEB, RUNTIME_LANGUAGE, POSITIONAL],
    ['listPackages', 'runtime:list-packages', WEB, RUNTIME_LANGUAGE_ENV, POSITIONAL], ['pickInterpreter', 'runtime:pick-interpreter', LOCAL],
    ['registerInterpreter', 'runtime:register-interpreter', LOCAL, RUNTIME_INTERPRETER, POSITIONAL],
    [
      'setEnvironmentEnabled',
      'runtime:set-environment-enabled',
      LOCAL,
      RUNTIME_ENABLEMENT,
      POSITIONAL
    ],
    [
      'setInstallAuthorized',
      'runtime:set-install-authorized',
      LOCAL,
      RUNTIME_INSTALL_AUTH,
      POSITIONAL
    ],
    ['setSelection', 'runtime:set-selection', LOCAL, RUNTIME_SELECTION, POSITIONAL], ['survey', 'runtime:survey'],
    [
      'unregisterInterpreter',
      'runtime:unregister-interpreter',
      LOCAL,
      RUNTIME_INTERPRETER,
      POSITIONAL
    ],
  ]),
  group('sessions', 'sessions', [
    ['exportConversation', 'sessions:export-conversation', MAPPED_ELECTRON], ['onCreated', 'session:created', EVENT], ['onDeleted', 'session:deleted', EVENT],
    ['onFlushRequest', 'sessions:flush-request', ELECTRON_EVENT], ['onUpdated', 'session:updated', EVENT], ['deleteSession', 'sessions:delete-session'],
    ['loadAll', 'sessions:load-all'], ['saveManifest', 'sessions:save-manifest'],
    ['saveSession', 'sessions:save-session', WEB, SESSION_SAVE, SESSION_SAVE_JSON], ['sendFlushResponse', 'sessions:flush-response', SEND],
  ]),
  group('settings', 'settings', [
    ['addCustomServer', 'settings:add-custom-server'], ['cancelClaudeLogin', 'settings:cancel-claude-login', LOCAL],
    ['cancelCodexLogin', 'settings:cancel-codex-login', LOCAL], ['cancelIsolatedClaudeLogin', 'settings:cancel-isolated-claude-login', LOCAL],
    ['checkEnvironment', 'settings:check-environment'], ['createSkill', 'settings:create-skill'], ['deleteProvider', 'settings:delete-provider'],
    ['deleteSkill', 'settings:delete-skill'], ['detectClaude', 'settings:detect-claude'], ['detectCodex', 'settings:detect-codex'],
    ['detectOpencode', 'settings:detect-opencode'], ['getConnectorDetail', 'settings:get-connector-detail'],
    ['getPackageMirror', 'settings:get-package-mirror'], ['getPreflight', 'settings:get-preflight'], ['getSettings', 'settings:get-settings'],
    ['getSkillDetail', 'settings:get-skill-detail'], ['importAgentHomeSkills', 'settings:import-agent-home-skills', MAPPED_ELECTRON],
    ['importSkill', 'settings:import-skill'], ['importSkillZip', 'settings:import-skill-zip'], ['importSkillZipBatch', 'settings:import-skill-zip-batch'],
    ['installClaude', 'settings:install-claude', LOCAL], ['installCodex', 'settings:install-codex', LOCAL],
    ['installOpencode', 'settings:install-opencode', LOCAL], ['isEncryptionAvailable', 'settings:encryption-available'],
    ['isNpmAvailable', 'settings:npm-available'], ['listAgentHomeSkills', 'settings:list-agent-home-skills', MAPPED_ELECTRON],
    ['listAppIcons', 'settings:list-app-icons'], ['listConnectors', 'settings:list-connectors'], ['listSkills', 'settings:list-skills'],
    ['loginIsolatedClaude', 'settings:login-isolated-claude', LOCAL], ['loginIsolatedClaudeBrowser', 'settings:login-isolated-claude-browser', LOCAL],
    ['loginIsolatedCodex', 'settings:login-isolated-codex', LOCAL], ['loginSharedClaude', 'settings:login-shared-claude', LOCAL],
    ['logoutIsolatedClaude', 'settings:logout-isolated-claude', LOCAL], ['logoutIsolatedCodex', 'settings:logout-isolated-codex', LOCAL],
    ['logoutSharedClaude', 'settings:logout-shared-claude', LOCAL], ['markOnboardingComplete', 'settings:mark-onboarding-complete'],
    ['onConnectorApprovalRequest', 'connectors:approval-request', EVENT], ['onInstallLog', 'settings:install-log', EVENT],
    ['onSkillImportApprovalRequest', 'skills:conversation-import-request', EVENT],
    ['onSkillImportApprovalSettled', 'skills:conversation-import-settled', EVENT], ['previewAgentHomeSkill', 'settings:preview-agent-home-skill'],
    ['previewGitHubSkill', 'settings:preview-github-skill'], ['previewSkillZip', 'settings:preview-skill-zip'],
    ['refreshProviderModels', 'settings:refresh-provider-models'], ['removeCustomServer', 'settings:remove-custom-server'],
    ['replayPendingSkillImportApprovals', 'skills:conversation-import-replay-pending'], ['respondConnectorApproval', 'connectors:approval-respond'],
    ['respondSkillImportApproval', 'skills:conversation-import-respond'], ['scanRepoSkills', 'settings:scan-repo-skills'],
    ['setActiveProvider', 'settings:set-active-provider'], ['setAgentFramework', 'settings:set-agent-framework'],
    ['setAppIconVariant', 'settings:set-app-icon-variant', LOCAL], ['setClosePreference', 'settings:set-close-preference', LOCAL],
    ['setConnectorAutoAllow', 'settings:set-connector-auto-allow'], ['setConnectorEnabled', 'settings:set-connector-enabled'],
    ['setConversationSkillImportEnabled', 'settings:set-conversation-skill-import-enabled'], ['setCustomServerEnabled', 'settings:set-custom-server-enabled'],
    ['setNcbiCredentials', 'settings:set-ncbi-credentials'], ['setNotificationsEnabled', 'settings:set-notifications-enabled', LOCAL],
    ['setPackageMirror', 'settings:set-package-mirror', LOCAL], ['setReasoningEffort', 'settings:set-reasoning-effort'],
    ['setSkillEnabled', 'settings:set-skill-enabled'], ['setToolPermission', 'settings:set-tool-permission'],
    ['uninstallClaude', 'settings:uninstall-claude', LOCAL], ['uninstallCodex', 'settings:uninstall-codex', LOCAL],
    ['uninstallOpencode', 'settings:uninstall-opencode', LOCAL], ['updateCustomServer', 'settings:update-custom-server'],
    ['updateSkill', 'settings:update-skill'], ['upsertProvider', 'settings:upsert-provider'], ['validateProvider', 'settings:validate-provider'],
  ]),
  group('specialist', 'specialist', [
    ['cancelHandoff', 'specialist:cancel-handoff', ELECTRON], ['cancelPackage', 'specialist:package-cancel', ELECTRON], ['create', 'specialist:create', ELECTRON], ['delete', 'specialist:delete', ELECTRON],
    ['duplicate', 'specialist:duplicate', ELECTRON], ['exportContributionTemplate', 'specialist:export-contribution-template', ELECTRON], ['exportSpecialist', 'specialist:export-save', ELECTRON],
    ['getHandoffEvents', 'specialist:get-handoff-events', ELECTRON], ['installPackage', 'specialist:package-install', ELECTRON], ['list', 'specialist:list', ELECTRON],
    ['onCatalogChanged', 'specialist:catalog-changed', ELECTRON_EVENT], ['onHandoffLifecycleEvent', 'specialist:handoff-lifecycle-changed', ELECTRON_EVENT],
    ['onPendingSwitch', 'specialist:pending-switch', ELECTRON_EVENT], ['previewDelete', 'specialist:delete-preview', ELECTRON], ['previewExport', 'specialist:export-preview', ELECTRON],
    ['resolveSessionSpecialist', 'specialist:resolve-session-specialist', ELECTRON],
    ['retryHandoff', 'specialist:retry-handoff', ELECTRON], ['setEnabled', 'specialist:set-enabled', ELECTRON],
    ['savePackageReport', 'specialist:package-report-save', ELECTRON], ['selectPackage', 'specialist:package-select', ELECTRON],
    ['setSessionSpecialist', 'specialist:set-session-specialist', ELECTRON], ['update', 'specialist:update', ELECTRON],
  ]),
  group('storage', 'storage', [
    ['cancelMigrate', 'storage:cancel-migrate', LOCAL], ['commitAndRelaunch', 'storage:commit-and-relaunch', LOCAL, STORAGE_PARENT],
    ['detectActive', 'storage:detect-active'], ['discardMigratedCopy', 'storage:discard-migrated-copy', LOCAL, STORAGE_PARENT],
    ['dismissLegacyMovePrompt', 'storage:dismiss-legacy-move-prompt'], ['getInfo', 'storage:get-info'],
    ['inspectDataRoot', 'storage:inspect-data-root', LOCAL, STORAGE_PARENT], ['migrate', 'storage:migrate', LOCAL, STORAGE_PARENT],
    ['onProgress', 'storage:migrate-progress', EVENT], ['pickDirectory', 'storage:pick-directory', LOCAL],
    ['revealAppStorage', 'storage:reveal-app-storage', LOCAL], ['setDataRootAndRelaunch', 'storage:set-data-root-and-relaunch', LOCAL, STORAGE_ROOT],
    ['validateDataRoot', 'storage:validate-data-root', LOCAL, STORAGE_PARENT],
  ]),
  group('update', 'update', [
    ['apply', 'update:apply', LOCAL], ['cancel', 'update:cancel', LOCAL], ['check', 'update:check'], ['download', 'update:download', LOCAL],
    ['getAppInfo', 'update:get-app-info'], ['getStatus', 'update:get-status'], ['onProgress', 'update:progress', EVENT], ['onStatus', 'update:status', EVENT],
  ]),
  group('uploads', 'uploads', [
    ['abortTransfer', 'uploads:abort-transfer'], ['appendTransfer', 'uploads:append-transfer'], ['beginTransfer', 'uploads:begin-transfer'],
    ['claimLocalFile', 'uploads:claim-local-file'], ['deleteUpload', 'uploads:delete'], ['finalizeSession', 'uploads:finalize-session'],
    ['finishTransfer', 'uploads:finish-transfer'], ['getTransferStatus', 'uploads:transfer-status'],
    ['onTransferProgress', 'uploads:transfer-progress', DORMANT_EVENT], ['readPreview', 'uploads:read-preview'],
    ['stageLocalFile', 'uploads:stage-local-file', MAPPED_ELECTRON, NATIVE_FILE_UPLOAD], ['stageLocalPath', 'uploads:stage-local-path', LOCAL],
  ]),
  group('window', 'window', [
    ['announceWindowFindAppearance', 'window:find-appearance-changed', SEND], ['announceWindowFindReady', 'shortcut:window-find-ready', WINDOW_FIND_READY],
    ['clearFind', 'window:clear-find-in-page', SEND], ['close', 'window:close', MAPPED_NATIVE], ['closeFind', 'window:find-close', SEND],
    ['findInPage', 'window:find-in-page', SEND], ['onCloseActivePane', 'shortcut:close-active-pane', CLOSE_PANE_EVENT],
    ['onCloseConfirmRequest', 'window:close-confirm-request', ELECTRON_EVENT], ['onFindInPageResult', 'window:find-in-page-result', ELECTRON_EVENT],
    ['onShowWindowFind', 'window:find-show', ELECTRON_EVENT], ['onWindowFindAppearance', 'window:find-appearance', ELECTRON_EVENT],
    ['sendCloseConfirmResponse', 'window:close-confirm-response', SEND],
  ]),
])

export const RENDERER_CONTRACT_CATALOG = composeRendererContractCatalog(RENDERER_CONTRACT_GROUPS)
