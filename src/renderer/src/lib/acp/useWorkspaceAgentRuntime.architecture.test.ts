import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCaseBlock,
  isCatchClause,
  isCallExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLike,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isSourceFile,
  isStringLiteralLike,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type ArrowFunction,
  type Node,
  type SourceFile,
  type TypeLiteralNode
} from 'typescript'
import { describe, expect, it } from 'vitest'
const rendererRoot = resolve(__dirname, '../..')
const facadePath = resolve(__dirname, 'useWorkspaceAgentRuntime.ts')
const manifestPath = resolve(__dirname, '../../../../../scripts/ci/module-impact.json')
const architectureTestPath =
  'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.architecture.test.ts'
// Full-tree AST scans parse every renderer production file. Nightly coverage
// on a loaded runner exceeds Vitest's 15s default when each case re-parses
// the same tree; keep a 60s budget and reuse parsed imports within the file.
const ARCHITECTURE_SCAN_TIMEOUT_MS = 60_000
const sourceTextCache = new Map<string, string>()
const readSource = (path: string): string => {
  const cached = sourceTextCache.get(path)
  if (cached !== undefined) return cached
  const source = readFileSync(path, 'utf8')
  sourceTextCache.set(path, source)
  return source
}
const normalizePathSeparators = (path: string): string => path.replace(/\\/g, '/')
const modulePath = (path: string): string =>
  normalizePathSeparators(path.replace(/\.[cm]?[jt]sx?$/, ''))
const sourceFileFor = (path: string, source = readSource(path)): SourceFile =>
  createSourceFile(
    path,
    source,
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
let productionSourcePaths: readonly string[] | undefined
const productionSources = (): readonly string[] => {
  if (productionSourcePaths) return productionSourcePaths
  const paths: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.[cm]?tsx?$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)) {
        paths.push(path)
      }
    }
  }
  visit(rendererRoot)
  productionSourcePaths = paths.sort()
  return productionSourcePaths
}
const ownerNames = [
  'workspace-runtime-event-owner',
  'workspace-runtime-prompt-preparation-owner',
  'workspace-runtime-session-branch-owner',
  'workspace-runtime-attachment-owner',
  'workspace-runtime-command-owner',
  'workspace-runtime-session-lifecycle-owner',
  'workspace-runtime-session-memory-owner',
  'workspace-runtime-selection-owner',
  'workspace-runtime-save-as-skill-owner'
] as const
const facadeOwnerNames = ownerNames.filter(
  (name) =>
    name !== 'workspace-runtime-session-branch-owner' &&
    name !== 'workspace-runtime-attachment-owner' &&
    name !== 'workspace-runtime-session-memory-owner'
)
const ownerTargets = new Map(ownerNames.map((name) => [name, modulePath(resolve(__dirname, name))]))
const ownerFilePath = (name: (typeof ownerNames)[number]): string => `${ownerTargets.get(name)}.ts`
const privateOwnerTargets = new Set(ownerTargets.values())
const subagentPresentationTarget = modulePath(
  resolve(__dirname, 'workspace-subagent-runtime-presentation')
)
const privateRuntimeTargets = new Set([...privateOwnerTargets, subagentPresentationTarget])
const facadeTarget = modulePath(facadePath)
const workspaceEventsTarget = modulePath(resolve(__dirname, 'workspace-events'))
const resolveImportTarget = (sourcePath: string, specifier: string): string | undefined => {
  if (specifier.startsWith('@/')) return modulePath(resolve(rendererRoot, specifier.slice(2)))
  if (specifier.startsWith('@renderer/')) {
    return modulePath(resolve(rendererRoot, specifier.slice('@renderer/'.length)))
  }
  if (specifier.startsWith('.')) {
    return modulePath(resolve(dirname(sourcePath), normalizePathSeparators(specifier)))
  }
  return undefined
}
type ImportReference = Readonly<{
  target: string | undefined
  kind: 'import' | 'export' | 'dynamic' | 'require'
  names: readonly string[] | undefined
  literal: boolean
}>
type LoaderBindings = Readonly<{
  requireAliases: ReadonlySet<string>
  specifiers: ReadonlyMap<string, string>
  wrappers: ReadonlyMap<string, 'dynamic' | 'require'>
}>
const isLoaderScope = (node: Node): boolean =>
  isSourceFile(node) ||
  isFunctionLike(node) ||
  isBlock(node) ||
  isCaseBlock(node) ||
  isCatchClause(node) ||
  isForStatement(node) ||
  isForInStatement(node) ||
  isForOfStatement(node)
