import {
  runtimeModuleSpecifiers,
  expectBoundaryPaths
} from '../../../test/module-boundary-assertions'
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
  backendTarget: resolve(settingsRoot, 'backend-target.ts'),
  backendRoutePlanner: resolve(settingsRoot, 'backend-route-planner.ts'),
  providerTransportOwner: resolve(settingsRoot, 'provider-transport-owner.ts'),
  responsesToChatCompletionsBridge: resolve(
    settingsRoot,
    'responses-to-chat-completions-bridge.ts'
  ),
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
      runtimeModuleSpecifiers(readSource(sourcePath)).some(
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
    expect(exportInventoryFrom(settingsPaths.responsesToChatCompletionsBridge)).toEqual([
      'type:ResponsesConnection',
      'type:ResponsesModelTarget',
      'type:ResponsesSkillCandidate',
      'type:ResponsesSkillInput',
      'type:ResponsesToChatCompletionsBridgeOptions',
      'type:ResponsesToChatCompletionsBridgeTarget',
      'value:ResponsesToChatCompletionsBridge',
      'value:chatUrl'
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
      'persistLegacyDataRoot',
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
      'setSemanticScholarCredential',
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
      'resolveExplicitDirectProvider',
      'resolveExplicitTarget',
      'resolveSelection'
    ])
    expect(
      publicOperationsOf(settingsPaths.providerTransportOwner, 'ProviderTransportOwner')
    ).toEqual(['acquire'])
    expect(
      publicOperationsOf(
        settingsPaths.responsesToChatCompletionsBridge,
        'ResponsesToChatCompletionsBridge'
      )
    ).toEqual([
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
        cancelNotebookNetworkSetup importSkillZipBatch installClaude installCodeBuddy installCodex installMissingWslDependencies installNotebookNetwork installOpencode installRecommendedWslDistro installSkillMarketplace installWslPlatform isEncryptionAvailable
        isNpmAvailable listAgentHomeSkills listConnectors listDeviceCredentials listHostSkills listSkillMarketplace listSkills listSpecialistSkillCatalog listUserSkills
        dispose loginClaudeShared loginIsolatedClaude loginIsolatedClaudeBrowser loginIsolatedCodex
        logoutClaudeShared logoutIsolatedClaude logoutIsolatedCodex logoutXaiOAuth markOnboardingComplete
        markPathsNormalized migrateAgentHomeSkillIdentities openWslTerminal prepareDelegatedSkills previewAgentHomeSkill previewCustomServerTemplateExport
        previewCustomServerTemplateImport previewGitHubSkill previewSkillArchive previewSkillZip
        createWslSupportHandoff probeWslSetup provisionedConnectorSkillNames publishHostSkill refreshProviderModels registeredHelperCatalog rememberCodexAutoHttpsFallback removeCustomServer removeDeviceCredential removeGitHubToken removeNotebookNetwork
        removeManualInterpreter resolveActiveModelChangeTarget resolveActiveReasoningEffort restoreLocalShellRuntimePreference reviewNotebookPrivateDestination
        resolveAdmittedSubagentBackend resolveAgentBackend resolveDeviceOAuthCredential resolveExplicitAgentBackend resolveExplicitDirectProvider resolveSkillDocument resolveSubagentExecutionModel saveCustomServerOAuthState saveGitHubToken saveValidatedProvider
        scanRepoSkills selectWslProfile setActiveProvider setAgentEnvironmentCreationEnabled setAgentFramework setAgentRouting setAppIconVariant setClosePreference switchLocalShellToPowerShell
        setComputeBookmarks setConnectorAutoAllow setConnectorEnabled
        setConversationSkillImportEnabled setCustomServerAuthenticator setCustomServerEnabled
        setDataRoot setDefaultPermissionProfile setDeviceCredentialAuthenticator setEnvironmentEnabled setInstallAuthorized
        setCustomServerRuntimeProjectionProvider setNcbiCredentials setNetworkProxy setNotebookNetwork setNotificationsEnabled
        setOpenAlexCredential setPackageMirror setProjectFilesFilter setReasoningEffort setReviewerModel setSemanticScholarCredential setSessionDetailsModel setShowNotificationContent setSkillDeletionGuard setSkillEnabled setSkillsEnabled setSubagentModel setVisionModel
        setToolPermission skillNudgeNamesForIds skillsNeedingForceLoad startSkillMarketplaceBatch stopSkillMarketplaceBatch uninstallClaude uninstallCodeBuddy uninstallCodex
        uninstallOpencode updateCustomServer updateDeviceCredential updateSkill upsertProvider useWsl2Bash validateOpenAlexCredential validateProvider waitXaiOAuthLogin withHostSkillRead
      `
        .trim()
        .split(/\s+/)
        .sort()
    )
  })

  it('locks the production runtime importer graph at the public seams', () => {
    expect(importersOf(settingsPaths.repository)).toEqual([
      'src/main/composition/compute.ts',
      'src/main/composition/connectors.ts',
      'src/main/composition/session-packages.ts',
      'src/main/composition/settings-bootstrap.ts',
      'src/main/composition/settings-effects.ts',
      'src/main/composition/specialists.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/connector-settings.ts',
      'src/main/settings/service.ts',
      'src/main/specialist/package/environment.ts',
      'src/main/storage/initialize-location.ts'
    ])
    expect(importersOf(settingsPaths.recordCodec)).toEqual([
      'src/main/settings/document-codec.ts',
      'src/main/settings/document-store.ts',
      'src/main/settings/repository.ts'
    ])
    expect(importersOf(settingsPaths.documentCodec)).toEqual([
      'src/main/settings/document-store.ts',
      'src/main/settings/repository.ts'
    ])
    expect(importersOf(settingsPaths.documentStore)).toEqual([
      'src/main/settings/repository.ts',
      'src/main/storage/initialize-location.ts'
    ])
    expect(importersOf(settingsPaths.computeGrantPort)).toEqual(['src/main/compute/ipc.ts'])
    expect(importersOf(settingsPaths.providerAccounts)).toEqual([
      'src/main/settings/backend-resolver.ts',
      'src/main/settings/service.ts'
    ])
    expect(importersOf(settingsPaths.backendResolver)).toEqual(['src/main/settings/service.ts'])
    expect(importersOf(settingsPaths.backendRoutePlanner)).toEqual([
      'src/main/settings/backend-resolver.ts'
    ])
    expect(importersOf(settingsPaths.providerTransportOwner)).toEqual([
      'src/main/settings/backend-resolver.ts'
    ])
    expect(importersOf(settingsPaths.responsesToChatCompletionsBridge)).toEqual([
      'src/main/settings/provider-transport-owner.ts',
      'src/main/settings/validate.ts'
    ])
    expect(importersOf(settingsPaths.service)).toEqual([
      'src/main/composition/agent-completion.ts',
      'src/main/composition/agent-controls.ts',
      'src/main/composition/agent-runtime.ts',
      'src/main/composition/connectors.ts',
      'src/main/composition/delegation.ts',
      'src/main/composition/handoff.ts',
      'src/main/composition/managed-files.ts',
      'src/main/composition/notebook-bridge.ts',
      'src/main/composition/notebook-runtime.ts',
      'src/main/composition/research-catalog.ts',
      'src/main/composition/session-foundation.ts',
      'src/main/composition/session-packages.ts',
      'src/main/composition/session-projection.ts',
      'src/main/composition/session-surfaces.ts',
      'src/main/composition/settings-bootstrap.ts',
      'src/main/composition/settings-effects.ts',
      'src/main/composition/side-chat.ts',
      'src/main/composition/specialists.ts',
      'src/main/composition/storage-startup.ts',
      'src/main/settings/ipc.ts'
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
      'listAuthorizedDirectories',
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
    expect(typePropertyNames(settingsPaths.backendTarget, 'ExplicitAgentBackendTarget')).toEqual([
      'frameworkId',
      'model',
      'providerId',
      'reasoningEffort',
      'resolvedReasoningEffort'
    ])
  })

  it('locks one production Settings document owner and the narrow Compute legacy port', () => {
    expect(constructorSitesFor(settingsPaths.repository, 'SettingsRepository')).toEqual([
      'src/main/composition/settings-bootstrap.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/service.ts',
      'src/main/specialist/package/environment.ts',
      'src/main/storage/initialize-location.ts'
    ])
    const computeIpc = readSource(resolve(projectRoot, 'src/main/compute/ipc.ts'))
    expect(computeIpc).not.toContain("from '../settings/repository'")
    expect(computeIpc).toContain('legacyComputeGrants?: LegacyComputeGrantPort')
    expect(computeIpc).toContain('legacyComputeGrants && !permissionGrantRegistry')
    expect(computeIpc).toContain('legacyComputeGrants.hasComputeGrant(grant)')
    expect(computeIpc).toContain('legacyComputeGrants.addComputeGrant(grant)')
    const settingsBootstrap = readSource(
      resolve(projectRoot, 'src/main/composition/settings-bootstrap.ts')
    )
    const specialists = readSource(resolve(projectRoot, 'src/main/composition/specialists.ts'))
    const handoff = readSource(resolve(projectRoot, 'src/main/composition/handoff.ts'))
    const compute = readSource(resolve(projectRoot, 'src/main/composition/compute.ts'))
    const nodeEntry = readSource(resolve(projectRoot, 'src/main/node-entry.ts'))
    expect(nodeEntry).toContain(
      'const { settingsStore, repository } = await prepareApplicationLocations(configRoot)'
    )
    expect(nodeEntry).toContain('const startupSettings = await repository.getSettings()')
    expect(nodeEntry).toMatch(/createCoreRuntime\(\{[\s\S]*?\bsettingsStore,/u)
    const desktopEntry = readSource(resolve(projectRoot, 'src/main/index.ts'))
    expect(desktopEntry).not.toMatch(
      /\b(?:new SettingsRepository|prepareApplicationLocations|createCoreRuntime)\s*\(/u
    )
    expect(settingsBootstrap).toContain('settingsStore ?? resolveConfigRoot()')
    // Package transactions use the shared production repository; their fallback supports standalone use.
    expect(specialists).toContain('skillSettings: settingsRepository')
    expect(specialists).toContain('await settingsService.migrateAgentHomeSkillIdentities()')
    expect(specialists.indexOf('specialistPackageRecovery.current =')).toBeLessThan(
      specialists.indexOf('await settingsService.migrateAgentHomeSkillIdentities()')
    )
    const settingsModule = settingsBootstrap.slice(
      settingsBootstrap.indexOf('const settingsService = await modules.add('),
      settingsBootstrap.indexOf('settingsServiceRef.current = settingsService')
    )
    expect(settingsModule).toContain(
      'const capability = new SettingsService({\n      repository: settingsRepository,\n      onProviderHealthChanged: async () => {\n        await settingsSnapshotCommits.projectAfter(Promise.resolve())\n      },\n      installCoordinator: settingsInstallCoordinator,\n      skillRuntimeMcpEntryPath: mainEntryPath,\n      openAlexFetch: netFetchStandard,\n      applyNetworkProxy:'
    )
    expect(settingsModule).toContain("name: 'settings-service'")
    expect(settingsModule).toContain('rollback: () => capability.dispose()')
    expect(settingsModule).toContain('dispose: () => capability.dispose()')
    expect(settingsModule).toContain('disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS')
    const updateBlockerDetector = handoff.slice(
      handoff.indexOf('const detectResearchBlockers'),
      handoff.indexOf('const durableDataRootHandoffGate')
    )
    expect(updateBlockerDetector).toContain(
      "if (settingsService.hasActiveInstall()) blockers.push('settings-install')"
    )
    const updateInstallHandoff = handoff.slice(
      handoff.indexOf('let releaseSettingsInstallAdmission'),
      handoff.indexOf('const updateCommandOwner')
    )
    expect(updateInstallHandoff).toContain(
      'releaseSettingsInstallAdmission ??= settingsService.holdInstallAdmission()'
    )
    expect(updateInstallHandoff).toContain('releaseAdmission?.()')
    const dataRootInstallHandoff = handoff.slice(
      handoff.indexOf('let releaseDataRootInstallAdmission'),
      handoff.indexOf("declareElectronAdapter('storage'")
    )
    expect(dataRootInstallHandoff).toContain(
      'releaseDataRootInstallAdmission ??= settingsService.holdInstallAdmission()'
    )
    expect(dataRootInstallHandoff).toContain('abortDataRootInstallAdmission()')
    expect(compute).toContain('permissionGrantRegistry,\n    settingsRepository')
  })

  it('locks dependency-aware impact owners and cross-surface evidence', () => {
    const manifest = loadModuleImpactManifest(manifestPath)
    // Keep exact leaves and routing without copying future application contracts into lower layers.
    const splits = [
      [
        'settings_token_policy',
        'settings_repository',
        ['provider-token-limits.ts', 'provider-token-limits.test.ts']
      ],
      ['settings_response_bounds', 'settings_provider_accounts', ['bounded-response.ts']],
      ['settings_provider_limits', 'settings_provider_accounts', ['provider-resource-limits.ts']],
      [
        'settings_proxy_runtime',
        'settings_backend_resolution',
        [
          'network-proxy-runtime.ts',
          'system-proxy.ts',
          'network-proxy-runtime.test.ts',
          'system-proxy.test.ts'
        ]
      ]
    ] as const
    const movedPaths = new Set<string>()
    for (const [id, parentId, names] of splits) {
      const child = manifest.modules[id]
      if (!child) continue
      const parent = manifest.modules[parentId]
      const paths = names.map((name) => `src/main/settings/${name}`)
      expect([...child.ownerPaths].sort()).toEqual([...paths].sort())
      expect([...child.interfacePaths].sort()).toEqual(
        paths.filter((path) => !path.endsWith('.test.ts')).sort()
      )
      expect([...child.testFiles.owner].sort()).toEqual(
        paths.filter((path) => path.endsWith('.test.ts')).sort()
      )
      const sharedContracts = [
        'src/preload/index.test.ts',
        'src/renderer/web/api-installer.test.ts',
        'src/shared/renderer-contract-catalog.test.ts',
        ...(id === 'settings_token_policy' ? ['src/shared/settings.test.ts'] : []),
        ...(['settings_response_bounds', 'settings_provider_limits'].includes(id)
          ? [
              'src/main/settings/service.providers.test.ts',
              'src/main/settings/runtime-application-commands.test.ts',
              'src/shared/provider-reasoning-effort.test.ts'
            ]
          : []),
        ...(id === 'settings_proxy_runtime'
          ? [
              'src/main/agent-framework/claude-code.test.ts',
              'src/main/agent-framework/codex.test.ts',
              'src/main/agent-framework/opencode.test.ts',
              'src/main/agent-framework/registry.test.ts'
            ]
          : [])
      ]
      expect(child.testFiles.contract).toEqual(expect.arrayContaining(sharedContracts))
      expect(parent.testFiles.contract).toEqual(expect.arrayContaining(sharedContracts))
      expect(child.consumerModules).toEqual(parent.consumerModules)
      expect(child.capabilityOverlays).toEqual(parent.capabilityOverlays)
      expect(child.fallbackCapability).toEqual(parent.fallbackCapability)
      paths.forEach((path) => movedPaths.add(path))
    }
    expectBoundaryPaths(
      manifest,
      'settings_repository',
      [
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
      ].filter((path) => !movedPaths.has(path))
    )
    expect(manifest.modules.settings_repository.interfacePaths).toEqual(
      expect.arrayContaining(
        [
          'src/main/settings/repository.ts',
          'src/shared/network-proxy.ts',
          'src/main/settings/compute-grant-port.ts',
          'src/main/settings/provider-token-limits.ts',
          'src/main/settings/document-store.ts'
        ].filter((path) => !movedPaths.has(path))
      )
    )
    expectBoundaryPaths(manifest, 'providers_package', [
      'packages/providers/src/providers/lookup.ts',
      'packages/providers/src/errors.ts',
      'packages/providers/src/protocols/endpoints.ts',
      'packages/providers/src/transport/request.ts',
      'packages/providers/src/transport/body.ts',
      'packages/providers/src/protocols/usage.ts',
      'packages/providers/src/protocols/reasoning.ts',
      'packages/providers/src/responses/request.ts',
      'packages/providers/src/responses/response.ts',
      'packages/providers/src/responses/types.ts',
      'packages/providers/src/models/text-generation.ts'
    ])
    // Static provider policy may stay with the full-validation contracts or move to its own
    // module, which routes it by imports. Either way each file keeps exactly one owner and the
    // platform routing of the contracts it came from. The URL policy stays with the settings
    // contracts that import it, which keeps the module graph acyclic.
    for (const path of [
      'src/shared/reasoning-effort.ts',
      'src/shared/model-preference-contract.ts',
      'src/shared/provider-url-policy.ts',
      'src/shared/provider-model-policy.ts',
      'src/shared/provider-bridge-policy.ts',
      'src/shared/provider-error.ts'
    ]) {
      const owners = Object.entries(manifest.modules).filter(([, module]) =>
        module.ownerPaths.includes(path)
      )
      expect(owners, `unique owner of ${path}`).toHaveLength(1)
      const [ownerId, owner] = owners[0]
      if (ownerId === 'shared_application_contracts') {
        expectBoundaryPaths(manifest, ownerId, [path])
        continue
      }
      expect(ownerId, path).toBe('shared_provider_policy')
      expect(owner.fullTestReason, path).toBeUndefined()
      expect(owner.fallbackCapability, path).toBe(
        manifest.modules.shared_application_contracts.fallbackCapability
      )
    }
    expectBoundaryPaths(
      manifest,
      'settings_provider_accounts',
      [
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
        'src/main/settings/list-models.test.ts',
        'src/main/settings/provider-accounts.test.ts',
        'src/main/settings/provider-auth-lifecycle.architecture.test.ts',
        'src/main/settings/provider-auth-lifecycle.test.ts',
        'src/main/settings/provider-runtime-projection.architecture.test.ts',
        'src/main/settings/provider-runtime-projection.test.ts',
        'src/main/settings/validate.test.ts',
        'src/main/settings/validate.ts',
        'src/main/settings/xai-oauth.test.ts',
        'src/main/settings/xai-provider-account-owner.test.ts'
      ].filter((path) => !movedPaths.has(path))
    )
    expectBoundaryPaths(manifest, 'provider_credentials', [
      'src/main/settings/codex-auth.ts',
      'src/main/settings/codex-auth.test.ts',
      'src/main/settings/crypto.ts',
      'src/main/settings/crypto.test.ts',
      'src/main/settings/provider-env.ts',
      'src/main/settings/provider-env.test.ts'
    ])
    expect(manifest.modules.settings_provider_accounts.interfacePaths).toEqual(
      expect.arrayContaining(
        [
          'src/main/settings/provider-accounts.ts',
          'src/main/settings/claude-isolated-auth.ts',
          'src/main/settings/claude-shared-auth.ts',
          'src/main/settings/provider-draft-projection.ts',
          'src/main/settings/provider-resource-limits.ts',
          'src/main/settings/provider-runtime-projection.ts',
          'src/main/settings/validate.ts'
        ].filter((path) => !movedPaths.has(path))
      )
    )
    expectBoundaryPaths(
      manifest,
      'settings_backend_resolution',
      [
        'src/main/settings/backend-resolver.ts',
        'src/main/settings/backend-selection-owner.ts',
        'src/main/settings/backend-route-planner.ts',
        'src/main/settings/codex-bridge-tools.ts',
        'src/main/settings/codex-bridge-tools.test.ts',
        'src/main/settings/network-proxy-runtime.ts',
        'src/main/settings/environment-check.ts',
        'src/main/settings/system-proxy.ts',
        'src/main/settings/native-responses-compatibility.ts',
        'src/main/settings/messages-bridge.ts',
        'src/main/settings/protocol-forwarding-bridge.ts',
        'src/main/settings/xai-oauth-provider-bridge.ts',
        'src/main/settings/provider-error-replay.ts',
        'src/main/settings/provider-loopback-http-host.ts',
        'src/main/settings/provider-transport-owner.ts',
        'src/main/settings/provider-failure-observation.ts',
        'src/main/settings/provider-runtime-health-owner.ts',
        'src/main/settings/responses-to-chat-completions-bridge.ts',
        'src/main/settings/responses-to-chat-completions-bridge.plan-tools.test.ts',
        'src/main/settings/messages-bridge.test.ts',
        'src/main/settings/backend-resolver.test.ts',
        'src/main/settings/backend-route-planner.architecture.test.ts',
        'src/main/settings/backend-route-planner.test.ts',
        'src/main/settings/backend-selection-owner.architecture.test.ts',
        'src/main/settings/backend-selection-owner.test.ts',
        'src/main/settings/environment-check-proxy.test.ts',
        'src/main/settings/environment-check.test.ts',
        'src/main/settings/native-responses-compatibility.test.ts',
        'src/main/settings/network-proxy-runtime.test.ts',
        'src/main/settings/protocol-forwarding-bridge.test.ts',
        'src/main/settings/provider-error-replay.test.ts',
        'src/main/settings/provider-loopback-http-host.architecture.test.ts',
        'src/main/settings/provider-loopback-http-host.test.ts',
        'src/main/settings/provider-transport-owner.architecture.test.ts',
        'src/main/settings/provider-transport-owner.test.ts',
        'src/main/settings/provider-runtime-health-owner.test.ts',
        'src/main/settings/responses-to-chat-completions-bridge.integration.test.ts',
        'src/main/settings/responses-to-chat-completions-bridge.test.ts',
        'src/main/settings/responses-reasoning-replay.test.ts',
        'src/main/settings/responses-request-adapter.architecture.test.ts',
        'src/main/settings/responses-response-adapter.architecture.test.ts',
        'src/main/settings/system-proxy.test.ts',
        'src/main/settings/xai-oauth-provider-bridge.test.ts',
        'src/main/settings/backend-target.ts'
      ].filter((path) => !movedPaths.has(path))
    )
    expect(manifest.modules.settings_backend_resolution.interfacePaths).toEqual(
      expect.arrayContaining(
        [
          'src/main/settings/backend-resolver.ts',
          'src/main/settings/responses-to-chat-completions-bridge.ts',
          'src/main/settings/messages-bridge.ts',
          'src/main/settings/backend-route-planner.ts',
          'src/main/settings/environment-check.ts',
          'src/main/settings/native-responses-compatibility.ts',
          'src/main/settings/network-proxy-runtime.ts',
          'src/main/settings/protocol-forwarding-bridge.ts',
          'src/main/settings/provider-loopback-http-host.ts',
          'src/main/settings/provider-transport-owner.ts',
          'src/main/settings/provider-failure-observation.ts',
          'src/main/settings/provider-runtime-health-owner.ts',
          'src/main/settings/system-proxy.ts',
          'src/main/settings/xai-oauth-provider-bridge.ts',
          'src/main/settings/backend-target.ts'
        ].filter((path) => !movedPaths.has(path))
      )
    )
    expectBoundaryPaths(manifest, 'settings_service_facade', [
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
      'src/main/settings/classification-settings.test.ts',
      'src/main/settings/classification-usage.ts',
      'src/main/settings/classification-usage.test.ts',
      'src/main/settings/file-commands.ts',
      'src/main/settings/file-commands.test.ts'
    ])
    expect(manifest.modules.settings_service_facade.interfacePaths).toEqual(
      expect.arrayContaining([
        'src/main/settings/service.ts',
        'src/main/settings/application-commands.ts',
        'src/main/settings/runtime-application-commands.ts',
        'src/main/settings/integration-application-commands.ts',
        'src/main/settings/ipc.ts',
        'src/main/settings/reviewer-model-owner.ts',
        'src/main/settings/settings-snapshot-commit-owner.ts',
        'src/main/settings/subagent-model-owner.ts',
        'src/main/settings/vision-model-owner.ts',
        'src/main/settings/file-commands.ts'
      ])
    )
    expect(manifest.modules.settings_repository.consumerModules).toEqual(
      expect.arrayContaining([
        'settings_provider_accounts',
        'settings_service_facade',
        'compute_service'
      ])
    )
    expect(manifest.modules.settings_provider_accounts.consumerModules).toEqual(
      expect.arrayContaining(['settings_backend_resolution', 'settings_service_facade'])
    )
    expect(manifest.modules.settings_backend_resolution.consumerModules).toEqual(
      expect.arrayContaining([
        'settings_service_facade',
        'reviewer_orchestrator',
        'artifact_provenance'
      ])
    )
    expect(manifest.modules.settings_service_facade.consumerModules).toEqual(
      expect.arrayContaining(['workspace_runtime'])
    )
    expect(manifest.modules.settings_service_facade.testFiles.contract).toEqual(
      expect.arrayContaining([
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
    )
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
