import { basename, dirname, extname, relative, resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isMethodDeclaration,
  isNamedExports,
  isNewExpression,
  isPropertyDeclaration,
  isStringLiteralLike,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

import { loadModuleImpactManifest } from '../../../scripts/ci/load-module-impact.mjs'

import {
  listProductionSources,
  readProductionSource
} from '../../../test/architecture-source-index'

const projectRoot = resolve(__dirname, '../../..')
const settingsRoot = resolve(projectRoot, 'src/main/settings')
const manifestPath = resolve(projectRoot, 'scripts/ci/module-impact.json')
const settingsPaths = {
  repository: resolve(settingsRoot, 'repository.ts'),
  recordCodec: resolve(settingsRoot, 'record-codec.ts'),
  documentCodec: resolve(settingsRoot, 'document-codec.ts'),
  documentStore: resolve(settingsRoot, 'document-store.ts'),
  computeGrantPort: resolve(settingsRoot, 'compute-grant-port.ts'),
  providerAccounts: resolve(settingsRoot, 'provider-accounts.ts'),
  providerAuthLifecycle: resolve(settingsRoot, 'provider-auth-lifecycle.ts'),
  providerRuntimeProjection: resolve(settingsRoot, 'provider-runtime-projection.ts'),
  backendResolver: resolve(settingsRoot, 'backend-resolver.ts'),
  backendSelection: resolve(settingsRoot, 'backend-selection-owner.ts'),
  backendRoutePlanner: resolve(settingsRoot, 'backend-route-planner.ts'),
  providerTransportOwner: resolve(settingsRoot, 'provider-transport-owner.ts'),
  responsesBridge: resolve(settingsRoot, 'responses-bridge.ts'),
  responsesProtocolTypes: resolve(settingsRoot, 'responses-protocol-types.ts'),
  responsesRequestAdapter: resolve(settingsRoot, 'responses-request-adapter.ts'),
  responsesResponseAdapter: resolve(settingsRoot, 'responses-response-adapter.ts'),
  reviewerModelOwner: resolve(settingsRoot, 'reviewer-model-owner.ts'),
  subagentModelOwner: resolve(settingsRoot, 'subagent-model-owner.ts'),
  visionModelOwner: resolve(settingsRoot, 'vision-model-owner.ts'),
  subagentModelSettings: resolve(settingsRoot, 'subagent-model-settings.ts'),
  service: resolve(settingsRoot, 'service.ts'),
  types: resolve(settingsRoot, 'types.ts'),
  notebookLocalRpcServer: resolve(projectRoot, 'src/main/notebook/local-rpc-server.ts')
} as const
const readSource = (path: string): string => readProductionSource(path, projectRoot)
const modulePath = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, '')
const portableProjectPath = (path: string): string =>
  relative(projectRoot, path).replaceAll('\\', '/')
