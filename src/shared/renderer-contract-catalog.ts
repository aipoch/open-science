import {
  composeRendererContractCatalog,
  defineRendererContractGroup,
  type RendererContractGroup,
  type RendererContractSeed,
  type RendererParameterCodec,
  type RendererSurfaceProfile
} from './renderer-contract'
import { DATABASE_STARTUP_CHANNELS } from './database-startup'

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
const RUNTIME_VALIDATED = 'runtime-validated'

// prettier-ignore
type ContractProfile = typeof WEB | typeof LOCAL | typeof EVENT | typeof DORMANT_EVENT | typeof CLOSE_PANE_EVENT | typeof ELECTRON | typeof MAPPED_ELECTRON | typeof SEND | typeof WINDOW_FIND_READY | typeof ELECTRON_EVENT | typeof NATIVE | typeof MAPPED_NATIVE | typeof DELEGATED_NATIVE

// prettier-ignore
type ContractEntry = readonly [member: string, channel: string | null, profile?: ContractProfile, electronCodec?: RendererParameterCodec, webCodec?: RendererParameterCodec, applicationCommand?: typeof RUNTIME_VALIDATED]

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
  [member, channel, profile = WEB, electronCodec, webCodec, applicationCommand]: ContractEntry
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
    applicationCommand,
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

