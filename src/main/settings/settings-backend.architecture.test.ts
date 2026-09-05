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

type ModuleImpactManifest = {
  modules: Record<
    string,
    {
      ownerPaths: string[]
      interfacePaths: string[]
      consumerModules: string[]
      testFiles: { owner: string[]; contract: string[]; consumer: string[] }
      capabilityOverlays: string[]
      fallbackCapability: string
    }
  >
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
      'rememberCodexAutoHttpsFallback',
      'removeCustomServer',
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
      'updateClaudeIsolatedCredentialsIfExists',
      'updateClaudeIsolatedValidationIfKeyMatches',
      'updateClaudeSharedValidationIfUnchanged',
      'updateCodexIsolatedValidationIfIdentityMatches',
      'updateCustomServer',
      'updateCustomServerOAuthState',
      'updateProviderModelCatalogIfTargetMatches',
      'upsertClaudeIsolatedProvider',
      'upsertProvider'
    ])
    expect(publicOperationsOf(settingsPaths.providerAccounts, 'ProviderAccountsModule')).toEqual([
      'beginXaiOAuthLogin',
      'cancelClaudeIsolatedLogin',
      'cancelClaudeLogin',
      'cancelCodexLogin',
      'cancelXaiOAuthLogin',
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
      'refreshProviderModels',
      'resolveActiveModel',
      'resolveProvider',
      'resolveProviderApiEndpoints',
      'resolveRuntimeModelCatalog',
      'resolveRuntimeReasoningEffortProfile',
      'resolveRuntimeTarget',
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
      'registerReviewerSession',
      'registerToolLessSession',
      'selectSkills',
      'setModelTarget',
      'setReasoningEffort',
      'setTarget',
      'start',
      'unregisterHostMessageSession',
      'unregisterReviewerSession',
      'unregisterToolLessSession'
    ])
  })

  it('locks the SettingsService application interface', () => {
    expect(publicOperationsOf(settingsPaths.service, 'SettingsService')).toEqual(
      `
        addCustomServer addManualInterpreter admitReviewerExecutionModel admitSessionDetailsExecutionTarget admitSubagentExecutionModel admitVisionModel allowNotebookNetworkDomain authenticateCustomServer authenticateDeviceCredential buildCustomServerTemplateExport
        buildSkillExport beginXaiOAuthLogin cancelClaudeIsolatedLogin cancelClaudeLogin cancelCodexLogin cancelCustomServerAuthentication cancelDeviceCredentialAuthentication cancelXaiOAuthLogin captureActiveAgentBackendSelection captureActiveExplicitAgentBackendTarget checkEnvironment clearGrantedLocalRoots codeBuddySkillCatalog codexSkillCatalog
        codexSkillDescriptorsForIds createDeviceCredential createSkill deleteProvider deleteSkill detectClaude detectCodeBuddy detectCodex
        detectOpencode deviceCredentialConsumerIds deviceCredentialIdForServer disconnectCustomServer disconnectDeviceCredential dismissLegacyDataMovePrompt getActiveInstallId getAgentEnvironmentCreationEnabled getAppIconVariant getClosePreference
        getComputeBookmarks getConnectorDetail getConnectors getConversationSkillImportEnabled getGitHubTokenStatus getGrantedLocalRoots getManualInterpreters getNotebookNetwork getNotebookNetworkStatus getNotificationsEnabled getPackageMirror
        getPreflight getRuntimeEnablement getSettingsView getShowNotificationContent getSkillDetail hasActiveInstall holdInstallAdmission
        getStoredSettings importAgentHomeSkills importSkill importSkillArchiveBatch importSkillZip
        importSkillZipBatch installClaude installCodeBuddy installCodex installNotebookNetwork installOpencode isEncryptionAvailable
        isNpmAvailable listAgentHomeSkills listConnectors listDeviceCredentials listHostSkills listSkills listSpecialistSkillCatalog listUserSkills
        dispose loginClaudeShared loginIsolatedClaude loginIsolatedClaudeBrowser loginIsolatedCodex
        logoutClaudeShared logoutIsolatedClaude logoutIsolatedCodex logoutXaiOAuth markOnboardingComplete
        markPathsNormalized migrateAgentHomeSkillIdentities previewAgentHomeSkill previewCustomServerTemplateExport
        previewCustomServerTemplateImport previewGitHubSkill previewSkillArchive previewSkillZip
        provisionedConnectorSkillNames publishHostSkill refreshProviderModels registeredHelperCatalog rememberCodexAutoHttpsFallback removeCustomServer removeDeviceCredential removeGitHubToken removeNotebookNetwork
        removeManualInterpreter resolveActiveModelChangeTarget resolveActiveReasoningEffort
        resolveAdmittedSubagentBackend resolveAgentBackend resolveDeviceOAuthCredential resolveExplicitAgentBackend resolveSkillDocument resolveSubagentExecutionModel saveCustomServerOAuthState saveGitHubToken
        scanRepoSkills setActiveProvider setAgentEnvironmentCreationEnabled setAgentFramework setAgentRouting setAppIconVariant setClosePreference
        setComputeBookmarks setConnectorAutoAllow setConnectorEnabled
        setConversationSkillImportEnabled setCustomServerAuthenticator setCustomServerEnabled
        setDataRoot setDefaultPermissionProfile setDeviceCredentialAuthenticator setEnvironmentEnabled setInstallAuthorized
        setCustomServerRuntimeProjectionProvider setNcbiCredentials setNetworkProxy setNotebookNetwork setNotificationsEnabled
        setOpenAlexCredential setPackageMirror setProjectFilesFilter setReasoningEffort setReviewerModel setSessionDetailsModel setShowNotificationContent setSkillDeletionGuard setSkillEnabled setSkillsEnabled setSubagentModel setVisionModel
        setToolPermission skillNudgeNamesForIds skillsNeedingForceLoad uninstallClaude uninstallCodeBuddy uninstallCodex
        uninstallOpencode updateCustomServer updateDeviceCredential updateSkill upsertProvider validateOpenAlexCredential validateProvider waitXaiOAuthLogin withHostSkillRead
      `
        .trim()
        .split(/\s+/)
        .sort()
    )
  })

  it('locks the current production importer graph at the public seams', () => {
    expect(importersOf(settingsPaths.repository)).toEqual([
      'src/main/index.ts',
      'src/main/ipc.ts',
      'src/main/locale/owner.ts',
      'src/main/settings/agent-runtime-manager.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/connector-settings.ts',
      'src/main/settings/network-proxy-settings-owner.ts',
      'src/main/settings/notebook-network-settings-owner.ts',
      'src/main/settings/notebook-runtime-settings.ts',
      'src/main/settings/preferences.ts',
      'src/main/settings/provider-accounts.ts',
      'src/main/settings/provider-auth-lifecycle.ts',
      'src/main/settings/provider-model-catalog-owner.ts',
      'src/main/settings/reviewer-model-owner.ts',
      'src/main/settings/service.ts',
      'src/main/settings/session-details-model-owner.ts',
      'src/main/settings/skill-catalog.ts',
      'src/main/settings/subagent-model-owner.ts',
      'src/main/settings/vision-model-owner.ts',
      'src/main/settings/xai-provider-account-owner.ts'
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
      'src/main/index.ts',
      'src/main/ipc.ts',
      'src/main/settings/repository.ts'
    ])
    expect(importersOf(settingsPaths.computeGrantPort)).toEqual(['src/main/compute/ipc.ts'])
    expect(importersOf(settingsPaths.providerAccounts)).toEqual([
      'src/main/settings/agent-runtime-manager.ts',
      'src/main/settings/backend-resolver.ts',
      'src/main/settings/backend-route-planner.ts',
      'src/main/settings/backend-selection-owner.ts',
      'src/main/settings/codebuddy-skill-selector-transport.ts',
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
      'activeModel',
      'activeProviderId',
      'agentEnvironmentCreationEnabled',
      'agentFrameworkId',
      'appIconVariant',
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
      'defaultPermissionProfile',
      'disabledSkillIds',
      'githubTokenMask',
      'githubTokenRef',
      'grantedLocalRoots',
      'legacyDataMovePromptDismissedAt',
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
      'visionModel'
    ])
    expect(typePropertyNames(settingsPaths.types, 'StoredProvider')).toEqual([
      'accountEmail',
      'apiEndpoints',
      'baseUrl',
      'codexAuthMode',
      'codexAutoUseHttps',
      'codexTransport',
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
      'src/main/index.ts',
      'src/main/ipc.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/service.ts'
    ])
    const computeIpc = readSource(resolve(projectRoot, 'src/main/compute/ipc.ts'))
    expect(computeIpc).not.toContain("from '../settings/repository'")
    expect(computeIpc).toContain('legacyComputeGrants?: LegacyComputeGrantPort')
    expect(computeIpc).toContain('legacyComputeGrants && !permissionGrantRegistry')
    expect(computeIpc).toContain('legacyComputeGrants.hasComputeGrant(grant)')
    expect(computeIpc).toContain('legacyComputeGrants.addComputeGrant(grant)')
    const mainIpc = readSource(resolve(projectRoot, 'src/main/ipc.ts'))
    const mainIndex = readSource(resolve(projectRoot, 'src/main/index.ts'))
    expect(mainIndex).toContain(
      'const settingsStore = new SettingsDocumentStore(resolveConfigRoot())'
    )
    expect(mainIndex).toContain(
      'const startupSettingsRepository = new SettingsRepository(settingsStore)'
    )
    expect(mainIndex).toMatch(
      /registerIpcHandlers\(\{\s+mainEntryPath,\s+settingsStore,\s+translate,/u
    )
    expect(mainIpc).toContain('settingsStore ?? resolveConfigRoot()')
    expect(mainIpc).toContain('await settingsService.migrateAgentHomeSkillIdentities()')
    expect(mainIpc.indexOf('specialistPackageRecovery.current =')).toBeLessThan(
      mainIpc.indexOf('await settingsService.migrateAgentHomeSkillIdentities()')
    )
    const settingsModule = mainIpc.slice(
      mainIpc.indexOf('const settingsService = await modules.add('),
      mainIpc.indexOf('settingsServiceRef.current = settingsService')
    )
    expect(settingsModule).toContain(
      'const capability = new SettingsService({\n      repository: settingsRepository,\n      skillRuntimeMcpEntryPath: mainEntryPath,\n      openAlexFetch: netFetchStandard,\n      applyNetworkProxy:'
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
    const manifest = JSON.parse(readSource(manifestPath)) as ModuleImpactManifest
    expect(manifest.modules.settings_repository.ownerPaths).toEqual([
      'src/main/settings/repository.ts',
      'src/main/settings/record-codec.ts',
      'src/main/settings/provider-token-limits.ts',
      'src/main/settings/document-codec.ts',
      'src/main/settings/document-store.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/subagent-model-settings.ts'
    ])
    expect(manifest.modules.settings_repository.interfacePaths).toEqual([
      'src/main/settings/repository.ts',
      'src/shared/network-proxy.ts',
      'src/main/settings/compute-grant-port.ts',
      'src/main/settings/provider-token-limits.ts'
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
      'src/main/settings/xai-provider-account-owner.ts'
    ])
    expect(manifest.modules.settings_provider_accounts.interfacePaths).toEqual([
      'src/main/settings/provider-accounts.ts'
    ])
    expect(manifest.modules.settings_backend_resolution.ownerPaths).toEqual([
      'src/main/settings/backend-resolver.ts',
      'src/main/settings/backend-selection-owner.ts',
      'src/main/settings/backend-route-planner.ts',
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
      'src/main/settings/responses-bridge.ts',
      'src/main/settings/responses-protocol-types.ts',
      'src/main/settings/responses-request-adapter.ts',
      'src/main/settings/responses-response-adapter.ts'
    ])
    expect(manifest.modules.settings_backend_resolution.interfacePaths).toEqual([
      'src/main/settings/backend-resolver.ts',
      'src/main/settings/responses-bridge.ts'
    ])
    expect(manifest.modules.settings_service_facade.ownerPaths).toEqual([
      'src/main/settings/service.ts',
      'src/main/settings/network-proxy-settings-owner.ts',
      'src/main/settings/settings-snapshot-commit-owner.ts',
      'src/main/settings/reviewer-model-owner.ts',
      'src/main/settings/subagent-model-owner.ts',
      'src/main/settings/vision-model-owner.ts'
    ])
    expect(manifest.modules.settings_service_facade.interfacePaths).toEqual([
      'src/main/settings/service.ts',
      'src/main/settings/application-commands.ts',
      'src/main/settings/runtime-application-commands.ts',
      'src/main/settings/integration-application-commands.ts',
      'src/main/settings/ipc.ts'
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
    expect(manifest.modules.settings_service_facade.testFiles.contract).toEqual(
      expect.arrayContaining([
        'src/main/settings/application-commands.test.ts',
        'src/main/settings/runtime-application-commands.test.ts',
        'src/main/settings/integration-application-commands.test.ts',
        'src/main/settings/ipc.test.ts',
        'src/main/settings/capabilities.test.ts',
        'src/shared/renderer-contract-catalog.test.ts',
        'src/shared/renderer-surface-inventory.test.ts',
        'src/shared/renderer-surface-matrix.test.ts',
        'src/shared/web-rpc-contract.test.ts',
        'src/preload/electron-renderer-contract-adapter.test.ts',
        'src/renderer/web/api-installer.test.ts'
      ])
    )
    expect(manifest.modules.settings_service_facade.testFiles.consumer).toEqual(
      expect.arrayContaining([
        'packages/open-science/cli.test.ts',
        'src/main/acp/backend-generation-owner.test.ts',
        'src/main/acp/runtime-provider-session-composition.test.ts',
        'src/main/acp/task-agent-port.test.ts',
        'src/main/notebook/local-rpc-notebook-adapter.test.ts',
        'src/main/notebook/local-rpc-server.mcpcall.test.ts',
        'src/main/notebook/mcp-server.test.ts',
        'src/main/web-service/http-server.test.ts',
        'src/renderer/src/stores/settings-runtime-slice.test.ts',
        'src/renderer/src/stores/settings-store.test.ts'
      ])
    )
    expect(manifest.modules.settings_backend_resolution.testFiles.consumer).toEqual(
      expect.arrayContaining([
        'packages/open-science/cli.test.ts',
        'src/main/acp/artifact-code-reconstruction-runner.test.ts',
        'src/main/acp/backend-generation-owner.test.ts',
        'src/main/acp/task-agent-port.test.ts',
        'src/main/acp/turn-skill-owner.test.ts',
        'src/main/artifacts/code-reconstruction.test.ts',
        'src/main/notebook/local-rpc-server.mcpcall.test.ts',
        'src/main/reviewer/mcp-server.test.ts'
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