const isVarDeclaration = (node: Node): boolean =>
  isVariableDeclaration(node) &&
  isVariableDeclarationList(node.parent) &&
  (node.parent.flags & (NodeFlags.Let | NodeFlags.Const)) === 0
const lexicalNamesIn = (scope: Node): ReadonlySet<string> => {
  const names = new Set<string>()
  const caught = isCatchClause(scope) ? scope.variableDeclaration : undefined
  if (caught && isIdentifier(caught.name)) names.add(caught.name.text)
  const visit = (node: Node): void => {
    if (node !== scope && isFunctionDeclaration(node)) {
      if (node.name) names.add(node.name.text)
      return
    }
    if (node !== scope && isLoaderScope(node)) return
    if (isVariableDeclaration(node) && isIdentifier(node.name) && !isVarDeclaration(node)) {
      names.add(node.name.text)
    }
    forEachChild(node, visit)
  }
  visit(scope)
  return names
}
const loaderWrapperKind = (
  node: Node,
  requireAliases: ReadonlySet<string>
): 'dynamic' | 'require' | undefined => {
  if (
    (!isArrowFunction(node) && !isFunctionExpression(node) && !isFunctionDeclaration(node)) ||
    !node.body ||
    node.parameters.length !== 1 ||
    !isIdentifier(node.parameters[0].name)
  ) {
    return undefined
  }
  const parameter = node.parameters[0].name.text
  const expression = isBlock(node.body)
    ? node.body.statements.length === 1 && isReturnStatement(node.body.statements[0])
      ? node.body.statements[0].expression
      : undefined
    : node.body
  if (
    !expression ||
    !isCallExpression(expression) ||
    !expression.arguments[0] ||
    !isIdentifier(expression.arguments[0]) ||
    expression.arguments[0].text !== parameter
  ) {
    return undefined
  }
  if (expression.expression.kind === SyntaxKind.ImportKeyword) return 'dynamic'
  return isIdentifier(expression.expression) && requireAliases.has(expression.expression.text)
    ? 'require'
    : undefined
}
const loaderBindingsIn = (scope: Node, inherited: LoaderBindings): LoaderBindings => {
  const aliases = new Set(inherited.requireAliases)
  const specifiers = new Map(inherited.specifiers)
  const wrappers = new Map(inherited.wrappers)
  if (isFunctionLike(scope)) {
    for (const parameter of scope.parameters) {
      if (isIdentifier(parameter.name)) {
        const name = parameter.name.text
        aliases.delete(name)
        specifiers.delete(name)
        wrappers.delete(name)
      }
    }
    for (const parameter of scope.parameters) {
      if (!isIdentifier(parameter.name) || !parameter.initializer) continue
      const name = parameter.name.text
      if (isIdentifier(parameter.initializer)) {
        const initializer = parameter.initializer.text
        if (aliases.has(initializer)) aliases.add(name)
        const specifier = specifiers.get(initializer)
        if (specifier !== undefined) specifiers.set(name, specifier)
        const wrapper = wrappers.get(initializer)
        if (wrapper) wrappers.set(name, wrapper)
      } else if (isStringLiteralLike(parameter.initializer)) {
        specifiers.set(name, parameter.initializer.text)
      }
    }
  }
  if (
    isCatchClause(scope) &&
    scope.variableDeclaration &&
    isIdentifier(scope.variableDeclaration.name)
  ) {
    aliases.delete(scope.variableDeclaration.name.text)
    specifiers.delete(scope.variableDeclaration.name.text)
    wrappers.delete(scope.variableDeclaration.name.text)
  }
  const hoistedVarNames = new Set<string>()
  if (isSourceFile(scope) || isFunctionLike(scope)) {
    const collect = (node: Node): void => {
      if (node !== scope && isFunctionLike(node)) return
      if (isVariableDeclaration(node) && isVarDeclaration(node) && isIdentifier(node.name)) {
        hoistedVarNames.add(node.name.text)
        aliases.delete(node.name.text)
        specifiers.delete(node.name.text)
        wrappers.delete(node.name.text)
      }
      forEachChild(node, collect)
    }
    collect(scope)
  }
  const forgetDirectDeclarations = (node: Node): void => {
    if (node !== scope && isFunctionDeclaration(node)) {
      if (node.name) {
        aliases.delete(node.name.text)
        specifiers.delete(node.name.text)
        wrappers.delete(node.name.text)
      }
      return
    }
    if (node !== scope && isLoaderScope(node)) return
    if (isVariableDeclaration(node) && isIdentifier(node.name)) {
      aliases.delete(node.name.text)
      specifiers.delete(node.name.text)
      wrappers.delete(node.name.text)
    }
    forEachChild(node, forgetDirectDeclarations)
  }
  forgetDirectDeclarations(scope)
  let previousState = ''
  while (`${aliases.size}:${specifiers.size}:${wrappers.size}` !== previousState) {
    previousState = `${aliases.size}:${specifiers.size}:${wrappers.size}`
    const visit = (
      node: Node,
      nestedScope = false,
      shadowed: ReadonlySet<string> = new Set()
    ): void => {
      if (node !== scope && isFunctionDeclaration(node)) {
        const wrapper = !nestedScope && node.name ? loaderWrapperKind(node, aliases) : undefined
        if (wrapper && node.name) wrappers.set(node.name.text, wrapper)
        return
      }
      if (node !== scope && isFunctionLike(node)) return
      const nested = nestedScope || (node !== scope && isLoaderScope(node))
      const blocked =
        node !== scope && isLoaderScope(node)
          ? new Set([...shadowed, ...lexicalNamesIn(node)])
          : shadowed
      let name: string | undefined
      let value: Node | undefined
      if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer) {
        name = node.name.text
        value = node.initializer
      } else if (
        isBinaryExpression(node) &&
        node.operatorToken.kind === SyntaxKind.EqualsToken &&
        isIdentifier(node.left)
      ) {
        name = node.left.text
        value = node.right
      }
      if (
        name &&
        value &&
        (!nested || (hoistedVarNames.has(name) && (isVarDeclaration(node) || !blocked.has(name))))
      ) {
        if (isIdentifier(value) && aliases.has(value.text)) aliases.add(name)
        const wrapper = isIdentifier(value)
          ? wrappers.get(value.text)
          : loaderWrapperKind(value, aliases)
        if (wrapper) wrappers.set(name, wrapper)
        const specifier = isStringLiteralLike(value)
          ? value.text
          : isIdentifier(value)
            ? specifiers.get(value.text)
            : undefined
        if (specifier !== undefined) specifiers.set(name, specifier)
      }
      forEachChild(node, (child) => visit(child, nested, blocked))
    }
    visit(scope)
  }
  return { requireAliases: aliases, specifiers, wrappers }
}
const fileImportCache = new Map<string, readonly ImportReference[]>()
const importsFrom = (path: string, source?: string): readonly ImportReference[] => {
  const useFileCache = source === undefined
  if (useFileCache) {
    const cached = fileImportCache.get(path)
    if (cached) return cached
  }
  const resolvedSource = source ?? readSource(path)
  const references: ImportReference[] = []
  const sourceFile = sourceFileFor(path, resolvedSource)
  const visit = (node: Node, inherited: LoaderBindings): void => {
    const bindings = isLoaderScope(node) ? loaderBindingsIn(node, inherited) : inherited
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      const bindings = isImportDeclaration(node) ? node.importClause?.namedBindings : undefined
      references.push({
        target: resolveImportTarget(path, node.moduleSpecifier.text),
        kind: isImportDeclaration(node) ? 'import' : 'export',
        names:
          bindings && isNamedImports(bindings)
            ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
            : undefined,
        literal: true
      })
    } else if (isCallExpression(node)) {
      const argument = node.arguments[0]
      const specifier = argument
        ? isStringLiteralLike(argument)
          ? argument.text
          : isIdentifier(argument)
            ? bindings.specifiers.get(argument.text)
            : undefined
        : undefined
      const target = specifier === undefined ? undefined : resolveImportTarget(path, specifier)
      const kind =
        isIdentifier(node.expression) && bindings.requireAliases.has(node.expression.text)
          ? 'require'
          : isIdentifier(node.expression) && bindings.wrappers.has(node.expression.text)
            ? bindings.wrappers.get(node.expression.text)
            : node.expression.kind === SyntaxKind.ImportKeyword
              ? 'dynamic'
              : undefined
      if (kind) {
        references.push({
          target,
          kind,
          names: undefined,
          literal: specifier !== undefined
        })
      }
    }
    forEachChild(node, (child) => visit(child, bindings))
  }
  visit(sourceFile, {
    requireAliases: new Set(['require']),
    specifiers: new Map(),
    wrappers: new Map()
  })
  if (useFileCache) fileImportCache.set(path, references)
  return references
}
const callCounts = (sourceFile: SourceFile): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isIdentifier(node.expression)) {
      counts.set(node.expression.text, (counts.get(node.expression.text) ?? 0) + 1)
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return counts
}
const propertyCallCounts = (
  sourceFile: SourceFile,
  receiver: string
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.expression.text === receiver
    ) {
      const name = node.expression.name.text
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return counts
}
const variableArrow = (sourceFile: SourceFile, name: string): ArrowFunction => {
  let found: ArrowFunction | undefined
  const visit = (node: Node): void => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      isArrowFunction(node.initializer)
    ) {
      found = node.initializer
      return
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!found) throw new Error(`${name} arrow function not found`)
  return found
}
const typeLiteralAlias = (sourceFile: SourceFile, name: string): TypeLiteralNode => {
  const declaration = sourceFile.statements
    .filter(isTypeAliasDeclaration)
    .find((statement) => statement.name.text === name)
  if (!declaration || !isTypeLiteralNode(declaration.type)) throw new Error(`${name} not found`)
  return declaration.type
}
const propertyNames = (object: Node): string[] => {
  if (!isObjectLiteralExpression(object)) throw new Error('expected object literal')
  return object.properties.map((property) => {
    if (!property.name) throw new Error('expected named object property')
    return property.name.getText().replace(/^['"]|['"]$/g, '')
  })
}
const expectSameNames = (actual: readonly string[], expected: readonly string[]): void => {
  expect(actual).toHaveLength(expected.length)
  expect([...actual].sort()).toEqual([...expected].sort())
}
const effectBodies = (sourceFile: SourceFile): readonly string[] => {
  const bodies: string[] = []
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'useEffect' &&
      node.arguments[0]
    ) {
      bodies.push(node.arguments[0].getText(sourceFile))
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return bodies
}
const directReturnObject = (arrow: ReturnType<typeof variableArrow>): Node => {
  if (!isBlock(arrow.body)) throw new Error('expected block-bodied arrow function')
  const statement = arrow.body.statements.find(isReturnStatement)
  if (!statement?.expression) throw new Error('expected direct return value')
  return statement.expression
}
const hookKeys = [
  'actionError',
  'isConnecting',
  'pendingPermissions',
  'permissionProfiles',
  'permissionGrants',
  'contextUsageBySession',
  'delegatedWorkUnavailableBySession',
  'promptInFlightSessionIds',
  'sendPreparationInFlightSessionIds',
  'saveAsSkillInFlightSessionIds',
  'nativeContextCompactionSessionIds',
  'subscribeToSubagentRuntimeUpdates',
  'compactContext',
  'ensureSessionReady',
  'saveAsSkill',
  'sendMessage',
  'resendEditedMessage',
  'cancelRun',
  'steerFollowUp',
  'resumeInterruptedSession',
  'respondToPermission',
  'setPermissionProfile',
  'setMemoryEnabled',
  'revokePermissionGrant',
  'resolveSessionRuntimeSelection'
] as const
const sendIntentKeys = [
  'sessionId',
  'messageId',
  'branchSourceSessionId',
  'branchSourceMessageId',
  'text',
  'attribution',
  'requireExistingSession',
  'turnIntent',
  'attachments',
  'annotations',
  'cwd',
  'projectId',
  'permissionProfile',
  'forcedSkillIds',
  'referencedArtifacts',
  'pdfContext',
  'pdfReadingPosition',
  'pendingPdfContextAttachmentIds',
  'pendingPdfContextVersions',
  'parts',
  'specialistId',
  'enabledComputeHosts',
  'selectedComputeHosts',
  'agentConfiguration',
  'memoryEnabled',
  'delegationPolicy',
  'preserveSelection'
] as const
const ownerDependencyNames = (path: string): string[] => {
  const targets = new Set(importsFrom(path).map((reference) => reference.target))
  return ownerNames.filter((name) => targets.has(ownerTargets.get(name)!))
}
const allowedOwnerConsumers = new Set([facadeTarget, ...privateRuntimeTargets])
const workspaceRuntimeBoundaryTargets = new Set([
  facadeTarget,
  workspaceEventsTarget,
  ...privateRuntimeTargets
])
const privateOwnerBoundaryViolations = (path: string, source?: string): string[] => {
  const consumer = normalizePathSeparators(relative(rendererRoot, path))
  const isWorkspaceRuntimeModule = workspaceRuntimeBoundaryTargets.has(modulePath(path))
  return importsFrom(path, source).flatMap((reference) => {
    if (
      isWorkspaceRuntimeModule &&
      (reference.kind === 'dynamic' || reference.kind === 'require') &&
      !reference.literal
    ) {
      return [`${consumer} uses a non-literal ${reference.kind} loader`]
    }
    if (
      reference.target &&
      privateRuntimeTargets.has(reference.target) &&
      !allowedOwnerConsumers.has(modulePath(path))
    ) {
      return [`${consumer} ${reference.kind} imports a private owner`]
    }
    return []
  })
}
describe('workspace runtime architecture', () => {
  const facadeFile = sourceFileFor(facadePath)
  it('keeps the established runtime interface plus readiness and the child-update selector', () => {
    const runtimeType = typeLiteralAlias(facadeFile, 'WorkspaceAgentRuntime')
    const owner = variableArrow(facadeFile, 'useOwnedWorkspaceAgentRuntime')
    const consumer = variableArrow(facadeFile, 'useWorkspaceAgentRuntime')
    const declaredKeys = runtimeType.members.map((member) => {
      if (!member.name) throw new Error('expected named hook property')
      return member.name.getText()
    })
    expectSameNames(declaredKeys, hookKeys)
    expect(owner.type?.getText()).toBe('WorkspaceAgentRuntime')
    expect(consumer.type?.getText()).toBe('WorkspaceAgentRuntime')
    expectSameNames(propertyNames(directReturnObject(owner)), hookKeys)
  })
  it('keeps replay and recovery mechanics behind the public send intent', () => {
    const commandOwnerFile = sourceFileFor(
      `${ownerTargets.get('workspace-runtime-command-owner')}.ts`
    )
    const sendIntent = typeLiteralAlias(commandOwnerFile, 'SendWorkspaceMessageIntent')
    const declaredKeys = sendIntent.members.map((member) => {
      if (!member.name) throw new Error('expected named send intent property')
      return member.name.getText()
    })
    const runtimeType = typeLiteralAlias(facadeFile, 'WorkspaceAgentRuntime')
    const sendMessage = runtimeType.members.find(
      (member) => member.name?.getText() === 'sendMessage'
    )

    expectSameNames(declaredKeys, sendIntentKeys)
    expect(sendMessage?.getText()).toContain('SendWorkspaceMessageIntent')
  })
  it('keeps React composition in the facade and lifecycle state in its owner', () => {
    const calls = callCounts(facadeFile)
    expect(calls.get('useAcpRuntime')).toBe(1)
    expect(calls.get('useSettingsStore')).toBeGreaterThan(0)
    expect(calls.get('useState')).toBeGreaterThan(0)
    expect(calls.get('useCallback')).toBeGreaterThan(0)
    expect(calls.get('sendWorkspaceMessage')).toBe(1)
    expect(calls.get('resendEditedWorkspaceMessage')).toBe(1)
    expect(Object.fromEntries(propertyCallCounts(facadeFile, 'lifecycleOwner'))).toEqual({
      processRuntimeEvents: 1,
      recordPromptAdmission: 1,
      compact: 1,
      ensureReady: 1,
      reconfigureMemory: 1,
      resume: 1,
      cancel: 1
    })
    expect(Object.fromEntries(propertyCallCounts(facadeFile, 'runtime'))).toEqual({
      setPermissionProfile: 1,
      resumeSession: 1,
      respondToPermission: 1,
      revokePermissionGrant: 1
    })
    const effects = effectBodies(facadeFile)
    for (const responsibility of [
      'lifecycleOwner.processRuntimeEvents',
      'processWorkspaceRuntimeEvents',
      'syncWorkspaceElicitationState',
      'syncWorkspacePermissionState',
      'syncWorkspaceContextUsage',
      'markRunningSessionsDisconnectedOnDrop'
    ]) {
      expect(
        effects.some((body) => body.includes(responsibility)),
        responsibility
      ).toBe(true)
    }
    expect(readSource(facadePath)).toContain('window.api?.acp?.onAgentRuntimeUpdate')
  })
  it('keeps the owner dependency DAG explicit and acyclic', () => {
    expect(ownerDependencyNames(facadePath)).toEqual(facadeOwnerNames)
    expect(
      Object.fromEntries(
        ownerNames.map((name) => [name, ownerDependencyNames(ownerFilePath(name))])
      )
    ).toEqual({
      'workspace-runtime-event-owner': [],
      'workspace-runtime-prompt-preparation-owner': [],
      'workspace-runtime-session-branch-owner': [],
      'workspace-runtime-attachment-owner': [],
      'workspace-runtime-command-owner': [
        'workspace-runtime-prompt-preparation-owner',
        'workspace-runtime-session-branch-owner',
        'workspace-runtime-attachment-owner'
      ],
      'workspace-runtime-session-lifecycle-owner': [
        'workspace-runtime-prompt-preparation-owner',
        'workspace-runtime-command-owner',
        'workspace-runtime-session-memory-owner'
      ],
      'workspace-runtime-session-memory-owner': [],
      'workspace-runtime-selection-owner': [],
      'workspace-runtime-save-as-skill-owner': [
        'workspace-runtime-prompt-preparation-owner',
        'workspace-runtime-selection-owner'
      ]
    })
    expect(importsFrom(facadePath).map((reference) => reference.target)).toContain(
      subagentPresentationTarget
    )
  })
  it(
    'keeps private owners behind the public facade',
    () => {
      const violations = productionSources().flatMap((path) => privateOwnerBoundaryViolations(path))
      expect(violations).toEqual([])
    },
    ARCHITECTURE_SCAN_TIMEOUT_MS
  )
  it(
    'keeps the hook consumer on the named facade interface',
    () => {
      const hookConsumers: string[] = []
      const unsupportedFacadeImports: string[] = []
      for (const path of productionSources()) {
        for (const reference of importsFrom(path)) {
          if (reference.target !== facadeTarget) continue
          const consumer = normalizePathSeparators(relative(rendererRoot, path))
          if (reference.kind !== 'import' || !reference.names) {
            unsupportedFacadeImports.push(consumer)
          }
          if (reference.names?.includes('useWorkspaceAgentRuntime')) hookConsumers.push(consumer)
        }
      }
      expect(unsupportedFacadeImports).toEqual([])
      expect(hookConsumers).toEqual([
        'pages/workspace/WorkspacePage.tsx',
        'pages/workspace/workspace-message-queue-controller.ts'
      ])
    },
    ARCHITECTURE_SCAN_TIMEOUT_MS
  )
  it('keeps the delegated runtime transport subscription in the App-level owner', () => {
    expect(
      productionSources()
        .filter((path) => readSource(path).includes('window.api?.acp?.onAgentRuntimeUpdate'))
        .map((path) => normalizePathSeparators(relative(rendererRoot, path)))
    ).toEqual(['lib/acp/useWorkspaceAgentRuntime.ts'])
    expect(readSource(`${subagentPresentationTarget}.ts`)).not.toContain('window.api')
    expect(readSource(`${subagentPresentationTarget}.ts`)).toContain('createSessionStore()')
    expect(readSource(`${subagentPresentationTarget}.ts`)).toContain(
      'never writes to the authoritative Session store'
    )
  })
  it('rejects aliased and non-literal loader bypass attempts', () => {
    const syntheticPath = resolve(__dirname, 'synthetic-consumer.ts')
    const violations = privateOwnerBoundaryViolations(
      syntheticPath,
      [
        'let load',
        "const loadOwner = () => load('./workspace-runtime-command-owner')",
        'load = baseLoad',
        'const baseLoad = require',
        "const ownerPath = './workspace-runtime-session-lifecycle-owner'",
        'void import(ownerPath)',
        'require(ownerPath)',
        'if (enabled) { var nestedLoad = require }',
        "nestedLoad('./workspace-runtime-command-owner')",
        "{ const blockLoad = require; blockLoad('./workspace-runtime-command-owner') }",
        "{ let blockLet; blockLet = require; blockLet('./workspace-runtime-command-owner') }",
        "const checkLocal = () => { const localLoad = require; localLoad('./workspace-runtime-command-owner') }",
        "const lazy = (path: string) => import(path); lazy('./workspace-runtime-event-owner')",
        "const wrapped = (path: string) => require(path); const wrappedAlias = wrapped; wrappedAlias('./workspace-runtime-command-owner')",
        "function declaredLazy(path: string) { return import(path) }; declaredLazy('./workspace-runtime-event-owner')",
        "function declaredWrapped(path: string) { return require(path) }; declaredWrapped('./workspace-runtime-command-owner')",
        "const defaultLoad = (loader = require) => loader('./workspace-runtime-command-owner'); defaultLoad()",
        "const defaultPath = (path = './workspace-runtime-event-owner') => import(path); defaultPath()",
        "const defaultAlias = (base = require, loader = base) => loader('./workspace-runtime-command-owner'); defaultAlias()",
        'const defaultConstantPath = (path = ownerPath) => import(path); defaultConstantPath()'
      ].join('\n')
    )
    expect(violations).toEqual([
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts dynamic imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts dynamic imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts dynamic imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts dynamic imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner',
      'lib/acp/synthetic-consumer.ts dynamic imports a private owner'
    ])
    expect(privateOwnerBoundaryViolations(syntheticPath, 'void import(runtimePath)')).toEqual([])
    expect(
      privateOwnerBoundaryViolations(
        syntheticPath,
        [
          "const ownerPath = './workspace-runtime-command-owner'",
          'const lazy = (ownerPath: string) => import(ownerPath)',
          'const load = require',
          "const invoke = (load: (path: string) => void) => load('./workspace-runtime-command-owner')",
          "const localPath = './workspace-runtime-command-owner'",
          '{ let localPath; void import(localPath) }',
          'const localLoad = require',
          "{ const localLoad = customLoader; localLoad('./workspace-runtime-command-owner') }",
          'const checkShadows = () => {',
          '  var shadowedLoad = customLoader',
          '  { const shadowedLoad = require }',
          '  { let shadowedLoad; shadowedLoad = require }',
          "  shadowedLoad('./workspace-runtime-command-owner')",
          '  var shadowedPath = getRuntimePath()',
          "  { const shadowedPath = './workspace-runtime-command-owner' }",
          '  void import(shadowedPath)',
          '}',
          "const shadowedLazy = (path: string) => { { const path = './external-module'; void import(path) } }",
          "shadowedLazy('./workspace-runtime-command-owner')",
          'const shadowedRequire = (path: string) => { const require = customLoader; return require(path) }',
          "shadowedRequire('./workspace-runtime-command-owner')",
          "const defaultTdz = (loader = require, require = customLoader) => loader('./workspace-runtime-command-owner'); defaultTdz()"
        ].join('\n')
      )
    ).toEqual([])
    expect(
      privateOwnerBoundaryViolations(
        syntheticPath,
        [
          "const ownerPath = './workspace-runtime-command-owner'",
          'const load = require',
          'const check = () => {',
          '  for (const ownerPath of []) {}',
          '  for (const load of []) {}',
          '  try { throw 0 } catch (ownerPath) {}',
          '  try { throw 0 } catch (load) {}',
          '  void import(ownerPath)',
          "  load('./workspace-runtime-command-owner')",
          '}'
        ].join('\n')
      )
    ).toEqual([
      'lib/acp/synthetic-consumer.ts dynamic imports a private owner',
      'lib/acp/synthetic-consumer.ts require imports a private owner'
    ])
    expect(privateOwnerBoundaryViolations(facadePath, 'void import(runtimePath)')).toEqual([
      'lib/acp/useWorkspaceAgentRuntime.ts uses a non-literal dynamic loader'
    ])
    expect(
      privateOwnerBoundaryViolations(
        facadePath,
        'const check = () => { const load = require; load(runtimePath) }'
      )
    ).toEqual(['lib/acp/useWorkspaceAgentRuntime.ts uses a non-literal require loader'])
    expect(
      privateOwnerBoundaryViolations(
        resolve(__dirname, 'workspace-events.ts'),
        'void import(runtimePath)'
      )
    ).toEqual(['lib/acp/workspace-events.ts uses a non-literal dynamic loader'])
  })
  it('prevents owners from reverse-importing the facade', () => {
    const violations = ownerNames.flatMap((name) => {
      const path = ownerFilePath(name)
      return importsFrom(path)
        .filter((reference) => reference.target === facadeTarget)
        .map(
          (reference) =>
            `${normalizePathSeparators(relative(rendererRoot, path))} ${reference.kind} imports the facade`
        )
    })
    expect(violations).toEqual([])
  })
  it('keeps the lifecycle owner interface at seven operations', () => {
    const lifecyclePath = `${ownerTargets.get('workspace-runtime-session-lifecycle-owner')}.ts`
    const lifecycle = variableArrow(
      sourceFileFor(lifecyclePath),
      'createWorkspaceRuntimeSessionLifecycleOwner'
    )
    expectSameNames(propertyNames(directReturnObject(lifecycle)), [
      'recordPromptAdmission',
      'processRuntimeEvents',
      'compact',
      'ensureReady',
      'reconfigureMemory',
      'resume',
      'cancel'
    ])
  })
  it('keeps the module-impact owner and test closure complete', () => {
    const manifest = JSON.parse(readSource(manifestPath)) as {
      modules: {
        workspace_runtime: {
          ownerPaths: string[]
          interfacePaths: string[]
          consumerModules: string[]
          testFiles: { owner: string[] }
          capabilityOverlays: string[]
          fallbackCapability: string
        }
      }
    }
    const workspaceRuntime = manifest.modules.workspace_runtime
    expect(workspaceRuntime.ownerPaths).toEqual([
      'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.ts',
      'src/renderer/src/lib/acp/workspace-events.ts',
      ...ownerNames.map((name) => `src/renderer/src/lib/acp/${name}.ts`),
      'src/renderer/src/lib/acp/workspace-subagent-runtime-presentation.ts'
    ])
    expect(workspaceRuntime.interfacePaths).toEqual([
      'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.ts'
    ])
    expect(workspaceRuntime.consumerModules).toEqual(['workspace_page'])
    expect(workspaceRuntime.testFiles.owner).toContain(architectureTestPath)
    expect(workspaceRuntime.capabilityOverlays).toEqual(['renderer_state'])
    expect(workspaceRuntime.fallbackCapability).toBe('renderer_view')
  })
})