// Compact tuple manifest:
// [member, channel, surface profile?, Electron codec?, Web codec?, Application command?].
// prettier-ignore
export const RENDERER_CONTRACT_GROUPS = Object.freeze([
  group('acp', 'acp', [
    ['onAgentRuntimeUpdate', 'acp:agent-runtime-update', EVENT], ['onEvent', 'acp:event', EVENT], ['onPermissionRequest', 'acp:permission-request', EVENT], ['onState', 'acp:state', EVENT], ['cancel', 'acp:cancel'],
    ['compactSession', 'acp:compact-session'], ['connect', 'acp:connect', WEB, DEFAULT_EMPTY, DEFAULT_EMPTY_ABSENT_ONLY], ['createSession', 'acp:create-session', WEB, DEFAULT_EMPTY, DEFAULT_EMPTY_ABSENT_ONLY],
    ['continueInterruptedTurn', 'acp:continue-interrupted-turn'], ['deleteSession', 'acp:delete-session'], ['disconnect', 'acp:disconnect'], ['getState', 'acp:get-state'], ['getPlanProjection', 'acp:get-plan-projection'],
    ['resetSessionContext', 'acp:reset-session-context'], ['respondToPermission', 'acp:respond-permission'], ['resumeSession', 'acp:resume-session'],
    ['respondPlan', 'acp:respond-plan'], ['respondToElicitation', 'acp:respond-elicitation'], ['revokePermissionGrant', 'acp:revoke-permission-grant'], ['saveAsSkill', 'acp:save-as-skill'], ['sendPrompt', 'acp:send-prompt'], ['setPermissionProfile', 'acp:set-permission-profile'], ['steerFollowUp', 'acp:steer-follow-up'],
  ]),
  group('artifacts', 'artifacts', [
    ['finalizeRunArtifacts', 'artifacts:finalize-run'], ['generateCodeReconstruction', 'artifacts:generate-code-reconstruction'], ['getCodeReconstruction', 'artifacts:get-code-reconstruction'],
    ['getLineage', 'artifacts:get-lineage'], ['getVersionExecution', 'artifacts:get-version-execution'],
    ['getVersionMessages', 'artifacts:get-version-messages'], ['getVersionProvenance', 'artifacts:get-version-provenance'],
    ['getVersionReview', 'artifacts:get-version-review'], ['listProjectFiles', 'artifacts:list-project-files'], ['openFile', 'artifacts:open-file', LOCAL],
    ['readPreview', 'artifacts:read-preview'], ['reconcilePendingArtifacts', 'artifacts:reconcile-pending'],
    ['resolveVersionDescriptors', 'artifacts:resolve-version-descriptors'],
  ]),
  group('cli', 'cli', [
    ['getStatus', 'cli:get-status'], ['install', 'cli:install', LOCAL], ['uninstall', 'cli:uninstall', LOCAL],
  ]),
  group('compute', 'compute', [
    ['onApprovalRequest', 'compute:approval-request', EVENT], ['onApprovalSettled', 'compute:approval-settled', EVENT], ['onJobUpdated', 'compute:job-updated', EVENT], ['bookmarksGet', 'compute:bookmarks:get'],
    ['bookmarksSet', 'compute:bookmarks:set'], ['changeAuthentication', 'compute:change-authentication', LOCAL], ['concurrencySet', 'compute:concurrency:set'], ['create', 'compute:create'], ['createPassword', 'compute:create-password', LOCAL], ['delete', 'compute:delete'], ['deletionStatus', 'compute:deletion-status'],
    ['detailsGet', 'compute:details:get'], ['detailsSave', 'compute:details:save'], ['download', 'compute:download', LOCAL],
    ['enabledHostsGet', 'compute:enabled-hosts:get'], ['enabledHostsSet', 'compute:enabled-hosts:set'], ['hostEnabledSet', 'compute:host-enabled:set'], ['hostSelectedSet', 'compute:host-selected:set'], ['get', 'compute:get'],
    ['jobsList', 'compute:jobs:list'], ['jobsMarkConsumed', 'compute:jobs:mark-consumed'], ['jobsPendingNotification', 'compute:jobs:pending-notification'],
    ['list', 'compute:list'], ['listDir', 'compute:list-dir'], ['passwordCapability', 'compute:password-capability', LOCAL], ['probe', 'compute:probe'], ['replayApproval', 'compute:approval-replay'], ['replayPendingApprovals', 'compute:approval-replay-pending'], ['resetPassword', 'compute:reset-password', LOCAL], ['respondApproval', 'compute:approval-respond'],
    ['revealInFolder', 'compute:reveal-in-folder', LOCAL], ['scratchSet', 'compute:scratch:set'], ['sshConfigAliases', 'compute:ssh-config-aliases'],
  ]),
  group('database-startup', 'databaseStartup', [
    ['getState', DATABASE_STARTUP_CHANNELS.getState, ELECTRON], ['retry', DATABASE_STARTUP_CHANNELS.retry, ELECTRON],
    ['quit', DATABASE_STARTUP_CHANNELS.quit, ELECTRON], ['onStateChanged', DATABASE_STARTUP_CHANNELS.stateChanged, ELECTRON_EVENT],
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
  group('locale', 'locale', [
    ['initialize', 'locale:initialize', ELECTRON], ['onChanged', 'locale:changed', ELECTRON_EVENT], ['setPreference', 'locale:set-preference', ELECTRON],
  ]),
  group('local-fs', 'localFs', [
    ['getRoots', 'local-fs:get-roots', LOCAL], ['grantRoot', 'local-fs:grant-root', LOCAL], ['listDir', 'local-fs:list-dir', LOCAL],
    ['listDrives', 'local-fs:list-drives', LOCAL], ['listGrantedRoots', 'local-fs:granted-roots:list', LOCAL], ['openPath', 'local-fs:open-path', LOCAL], ['readPreview', 'local-fs:read-preview', LOCAL],
    ['removeGrantedRoot', 'local-fs:granted-roots:remove', LOCAL], ['reveal', 'local-fs:reveal', LOCAL], ['setGrantedRootAccess', 'local-fs:granted-roots:set-access', LOCAL],
  ]),
  group('logs', 'logs', [
    ['getPath', 'logs:get-path'], ['openFile', 'logs:open-file', LOCAL], ['revealInFolder', 'logs:reveal-in-folder', LOCAL],
  ]),
  group('network', 'network', [
    ['getInfo', 'network:get-info', ELECTRON], ['checkConnectivity', 'network:check-connectivity', ELECTRON],
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
    ['getSnapshot', 'notifications:get-snapshot'], ['markAllRead', 'notifications:mark-all-read'], ['markRead', 'notifications:mark-read'],
    ['markSessionCompletionsRead', 'notifications:mark-session-completions-read'],
    ['onChanged', 'notifications:changed', EVENT], ['onOpenSession', 'notifications:open-session', DORMANT_EVENT],
    ['onViewProbe', 'notifications:probe-unread-view', DORMANT_EVENT], ['peekPendingOpenSession', 'notifications:peek-pending-open-session'],
    ['syncViewState', 'notifications:sync-unread-view', SEND], ['takePendingOpenSession', 'notifications:take-pending-open-session'],
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
    ['saveProjectArtifacts', 'file:save-project-artifacts', MAPPED_ELECTRON],
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
    ['onCreated', 'project:created', EVENT], ['onDeleted', 'project:deleted', EVENT], ['onUpdated', 'project:updated', EVENT], ['create', 'projects:create', WEB, undefined, undefined, RUNTIME_VALIDATED],
    ['delete', 'projects:delete', WEB, undefined, undefined, RUNTIME_VALIDATED], ['get', 'projects:get', WEB, undefined, undefined, RUNTIME_VALIDATED], ['list', 'projects:list', WEB, undefined, undefined, RUNTIME_VALIDATED], ['updateArchive', 'projects:update-archive', WEB, undefined, undefined, RUNTIME_VALIDATED], ['update', 'projects:update', WEB, undefined, undefined, RUNTIME_VALIDATED],
  ]),
  group('tags', 'tags', [
    ['onChanged', 'tags:changed', EVENT], ['create', 'tags:create', WEB, undefined, undefined, RUNTIME_VALIDATED],
    ['delete', 'tags:delete', WEB, undefined, undefined, RUNTIME_VALIDATED], ['reorder', 'tags:reorder', WEB, undefined, undefined, RUNTIME_VALIDATED], ['setAssignment', 'tags:set-assignment', WEB, undefined, undefined, RUNTIME_VALIDATED],
    ['snapshot', 'tags:snapshot', WEB, undefined, undefined, RUNTIME_VALIDATED], ['update', 'tags:update', WEB, undefined, undefined, RUNTIME_VALIDATED],
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
    ['describeUsage', 'runtime:describe-usage', WEB, RUNTIME_LANGUAGE_ENV],
    ['getEnablement', 'runtime:get-enablement', WEB, RUNTIME_LANGUAGE], ['listEnvironments', 'runtime:list-environments'],
    ['listPackageCounts', 'runtime:list-package-counts', WEB, RUNTIME_LANGUAGE],
    ['listPackages', 'runtime:list-packages', WEB, RUNTIME_LANGUAGE_ENV], ['pickInterpreter', 'runtime:pick-interpreter', LOCAL],
    ['registerInterpreter', 'runtime:register-interpreter', LOCAL, RUNTIME_INTERPRETER],
    [
      'setEnvironmentEnabled',
      'runtime:set-environment-enabled',
      LOCAL,
      RUNTIME_ENABLEMENT
    ],
    [
      'setInstallAuthorized',
      'runtime:set-install-authorized',
      LOCAL,
      RUNTIME_INSTALL_AUTH
    ],
    ['setSelection', 'runtime:set-selection', LOCAL, RUNTIME_SELECTION], ['survey', 'runtime:survey'],
    [
      'unregisterInterpreter',
      'runtime:unregister-interpreter',
      LOCAL,
      RUNTIME_INTERPRETER
    ],
  ]),
  group('sessions', 'sessions', [
    ['exportConversation', 'sessions:export-conversation', MAPPED_ELECTRON], ['onCreated', 'session:created', EVENT], ['onDeleted', 'session:deleted', EVENT],
    ['onFlushAborted', 'sessions:flush-aborted', ELECTRON_EVENT], ['onFlushRequest', 'sessions:flush-request', ELECTRON_EVENT], ['onUpdated', 'session:updated', EVENT], ['deleteSession', 'sessions:delete-session', WEB, undefined, undefined, RUNTIME_VALIDATED],
    ['loadAll', 'sessions:load-all'], ['loadOne', 'sessions:load-one'], ['saveManifest', 'sessions:save-manifest'],
    ['saveSession', 'sessions:save-session', WEB, SESSION_SAVE, SESSION_SAVE_JSON], ['updateArchive', 'sessions:update-archive'], ['sendFlushResponse', 'sessions:flush-response', SEND],
  ]),
  group('settings', 'settings', [
    ['onChanged', 'settings:changed', EVENT],
    ['addCustomServer', 'settings:add-custom-server'], ['authenticateCustomServer', 'settings:authenticate-custom-server', LOCAL], ['cancelCustomServerAuthentication', 'settings:cancel-custom-server-authentication', LOCAL], ['cancelClaudeLogin', 'settings:cancel-claude-login', LOCAL],
    ['cancelCodexLogin', 'settings:cancel-codex-login', LOCAL], ['cancelIsolatedClaudeLogin', 'settings:cancel-isolated-claude-login', LOCAL], ['beginXaiOAuthLogin', 'settings:begin-xai-oauth-login', LOCAL], ['waitXaiOAuthLogin', 'settings:wait-xai-oauth-login', LOCAL], ['cancelXaiOAuthLogin', 'settings:cancel-xai-oauth-login', LOCAL],
    ['checkEnvironment', 'settings:check-environment'], ['createSkill', 'settings:create-skill'], ['deleteProvider', 'settings:delete-provider'],
    ['deleteSkill', 'settings:delete-skill'], ['detectClaude', 'settings:detect-claude'], ['detectCodex', 'settings:detect-codex'],
    ['detectOpencode', 'settings:detect-opencode'], ['exportCustomServerTemplate', 'settings:export-custom-server-template', ELECTRON], ['exportSkill', 'settings:export-skill', ELECTRON], ['getConnectorDetail', 'settings:get-connector-detail'],
    ['getGitHubTokenStatus', 'settings:get-github-token-status', LOCAL], ['getPackageMirror', 'settings:get-package-mirror'], ['getPreflight', 'settings:get-preflight'], ['getSettings', 'settings:get-settings'],
    ['getSkillDetail', 'settings:get-skill-detail'], ['importAgentHomeSkills', 'settings:import-agent-home-skills', MAPPED_ELECTRON],
    ['importSkill', 'settings:import-skill'], ['importSkillZip', 'settings:import-skill-zip'], ['importSkillZipBatch', 'settings:import-skill-zip-batch'],
    ['installClaude', 'settings:install-claude', LOCAL], ['installCodex', 'settings:install-codex', LOCAL],
    ['installOpencode', 'settings:install-opencode', LOCAL], ['isEncryptionAvailable', 'settings:encryption-available'],
    ['isNpmAvailable', 'settings:npm-available'], ['listAgentHomeSkills', 'settings:list-agent-home-skills', MAPPED_ELECTRON],
    ['listAppIcons', 'settings:list-app-icons'], ['listConnectors', 'settings:list-connectors'], ['listSkills', 'settings:list-skills'],
    ['loginIsolatedClaude', 'settings:login-isolated-claude', LOCAL], ['loginIsolatedClaudeBrowser', 'settings:login-isolated-claude-browser', LOCAL],
    ['loginIsolatedCodex', 'settings:login-isolated-codex', LOCAL], ['loginSharedClaude', 'settings:login-shared-claude', LOCAL],
    ['logoutIsolatedClaude', 'settings:logout-isolated-claude', LOCAL], ['logoutIsolatedCodex', 'settings:logout-isolated-codex', LOCAL],
    ['logoutSharedClaude', 'settings:logout-shared-claude', LOCAL], ['logoutXaiOAuth', 'settings:logout-xai-oauth', LOCAL], ['markOnboardingComplete', 'settings:mark-onboarding-complete'],
    ['onConnectorApprovalRequest', 'connectors:approval-request', EVENT], ['onConnectorApprovalSettled', 'connectors:approval-settled', EVENT], ['onConnectorRuntimeChanged', 'settings:connector-runtime-changed', EVENT], ['onInstallLog', 'settings:install-log', EVENT],
    ['onSkillCatalogChanged', 'skills:catalog-changed', EVENT],
    ['onSkillImportApprovalRequest', 'skills:conversation-import-request', EVENT],
    ['onSkillImportApprovalSettled', 'skills:conversation-import-settled', EVENT], ['previewAgentHomeSkill', 'settings:preview-agent-home-skill'], ['previewCustomServerTemplateExport', 'settings:preview-custom-server-template-export', ELECTRON],
    ['previewGitHubSkill', 'settings:preview-github-skill'], ['previewSkillZip', 'settings:preview-skill-zip'],
    ['refreshProviderModels', 'settings:refresh-provider-models'], ['removeCustomServer', 'settings:remove-custom-server'], ['removeGitHubToken', 'settings:remove-github-token', LOCAL],
    ['replayConnectorApproval', 'connectors:approval-replay'], ['replayPendingConnectorApprovals', 'connectors:approval-replay-pending'], ['replayPendingSkillImportApprovals', 'skills:conversation-import-replay-pending'], ['respondConnectorApproval', 'connectors:approval-respond'],
    ['respondSkillImportApproval', 'skills:conversation-import-respond'], ['saveGitHubToken', 'settings:save-github-token', LOCAL], ['scanRepoSkills', 'settings:scan-repo-skills'], ['selectCustomServerTemplate', 'settings:select-custom-server-template', ELECTRON],
    ['setActiveProvider', 'settings:set-active-provider'], ['setAgentFramework', 'settings:set-agent-framework'],
    ['setAppIconVariant', 'settings:set-app-icon-variant', LOCAL], ['setClosePreference', 'settings:set-close-preference', LOCAL],
    ['setDefaultPermissionProfile', 'settings:set-default-permission-profile', LOCAL],
    ['setConnectorAutoAllow', 'settings:set-connector-auto-allow'], ['setConnectorEnabled', 'settings:set-connector-enabled'],
    ['retryCustomServer', 'settings:retry-custom-server', LOCAL],
    ['setConversationSkillImportEnabled', 'settings:set-conversation-skill-import-enabled'], ['setCustomServerEnabled', 'settings:set-custom-server-enabled'],
    ['setNcbiCredentials', 'settings:set-ncbi-credentials'], ['setNotificationsEnabled', 'settings:set-notifications-enabled', LOCAL],
    ['setPackageMirror', 'settings:set-package-mirror', LOCAL], ['setProjectFilesFilter', 'settings:set-project-files-filter', LOCAL],
    ['setNetworkProxy', 'settings:set-network-proxy', LOCAL],
    ['setReasoningEffort', 'settings:set-reasoning-effort'], ['setReviewerModel', 'settings:set-reviewer-model'], ['setSubagentModel', 'settings:set-subagent-model'], ['setVisionModel', 'settings:set-vision-model'],
    ['setSkillEnabled', 'settings:set-skill-enabled'], ['setSkillsEnabled', 'settings:set-skills-enabled'], ['setToolPermission', 'settings:set-tool-permission'],
    ['uninstallClaude', 'settings:uninstall-claude', LOCAL], ['uninstallCodex', 'settings:uninstall-codex', LOCAL],
    ['uninstallOpencode', 'settings:uninstall-opencode', LOCAL], ['updateCustomServer', 'settings:update-custom-server'],
    ['updateSkill', 'settings:update-skill'], ['upsertProvider', 'settings:upsert-provider'], ['validateProvider', 'settings:validate-provider'],
  ]),
  group('side-chat', 'sideChat', [
    ['onEvent', 'side-chat:event', ELECTRON_EVENT], ['onRelayDelivered', 'side-chat:relay-delivered', ELECTRON_EVENT],
    ['cancel', 'side-chat:cancel', ELECTRON], ['close', 'side-chat:close', ELECTRON], ['list', 'side-chat:list', ELECTRON], ['send', 'side-chat:send', ELECTRON], ['start', 'side-chat:start', ELECTRON],
  ]),
  group('specialist', 'specialist', [
    ['addMarketplaceSource', 'specialist:marketplace-source-add', ELECTRON], ['cancelHandoff', 'specialist:cancel-handoff', ELECTRON], ['cancelMarketplaceCandidate', 'specialist:marketplace-candidate-cancel', ELECTRON], ['cancelPackage', 'specialist:package-cancel', ELECTRON], ['create', 'specialist:create', ELECTRON], ['delete', 'specialist:delete', ELECTRON],
    ['duplicate', 'specialist:duplicate', ELECTRON], ['exportContributionTemplate', 'specialist:export-contribution-template', ELECTRON], ['exportSpecialist', 'specialist:export-save', ELECTRON],
    ['getHandoffEvents', 'specialist:get-handoff-events', ELECTRON], ['getMarketplaceRelease', 'specialist:marketplace-release-get', ELECTRON], ['inspectGitHubMarketplaceSource', 'specialist:marketplace-source-inspect-github', ELECTRON],
    ['installMarketplace', 'specialist:marketplace-install', ELECTRON], ['installPackage', 'specialist:package-install', ELECTRON], ['list', 'specialist:list', ELECTRON], ['listMarketplace', 'specialist:marketplace-list', ELECTRON],
    ['onCatalogChanged', 'specialist:catalog-changed', ELECTRON_EVENT], ['onHandoffLifecycleEvent', 'specialist:handoff-lifecycle-changed', ELECTRON_EVENT],
    ['onMarketplaceDownloadProgress', 'specialist:marketplace-download-progress', ELECTRON_EVENT], ['onPendingSwitch', 'specialist:pending-switch', ELECTRON_EVENT], ['prepareMarketplaceInstall', 'specialist:marketplace-install-prepare', ELECTRON], ['previewDelete', 'specialist:delete-preview', ELECTRON], ['previewExport', 'specialist:export-preview', ELECTRON],
    ['removeMarketplaceSource', 'specialist:marketplace-source-remove', ELECTRON],
    ['resolveSessionSpecialist', 'specialist:resolve-session-specialist', ELECTRON],
    ['retryHandoff', 'specialist:retry-handoff', ELECTRON], ['setEnabled', 'specialist:set-enabled', ELECTRON],
    ['savePackageReport', 'specialist:package-report-save', ELECTRON], ['selectPackage', 'specialist:package-select', ELECTRON],
    ['setSessionSpecialist', 'specialist:set-session-specialist', ELECTRON], ['update', 'specialist:update', ELECTRON],
  ]),
  group('storage', 'storage', [
    ['cancelMigrate', 'storage:cancel-migrate', LOCAL], ['commitAndRelaunch', 'storage:commit-and-relaunch', LOCAL, STORAGE_PARENT],
    ['detectActive', 'storage:detect-active'], ['discardMigratedCopy', 'storage:discard-migrated-copy', LOCAL, STORAGE_PARENT],
    ['dismissLegacyMovePrompt', 'storage:dismiss-legacy-move-prompt'], ['getStatus', 'storage:get-status'], ['getInfo', 'storage:get-info'],
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

export const ELECTRON_APPLICATION_COMMAND_CHANNELS: readonly string[] = Object.freeze(
  RENDERER_CONTRACT_CATALOG.flatMap(
    ({ applicationCommand, channel, dispatchPolicy, kind, surfaceInstallation }) =>
      applicationCommand === 'runtime-validated' &&
      channel !== null &&
      kind === 'method' &&
      surfaceInstallation.electron === 'preload' &&
      dispatchPolicy.electron === 'electron-ipc-request'
        ? [channel]
        : []
  ).sort()
)
