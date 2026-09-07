import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isExpressionWithTypeArguments,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isNamedImports,
  isStringLiteralLike,
  isTypeReferenceNode,
  isUnionTypeNode,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node
} from 'typescript'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { AcpApplicationCommandDependencies } from './acp/application-commands'
import type { ApplicationEventPublisher, ApplicationEventSource } from './application-events'
import type { DataContentApplicationCommandDependencies } from './data-content-application-commands'
import type { installNotebookEnvironmentApplicationCommands } from './notebook/environment-application-commands'
import type { NotebookApplicationCommandDependencies } from './notebook/application-commands'
import type { RuntimeApplicationCommandDependencies } from './notebook/runtime-application-commands'
import type { registerPermissionGrantApplicationCommands } from './permission-grants/application-commands'
import type { CoreSettingsApplicationCommandDependencies } from './settings/application-commands'
import type { IntegrationSettingsApplicationCommandDependencies } from './settings/integration-application-commands'
import type { RuntimeSettingsApplicationCommandDependencies } from './settings/runtime-application-commands'

type FutureOrchestrationInterfaces = Readonly<{
  settings: Readonly<{
    settingsCore: CoreSettingsApplicationCommandDependencies
    settingsIntegration: IntegrationSettingsApplicationCommandDependencies
    settingsRuntime: RuntimeSettingsApplicationCommandDependencies
  }>
  acp: AcpApplicationCommandDependencies
  notebook: Readonly<{
    notebook: NotebookApplicationCommandDependencies
    notebookEnvironment: Parameters<typeof installNotebookEnvironmentApplicationCommands>[1]
    notebookRuntime: RuntimeApplicationCommandDependencies
  }>
  artifacts: Pick<DataContentApplicationCommandDependencies, 'artifacts'>
  permission: Parameters<typeof registerPermissionGrantApplicationCommands>[1]
  workspace: Pick<
    DataContentApplicationCommandDependencies,
    'projects' | 'projectFiles' | 'sessions'
  >
  events: ApplicationEventPublisher & ApplicationEventSource
}>

const projectRoot = resolve(__dirname, '../..')
const mainRoot = resolve(projectRoot, 'src/main')
const orchestrationRoot = resolve(mainRoot, 'orchestration')
const readSource = (path: string): string => readFileSync(resolve(projectRoot, path), 'utf8')
const modulePath = (path: string): string => path.replace(/\.(?:[cm]?[jt]sx?)$/, '')

type ImportReference = Readonly<{
  specifier: string
  kind: 'named-type' | 'other'
  names: readonly string[]
}>