const sourceFileCache = new Map<string, SourceFile>()
const sourceFileFor = (path: string): SourceFile => {
  const cached = sourceFileCache.get(path)
  if (cached) return cached
  const sourceFile = createSourceFile(
    path,
    readSource(path),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
  sourceFileCache.set(path, sourceFile)
  return sourceFile
}
const productionSources = (): readonly string[] => listProductionSources(projectRoot)
const importSpecifiersCache = new Map<string, string[]>()
const importSpecifiersFrom = (sourcePath: string): string[] => {
  const cached = importSpecifiersCache.get(sourcePath)
  if (cached) return cached
  const specifiers: string[] = []
  const visit = (node: Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (isImportTypeNode(node)) {
      const argument = node.argument
      if (isLiteralTypeNode(argument) && isStringLiteralLike(argument.literal)) {
        specifiers.push(argument.literal.text)
      }
    } else if (isCallExpression(node)) {
      const [argument] = node.arguments
      const isRequire = isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword
      if ((isRequire || isDynamicImport) && argument && isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(sourcePath))
  importSpecifiersCache.set(sourcePath, specifiers)
  return specifiers
}
const resolveImportTarget = (sourcePath: string, specifier: string): string | undefined =>
  specifier.startsWith('.') ? modulePath(resolve(dirname(sourcePath), specifier)) : undefined
const importersOf = (targetPath: string): string[] =>
  productionSourcePaths
    .filter((sourcePath) => readSource(sourcePath).includes(basename(modulePath(targetPath))))
    .filter((sourcePath) =>
      importSpecifiersFrom(sourcePath).some(
        (specifier) => resolveImportTarget(sourcePath, specifier) === modulePath(targetPath)
      )
    )
    .map(portableProjectPath)
const constructorSitesFor = (targetPath: string, className: string): string[] =>
  importersOf(targetPath).flatMap((portablePath) => {
    const sourcePath = resolve(projectRoot, portablePath)
    let count = 0
    const visit = (node: Node): void => {
      if (
        isNewExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === className
      ) {
        count += 1
      }
      forEachChild(node, visit)
    }
    visit(sourceFileFor(sourcePath))
    return Array.from({ length: count }, () => portablePath)
  })
const exportInventoryFrom = (path: string): string[] => {
  const names: string[] = []
  const sourceFile = sourceFileFor(path)
  for (const statement of sourceFile.statements) {
    if (isExportDeclaration(statement) && statement.exportClause) {
      if (isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.push(
            `${statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${element.name.text}`
          )
        }
      }
      continue
    }
    const exported =
      canHaveModifiers(statement) &&
      getModifiers(statement)?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) {
      names.push(`type:${statement.name.text}`)
    } else if (
      isClassDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isFunctionDeclaration(statement)
    ) {
      names.push(`value:${statement.name?.text ?? '<anonymous>'}`)
    } else if (isVariableStatement(statement)) {
      names.push(
        ...statement.declarationList.declarations.flatMap((declaration) =>
          isIdentifier(declaration.name) ? [`value:${declaration.name.text}`] : []
        )
      )
    }
  }
  return names.sort()
}
const publicOperationsOf = (path: string, className: string): string[] => {
  const sourceFile = sourceFileFor(path)
  const declaration = sourceFile.statements.find(
    (statement) => isClassDeclaration(statement) && statement.name?.text === className
  )
  if (!declaration || !isClassDeclaration(declaration)) throw new Error(`${className} not found`)

  return declaration.members
    .flatMap((member) => {
      const hidden =
        canHaveModifiers(member) &&
        getModifiers(member)?.some((modifier) =>
          [SyntaxKind.PrivateKeyword, SyntaxKind.ProtectedKeyword].includes(modifier.kind)
        )
      if (
        hidden ||
        (!isMethodDeclaration(member) && !isPropertyDeclaration(member)) ||
        !isIdentifier(member.name)
      ) {
        return []
      }
      return [member.name.text]
    })
    .sort()
}

const typePropertyNames = (path: string, typeName: string): string[] => {
  const sourceFile = sourceFileFor(path)
  const declaration = sourceFile.statements.find(
    (statement) => isTypeAliasDeclaration(statement) && statement.name.text === typeName
  )
  if (!declaration || !isTypeAliasDeclaration(declaration)) {
    throw new Error(`${typeName} is not an object type`)
  }
  const typeNode =
    isTypeReferenceNode(declaration.type) && declaration.type.typeArguments?.[0]
      ? declaration.type.typeArguments[0]
      : declaration.type
  if (!isTypeLiteralNode(typeNode)) {
    throw new Error(`${typeName} is not an object type`)
  }
  return typeNode.members
    .flatMap((member) => (member.name ? [member.name.getText(sourceFile)] : []))
    .sort()
}

const stringSetValues = (path: string, variableName: string): string[] => {
  const declaration = sourceFileFor(path)
    .statements.filter(isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((candidate) => isIdentifier(candidate.name) && candidate.name.text === variableName)
  const initializer = declaration?.initializer
  const [values] = initializer && isNewExpression(initializer) ? (initializer.arguments ?? []) : []
  if (!values || !isArrayLiteralExpression(values)) {
    throw new Error(`${variableName} is not initialized from an array`)
  }
  return values.elements.map((element) => {
    if (!isStringLiteralLike(element)) throw new Error(`${variableName} contains a non-string`)
    return element.text
  })
}

const productionSourcePaths = productionSources()

describe('Settings backend ownership architecture', () => {
  it('locks the stable module export inventories', () => {
    expect(exportInventoryFrom(settingsPaths.repository)).toEqual([
      'value:SettingsRepository',
      'value:sanitizeConnectors',
      'value:sanitizeCustomMcpServer',
      'value:sanitizePackageMirror',
      'value:sanitizeSettings'
    ])
    expect(exportInventoryFrom(settingsPaths.computeGrantPort)).toEqual([
      'value:createSettingsComputeGrantPort'
    ])
    expect(exportInventoryFrom(settingsPaths.providerAccounts)).toEqual([
      'type:ProviderAccountsModuleOptions',
      'type:ProviderRuntimeTarget',
      'type:RuntimeProviderModelSelection',
      'value:CLAUDE_SHARED_DISCONNECTED_MESSAGE',
      'value:ProviderAccountsModule',
      'value:requiresNativeResponsesCompatibility'
    ])
    expect(exportInventoryFrom(settingsPaths.backendResolver)).toEqual([
      'type:AdmittedAgentBackendTarget',
      'type:AgentBackendConnectorPort',
      'type:AgentBackendProviderPort',
      'type:AgentBackendResolutionContext',
      'type:AgentBackendResolverOptions',
      'type:AgentBackendRuntimePort',
      'type:AgentBackendSelection',
      'type:AgentSpawnConfig',
      'type:ExplicitAgentBackendTarget',
      'value:AgentBackendResolver'
    ])
    expect(exportInventoryFrom(settingsPaths.providerTransportOwner)).toEqual([
      'type:ProviderTransportOwnerOptions',
      'value:ProviderTransportOwner'
    ])
    expect(exportInventoryFrom(settingsPaths.responsesBridge)).toEqual([
      'type:ResponsesBridgeConnection',
      'type:ResponsesBridgeModelTarget',
      'type:ResponsesBridgeNamespacedTool',
      'type:ResponsesBridgeOptions',
      'type:ResponsesBridgeSkillCandidate',
      'type:ResponsesBridgeSkillInput',
      'type:ResponsesBridgeTarget',
      'value:ResponsesBridge',
      'value:chatUrl',
      'value:completionToResponse',
      'value:inputToMessages',
      'value:responsesToChatRequest',
      'value:toolsToChat',
      'value:upstreamErrorMessage'
    ])
    expect(exportInventoryFrom(settingsPaths.service)).toEqual([
      'type:AgentBackendResolutionContext',
      'type:AgentBackendSelection',
      'type:CustomServerSecurityChangeGuard',
      'type:SettingsServiceOptions',
      'type:UninstallResult',
      'value:SettingsService',
      'value:createDefaultSettingsService'
    ])
    expect(exportInventoryFrom(settingsPaths.subagentModelOwner)).toEqual([
      'type:InheritedSubagentModel',
      'type:SubagentModelOwnerOptions',
      'value:SubagentModelOwner',
      'value:createSubagentModels'
    ])
    expect(exportInventoryFrom(settingsPaths.subagentModelSettings)).toEqual([
      'type:ReviewerModelValidator',
      'type:SessionDetailsModelValidator',
      'type:SubagentModelValidator',
      'type:VisionModelValidator',
      'value:buildReviewerModelMutation',
      'value:buildSessionDetailsModelMutation',
      'value:buildSubagentModelMutation',
      'value:buildVisionModelMutation'
    ])
  })

  it('locks repository and provider account facade operations', () => {
    expect(publicOperationsOf(settingsPaths.repository, 'SettingsRepository')).toEqual([
      'addComputeGrant',
      'addCustomServer',
      'clearCodeBuddyInfo',
      'clearCodexInfo',
      'clearCodexIsolatedValidationIfExists',
      'clearComputeGrants',
      'clearGrantedLocalRoots',
      'clearOpencodeInfo',
      'completeCustomServerDeletion',
      'deleteProvider',
      'getSettings',
      'hasComputeGrant',
      'listComputeGrants',
      'markLegacyDataMovePromptDismissed',
      'markOnboardingComplete',
      'markPathsNormalized',
      'mutateClassification',
      'publishBootstrapOpenAlex',
      'publishBootstrapProvider',
      'rememberCodexAutoHttpsFallback',
      'removeCustomServer',
      'restoreLocalShellRuntime',
      'selectBootstrapCodex',
      'setActiveProvider',
      'setAgentEnvironmentCreationEnabled',
      'setAgentFramework',
      'setAgentRouting',
      'setAppIconVariant',
      'setClaudeInfo',
      'setClosePreference',
      'setCodeBuddyInfo',
      'setCodexInfo',
      'setComputeBookmarks',
      'setConnectorAutoAllow',
      'setConnectorDisabled',
      'setConversationSkillImportEnabled',
      'setCustomServerEnabled',
      'setCustomServersEnabled',
      'setDataRoot',
      'setDefaultPermissionProfile',
      'setGitHubToken',
      'setLocalShellRuntime',
      'setLocalePreference',
      'setManualInterpreters',
      'setNcbiCredentials',
      'setNetworkProxy',
      'setNotebookNetwork',
      'setNotificationsEnabled',
      'setOpenAlexCredential',
      'setOpencodeInfo',
      'setPackageMirror',
      'setProjectFilesFilter',
      'setReasoningEffort',
      'setReviewerModel',
      'setRuntimeEnablement',
      'setSessionDetailsModel',
      'setShowNotificationContent',
      'setSkillEnabled',
      'setSkillsEnabled',
      'setSubagentModel',
      'setToolBlocked',
      'setToolPolicy',
      'setVisionModel',
      'setWslSelection',
      'updateClaudeIsolatedCredentialsIfExists',
      'updateClaudeIsolatedValidationIfKeyMatches',
      'updateClaudeSharedValidationIfUnchanged',
      'updateCodexIsolatedValidationIfIdentityMatches',
      'updateCustomServer',
      'updateCustomServerOAuthState',
      'updateProviderModelCatalogIfTargetMatches',
      'updateProviderValidationIfTargetMatches',
      'updateXaiCredentialsIfKeyMatches',
      'upsertClaudeIsolatedProvider',
      'upsertProvider'
    ])
    expect(publicOperationsOf(settingsPaths.providerAccounts, 'ProviderAccountsModule')).toEqual([
      'beginXaiOAuthLogin',
      'bootstrapOpenAi',
      'cancelClaudeIsolatedLogin',
      'cancelClaudeLogin',
      'cancelCodexLogin',
      'cancelXaiOAuthLogin',
      'completeBootstrapCodex',
      'deleteProvider',
      'dispose',
      'getClaudeIsolatedStatus',
      'getClaudeSharedStatus',
      'getXaiOAuthAccessToken',
      'isProviderKeyUsable',
      'loginClaudeShared',
      'loginIsolatedClaude',
      'loginIsolatedClaudeBrowser',
      'loginIsolatedCodex',
      'logoutClaudeShared',
      'logoutIsolatedClaude',
      'logoutIsolatedCodex',
      'logoutXaiOAuth',
      'migrateLegacyKeyRefs',
      'prepareBootstrapCodex',
      'refreshProviderModels',
      'resolveActiveModel',
      'resolveProvider',
      'resolveProviderApiEndpoints',
      'resolveRuntimeModelCatalog',
      'resolveRuntimeReasoningEffortProfile',
      'resolveRuntimeTarget',
      'saveValidatedProvider',
      'setActiveProvider',
      'toProviderView',
      'upsertProvider',
      'validateProvider',
      'waitXaiOAuthLogin'
    ])
  })

  it('locks backend resolver and Responses bridge facade operations', () => {
    expect(publicOperationsOf(settingsPaths.backendResolver, 'AgentBackendResolver')).toEqual([
      'captureConfiguredSelection',
      'captureExplicitTarget',
      'resolveActiveBackend',
      'resolveActiveModelChangeTarget',
      'resolveActiveReasoningEffort',
      'resolveActiveSpawnConfig',
      'resolveAdmittedTarget',
      'resolveExplicitTarget',
      'resolveSelection'
    ])
    expect(
      publicOperationsOf(settingsPaths.providerTransportOwner, 'ProviderTransportOwner')
    ).toEqual(['acquire'])
    expect(publicOperationsOf(settingsPaths.responsesBridge, 'ResponsesBridge')).toEqual([
      'close',
      'registerHostMessageSession',
      'registerMcpSession',
      'registerReviewerSession',
      'registerToolLessSession',
      'selectSkills',
      'setModelTarget',
      'setReasoningEffort',
      'setTarget',
      'start',
      'unregisterHostMessageSession',
      'unregisterMcpSession',
      'unregisterReviewerSession',
      'unregisterToolLessSession'
    ])
  })

  it('locks the SettingsService application interface', () => {
    expect(publicOperationsOf(settingsPaths.service, 'SettingsService')).toEqual(
      `
        addCustomServer addManualInterpreter admitReviewerExecutionModel admitSessionDetailsExecutionTarget admitSubagentExecutionModel admitVisionModel allowNotebookNetworkDomain authenticateCustomServer authenticateDeviceCredential bootstrap buildCustomServerTemplateExport
        buildSkillExport beginXaiOAuthLogin cancelClaudeIsolatedLogin cancelClaudeLogin cancelCodexLogin cancelCustomServerAuthentication cancelDeviceCredentialAuthentication cancelXaiOAuthLogin captureActiveAgentBackendSelection captureActiveExplicitAgentBackendTarget checkEnvironment classification clearGrantedLocalRoots codeBuddySkillCatalog codexSkillCatalog
        codexSkillDescriptorsForIds createDeviceCredential createSkill deleteProvider deleteSkill detectClaude detectCodeBuddy detectCodex
        detectOpencode deviceCredentialConsumerIds deviceCredentialIdForServer disconnectCustomServer disconnectDeviceCredential dismissLegacyDataMovePrompt getActiveInstallId getAgentEnvironmentCreationEnabled getAppIconVariant getClosePreference
        getComputeBookmarks getConnectorDetail getConnectors getConversationSkillImportEnabled getGitHubTokenStatus getGrantedLocalRoots getLocalShellRuntimePreference getManualInterpreters getNotebookNetwork getNotebookNetworkStatus getNotificationsEnabled getPackageMirror
        getPreflight getRuntimeEnablement getSettingsView getShowNotificationContent getSkillDetail getSkillMarketplaceBatch getSkillMarketplaceDetail getWsl2BashPreviewStatus getWslSetupStatus hasActiveInstall holdInstallAdmission
        getStoredSettings importAgentHomeSkills importSkill importSkillArchiveBatch importSkillZip
        importSkillZipBatch installClaude installCodeBuddy installCodex installMissingWslDependencies installNotebookNetwork installOpencode installRecommendedWslDistro installSkillMarketplace installWslPlatform isEncryptionAvailable
        isNpmAvailable listAgentHomeSkills listConnectors listDeviceCredentials listHostSkills listSkillMarketplace listSkills listSpecialistSkillCatalog listUserSkills
        dispose loginClaudeShared loginIsolatedClaude loginIsolatedClaudeBrowser loginIsolatedCodex
        logoutClaudeShared logoutIsolatedClaude logoutIsolatedCodex logoutXaiOAuth markOnboardingComplete
        markPathsNormalized migrateAgentHomeSkillIdentities openWslTerminal prepareDelegatedSkills previewAgentHomeSkill previewCustomServerTemplateExport
        previewCustomServerTemplateImport previewGitHubSkill previewSkillArchive previewSkillZip
        createWslSupportHandoff probeWslSetup provisionedConnectorSkillNames publishHostSkill refreshProviderModels registeredHelperCatalog rememberCodexAutoHttpsFallback removeCustomServer removeDeviceCredential removeGitHubToken removeNotebookNetwork
        removeManualInterpreter resolveActiveModelChangeTarget resolveActiveReasoningEffort restoreLocalShellRuntimePreference
        resolveAdmittedSubagentBackend resolveAgentBackend resolveDeviceOAuthCredential resolveExplicitAgentBackend resolveSkillDocument resolveSubagentExecutionModel saveCustomServerOAuthState saveGitHubToken saveValidatedProvider
        scanRepoSkills selectWslProfile setActiveProvider setAgentEnvironmentCreationEnabled setAgentFramework setAgentRouting setAppIconVariant setClosePreference switchLocalShellToPowerShell
        setComputeBookmarks setConnectorAutoAllow setConnectorEnabled
        setConversationSkillImportEnabled setCustomServerAuthenticator setCustomServerEnabled
        setDataRoot setDefaultPermissionProfile setDeviceCredentialAuthenticator setEnvironmentEnabled setInstallAuthorized
        setCustomServerRuntimeProjectionProvider setNcbiCredentials setNetworkProxy setNotebookNetwork setNotificationsEnabled
        setOpenAlexCredential setPackageMirror setProjectFilesFilter setReasoningEffort setReviewerModel setSessionDetailsModel setShowNotificationContent setSkillDeletionGuard setSkillEnabled setSkillsEnabled setSubagentModel setVisionModel
        setToolPermission skillNudgeNamesForIds skillsNeedingForceLoad startSkillMarketplaceBatch stopSkillMarketplaceBatch uninstallClaude uninstallCodeBuddy uninstallCodex
        uninstallOpencode updateCustomServer updateDeviceCredential updateSkill upsertProvider useWsl2Bash validateOpenAlexCredential validateProvider waitXaiOAuthLogin withHostSkillRead
      `
        .trim()
        .split(/\s+/)
        .sort()
    )
  })

  it('locks the current production importer graph at the public seams', () => {
    expect(importersOf(settingsPaths.repository)).toEqual([
      'src/main/ipc.ts',
      'src/main/locale/owner.ts',
      'src/main/settings/agent-runtime-manager.ts',
      'src/main/settings/classification-settings.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/connector-settings.ts',
      'src/main/settings/network-proxy-settings-owner.ts',
      'src/main/settings/notebook-network-settings-owner.ts',
      'src/main/settings/notebook-runtime-settings.ts',
      'src/main/settings/preferences.ts',
      'src/main/settings/provider-accounts.ts',
      'src/main/settings/provider-auth-lifecycle.ts',
      'src/main/settings/provider-model-catalog-owner.ts',
      'src/main/settings/provider-runtime-health-owner.ts',
      'src/main/settings/reviewer-model-owner.ts',
      'src/main/settings/service.ts',
      'src/main/settings/session-details-model-owner.ts',
      'src/main/settings/skill-catalog.ts',
      'src/main/settings/subagent-model-owner.ts',
      'src/main/settings/vision-model-owner.ts',
      'src/main/settings/xai-provider-account-owner.ts',
      'src/main/specialist/package/service.ts',
      'src/main/specialist/package/transaction.ts',
      'src/main/storage/initialize-location.ts'
    ])
    expect(importersOf(settingsPaths.recordCodec)).toEqual([
      'src/main/settings/document-codec.ts',
      'src/main/settings/repository.ts'
    ])
    expect(importersOf(settingsPaths.documentCodec)).toEqual([
      'src/main/settings/document-store.ts',
      'src/main/settings/repository.ts'
    ])
    expect(importersOf(settingsPaths.documentStore)).toEqual([
      'src/main/ipc.ts',
      'src/main/settings/repository.ts',
      'src/main/storage/initialize-location.ts'
    ])
    expect(importersOf(settingsPaths.computeGrantPort)).toEqual(['src/main/compute/ipc.ts'])
    expect(importersOf(settingsPaths.providerAccounts)).toEqual([
      'src/main/settings/agent-runtime-manager.ts',
      'src/main/settings/backend-resolver.ts',
      'src/main/settings/backend-route-planner.ts',
      'src/main/settings/backend-selection-owner.ts',
      'src/main/settings/codebuddy-skill-selector-transport.ts',
      'src/main/settings/provider-runtime-health-owner.ts',
      'src/main/settings/provider-transport-owner.ts',
      'src/main/settings/reviewer-model-owner.ts',
      'src/main/settings/service.ts',
      'src/main/settings/session-details-model-owner.ts',
      'src/main/settings/subagent-model-owner.ts',
      'src/main/settings/vision-model-owner.ts'
    ])
    expect(importersOf(settingsPaths.backendResolver)).toEqual([
      'src/main/acp/artifact-code-reconstruction-runner.ts',
      'src/main/acp/image-input-compatibility-owner.ts',
      'src/main/acp/restricted-inference-runner.ts',
      'src/main/artifacts/code-reconstruction.ts',
      'src/main/notebook/host-model-service.ts',
      'src/main/reviewer/model-runtime-owner.ts',
      'src/main/settings/reviewer-model-owner.ts',
      'src/main/settings/service.ts',
      'src/main/settings/session-details-model-owner.ts',
      'src/main/settings/subagent-model-owner.ts',
      'src/main/settings/vision-model-owner.ts',
      'src/main/side-chat/runtime-owner.ts'
    ])
    expect(importersOf(settingsPaths.backendRoutePlanner)).toEqual([
      'src/main/settings/backend-resolver.ts',
      'src/main/settings/provider-transport-owner.ts'
    ])
    expect(importersOf(settingsPaths.providerTransportOwner)).toEqual([
      'src/main/settings/backend-resolver.ts'
    ])
    expect(importersOf(settingsPaths.responsesBridge)).toEqual([
      'src/main/acp/turn-skill-owner.ts',
      'src/main/agent-framework/types.ts',
      'src/main/reviewer/bridge-tools.ts',
      'src/main/settings/backend-route-planner.ts',
      'src/main/settings/codebuddy-skill-selector-transport.ts',
      'src/main/settings/native-responses-compatibility.ts',
      'src/main/settings/provider-transport-owner.ts',
      'src/main/settings/validate.ts'
    ])
    expect(importersOf(settingsPaths.service)).toEqual([
      'src/main/ipc.ts',
      'src/main/settings/application-commands.ts',
      'src/main/settings/bootstrap-application-commands.ts',
      'src/main/settings/ipc.ts',
      'src/main/settings/service-capabilities.ts',
      'src/main/settings/workflows/appearance.ts',
      'src/main/settings/workflows/connectors.ts',
      'src/main/settings/workflows/runtime.ts',
      'src/main/settings/workflows/skills.ts'
    ])
  })

  it('keeps Issue #458 coordination code behind application-owned ports', () => {
    const concreteSettingsOwners = new Set(
      [
        settingsPaths.repository,
        settingsPaths.backendResolver,
        settingsPaths.providerTransportOwner
      ].map(modulePath)
    )
    const coordinationSources = productionSourcePaths.filter((sourcePath) =>
      /(?:orchestrat|coordinat|delegat)/i.test(portableProjectPath(sourcePath))
    )

    expect(coordinationSources.length).toBeGreaterThan(0)
    expect(
      coordinationSources
        .filter((sourcePath) =>
          importSpecifiersFrom(sourcePath).some((specifier) => {
            const target = resolveImportTarget(sourcePath, specifier)
            return target ? concreteSettingsOwners.has(target) : false
          })
        )
        .map(portableProjectPath)
    ).toEqual([])
  })

  it('locks the complete Notebook local-RPC capability inventory', () => {
    expect(stringSetValues(settingsPaths.notebookLocalRpcServer, 'ARTIFACT_RPC_METHODS')).toEqual([
      'artifactSaveVersion',
      'artifactReserveWrite',
      'artifactReleaseWrite',
      'artifactCreateVersion',
      'artifactReplayVersion'
    ])
    expect(stringSetValues(settingsPaths.notebookLocalRpcServer, 'CONTROL_RPC_METHODS')).toEqual([
      'capabilitiesCall',
      'artifactsCall',
      'lineageCall',
      'framesCall',
      'sessionsCall',
      'mcpCall',
      'computeCall',
      'agentsCall',
      'hostSdkHelp',
      'delegatedWorkCall',
      'skillsCall',
      'llmCall',
      'currentModelCall',
      'listModelsCall',
      'viewImageCall',
      'requestUserInput',
      'memoryListCategories',
      'memorySearch',
      'memoryRemember'
    ])
    expect(
      stringSetValues(settingsPaths.notebookLocalRpcServer, 'SKILL_IMPORT_RPC_METHODS')
    ).toEqual(['skillImport'])
    expect(stringSetValues(settingsPaths.notebookLocalRpcServer, 'PLAN_RPC_METHODS')).toEqual([
      'planCall'
    ])
  })

  it('locks the durable Settings shape and secret-free explicit target seam', () => {
    expect(typePropertyNames(settingsPaths.types, 'StoredSettings')).toEqual([
      'activatedWslSelection',
      'activeModel',
      'activeProviderId',
      'agentEnvironmentCreationEnabled',
      'agentFrameworkId',
      'appIconVariant',
      'classification',
      'claude',
      'claudeSubscriptionProviderId',
      'closePreference',
      'codebuddyPath',
      'codebuddyVersion',
      'codex',
      'computeBookmarks',
      'computeGrants',
      'connectors',
      'conversationSkillImportEnabled',
      'dataRoot',
      'dataRootIsInitialDefault',
      'defaultPermissionProfile',
      'disabledSkillIds',
      'githubTokenMask',
      'githubTokenRef',
      'grantedLocalRoots',
      'legacyDataMovePromptDismissedAt',
      'localShellRuntime',
      'localePreference',
      'networkProxy',
      'notebookManualInterpreters',
      'notebookNetwork',
      'notebookRuntimeEnablement',
      'notificationsEnabled',
      'onboardingCompletedAt',
      'opencodePath',
      'opencodeVersion',
      'packageMirror',
      'pathsNormalizedAt',
      'projectFilesFilter',
      'providers',
      'reasoningEffort',
      'reviewerModel',
      'sessionDetailsModel',
      'showNotificationContent',
      'subagentModel',
      'version',
      'visionModel',
      'wslSelection'
    ])
    expect(typePropertyNames(settingsPaths.types, 'StoredProvider')).toEqual([
      'accountEmail',
      'apiEndpoints',
      'baseUrl',
      'codexAuthMode',
      'codexAutoUseHttps',
      'codexTransport',
      'configRevision',
      'contextWindow',
      'disconnectedAt',
      'expiresAt',
      'fetchedModels',
      'id',
      'keyMask',
      'keyRef',
      'lastValidatedAt',
      'lastValidatedTarget',
      'lastValidationFailure',
      'maxInputTokens',
      'maxOutputTokens',
      'model',
      'name',
      'reasoningEffortPreset',
      'reasoningEffortTransport',
      'region',
      'supportsImageInput',
      'type',
      'vendorId'
    ])
    expect(typePropertyNames(settingsPaths.backendSelection, 'ExplicitAgentBackendTarget')).toEqual(
      ['frameworkId', 'model', 'providerId', 'reasoningEffort', 'resolvedReasoningEffort']
    )
  })

  it('locks one production Settings document owner and the narrow Compute legacy port', () => {
    expect(constructorSitesFor(settingsPaths.repository, 'SettingsRepository')).toEqual([
      'src/main/ipc.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/service.ts',
      'src/main/specialist/package/transaction.ts',
      'src/main/storage/initialize-location.ts'
    ])
    const computeIpc = readSource(resolve(projectRoot, 'src/main/compute/ipc.ts'))
    expect(computeIpc).not.toContain("from '../settings/repository'")
    expect(computeIpc).toContain('legacyComputeGrants?: LegacyComputeGrantPort')
    expect(computeIpc).toContain('legacyComputeGrants && !permissionGrantRegistry')
    expect(computeIpc).toContain('legacyComputeGrants.hasComputeGrant(grant)')
    expect(computeIpc).toContain('legacyComputeGrants.addComputeGrant(grant)')
    const mainIpc = readSource(resolve(projectRoot, 'src/main/ipc.ts'))
    const mainIndex = readSource(resolve(projectRoot, 'src/main/index.ts'))
    expect(mainIndex).toContain('const settingsStore = bootstrapLocations.settingsStore')
    expect(mainIndex).toContain('const startupSettingsRepository = bootstrapLocations.repository')
    expect(mainIndex).toMatch(
      /registerIpcHandlers\(\{\s+mainEntryPath,\s+settingsStore,\s+translate,/u
    )
    expect(mainIpc).toContain('settingsStore ?? resolveConfigRoot()')
    // Package transactions use the shared production repository; their fallback supports standalone use.
    expect(mainIpc).toContain('skillSettings: settingsRepository')
    expect(mainIpc).toContain('await settingsService.migrateAgentHomeSkillIdentities()')
    expect(mainIpc.indexOf('specialistPackageRecovery.current =')).toBeLessThan(
      mainIpc.indexOf('await settingsService.migrateAgentHomeSkillIdentities()')
    )
    const settingsModule = mainIpc.slice(
      mainIpc.indexOf('const settingsService = await modules.add('),
      mainIpc.indexOf('settingsServiceRef.current = settingsService')
    )
    expect(settingsModule).toContain(
      'const capability = new SettingsService({\n      repository: settingsRepository,\n      onProviderHealthChanged: async () => {\n        await settingsSnapshotCommits.projectAfter(Promise.resolve())\n      },\n      installCoordinator: settingsInstallCoordinator,\n      skillRuntimeMcpEntryPath: mainEntryPath,\n      openAlexFetch: netFetchStandard,\n      applyNetworkProxy:'
    )
    expect(settingsModule).toContain("name: 'settings-service'")
    expect(settingsModule).toContain('rollback: () => capability.dispose()')
    expect(settingsModule).toContain('dispose: () => capability.dispose()')
    expect(settingsModule).toContain('disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS')
    const updateBlockerDetector = mainIpc.slice(
      mainIpc.indexOf('const detectResearchBlockers'),
      mainIpc.indexOf('const durableDataRootHandoffGate')
    )
    expect(updateBlockerDetector).toContain(
      "if (settingsService.hasActiveInstall()) blockers.push('settings-install')"
    )
    const updateInstallHandoff = mainIpc.slice(
      mainIpc.indexOf('let releaseSettingsInstallAdmission'),
      mainIpc.indexOf('const updateCommandOwner')
    )
    expect(updateInstallHandoff).toContain(
      'releaseSettingsInstallAdmission = settingsService.holdInstallAdmission()'
    )
    expect(updateInstallHandoff).toContain('releaseAdmission?.()')
    const dataRootInstallHandoff = mainIpc.slice(
      mainIpc.indexOf('let releaseDataRootInstallAdmission'),
      mainIpc.indexOf("declareElectronAdapter('storage'")
    )
    expect(dataRootInstallHandoff).toContain(
      'releaseDataRootInstallAdmission ??= settingsService.holdInstallAdmission()'
    )
    expect(dataRootInstallHandoff).toContain('abortDataRootInstallAdmission()')
    expect(mainIpc).toContain('permissionGrantRegistry,\n    settingsRepository')
  })

  it('locks dependency-aware impact owners and cross-surface evidence', () => {
    const manifest = loadModuleImpactManifest(manifestPath)
    expect(manifest.modules.settings_repository.ownerPaths).toEqual([
      'src/main/settings/repository.ts',
      'src/main/settings/record-codec.ts',
      'src/main/settings/provider-token-limits.ts',
      'src/main/settings/document-codec.ts',
      'src/main/settings/document-store.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/subagent-model-settings.ts',
      'src/main/settings/compute-grants.test.ts',
      'src/main/settings/connectors-settings.test.ts',
      'src/main/settings/custom-mcp-settings.test.ts',
      'src/main/settings/document-codec.test.ts',
      'src/main/settings/document-store.test.ts',
      'src/main/settings/mirror-settings.test.ts',
      'src/main/settings/provider-token-limits.test.ts',
      'src/main/settings/record-codec.test.ts',
      'src/main/settings/repository.test.ts',
      'src/main/settings/document-read-error.ts',
      'src/main/settings/document-shape.ts',
      'src/main/settings/classification-config.ts'
    ])
    expect(manifest.modules.settings_repository.interfacePaths).toEqual([
      'src/main/settings/repository.ts',
      'src/shared/network-proxy.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/provider-token-limits.ts',
      'src/main/settings/document-store.ts'
    ])
    expect(manifest.modules.settings_provider_accounts.ownerPaths).toEqual([
      'src/main/settings/bounded-response.ts',
      'src/main/settings/provider-accounts.ts',
      'src/main/settings/provider-auth-lifecycle.ts',
      'src/main/settings/provider-draft-projection.ts',
      'src/main/settings/provider-model-catalog-owner.ts',
      'src/main/settings/provider-resource-limits.ts',
      'src/main/settings/provider-runtime-projection.ts',
      'src/main/settings/xai-oauth.ts',
      'src/main/settings/xai-provider-account-owner.ts',
      'src/main/settings/claude-isolated-auth.test.ts',
      'src/main/settings/claude-isolated-auth.ts',
      'src/main/settings/claude-shared-auth.test.ts',
      'src/main/settings/claude-shared-auth.ts',
      'src/main/settings/codex-auth.test.ts',
      'src/main/settings/codex-auth.ts',
      'src/main/settings/crypto.test.ts',
      'src/main/settings/crypto.ts',
      'src/main/settings/list-models.test.ts',
      'src/main/settings/list-models.ts',
      'src/main/settings/provider-accounts.test.ts',
      'src/main/settings/provider-auth-lifecycle.architecture.test.ts',
      'src/main/settings/provider-auth-lifecycle.test.ts',
      'src/main/settings/provider-env.test.ts',
      'src/main/settings/provider-env.ts',
      'src/main/settings/provider-runtime-projection.architecture.test.ts',
      'src/main/settings/provider-runtime-projection.test.ts',
      'src/main/settings/validate.test.ts',
      'src/main/settings/validate.ts',
      'src/main/settings/xai-oauth.test.ts',
      'src/main/settings/xai-provider-account-owner.test.ts'
    ])
    expect(manifest.modules.settings_provider_accounts.interfacePaths).toEqual([
      'src/main/settings/provider-accounts.ts',
      'src/main/settings/bounded-response.ts',
      'src/main/settings/claude-isolated-auth.ts',
      'src/main/settings/claude-shared-auth.ts',
      'src/main/settings/codex-auth.ts',
      'src/main/settings/crypto.ts',
      'src/main/settings/list-models.ts',
      'src/main/settings/provider-draft-projection.ts',
      'src/main/settings/provider-env.ts',
      'src/main/settings/provider-resource-limits.ts',
      'src/main/settings/provider-runtime-projection.ts',
      'src/main/settings/validate.ts'
    ])
    expect(manifest.modules.settings_backend_resolution.ownerPaths).toEqual([
      'src/main/settings/backend-resolver.ts',
      'src/main/settings/backend-selection-owner.ts',
      'src/main/settings/backend-route-planner.ts',
      'src/main/settings/codex-bridge-tools.ts',
      'src/main/settings/codex-bridge-tools.test.ts',
      'src/main/settings/network-proxy-runtime.ts',
      'src/main/settings/environment-check.ts',
      'src/main/settings/system-proxy.ts',
      'src/main/settings/native-responses-compatibility.ts',
      'src/main/settings/anthropic-provider-bridge.ts',
      'src/main/settings/openai-provider-bridge.ts',
      'src/main/settings/xai-oauth-provider-bridge.ts',
      'src/main/settings/xai-protocol.ts',
      'src/main/settings/provider-error-replay.ts',
      'src/main/settings/provider-loopback-http-host.ts',
      'src/main/settings/provider-transport-owner.ts',
      'src/main/settings/provider-failure-observation.ts',
      'src/main/settings/provider-runtime-health-owner.ts',
      'src/main/settings/responses-bridge.ts',
      'src/main/settings/responses-bridge.plan-tools.test.ts',
      'src/main/settings/responses-protocol-types.ts',
      'src/main/settings/responses-request-adapter.ts',
      'src/main/settings/responses-response-adapter.ts',
      'src/main/settings/anthropic-provider-bridge.test.ts',
      'src/main/settings/backend-resolver.test.ts',
      'src/main/settings/backend-route-planner.architecture.test.ts',
      'src/main/settings/backend-route-planner.test.ts',
      'src/main/settings/backend-selection-owner.architecture.test.ts',
      'src/main/settings/backend-selection-owner.test.ts',
      'src/main/settings/environment-check-proxy.test.ts',
      'src/main/settings/environment-check.test.ts',
      'src/main/settings/native-responses-compatibility.test.ts',
      'src/main/settings/network-proxy-runtime.test.ts',
      'src/main/settings/openai-provider-bridge.test.ts',
      'src/main/settings/provider-error-replay.test.ts',
      'src/main/settings/provider-loopback-http-host.architecture.test.ts',
      'src/main/settings/provider-loopback-http-host.test.ts',
      'src/main/settings/provider-transport-owner.architecture.test.ts',
      'src/main/settings/provider-transport-owner.test.ts',
      'src/main/settings/provider-runtime-health-owner.test.ts',
      'src/main/settings/responses-bridge.integration.test.ts',
      'src/main/settings/responses-bridge.test.ts',
      'src/main/settings/responses-reasoning-replay.test.ts',
      'src/main/settings/responses-request-adapter.architecture.test.ts',
      'src/main/settings/responses-request-adapter.test.ts',
      'src/main/settings/responses-response-adapter.architecture.test.ts',
      'src/main/settings/responses-response-adapter.test.ts',
      'src/main/settings/system-proxy.test.ts',
      'src/main/settings/xai-oauth-provider-bridge.test.ts',
      'src/main/settings/xai-protocol.test.ts'
    ])
    expect(manifest.modules.settings_backend_resolution.interfacePaths).toEqual([
      'src/main/settings/backend-resolver.ts',
      'src/main/settings/responses-bridge.ts',
      'src/main/settings/anthropic-provider-bridge.ts',
      'src/main/settings/backend-route-planner.ts',
      'src/main/settings/environment-check.ts',
      'src/main/settings/native-responses-compatibility.ts',
      'src/main/settings/network-proxy-runtime.ts',
      'src/main/settings/openai-provider-bridge.ts',
      'src/main/settings/provider-loopback-http-host.ts',
      'src/main/settings/provider-transport-owner.ts',
      'src/main/settings/provider-failure-observation.ts',
      'src/main/settings/provider-runtime-health-owner.ts',
      'src/main/settings/responses-request-adapter.ts',
      'src/main/settings/responses-response-adapter.ts',
      'src/main/settings/system-proxy.ts',
      'src/main/settings/xai-oauth-provider-bridge.ts',
      'src/main/settings/xai-protocol.ts'
    ])
    expect(manifest.modules.settings_service_facade.ownerPaths).toEqual([
      'src/main/settings/service.ts',
      'src/main/settings/network-proxy-settings-owner.ts',
      'src/main/settings/settings-snapshot-commit-owner.ts',
      'src/main/settings/reviewer-model-owner.ts',
      'src/main/settings/subagent-model-owner.ts',
      'src/main/settings/vision-model-owner.ts',
      'src/main/settings/application-commands.test.ts',
      'src/main/settings/application-commands.ts',
      'src/main/settings/integration-application-commands.test.ts',
      'src/main/settings/integration-application-commands.ts',
      'src/main/settings/ipc.test.ts',
      'src/main/settings/ipc.ts',
      'src/main/settings/runtime-application-commands.test.ts',
      'src/main/settings/runtime-application-commands.ts',
      'src/main/settings/service.connectors.test.ts',
      'src/main/settings/service.providers.test.ts',
      'src/main/settings/service.test.ts',
      'src/main/settings/settings-snapshot-commit-owner.test.ts',
      'src/main/settings/classification-settings.ts',
      'src/main/settings/classification-settings.test.ts'
    ])
    expect(manifest.modules.settings_service_facade.interfacePaths).toEqual([
      'src/main/settings/service.ts',
      'src/main/settings/application-commands.ts',
      'src/main/settings/runtime-application-commands.ts',
      'src/main/settings/integration-application-commands.ts',
      'src/main/settings/ipc.ts',
      'src/main/settings/reviewer-model-owner.ts',
      'src/main/settings/settings-snapshot-commit-owner.ts',
      'src/main/settings/subagent-model-owner.ts',
      'src/main/settings/vision-model-owner.ts'
    ])
    expect(manifest.modules.settings_repository.consumerModules).toEqual([
      'settings_provider_accounts',
      'settings_service_facade',
      'compute_service'
    ])
    expect(manifest.modules.settings_provider_accounts.consumerModules).toEqual([
      'settings_backend_resolution',
      'settings_service_facade'
    ])
    expect(manifest.modules.settings_backend_resolution.consumerModules).toEqual([
      'settings_service_facade',
      'reviewer_orchestrator',
      'artifact_provenance'
    ])
    expect(manifest.modules.settings_service_facade.consumerModules).toEqual(['workspace_runtime'])
    expect(manifest.modules.settings_service_facade.testFiles.contract).toEqual([
      'src/main/settings/application-commands.test.ts',
      'src/main/settings/runtime-application-commands.test.ts',
      'src/main/settings/integration-application-commands.test.ts',
      'src/main/settings/ipc.test.ts',
      'src/main/settings/capabilities.test.ts',
      'src/main/settings/workflows.test.ts',
      'src/main/application-command-composition.test.ts',
      'src/main/application-command-wiring.test.ts',
      'src/shared/renderer-contract-catalog.test.ts',
      'src/shared/renderer-surface-inventory.test.ts',
      'src/shared/renderer-surface-matrix.test.ts',
      'src/shared/web-rpc-contract.test.ts',
      'src/preload/electron-renderer-contract-adapter.test.ts',
      'src/renderer/web/api-installer.test.ts',
      'src/preload/index.test.ts'
    ])
    expect(manifest.modules.settings_service_facade.testFiles.consumer).toEqual([
      'packages/open-science/cli.test.ts',
      'src/main/acp/backend-generation-owner.test.ts',
      'src/main/acp/runtime-provider-session-composition.test.ts',
      'src/main/acp/task-agent-port.test.ts',
      'src/main/notebook/local-rpc-notebook-adapter.test.ts',
      'src/main/notebook/local-rpc-server.mcpcall.test.ts',
      'src/main/notebook/mcp-server.test.ts',
      'src/main/web-service/http-server.test.ts',
      'src/renderer/src/stores/settings-runtime-slice.test.ts',
      'src/renderer/src/stores/settings-store.test.ts',
      'src/main/acp/ipc.test.ts',
      'src/main/acp/runtime-composition.test.ts',
      'src/main/acp/runtime.test.ts',
      'src/main/application-command-client.test.ts',
      'src/main/application-command-electron-adapter.test.ts',
      'src/main/connectors/application.test.ts',
      'src/main/delegation/production-framework-runtime.test.ts',
      'src/main/host-application-commands.test.ts',
      'src/main/index-fatal-errors.test.ts',
      'src/main/index-startup-failure.test.ts',
      'src/main/ipc-surfaces/settings.test.ts',
      'src/main/literature/library-tool-contracts.test.ts',
      'src/main/literature/scale-regressions.test.ts',
      'src/main/remote-access/ipc.test.ts',
      'src/main/remote-access/pairing.test.ts',
      'src/main/remote-access/service.test.ts',
      'src/main/runtime-electron-wiring.test.ts',
      'src/main/runtime-state-ownership.architecture.test.ts',
      'src/main/settings/bootstrap.integration.test.ts',
      'src/main/settings/connector-credential-recovery.integration.test.ts',
      'src/main/settings/workflows/connectors-diagnostic.test.ts',
      'src/main/web-service/artifact-download.integration.test.ts',
      'src/main/web-service/controller.test.ts',
      'src/main/web-service/task-api.test.ts'
    ])
    expect(manifest.modules.settings_backend_resolution.testFiles.consumer).toEqual([
      'src/main/session-persistence/runtime-session-owner.test.ts',
      'src/main/session-plan/adversarial-session-plan.test.ts',
      'packages/open-science/cli.test.ts',
      'src/main/acp/artifact-code-reconstruction-runner.test.ts',
      'src/main/acp/backend-generation-owner.test.ts',
      'src/main/acp/provider-prompt-executor.test.ts',
      'src/main/acp/task-agent-port.test.ts',
      'src/main/acp/turn-skill-owner.test.ts',
      'src/main/artifacts/code-reconstruction.test.ts',
      'src/main/notebook/local-rpc-server.mcpcall.test.ts',
      'src/main/reviewer/mcp-server.test.ts',
      'src/main/acp/agent-connection-adapter.test.ts',
      'src/main/acp/application-commands.test.ts',
      'src/main/acp/client-interaction-owner.test.ts',
      'src/main/acp/codex-completion-handoff.integration.test.ts',
      'src/main/acp/connection-close-workflow.test.ts',
      'src/main/acp/connection-lifecycle-workflow.test.ts',
      'src/main/acp/connection-resource-owner.test.ts',
      'src/main/acp/context-compaction-workflow.test.ts',
      'src/main/acp/context-usage-policy.test.ts',
      'src/main/acp/context-usage-static-context.test.ts',
      'src/main/acp/durable-continuation-context-owner.test.ts',
      'src/main/acp/file-reference-resolver.test.ts',
      'src/main/acp/file-reference-resolver.windows-scope.test.ts',
      'src/main/acp/handler-workflows.test.ts',
      'src/main/acp/image-input-compatibility-owner.test.ts',
      'src/main/acp/ipc.test.ts',
      'src/main/acp/isolated-execution-preflight.test.ts',
      'src/main/acp/mcp-http-host.test.ts',
      'src/main/acp/model-change-workflow.test.ts',
      'src/main/acp/native-follow-up-workflow.test.ts',
      'src/main/acp/native-follow-up.test.ts',
      'src/main/acp/opencode-immediate-handoff.integration.test.ts',
      'src/main/acp/opencode-immediate-handoff.test.ts',
      'src/main/acp/opencode-turn-adapter.test.ts',
      'src/main/acp/opencode-turn-usage.test.ts',
      'src/main/acp/permission-broker-registry.test.ts',
      'src/main/acp/permission-broker.test.ts',
      'src/main/acp/permission-context.test.ts',
      'src/main/acp/permission-frequency.test.ts',
      'src/main/acp/permission-policy.test.ts',
      'src/main/acp/permission-wait-owner.test.ts',
      'src/main/acp/plan-review-provider-stop.test.ts',
      'src/main/acp/prompt-attachment-notebook-sandbox.integration.test.ts',
      'src/main/acp/prompt-content-owner.test.ts',
      'src/main/acp/prompt-image-privacy.test.ts',
      'src/main/acp/prompt-outcome-finalizer.test.ts',
      'src/main/acp/prompt-preparation-owner.test.ts',
      'src/main/acp/prompt-turn-workflow.test.ts',
      'src/main/acp/provider-session-adopter.test.ts',
      'src/main/acp/provider-session-creator.test.ts',
      'src/main/acp/provider-session-resumer.test.ts',
      'src/main/acp/restricted-inference-runner.test.ts',
      'src/main/acp/runtime-activity.test.ts',
      'src/main/acp/runtime-base-composition.test.ts',
      'src/main/acp/runtime-composition.test.ts',
      'src/main/acp/runtime-coordinator.test.ts',
      'src/main/acp/runtime-library-evidence.test.ts',
      'src/main/acp/runtime-lifecycle-composition.test.ts',
      'src/main/acp/runtime-pdf-elements.test.ts',
      'src/main/acp/runtime-plan-composition.test.ts',
      'src/main/acp/runtime-prompt-composition.test.ts',
      'src/main/acp/runtime-provider-session-composition.test.ts',
      'src/main/acp/runtime-session-composition.test.ts',
      'src/main/acp/runtime-session-plan.test.ts',
      'src/main/acp/runtime.test.ts',
      'src/main/acp/session-capability-handover.integration.test.ts',
      'src/main/acp/session-capability-owner.test.ts',
      'src/main/acp/session-configurator.test.ts',
      'src/main/acp/session-deletion-workflow.test.ts',
      'src/main/acp/session-environment-policy.test.ts',
      'src/main/acp/session-plan-delivery-owner.test.ts',
      'src/main/acp/session-presentation-policy.test.ts',
      'src/main/acp/session-replacement-workflow.test.ts',
      'src/main/acp/session-resume-policy.test.ts',
      'src/main/acp/session-update-projector.test.ts',
      'src/main/acp/shutdown-guard.test.ts',
      'src/main/acp/side-chat-interaction-admission.test.ts',
      'src/main/agent-framework/app-mcp-names.test.ts',
      'src/main/agent-framework/claude-code-memory.integration.test.ts',
      'src/main/agent-framework/codebuddy.test.ts',
      'src/main/agent-framework/native-shell-policy.test.ts',
      'src/main/agent-framework/opencode-session-header.integration.test.ts',
      'src/main/agent-framework/opencode-skill-reference.integration.test.ts',
      'src/main/agent-framework/resolved-agent-backend-leases.test.ts',
      'src/main/agents/agents-dispatch.test.ts',
      'src/main/agents/agents-mutations.test.ts',
      'src/main/agents/agents-repl.integration.test.ts',
      'src/main/agents/agents-repl.mutations.integration.test.ts',
      'src/main/agents/agents-repl.privileged.integration.test.ts',
      'src/main/agents/agents-repl.runtime-consumption.integration.test.ts',
      'src/main/agents/agents-service.test.ts',
      'src/main/agents/app-handoff-runtime.integration.test.ts',
      'src/main/agents/completion-gate.execute-control.integration.test.ts',
      'src/main/agents/completion-gate.integration.test.ts',
      'src/main/agents/customize/workflow.test.ts',
      'src/main/application-command-client.test.ts',
      'src/main/application-command-composition.test.ts',
      'src/main/application-command-electron-adapter.test.ts',
      'src/main/artifacts/artifact-provenance-graph.test.ts',
      'src/main/artifacts/artifact-save.integration.test.ts',
      'src/main/artifacts/ipc.test.ts',
      'src/main/artifacts/literature-manifest.test.ts',
      'src/main/artifacts/mcp-server.test.ts',
      'src/main/artifacts/provenance-dependency-read.test.ts',
      'src/main/artifacts/provenance-helper-evidence.test.ts',
      'src/main/artifacts/provenance-lifecycle-contract.test.ts',
      'src/main/artifacts/provenance-message-snapshot.test.ts',
      'src/main/artifacts/provenance-repository.test.ts',
      'src/main/artifacts/provenance-startup.integration.test.ts',
      'src/main/artifacts/provenance-write-contract.test.ts',
      'src/main/bookmarks/pdf-source-diagnostics.test.ts',
      'src/main/bookmarks/service.test.ts',
      'src/main/compute/application-commands.test.ts',
      'src/main/compute/compute-job-workflow-owner.test.ts',
      'src/main/compute/compute-password-auth.real-ssh.integration.test.ts',
      'src/main/compute/compute-password-auth.release.test.ts',
      'src/main/compute/concurrency-integration.test.ts',
      'src/main/compute/ipc.test.ts',
      'src/main/compute/job-deletion-runtime-drain.test.ts',
      'src/main/compute/job-deletion-runtime-isolation.test.ts',
      'src/main/compute/job-recovery-regressions.integration.test.ts',
      'src/main/compute/job-runtime.test.ts',
      'src/main/compute/session-catalog-hydration.integration.test.ts',
      'src/main/compute/skill-provisioning.test.ts',
      'src/main/connectors/application.test.ts',
      'src/main/connectors/custom-mcp/bootstrap.test.ts',
      'src/main/connectors/custom-skill-doc.test.ts',
      'src/main/connectors/descriptors/variants-gnomad.test.ts',
      'src/main/connectors/custom-mcp/client-manager.test.ts',
      'src/main/connectors/mcp-payload-pagination.integration.test.ts',
      'src/main/connectors/custom-mcp/oauth-client.test.ts',
      'src/main/connectors/provision.test.ts',
      'src/main/connectors/runtime-settings-projection.test.ts',
      'src/main/connectors/service.test.ts',
      'src/main/data-content-application-commands.test.ts',
      'src/main/database/literature-inbox-integrity-migration.test.ts',
      'src/main/database/managed-file-version-domain.test.ts',
      'src/main/database/migration-service.test.ts',
      'src/main/delegation/acp-execution.test.ts',
      'src/main/delegation/attempt-runtime-transcript.test.ts',
      'src/main/delegation/certification-contract.test.ts',
      'src/main/delegation/certification.test.ts',
      'src/main/delegation/claude-code-certification.test.ts',
      'src/main/delegation/codebuddy-execution.test.ts',
      'src/main/delegation/codex-execution.test.ts',
      'src/main/delegation/delegated-artifact-evidence.test.ts',
      'src/main/delegation/delegation-settlement-wake-owner.test.ts',
      'src/main/delegation/durable-delegated-work.test.ts',
      'src/main/delegation/execution-backend-lease.test.ts',
      'src/main/delegation/execution-contract.test.ts',
      'src/main/delegation/opencode-execution.test.ts',
      'src/main/delegation/opencode-runtime-preparation.integration.test.ts',
      'src/main/delegation/opencode-runtime-preparation.test.ts',
      'src/main/delegation/production-composition.test.ts',
      'src/main/delegation/production-framework-runtime.test.ts',
      'src/main/delegation/production-frameworks.test.ts',
      'src/main/delegation/session-record-adapter.test.ts',
      'src/main/delegation/settlement-continuation-dispatch.test.ts',
      'src/main/delegation/specialist-runtime-consumption.test.ts',
      'src/main/delegation/structured-output-owner.test.ts',
      'src/main/host-application-commands.test.ts',
      'src/main/host-sdk/delegate-contract.test.ts',
      'src/main/immutable-input-authority.test.ts',
      'src/main/index-fatal-errors.test.ts',
      'src/main/index-startup-failure.test.ts',
      'src/main/ipc-surfaces/adapter.test.ts',
      'src/main/ipc-surfaces/artifacts.test.ts',
      'src/main/ipc-surfaces/connector-approvals.test.ts',
      'src/main/ipc-surfaces/core.test.ts',
      'src/main/ipc-surfaces/desktop-utilities.test.ts',
      'src/main/ipc-surfaces/notifications.test.ts',
      'src/main/ipc-surfaces/office-preview.test.ts',
      'src/main/ipc-surfaces/session-persistence.test.ts',
      'src/main/ipc-surfaces/settings.test.ts',
      'src/main/ipc-surfaces/specialist.test.ts',
      'src/main/ipc-surfaces/uploads.test.ts',
      'src/main/literature/agent-pdf-acquisition.test.ts',
      'src/main/literature/attachment-authority.test.ts',
      'src/main/literature/batch-jobs.test.ts',
      'src/main/literature/catalog-capacity.test.ts',
      'src/main/literature/catalog.test.ts',
      'src/main/literature/document-reader.test.ts',
      'src/main/literature/export-roundtrip.test.ts',
      'src/main/literature/full-text-finder.test.ts',
      'src/main/literature/library-mcp-server.test.ts',
      'src/main/literature/library-tool-contracts.test.ts',
      'src/main/literature/mcp-server.test.ts',
      'src/main/literature/metadata-enricher.test.ts',
      'src/main/literature/migration-writers.test.ts',
      'src/main/literature/pdf-attachment-reliability.test.ts',
      'src/main/literature/pdf-elements-mcp.test.ts',
      'src/main/literature/pdf-importer.test.ts',
      'src/main/literature/pdf-structure/agent-reader.test.ts',
      'src/main/literature/pdf-structure/engine.test.ts',
      'src/main/literature/pdf-structure/owner.test.ts',
      'src/main/literature/pdf-structure/reader.test.ts',
      'src/main/literature/pdf-structure/source-metadata.test.ts',
      'src/main/literature/reference-resolver.test.ts',
      'src/main/literature/scale-regressions.test.ts',
      'src/main/literature/session-pdf-source-resolver.test.ts',
      'src/main/local-fs/granted-roots-repository.test.ts',
      'src/main/locale/owner.test.ts',
      'src/main/locale/resources.lazy.test.ts',
      'src/main/managed-file-versions/diff-task.test.ts',
      'src/main/managed-file-versions/ipc.test.ts',
      'src/main/managed-file-versions/service.integration.test.ts',
      'src/main/managed-preview-ipc.test.ts',
      'src/main/managed-preview-protocol.test.ts',
      'src/main/managed-preview-resources.test.ts',
      'src/main/net/network-info.test.ts',
      'src/main/network-ipc.test.ts',
      'src/main/notebook/configured-shell-runtime.test.ts',
      'src/main/notebook/delegated-lane-capability.test.ts',
      'src/main/notebook/e2e.certification.test.ts',
      'src/main/notebook/host-artifacts-service.test.ts',
      'src/main/notebook/host-mcp.integration.test.ts',
      'src/main/notebook/host-model-service.test.ts',
      'src/main/notebook/input-registry.test.ts',
      'src/main/notebook/local-rpc-server.agents.test.ts',
      'src/main/notebook/local-rpc-server.artifacts.test.ts',
      'src/main/notebook/local-rpc-server.capabilities.test.ts',
      'src/main/notebook/local-rpc-server.delegated-work.test.ts',
      'src/main/notebook/local-rpc-server.errors.test.ts',
      'src/main/notebook/local-rpc-server.frames.test.ts',
      'src/main/notebook/local-rpc-server.lineage.test.ts',
      'src/main/notebook/local-rpc-server.llm.test.ts',
      'src/main/notebook/local-rpc-server.models.test.ts',
      'src/main/notebook/local-rpc-server.sessions.test.ts',
      'src/main/notebook/local-rpc-server.skill-import.test.ts',
      'src/main/notebook/local-rpc-server.skills.test.ts',
      'src/main/notebook/local-rpc-server.test.ts',
      'src/main/notebook/local-rpc-server.user-input.test.ts',
      'src/main/notebook/local-rpc-server.wsl-setup.test.ts',
      'src/main/notebook/mcp-management-lifecycle.integration.test.ts',
      'src/main/notebook/mcp-server.test.ts',
      'src/main/notebook/no-legacy-bridge.test.ts',
      'src/main/notebook/repl-loop.integration.test.ts',
      'src/main/notifications/notification-inbox-runtime.test.ts',
      'src/main/office-preview/office-preview-ipc-lifecycle.test.ts',
      'src/main/office-preview/office-preview-ipc.test.ts',
      'src/main/office-preview/office-preview-navigation.test.ts',
      'src/main/office-preview/office-preview-oopif-supervisor.test.ts',
      'src/main/permission-grants/application-commands.test.ts',
      'src/main/permission-grants/ipc.test.ts',
      'src/main/permission-grants/projection-controller.test.ts',
      'src/main/permission-grants/registry.test.ts',
      'src/main/project-files/content-search.test.ts',
      'src/main/project-files/host-artifact-catalog.test.ts',
      'src/main/project-files/ipc.test.ts',
      'src/main/project-files/repository.test.ts',
      'src/main/projects/data-lifecycle-regressions.integration.test.ts',
      'src/main/projects/deletion-coordinator.test.ts',
      'src/main/projects/ipc.test.ts',
      'src/main/remote-access/ipc.test.ts',
      'src/main/remote-access/pairing.test.ts',
      'src/main/remote-access/service.test.ts',
      'src/main/reviewer/correction-context.test.ts',
      'src/main/reviewer/correction-owner.test.ts',
      'src/main/reviewer/correction.test.ts',
      'src/main/reviewer/fix-loop.test.ts',
      'src/main/reviewer/host-sdk.test.ts',
      'src/main/reviewer/image-generation-trace.integration.test.ts',
      'src/main/reviewer/ipc.test.ts',
      'src/main/reviewer/lifecycle.test.ts',
      'src/main/reviewer/log-capture.test.ts',
      'src/main/reviewer/model-runtime-owner.test.ts',
      'src/main/reviewer/orchestrator-drive.test.ts',
      'src/main/reviewer/orchestrator-prompt-prefix.test.ts',
      'src/main/reviewer/orchestrator-prompt.test.ts',
      'src/main/reviewer/orchestrator.start-contract.test.ts',
      'src/main/reviewer/orchestrator.test.ts',
      'src/main/reviewer/paged-preview-electron.test.ts',
      'src/main/reviewer/review-assessment-owner.test.ts',
      'src/main/reviewer/reviewer-fix-loop-owner.test.ts',
      'src/main/reviewer/reviewer-orchestrator.architecture.test.ts',
      'src/main/runtime-electron-wiring.test.ts',
      'src/main/runtime-state-ownership.architecture.test.ts',
      'src/main/session-package/archive.test.ts',
      'src/main/session-package/deletion.test.ts',
      'src/main/session-package/desktop-composition.test.ts',
      'src/main/session-package/desktop.test.ts',
      'src/main/session-package/export-validation.test.ts',
      'src/main/session-package/inspection-worker.integration.test.ts',
      'src/main/session-package/literature.test.ts',
      'src/main/session-package/native-snapshot.test.ts',
      'src/main/session-package/portability.test.ts',
      'src/main/session-package/recovery-diagnostics.test.ts',
      'src/main/session-package/recovery.test.ts',
      'src/main/session-package/service.test.ts',
      'src/main/session-persistence/artifact-finalization-recovery.integration.test.ts',
      'src/main/session-persistence/claude-replay.test.ts',
      'src/main/session-persistence/coordinator-contract.test.ts',
      'src/main/session-persistence/coordinator.test.ts',
      'src/main/session-persistence/delegated-work-records.test.ts',
      'src/main/session-persistence/deletion-integration.test.ts',
      'src/main/session-persistence/ipc.test.ts',
      'src/main/session-persistence/pdf-context-owner.test.ts',
      'src/main/session-persistence/runtime-lookup.test.ts',
      'src/main/session-plan/plan-service.test.ts',
      'src/main/session-plan/production-plan-service.test.ts',
      'src/main/settings/agent-config-files.test.ts',
      'src/main/settings/agent-runtime-manager.test.ts',
      'src/main/settings/application-commands.test.ts',
      'src/main/settings/authenticated-provider-redirects.test.ts',
      'src/main/settings/bootstrap.integration.test.ts',
      'src/main/settings/capabilities.test.ts',
      'src/main/settings/chat-provider-compatibility.test.ts',
      'src/main/settings/claude-provider-configuration.integration.test.ts',
      'src/main/settings/codex-auth.test.ts',
      'src/main/settings/codex-skill-loading.integration.test.ts',
      'src/main/settings/compute-grants.test.ts',
      'src/main/settings/connector-credential-recovery.integration.test.ts',
      'src/main/settings/connector-settings.test.ts',
      'src/main/settings/connector-template.test.ts',
      'src/main/settings/connectors-settings.test.ts',
      'src/main/settings/custom-mcp-settings.test.ts',
      'src/main/settings/data-root-setting.test.ts',
      'src/main/settings/device-credential-recovery.test.ts',
      'src/main/settings/device-credentials.test.ts',
      'src/main/settings/document-codec.test.ts',
      'src/main/settings/document-store.test.ts',
      'src/main/settings/file-credential-storage.test.ts',
      'src/main/settings/integration-application-commands.test.ts',
      'src/main/settings/ipc.test.ts',
      'src/main/settings/list-models.test.ts',
      'src/main/settings/mirror-settings.test.ts',
      'src/main/settings/network-proxy-settings.test.ts',
      'src/main/settings/notebook-network-settings-owner.test.ts',
      'src/main/settings/notebook-network-settings.test.ts',
      'src/main/settings/notebook-runtime-settings.test.ts',
      'src/main/settings/opencode-go-validation.integration.test.ts',
      'src/main/settings/preferences.test.ts',
      'src/main/settings/preflight.test.ts',
      'src/main/settings/provider-accounts.test.ts',
      'src/main/settings/provider-auth-lifecycle.test.ts',
      'src/main/settings/provider-completion-races.test.ts',
      'src/main/settings/provider-privacy.test.ts',
      'src/main/settings/provider-protocol-regressions.test.ts',
      'src/main/settings/provider-runtime-projection.test.ts',
      'src/main/settings/record-codec.test.ts',
      'src/main/settings/repository.test.ts',
      'src/main/settings/responses-bridge.skill-loading.test.ts',
      'src/main/settings/runtime-application-commands.test.ts',
      'src/main/settings/service.connectors.test.ts',
      'src/main/settings/service.providers.test.ts',
      'src/main/settings/service.test.ts',
      'src/main/settings/session-details-model-owner.test.ts',
      'src/main/settings/skill-catalog.python-availability.test.ts',
      'src/main/settings/skill-catalog.registered-helpers.test.ts',
      'src/main/settings/skill-catalog.test.ts',
      'src/main/settings/validate.test.ts',
      'src/main/settings/workflows.test.ts',
      'src/main/settings/workflows/connectors-diagnostic.test.ts',
      'src/main/settings/xai-provider-account-owner.test.ts',
      'src/main/side-chat/ipc.test.ts',
      'src/main/side-chat/runtime-owner.test.ts',
      'src/main/skills/conversation-import.test.ts',
      'src/main/specialist/application-commands.test.ts',
      'src/main/specialist/ipc.test.ts',
      'src/main/specialist/package/service.test.ts',
      'src/main/specialist/service.test.ts',
      'src/main/specialist/specialist-identity-injection.test.ts',
      'src/main/storage/command-owner.atomicity.test.ts',
      'src/main/storage/content-repository.test.ts',
      'src/main/storage/ipc.test.ts',
      'src/main/storage/literature-migration.integration.test.ts',
      'src/main/storage/managed-workspace-ownership.integration.test.ts',
      'src/main/storage/migration-service.test.ts',
      'src/main/storage/provenance-migration-validation.test.ts',
      'src/main/tasks/task-runner.test.ts',
      'src/main/uploads/caller-cancellation.test.ts',
      'src/main/uploads/command-owner.test.ts',
      'src/main/uploads/ipc.test.ts',
      'src/main/uploads/publication-lifecycle.integration.test.ts',
      'src/main/uploads/repository.characterization.test.ts',
      'src/main/uploads/repository.test.ts',
      'src/main/web-service/artifact-download.integration.test.ts',
      'src/main/web-service/controller.test.ts',
      'src/main/web-service/http-server.test.ts',
      'src/main/web-service/task-api.test.ts',
      'src/main/window-find-ipc.test.ts',
      'src/renderer/src/hooks/useLifecycleSync.test.tsx',
      'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.test.ts',
      'src/renderer/src/pages/literature/LiteratureFullTextLookup.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureLibraryPage.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureMetadataEditor.test.tsx',
      'src/renderer/src/pages/onboarding/OnboardingWizard.regressions.test.tsx',
      'src/renderer/src/pages/settings/ConnectorAddForm.render.test.tsx',
      'src/renderer/src/pages/settings/SpecialistEditor.persistence.render.test.tsx',
      'src/renderer/src/pages/workspace/artifact-publication-preview.integration.test.tsx',
      'src/renderer/src/pages/workspace/previews/preview-pagination-contract.test.tsx',
      'src/renderer/src/stores/locale-preference-recovery.render.test.tsx',
      'src/renderer/src/stores/runtime-settings-store.test.ts',
      'src/renderer/src/stores/settings-connectors-slice.test.ts',
      'src/shared/renderer-surface-inventory.test.ts',
      'src/shared/renderer-surface-matrix.test.ts',
      'src/main/session-package/fork.test.ts',
      'src/main/storage/brand-location.test.ts',
      'src/main/credential-identity/persistence.test.ts',
      'src/main/credential-identity/ciphertext-inventory.test.ts',
      'src/main/credential-identity/linux.test.ts',
      'src/main/storage/migration-target-race.test.ts',
      'src/renderer/src/components/LegacyDataMoveDialog.storage.test.tsx',
      'src/main/credential-identity/macos.test.ts',
      'src/main/credential-identity/probe-logging.test.ts',
      'src/renderer/src/lib/session-persistence/session-persistence.test.ts',
      'src/renderer/src/pages/workspace/workspace-message-queue-controller.test.ts',
      'src/main/specialist/marketplace/official-source.test.ts',
      'src/main/specialist/marketplace/service.test.ts',
      'src/main/specialist/package/release-certification.test.ts',
      'src/main/specialist/package/reported-regressions.test.ts',
      'src/main/specialist/package/transaction.test.ts',
      'src/main/delegation/process-ownership.test.ts',
      'src/main/process-tree.windows.integration.test.ts',
      'src/main/delegation/frame-workspace.test.ts',
      'src/main/acp/agent-process.test.ts',
      'src/main/settings/classification-settings.test.ts',
      'src/main/artifacts/resumed-finalization-ownership.test.ts',
      'src/main/session-persistence/resumed-artifact-publication.integration.test.ts',
      'src/main/agent-framework/opencode-mcp-isolation.integration.test.ts',
      'src/main/agent-framework/session-mcp-isolation.integration.test.ts',
      'src/main/compute/cancellation-runtime.integration.test.ts',
      'src/main/pdf-annotations/repository.integration.test.ts',
      'src/main/pdf-annotations/service.test.ts',
      'src/main/session-package/ro-crate.integration.test.ts',
      'src/main/session-package/ro-crate.test.ts'
    ])
    expect(
      [
        'settings_repository',
        'settings_provider_accounts',
        'settings_backend_resolution',
        'settings_service_facade'
      ].map((moduleName) => manifest.modules[moduleName].fallbackCapability)
    ).toEqual(['main_runtime', 'main_runtime', 'main_runtime', 'main_runtime'])
  })
})