const importReferencesFrom = (source: string): readonly ImportReference[] => {
  const imports: ImportReference[] = []
  const sourceFile = createSourceFile(
    'architecture-source.ts',
    source,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  )
  const visit = (node: Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = isImportDeclaration(node) ? node.importClause : undefined
      const bindings = clause?.namedBindings
      const elements = bindings && isNamedImports(bindings) ? bindings.elements : undefined
      const typeOnlyNames =
        elements &&
        !clause?.name &&
        elements.every(
          (element) => !element.propertyName && (clause?.isTypeOnly || element.isTypeOnly)
        )
          ? elements.map((element) => element.name.text)
          : undefined
      imports.push({
        specifier: node.moduleSpecifier.text,
        kind: typeOnlyNames ? 'named-type' : 'other',
        names: typeOnlyNames ?? []
      })
    } else if (isImportTypeNode(node)) {
      const argument = node.argument
      imports.push({
        specifier:
          isLiteralTypeNode(argument) && isStringLiteralLike(argument.literal)
            ? argument.literal.text
            : '<dynamic import type>',
        kind: 'other',
        names: []
      })
    } else if (isCallExpression(node)) {
      const [argument] = node.arguments
      const isRequire = isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword
      if (isRequire || isDynamicImport) {
        imports.push({
          specifier:
            node.arguments.length === 1 && argument && isStringLiteralLike(argument)
              ? argument.text
              : isRequire
                ? '<dynamic require>'
                : '<dynamic import>',
          kind: 'other',
          names: []
        })
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return imports
}

const resolveImportTarget = (sourcePath: string, specifier: string): string | undefined =>
  specifier.startsWith('.')
    ? modulePath(resolve(dirname(resolve(projectRoot, sourcePath)), specifier))
    : undefined

const CONCRETE_OWNER_TARGETS = new Set([
  modulePath(resolve(mainRoot, 'acp/runtime')),
  modulePath(resolve(mainRoot, 'acp/runtime-coordinator')),
  modulePath(resolve(mainRoot, 'notebook/runtime-service')),
  modulePath(resolve(mainRoot, 'settings/service')),
  modulePath(resolve(mainRoot, 'settings/types'))
])

const isCurrentSeamViolation = (sourcePath: string, specifier: string): boolean => {
  const target = resolveImportTarget(sourcePath, specifier)
  return (
    specifier === 'electron' ||
    specifier.startsWith('electron/') ||
    (target !== undefined &&
      (CONCRETE_OWNER_TARGETS.has(target) ||
        /(?:^|-)repository$/.test(basename(target)) ||
        target.startsWith(resolve(mainRoot, 'web-service') + sep) ||
        (dirname(target) === mainRoot && basename(target).startsWith('renderer')) ||
        basename(target).includes('http')))
  )
}

const currentSeamViolations = (sourcePath: string, source: string): readonly string[] =>
  importReferencesFrom(source)
    .map(({ specifier }) => specifier)
    .filter((specifier) => isCurrentSeamViolation(sourcePath, specifier))

const FUTURE_INTERFACE_IMPORTS = new Map<string, ReadonlySet<string>>([
  [
    modulePath(resolve(mainRoot, 'acp/application-commands')),
    new Set(['AcpApplicationCommandDependencies'])
  ],
  [
    modulePath(resolve(mainRoot, 'notebook/application-commands')),
    new Set(['NotebookApplicationCommandDependencies'])
  ],
  [
    modulePath(resolve(mainRoot, 'notebook/environment-application-commands')),
    new Set(['installNotebookEnvironmentApplicationCommands'])
  ],
  [
    modulePath(resolve(mainRoot, 'notebook/runtime-application-commands')),
    new Set(['RuntimeApplicationCommandDependencies'])
  ],
  [
    modulePath(resolve(mainRoot, 'settings/application-commands')),
    new Set(['CoreSettingsApplicationCommandDependencies'])
  ],
  [
    modulePath(resolve(mainRoot, 'settings/integration-application-commands')),
    new Set(['IntegrationSettingsApplicationCommandDependencies'])
  ],
  [
    modulePath(resolve(mainRoot, 'settings/runtime-application-commands')),
    new Set(['RuntimeSettingsApplicationCommandDependencies'])
  ],
  [
    modulePath(resolve(mainRoot, 'data-content-application-commands')),
    new Set(['DataContentApplicationCommandDependencies'])
  ],
  [
    modulePath(resolve(mainRoot, 'permission-grants/application-commands')),
    new Set(['registerPermissionGrantApplicationCommands'])
  ],
  [
    modulePath(resolve(mainRoot, 'application-events')),
    new Set(['ApplicationEventPublisher', 'ApplicationEventSource'])
  ]
])

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(root + sep)

const isFutureOrchestrationImportAllowed = (
  sourcePath: string,
  reference: ImportReference
): boolean => {
  const target = resolveImportTarget(sourcePath, reference.specifier)
  if (target === undefined) return false
  if (isWithin(target, orchestrationRoot)) return true
  const allowedNames = FUTURE_INTERFACE_IMPORTS.get(target)
  return (
    reference.kind === 'named-type' &&
    allowedNames !== undefined &&
    reference.names.length > 0 &&
    reference.names.every((name) => allowedNames.has(name))
  )
}

const hasInvalidDataContentTypeUse = (source: string): boolean => {
  const sourceFile = createSourceFile(
    'future-orchestration.ts',
    source,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  )
  const allowedKeys = new Set(['artifacts', 'projects', 'projectFiles', 'sessions'])
  let invalid = false
  const literalKeys = (node: Node): readonly string[] | undefined => {
    if (isLiteralTypeNode(node) && isStringLiteralLike(node.literal)) return [node.literal.text]
    if (isUnionTypeNode(node)) {
      const keys = node.types.flatMap((type) => literalKeys(type) ?? [])
      return keys.length === node.types.length ? keys : undefined
    }
    return undefined
  }
  const visit = (node: Node): void => {
    if (
      isTypeReferenceNode(node) &&
      isIdentifier(node.typeName) &&
      node.typeName.text === 'DataContentApplicationCommandDependencies'
    ) {
      const pick = node.parent
      const keys =
        isTypeReferenceNode(pick) &&
        isIdentifier(pick.typeName) &&
        pick.typeName.text === 'Pick' &&
        pick.typeArguments?.[0] === node &&
        pick.typeArguments[1]
          ? literalKeys(pick.typeArguments[1])
          : undefined
      if (!keys || keys.some((key) => !allowedKeys.has(key))) invalid = true
    } else if (
      isExpressionWithTypeArguments(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'DataContentApplicationCommandDependencies'
    ) {
      invalid = true
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return invalid
}

const futureOrchestrationViolations = (sourcePath: string, source: string): readonly string[] => {
  const violations = importReferencesFrom(source)
    .filter((reference) => !isFutureOrchestrationImportAllowed(sourcePath, reference))
    .map(({ specifier }) => specifier)
  if (hasInvalidDataContentTypeUse(source)) {
    violations.push('DataContentApplicationCommandDependencies')
  }
  return violations
}

const productionOrchestrationSources = (): readonly string[] => {
  if (!existsSync(orchestrationRoot)) return []
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (
        /\.[cm]?tsx?$/.test(entry.name) &&
        !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
      ) {
        files.push(relative(projectRoot, path))
      }
    }
  }
  visit(orchestrationRoot)
  return files.sort()
}

describe('runtime state ownership architecture', () => {
  it('defines the future orchestration seam only from declared application interfaces', () => {
    expectTypeOf<keyof FutureOrchestrationInterfaces>().toEqualTypeOf<
      'settings' | 'acp' | 'notebook' | 'artifacts' | 'permission' | 'workspace' | 'events'
    >()
    expectTypeOf<keyof FutureOrchestrationInterfaces['settings']>().toEqualTypeOf<
      'settingsCore' | 'settingsIntegration' | 'settingsRuntime'
    >()
    expectTypeOf<keyof FutureOrchestrationInterfaces['notebook']>().toEqualTypeOf<
      'notebook' | 'notebookEnvironment' | 'notebookRuntime'
    >()
    expectTypeOf<keyof FutureOrchestrationInterfaces['artifacts']>().toEqualTypeOf<'artifacts'>()
    expectTypeOf<keyof FutureOrchestrationInterfaces['workspace']>().toEqualTypeOf<
      'projects' | 'projectFiles' | 'sessions'
    >()
    expectTypeOf<FutureOrchestrationInterfaces['events']>().toEqualTypeOf<
      ApplicationEventPublisher & ApplicationEventSource
    >()
  })

  it('keeps the current seams free of known concrete owners, repositories, and transports', () => {
    const seamSources = [
      'src/main/application-command-composition.ts',
      'src/main/application-events.ts'
    ]

    for (const path of seamSources) {
      expect(currentSeamViolations(path, readSource(path)), path).toEqual([])
    }
  })

  it('keeps live Session Plan state behind one owner and application workflow', () => {
    const runtime = readSource('src/main/acp/runtime.ts')
    const composition = readSource('src/main/acp/runtime-base-composition.ts')
    const planComposition = readSource('src/main/acp/runtime-plan-composition.ts')
    const source = runtime + composition + planComposition

    expect(source).not.toContain('planApprovalWaiters')
    expect(source).not.toContain('planExecutionBindings')
    expect(source.match(/new SessionPlanInteractionOwner\(\)/g)).toHaveLength(1)
    expect(composition).toContain('interactions: planInteractions')
    expect(runtime).not.toMatch(/private readonly (?:planInteractions|planService)/)
    expect(runtime).not.toContain('this.planInteractions = base.planInteractions')
    expect(runtime).not.toContain('this.planService = base.planService')
    expect(runtime).not.toContain('private readonly planSessions')
    expect(runtime).toContain('composeAcpRuntimePlanWorkflow(options, base, session, {')
    expect(runtime).toContain('deliveries: this.planDeliveryOwner')
    expect(runtime).toContain('plan: this.sessionPlanWorkflow.prompt')
    expect(runtime).toContain('this.sessionPlanWorkflow.capturePromptCancellation(')
    expect(runtime).toContain('this.sessionPlanWorkflow.sessionDeleted(request.sessionId)')
    expect(runtime).toContain('return this.sessionPlanWorkflow.call(input)')
    expect(runtime).toContain('return this.sessionPlanWorkflow.projection(projectId, sessionId)')
    expect(runtime).toContain('const result = await this.sessionPlanWorkflow.respond(input)')
    expect(runtime).toContain('this.scheduleQueuedPlanDelivery(input.projectId, input.sessionId)')
    expect(planComposition).toContain('const interactions = base.planInteractions')
    expect(planComposition).toContain('const service = base.planService')
    expect(planComposition).not.toMatch(/AcpRuntime\.prototype|from ['"]electron['"]/)
  })

  it('keeps model application and attached resume behavior behind their workflows', () => {
    const runtime = readSource('src/main/acp/runtime.ts')
    const providerSessions = readSource('src/main/acp/runtime-provider-session-composition.ts')
    const source = runtime + providerSessions

    expect(source).not.toContain('canApplyModelChange')
    expect(source).not.toContain('modelChangeMatchesCurrent')
    expect(source).not.toContain('applyModelTarget')
    expect(source).not.toContain('resumeSessionOperation')
    expect(source).toContain('return this.modelChanges.applyReasoningEffort(effort)')
    expect(source).toContain('this.providerSessionResumer.resume(request)')
    expect(providerSessions).toContain(
      'const currentConnection = (): ClientConnection | undefined => base.connectionResources.connection'
    )
  })

  it('constructs the model and connection lifecycle cycle outside Runtime', () => {
    const runtime = readSource('src/main/acp/runtime.ts')
    const composition = readSource('src/main/acp/runtime-lifecycle-composition.ts')

    expect(runtime).not.toMatch(
      /new (?:AcpModelChangeWorkflow|AcpConnectionCloseWorkflow|AcpConnectionLifecycleWorkflow)/
    )
    expect(runtime).toContain('composeAcpRuntimeLifecycleOwners(options, base, session, {')
    expect(composition.match(/new AcpModelChangeWorkflow\(/g)).toHaveLength(1)
    expect(composition.match(/new AcpConnectionCloseWorkflow\(/g)).toHaveLength(1)
    expect(composition.match(/new AcpConnectionLifecycleWorkflow\(/g)).toHaveLength(1)
    expect(composition).not.toContain('AcpRuntime.prototype')
  })

  it('constructs Provider Session workflows outside Runtime with one shared adopter', () => {
    const runtime = readSource('src/main/acp/runtime.ts')
    const composition = readSource('src/main/acp/runtime-provider-session-composition.ts')

    expect(runtime).not.toMatch(
      /new (?:AcpProviderSessionCreator|AcpProviderSessionAdopter|AcpProviderSessionResumer|AcpSessionReplacementWorkflow|AcpSessionDeletionWorkflow)/
    )
    expect(runtime).toContain('composeAcpRuntimeProviderSessionOwners(')
    expect(composition.match(/new AcpProviderSessionCreator\(/g)).toHaveLength(1)
    expect(composition.match(/new AcpProviderSessionAdopter\(/g)).toHaveLength(1)
    expect(composition.match(/new AcpProviderSessionResumer\(/g)).toHaveLength(1)
    expect(composition.match(/new AcpSessionReplacementWorkflow\(/g)).toHaveLength(1)
    expect(composition.match(/new AcpSessionDeletionWorkflow\(/g)).toHaveLength(1)
    expect(composition.match(/adopter: providerSessionAdopter/g)).toHaveLength(2)
    expect(composition).toContain('await lifecycle.connectionClose.disconnect(false)')
    expect(composition).not.toMatch(/AcpRuntime\.prototype|from ['"]electron['"]/)
  })

  it('constructs Prompt workflows outside Runtime with a private preparation owner', () => {
    const runtime = readSource('src/main/acp/runtime.ts')
    const composition = readSource('src/main/acp/runtime-prompt-composition.ts')

    expect(runtime).not.toMatch(
      /new (?:AcpPromptPreparationOwner|AcpContextCompactionWorkflow|AcpPromptTurnWorkflow)/
    )
    expect(runtime).toContain('composeAcpRuntimePromptOwners(options, base, session, {')
    expect(composition.match(/new AcpPromptPreparationOwner\(/g)).toHaveLength(1)
    expect(composition.match(/new AcpContextCompactionWorkflow\(/g)).toHaveLength(1)
    expect(composition.match(/new AcpPromptTurnWorkflow\(/g)).toHaveLength(1)
    expect(composition).toContain(
      'return Object.freeze({ contextCompactionWorkflow, promptTurnWorkflow })'
    )
    expect(composition).not.toMatch(/AcpRuntime\.prototype|from ['"]electron['"]/)
  })

  it('keeps provider interactions and reviewer preparation behind their owners', () => {
    const runtime = readSource('src/main/acp/runtime.ts')
    const interactions = readSource('src/main/acp/client-interaction-owner.ts')
    const composition = readSource('src/main/acp/runtime-session-composition.ts')

    expect(runtime).not.toContain('private async handlePermissionRequest')
    expect(runtime).not.toContain('private handleElicitationRequest')
    expect(runtime).not.toContain('private observePermissionToolContext')
    expect(runtime).not.toContain('reviewerSessions.create(request, async')
    expect(runtime).not.toContain('codex_approval_kind')
    expect(runtime).toContain('this.clientInteractions.createElicitation(params)')
    expect(runtime).toContain('this.clientInteractions.requestPermission(params)')
    expect(runtime).toContain('this.permissionContext.observeProviderUpdate(notification)')
    expect(runtime).toContain('this.reviewerSessions.create(request, {')
    expect(runtime).toContain('ensureConnected: (cwd) => this.ensureConnected(cwd)')

    expect(interactions).toContain("meta.codex_approval_kind === 'mcp_tool_call'")
    expect(interactions).toContain('this.options.elicitation.request(')
    expect(interactions).toContain('this.options.permission.handleProviderRequest(params)')
    expect(composition.match(/new AcpClientInteractionOwner\(/g)).toHaveLength(1)
    expect(composition).toContain('elicitation: elicitationOwner')
    expect(composition).toContain('permission: permissionContext')
  })

  it('keeps provider selection and Context routing behind their prompt owners', () => {
    const runtime = readSource('src/main/acp/runtime.ts')
    const promptComposition = readSource('src/main/acp/runtime-prompt-composition.ts')
    const source = runtime + promptComposition

    expect(source).not.toContain('private providerTurnAdapter')
    expect(source).not.toContain('private recordProviderPromptContextUsage')
    expect(source).not.toContain('private contextUsageSelectionFor')
    expect(source).not.toContain('private contextUsageEstimateInput')
    expect(source).not.toContain('private selectedContextWindowFor')
    expect(source).not.toContain('private handleSessionUpdate')
    expect(source).not.toContain('private applySessionUpdateEffects')
    expect(promptComposition).toContain('session.contextUsagePolicy.resolve(sessionId)')
    expect(promptComposition).toContain('session.sessionUpdateProjector.route(notification')
  })

  it('accepts declared interface imports for a future orchestration module', () => {
    const source = `
      import type { AcpApplicationCommandDependencies } from '../acp/application-commands'
      import type { NotebookApplicationCommandDependencies } from '../notebook/application-commands'
      import type { installNotebookEnvironmentApplicationCommands } from '../notebook/environment-application-commands'
      import type { RuntimeApplicationCommandDependencies } from '../notebook/runtime-application-commands'
      import type { CoreSettingsApplicationCommandDependencies } from '../settings/application-commands'
      import type { IntegrationSettingsApplicationCommandDependencies } from '../settings/integration-application-commands'
      import type { RuntimeSettingsApplicationCommandDependencies } from '../settings/runtime-application-commands'
      import type { DataContentApplicationCommandDependencies } from '../data-content-application-commands'
      import type { registerPermissionGrantApplicationCommands } from '../permission-grants/application-commands'
      import type { ApplicationEventPublisher, ApplicationEventSource } from '../application-events'
      import { coordinateStep } from './coordinate-step'
      type Artifacts = Pick<DataContentApplicationCommandDependencies, 'artifacts'>
      type Workspace = Pick<
        DataContentApplicationCommandDependencies,
        'projects' | 'projectFiles' | 'sessions'
      >
    `

    expect(futureOrchestrationViolations('src/main/orchestration/orchestrator.ts', source)).toEqual(
      []
    )
  })

  it.each([
    ['../application-command-composition', 'ApplicationCommandCompositionDependencies'],
    ['../acp/runtime', 'AcpRuntime'],
    ['../acp/runtime-coordinator.js', 'AcpRuntimeCoordinator'],
    ['../acp/reviewer-session-owner', 'ReviewerSessionOwner'],
    ['../session-plan/session-plan-interaction-owner', 'SessionPlanInteractionOwner'],
    ['../settings/service', 'SettingsService'],
    ['../settings/backend-resolver', 'AgentBackendResolver'],
    ['../settings/ipc', 'registerSettingsIpcHandlers'],
    ['../settings/types', 'StoredSettings'],
    ['../notebook/runtime-service', 'NotebookRuntimeService'],
    ['../notebook/execution-owner', 'NotebookExecutionOwner'],
    ['../notebook/local-rpc-server', 'NotebookLocalRpcServer'],
    ['../artifacts/repository', 'ArtifactRepository'],
    ['../tasks/task-runner', 'TaskRunner'],
    ['../specialist/service', 'SpecialistService'],
    ['../ipc', 'createApplicationModules'],
    ['../renderer-broadcast', 'broadcastToRenderers'],
    ['../web-service/http-server', 'WebHttpServer'],
    ['electron', 'ipcMain'],
    ['../compute/application-commands', 'ComputeApplicationCommandDependencies'],
    ['../../../packages/open-science/index', 'OpenScienceClient']
  ])('rejects direct future orchestration dependency on %s', (specifier, symbol) => {
    const source = `import { ${symbol} } from '${specifier}'`

    expect(futureOrchestrationViolations('src/main/orchestration/orchestrator.ts', source)).toEqual(
      [specifier]
    )
  })

  it('rejects value and namespace imports from an allowed interface module', () => {
    const source = `
      import { registerAcpCommands } from '../acp/application-commands'
      import type * as AcpCommands from '../acp/application-commands'
    `

    expect(futureOrchestrationViolations('src/main/orchestration/orchestrator.ts', source)).toEqual(
      ['../acp/application-commands', '../acp/application-commands']
    )
  })

  it('rejects broad or non-owned data-content capability access', () => {
    const source = `
      import type { DataContentApplicationCommandDependencies } from '../data-content-application-commands'
      type WholeDataPlane = DataContentApplicationCommandDependencies
      type Uploads = Pick<DataContentApplicationCommandDependencies, 'uploads'>
      interface ExtendedDataPlane extends DataContentApplicationCommandDependencies {}
    `

    expect(futureOrchestrationViolations('src/main/orchestration/orchestrator.ts', source)).toEqual(
      ['DataContentApplicationCommandDependencies']
    )
  })

  it('rejects dynamic imports and CommonJS requires outside the future interface seam', () => {
    const source = `
      const runtime = import('../acp/runtime')
      const settings = require('../settings/service')
    `

    expect(futureOrchestrationViolations('src/main/orchestration/orchestrator.ts', source)).toEqual(
      ['../acp/runtime', '../settings/service']
    )
  })

  it('rejects import types and non-literal module loading', () => {
    const source = `
      type Runtime = import('../acp/runtime').AcpRuntime
      type DynamicType = import(typePath).Owner
      const settings = require(settingsPath)
      const notebook = import(notebookPath)
    `

    expect(futureOrchestrationViolations('src/main/orchestration/orchestrator.ts', source)).toEqual(
      ['../acp/runtime', '<dynamic import type>', '<dynamic require>', '<dynamic import>']
    )
  })

  it('keeps production orchestration modules on the declared interface seam once introduced', () => {
    for (const path of productionOrchestrationSources()) {
      expect(futureOrchestrationViolations(path, readSource(path)), path).toEqual([])
    }
  })
})
