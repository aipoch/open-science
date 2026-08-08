import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isArrayBindingPattern,
  isBindingElement,
  isBlock,
  isCallExpression,
  isCatchClause,
  isArrowFunction,
  isElementAccessExpression,
  isExportAssignment,
  isExportDeclaration,
  isFunctionLike,
  isIdentifier,
  isImportDeclaration,
  isIntersectionTypeNode,
  isNamedExports,
  isNamedImports,
  isObjectLiteralExpression,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertySignature,
  isSpreadAssignment,
  isStringLiteralLike,
  isSourceFile,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isVariableDeclaration,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  NodeFlags,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(__dirname, '..')
const facadePath = resolve(__dirname, 'session-store.ts')
const moduleImpactPath = resolve(__dirname, '../../../../scripts/ci/module-impact.json')
const readSource = (path: string): string => readFileSync(path, 'utf8')
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

const productionSources = (): readonly string[] => {
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
  return paths.sort()
}

const resolveImportTarget = (sourcePath: string, specifier: string): string | undefined => {
  if (specifier.startsWith('@/')) return modulePath(resolve(rendererRoot, specifier.slice(2)))
  if (specifier.startsWith('@renderer/')) {
    return modulePath(resolve(rendererRoot, specifier.slice('@renderer/'.length)))
  }
  if (specifier.startsWith('.')) {
    return modulePath(
      resolve(dirname(normalizePathSeparators(sourcePath)), normalizePathSeparators(specifier))
    )
  }
  return undefined
}

const ownerNames = [
  'session-store-message-graph-helpers',
  'session-store-message-graph-owner',
  'session-store-persistence-owner',
  'session-store-run-activity-helpers',
  'session-store-run-output-helpers',
  'session-store-run-projection-owner',
  'session-store-run-terminal-helpers'
] as const
const privateOwnerTargets = new Set(ownerNames.map((name) => modulePath(resolve(__dirname, name))))
const sessionModuleTargets = new Set([modulePath(facadePath), ...privateOwnerTargets])
const publicStoreTarget = modulePath(facadePath)
const publicValueExports = [
  'createInitialSessionState',
  'isExternallyHydratedSession',
  'toPersistedSession',
  'useSessionStore'
].sort()
const publicTypeExports = [
  'ActiveRun',
  'BranchInNewSessionInput',
  'ChatMessage',
  'ChatMessageRole',
  'ChatMessageStatus',
  'ChatSession',
  'SessionHydrationSelection',
  'SessionStatus',
  'ToolActivity',
  'ToolActivityStatus'
].sort()
const publicBindings = new Set([...publicValueExports, ...publicTypeExports])

type ImportReference = Readonly<{
  target: string | undefined
  names: readonly string[] | undefined
  aliased: boolean
  literal: boolean
  kind: 'import' | 'export' | 'dynamic' | 'require'
}>

const importsFrom = (path: string, source = readSource(path)): readonly ImportReference[] => {
  const references: ImportReference[] = []
  const sourceFile = sourceFileFor(path, source)
  const bindingContains = (name: Node, identifier: string): boolean => {
    if (isIdentifier(name)) return name.text === identifier
    if (isObjectBindingPattern(name) || isArrayBindingPattern(name)) {
      return name.elements.some(
        (element) => isBindingElement(element) && bindingContains(element.name, identifier)
      )
    }
    return false
  }
  const resolveLiteralBinding = (identifier: Node & { text: string }): string | undefined => {
    let current: Node | undefined = identifier.parent
    while (current) {
      if (
        isFunctionLike(current) &&
        current.parameters.some((parameter) => bindingContains(parameter.name, identifier.text))
      ) {
        return undefined
      }
      if (
        isCatchClause(current) &&
        current.variableDeclaration &&
        bindingContains(current.variableDeclaration.name, identifier.text)
      ) {
        return undefined
      }
      if (isBlock(current) || isSourceFile(current)) {
        let declaration: Node | undefined
        const find = (node: Node): void => {
          if (node !== current && (isBlock(node) || isSourceFile(node))) return
          if (
            isVariableDeclaration(node) &&
            bindingContains(node.name, identifier.text) &&
            node.getStart(sourceFile) < identifier.getStart(sourceFile) &&
            (!declaration || node.getStart(sourceFile) > declaration.getStart(sourceFile))
          ) {
            declaration = node
          }
          forEachChild(node, find)
        }
        find(current)
        if (declaration && isVariableDeclaration(declaration)) {
          const declarationList = declaration.parent
          return (declarationList.flags & NodeFlags.Const) !== 0 &&
            declaration.initializer &&
            isStringLiteralLike(declaration.initializer)
            ? declaration.initializer.text
            : undefined
        }
      }
      current = current.parent
    }
    return undefined
  }

  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings
      const elements = bindings && isNamedImports(bindings) ? bindings.elements : undefined
      references.push({
        target: resolveImportTarget(path, node.moduleSpecifier.text),
        names: elements?.map((element) => (element.propertyName ?? element.name).text),
        aliased: elements?.some((element) => element.propertyName !== undefined) ?? false,
        literal: true,
        kind: 'import'
      })
    } else if (
      isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      const elements =
        node.exportClause && isNamedExports(node.exportClause)
          ? node.exportClause.elements
          : undefined
      references.push({
        target: resolveImportTarget(path, node.moduleSpecifier.text),
        names: elements?.map((element) => (element.propertyName ?? element.name).text),
        aliased: elements?.some((element) => element.propertyName !== undefined) ?? false,
        literal: true,
        kind: 'export'
      })
    } else if (isCallExpression(node)) {
      const [argument] = node.arguments
      const kind =
        isIdentifier(node.expression) && node.expression.text === 'require'
          ? 'require'
          : node.expression.kind === SyntaxKind.ImportKeyword
            ? 'dynamic'
            : undefined
      if (kind) {
        const specifier =
          argument && isStringLiteralLike(argument)
            ? argument.text
            : argument && isIdentifier(argument)
              ? resolveLiteralBinding(argument)
              : undefined
        references.push({
          target: specifier ? resolveImportTarget(path, specifier) : undefined,
          names: undefined,
          aliased: false,
          literal: specifier !== undefined,
          kind
        })
      }
    } else if (
      isIdentifier(node) &&
      node.text === 'require' &&
      !(isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      references.push({
        target: undefined,
        names: undefined,
        aliased: false,
        literal: false,
        kind: 'require'
      })
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

const importBoundaryViolations = (path: string, source = readSource(path)): readonly string[] => {
  const sourceTarget = modulePath(path)
  const violations: string[] = []
  for (const reference of importsFrom(path, source)) {
    if (
      (reference.kind === 'dynamic' || reference.kind === 'require') &&
      !reference.literal &&
      sessionModuleTargets.has(sourceTarget)
    ) {
      violations.push(`${relative(rendererRoot, path)} uses unresolved ${reference.kind}`)
      continue
    }
    if (
      reference.target &&
      privateOwnerTargets.has(reference.target) &&
      !sessionModuleTargets.has(sourceTarget)
    ) {
      violations.push(`${relative(rendererRoot, path)} imports a private Session Store owner`)
    }
    if (
      sourceTarget !== publicStoreTarget &&
      reference.target === publicStoreTarget &&
      (reference.kind !== 'import' ||
        !reference.names ||
        reference.names.some((name) => !publicBindings.has(name)))
    ) {
      violations.push(`${relative(rendererRoot, path)} bypasses the public Session Store surface`)
    }
  }
  return violations
}

const callCounts = (sourceFile: SourceFile): Map<string, number> => {
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

const compositionViolations = (source: string): readonly string[] => {
  const sourceFile = sourceFileFor(facadePath, source)
  const creators = new Map<string, string>([
    [
      'createInitialSessionState',
      modulePath(resolve(__dirname, 'session-store-persistence-owner'))
    ],
    [
      'createSessionMessageGraphOwner',
      modulePath(resolve(__dirname, 'session-store-message-graph-owner'))
    ],
    [
      'createSessionPersistenceOwner',
      modulePath(resolve(__dirname, 'session-store-persistence-owner'))
    ],
    [
      'createSessionRunProjectionOwner',
      modulePath(resolve(__dirname, 'session-store-run-projection-owner'))
    ]
  ])
  const importCounts = new Map<string, number>()
  const violations: string[] = []

  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement) || !isStringLiteralLike(statement.moduleSpecifier)) continue
    const target = resolveImportTarget(facadePath, statement.moduleSpecifier.text)
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const importedName = (element.propertyName ?? element.name).text
      const expectedTarget = creators.get(importedName)
      if (!expectedTarget) continue
      importCounts.set(importedName, (importCounts.get(importedName) ?? 0) + 1)
      if (target !== expectedTarget || element.propertyName || element.name.text !== importedName) {
        violations.push(`${importedName} is not a canonical owner import`)
      }
    }
  }

  const counts = callCounts(sourceFile)
  const visit = (node: Node): void => {
    if (isVariableDeclaration(node) && isIdentifier(node.name) && creators.has(node.name.text)) {
      violations.push(`${node.name.text} shadows its owner import`)
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)

  for (const creator of creators.keys()) {
    if (importCounts.get(creator) !== 1) {
      violations.push(`${creator} imported ${importCounts.get(creator) ?? 0} times`)
    }
    if (counts.get(creator) !== 1) {
      violations.push(`${creator} called ${counts.get(creator) ?? 0} times`)
    }
  }
  const createCall = (() => {
    let result: Node | undefined
    const find = (node: Node): void => {
      if (
        isCallExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === 'create'
      ) {
        result = node
      }
      forEachChild(node, find)
    }
    find(sourceFile)
    return result
  })()
  if (!createCall || !isCallExpression(createCall)) {
    violations.push('the facade does not create the public store')
    return violations
  }
  const initializer = createCall.arguments[0]
  const body = initializer && isArrowFunction(initializer) ? initializer.body : undefined
  const object =
    body && isParenthesizedExpression(body) && isObjectLiteralExpression(body.expression)
      ? body.expression
      : body && isObjectLiteralExpression(body)
        ? body
        : undefined
  const spreadCreators =
    object?.properties.filter(isSpreadAssignment).map((property) => {
      const expression = property.expression
      return isCallExpression(expression) && isIdentifier(expression.expression)
        ? expression.expression.text
        : '<non-owner>'
    }) ?? []
  const expectedSpreads = [...creators.keys()]
  if (spreadCreators.join(',') !== expectedSpreads.join(',')) {
    violations.push(`facade owner spreads are ${spreadCreators.join(',')}`)
  }
  return violations
}

const facadeExports = (source: string): Readonly<{ values: string[]; types: string[] }> => {
  const sourceFile = sourceFileFor(facadePath, source)
  const values: string[] = []
  const types: string[] = []
  for (const statement of sourceFile.statements) {
    if (isExportAssignment(statement)) {
      values.push(`default:${statement.expression.getText(sourceFile)}`)
    } else if (
      isExportDeclaration(statement) &&
      (!statement.exportClause || !isNamedExports(statement.exportClause))
    ) {
      values.push(statement.exportClause ? 'namespace-export' : 'export-all')
    } else if (
      isExportDeclaration(statement) &&
      statement.exportClause &&
      isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const destination = statement.isTypeOnly || element.isTypeOnly ? types : values
        destination.push(element.name.text)
      }
    } else if (isVariableStatement(statement)) {
      const exported =
        canHaveModifiers(statement) &&
        (getModifiers(statement)?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) ??
          false)
      if (exported)
        values.push(
          ...statement.declarationList.declarations.map((declaration) =>
            declaration.name.getText(sourceFile)
          )
        )
    } else if (
      canHaveModifiers(statement) &&
      getModifiers(statement)?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword)
    ) {
      values.push(`declaration:${SyntaxKind[statement.kind]}`)
    }
  }
  return { values: values.sort(), types: types.sort() }
}

const facadeActionNames = (source: string): string[] => {
  const sourceFile = sourceFileFor(facadePath, source)
  const declaration = sourceFile.statements.find(
    (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'SessionStore'
  )
  if (
    !declaration ||
    !isTypeAliasDeclaration(declaration) ||
    !isIntersectionTypeNode(declaration.type)
  ) {
    throw new Error('SessionStore intersection type not found')
  }
  const actionType = declaration.type.types.find(isTypeLiteralNode)
  if (!actionType) throw new Error('SessionStore action type not found')
  return actionType.members
    .filter(isPropertySignature)
    .map((member) => member.name.getText(sourceFile))
    .sort()
}

const ownerTypeProperties = (file: string, typeName: string): string[] => {
  const path = resolve(__dirname, file)
  const sourceFile = sourceFileFor(path)
  const declaration = sourceFile.statements.find(
    (statement) => isTypeAliasDeclaration(statement) && statement.name.text === typeName
  )
  if (
    !declaration ||
    !isTypeAliasDeclaration(declaration) ||
    !isTypeLiteralNode(declaration.type)
  ) {
    throw new Error(`${typeName} type literal not found`)
  }
  return declaration.type.members
    .filter(isPropertySignature)
    .map((member) => member.name.getText(sourceFile))
    .sort()
}

const facadeIntersectionNames = (source: string): string[] => {
  const sourceFile = sourceFileFor(facadePath, source)
  const declaration = sourceFile.statements.find(
    (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'SessionStore'
  )
  if (
    !declaration ||
    !isTypeAliasDeclaration(declaration) ||
    !isIntersectionTypeNode(declaration.type)
  ) {
    throw new Error('SessionStore intersection type not found')
  }
  return declaration.type.types
    .filter((type) => !isTypeLiteralNode(type))
    .map((type) => type.getText(sourceFile))
}

const zustandImportViolations = (path: string, source = readSource(path)): readonly string[] => {
  const sourceFile = sourceFileFor(path, source)
  const relativePath = relative(rendererRoot, path)
  const valueImports = sourceFile.statements.filter((statement) => {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteralLike(statement.moduleSpecifier) ||
      (statement.moduleSpecifier.text !== 'zustand' &&
        !statement.moduleSpecifier.text.startsWith('zustand/')) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    ) {
      return false
    }
    const bindings = statement.importClause.namedBindings
    return (
      !bindings ||
      !isNamedImports(bindings) ||
      bindings.elements.some((element) => !element.isTypeOnly)
    )
  })

  if (path !== facadePath) {
    return valueImports.length > 0 ? [`${relativePath} imports a Zustand value`] : []
  }

  const [canonicalImport] = valueImports
  const bindings =
    canonicalImport && isImportDeclaration(canonicalImport)
      ? canonicalImport.importClause?.namedBindings
      : undefined
  const elements = bindings && isNamedImports(bindings) ? bindings.elements : []
  const canonical =
    valueImports.length === 1 &&
    canonicalImport &&
    isImportDeclaration(canonicalImport) &&
    isStringLiteralLike(canonicalImport.moduleSpecifier) &&
    canonicalImport.moduleSpecifier.text === 'zustand' &&
    elements.length === 1 &&
    elements[0].name.text === 'create' &&
    !elements[0].propertyName
  return canonical ? [] : ['facade does not use the canonical Zustand create import']
}

const storeCreationViolations = (): readonly string[] => {
  const violations: string[] = []
  for (const path of productionSources().filter((candidate) =>
    sessionModuleTargets.has(modulePath(candidate))
  )) {
    const sourceFile = sourceFileFor(path)
    violations.push(...zustandImportViolations(path))
    const counts = callCounts(sourceFile)
    if (path === facadePath) {
      if (counts.get('create') !== 1)
        violations.push(`facade calls create ${counts.get('create') ?? 0} times`)
    }
  }
  return violations
}

const staticMemberPath = (node: Node): readonly string[] | undefined => {
  if (isIdentifier(node)) return [node.text]
  if (isParenthesizedExpression(node)) return staticMemberPath(node.expression)
  if (isPropertyAccessExpression(node)) {
    const parent = staticMemberPath(node.expression)
    return parent ? [...parent, node.name.text] : undefined
  }
  if (isElementAccessExpression(node) && isStringLiteralLike(node.argumentExpression)) {
    const parent = staticMemberPath(node.expression)
    return parent ? [...parent, node.argumentExpression.text] : undefined
  }
  return undefined
}

const sessionEventReferencesFrom = (path: string, source = readSource(path)): string[] => {
  const sites: string[] = []
  const visit = (node: Node): void => {
    if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
      const memberPath = staticMemberPath(node)?.join('.')
      if (
        memberPath &&
        /^(?:globalThis\.)?window\.api\.sessions\.on(?:Created|Updated|Deleted)$/.test(memberPath)
      ) {
        sites.push(`${normalizePathSeparators(relative(rendererRoot, path))}:${memberPath}`)
      }
    }
    if (
      isVariableDeclaration(node) &&
      isObjectBindingPattern(node.name) &&
      node.initializer &&
      /^(?:globalThis\.)?window\.api\.sessions$/.test(
        staticMemberPath(node.initializer)?.join('.') ?? ''
      )
    ) {
      for (const element of node.name.elements) {
        const member = (element.propertyName ?? element.name).getText()
        if (/^on(?:Created|Updated|Deleted)$/.test(member)) {
          sites.push(
            `${normalizePathSeparators(relative(rendererRoot, path))}:window.api.sessions.${member}`
          )
        }
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(path, source))
  return sites
}

const sessionEventSubscriptions = (): string[] =>
  productionSources()
    .flatMap((path) => sessionEventReferencesFrom(path))
    .sort()

describe('Session Store architecture', () => {
  const facadeSource = readSource(facadePath)

  it('keeps the compatibility facade and private modules within their completion gates', () => {
    const physicalLines = facadeSource.split(/\r?\n/).length - Number(facadeSource.endsWith('\n'))
    expect(physicalLines).toBeLessThanOrEqual(395)

    const actualModules = productionSources()
      .filter((path) =>
        modulePath(path).startsWith(modulePath(resolve(__dirname, 'session-store')))
      )
      .map((path) => normalizePathSeparators(relative(__dirname, path)))
      .sort()
    expect(actualModules).toEqual(
      ['session-store.ts', ...ownerNames.map((name) => `${name}.ts`)].sort()
    )
    for (const file of actualModules) {
      const source = readSource(resolve(__dirname, file))
      const lines = source.split(/\r?\n/).length - Number(source.endsWith('\n'))
      expect(lines, file).toBeLessThanOrEqual(660)
    }
  })

  it('locks the established public values, types and actions', () => {
    expect(facadeExports(facadeSource)).toEqual({
      values: publicValueExports,
      types: publicTypeExports
    })
    expect(facadeIntersectionNames(facadeSource)).toEqual([
      'SessionStoreData',
      'SessionPersistenceActions',
      'SessionMessageGraphActions',
      'SessionRunProjectionActions'
    ])
    expect(facadeActionNames(facadeSource)).toEqual([
      'clearBranchContextReset',
      'clearPermissionPending',
      'clearSelection',
      'clearSpecialistSwitchResetRequired',
      'deleteSession',
      'markDisconnected',
      'markResumed',
      'markSpecialistSwitchResetRequired',
      'removeSessionsForProject',
      'renameSession',
      'selectSession',
      'setAutoReviewEnabled',
      'setBranchSwitchBlocked',
      'setContextUsage',
      'setEnabledComputeHosts',
      'setFixLoopActive',
      'setPermissionPending',
      'setPermissionProfile',
      'setSessionSpecialistId',
      'togglePinned',
      'updateSessionArchive'
    ])
    expect(ownerTypeProperties('session-store-persistence-owner.ts', 'SessionStoreData')).toEqual([
      'selectedSessionId',
      'sessions'
    ])
    expect(
      ownerTypeProperties('session-store-persistence-owner.ts', 'SessionPersistenceActions')
    ).toEqual(['applyDurableSessionProjection', 'hydrateSessions', 'upsertPersistedSession'])
    expect(
      ownerTypeProperties('session-store-message-graph-helpers.ts', 'SessionMessageGraphActions')
    ).toEqual([
      'activateMessageBranch',
      'appendPendingUserMessage',
      'appendRoutedUserMessage',
      'appendUserMessage',
      'bindPendingSession',
      'branchInNewSession',
      'clearPendingContextReplay',
      'removeMessage',
      'truncateSessionFromMessage'
    ])
    expect(
      ownerTypeProperties('session-store-run-projection-owner.ts', 'SessionRunProjectionActions')
    ).toEqual([
      'appendAgentMessageChunk',
      'attachRunArtifacts',
      'beginActivityGroup',
      'beginCompaction',
      'clearArtifactError',
      'completeActivityGroup',
      'failCompaction',
      'failRun',
      'finishCompaction',
      'finishRun',
      'recordArtifactError',
      'replaceMessageArtifacts',
      'replaceMessageUploads',
      'setActivePlanProjection',
      'setAgentPromptInFlight',
      'setAgentStatus',
      'setAwaitingFirstAgentOutput',
      'upsertToolActivity'
    ])
  })

  it('composes each state owner exactly once without a shadow store', () => {
    expect(compositionViolations(facadeSource)).toEqual([])
    expect(storeCreationViolations()).toEqual([])
  })

  it('keeps private owners internal and consumers on the public store surface', () => {
    expect(productionSources().flatMap((path) => importBoundaryViolations(path))).toEqual([])
  })

  it('keeps Session lifecycle event synchronization in the canonical adapter', () => {
    expect(sessionEventSubscriptions()).toEqual([
      'hooks/useLifecycleSync.ts:window.api.sessions.onCreated',
      'hooks/useLifecycleSync.ts:window.api.sessions.onDeleted',
      'hooks/useLifecycleSync.ts:window.api.sessions.onUpdated'
    ])
  })

  it('keeps the architecture suite in the Session renderer impact set', () => {
    const manifest = JSON.parse(readSource(moduleImpactPath)) as {
      modules: Record<
        string,
        { ownerPaths: string[]; interfacePaths: string[]; testFiles: { owner: string[] } }
      >
    }
    expect(manifest.modules.session_renderer).toMatchObject({
      ownerPaths: [
        'src/renderer/src/stores/session-store.ts',
        'src/renderer/src/stores/session-store-persistence-owner.ts',
        'src/renderer/src/stores/session-store-message-graph-owner.ts',
        'src/renderer/src/stores/session-store-message-graph-helpers.ts',
        'src/renderer/src/stores/session-store-run-projection-owner.ts',
        'src/renderer/src/stores/session-store-run-output-helpers.ts',
        'src/renderer/src/stores/session-store-run-activity-helpers.ts',
        'src/renderer/src/stores/session-store-run-terminal-helpers.ts'
      ],
      interfacePaths: ['src/renderer/src/stores/session-store.ts'],
      consumerModules: ['workspace_runtime', 'project_files_view', 'workspace_page'],
      testFiles: {
        owner: [
          'src/renderer/src/stores/session-store.test.ts',
          'src/renderer/src/stores/session-store.architecture.test.ts'
        ],
        contract: ['src/shared/session-persistence.test.ts'],
        consumer: ['src/renderer/src/lib/acp/useWorkspaceAgentRuntime.test.ts']
      },
      capabilityOverlays: ['renderer_state'],
      fallbackCapability: 'renderer_view'
    })
  })
})

describe('Session Store architecture guard regressions', () => {
  const consumerFixture = resolve(rendererRoot, 'pages/workspace/session-store-fixture.ts')
  const windowsStyleFixture = consumerFixture.replace(/\//g, '\\')

  it('rejects a private owner import from a Windows-style consumer path', () => {
    const source =
      "import { createSessionRunProjectionOwner } from '../../stores/session-store-run-projection-owner'"
    expect(importBoundaryViolations(windowsStyleFixture, source)).not.toEqual([])
  })

  it('allows aliases of supported public bindings and rejects unsupported bindings', () => {
    expect(
      importBoundaryViolations(
        consumerFixture,
        "import { useSessionStore as store } from '../../stores/session-store'"
      )
    ).toEqual([])
    expect(
      importBoundaryViolations(
        consumerFixture,
        "import { internalState } from '../../stores/session-store'"
      )
    ).not.toEqual([])
  })

  it('rejects dynamic owner access without banning unrelated lazy imports', () => {
    expect(
      importBoundaryViolations(
        consumerFixture,
        "void import('../../stores/session-store-message-graph-owner')"
      )
    ).not.toEqual([])
    expect(
      importBoundaryViolations(
        consumerFixture,
        "const path = '../../stores/session-store-run-output-helpers'; void import(path)"
      )
    ).not.toEqual([])
    expect(
      importBoundaryViolations(consumerFixture, "const path = './feature'; void import(path)")
    ).toEqual([])
    expect(
      importBoundaryViolations(
        consumerFixture,
        [
          "{ const path = '../../stores/session-store-run-output-helpers'; void import(path) }",
          "{ const path = './feature'; void import(path) }"
        ].join('\n')
      )
    ).toEqual(['pages/workspace/session-store-fixture.ts imports a private Session Store owner'])
    expect(
      importBoundaryViolations(
        consumerFixture,
        [
          "const path = '../../stores/session-store-run-output-helpers'",
          'const load = (path: string) => import(path)',
          "void load('./feature')"
        ].join('\n')
      )
    ).toEqual([])
  })

  it('detects aliased and bracketed lifecycle event references', () => {
    expect(
      sessionEventReferencesFrom(
        consumerFixture,
        "const subscribe = window.api.sessions['onCreated']; void subscribe"
      )
    ).toEqual(['pages/workspace/session-store-fixture.ts:window.api.sessions.onCreated'])
    expect(
      sessionEventReferencesFrom(
        consumerFixture,
        'const { onDeleted: subscribe } = window.api.sessions; void subscribe'
      )
    ).toEqual(['pages/workspace/session-store-fixture.ts:window.api.sessions.onDeleted'])
  })

  it('rejects facade star exports and non-canonical Zustand imports', () => {
    expect(
      facadeExports(
        `${readSource(facadePath)}\nexport * from './session-store-run-projection-owner'`
      ).values
    ).toContain('export-all')
    expect(
      zustandImportViolations(
        facadePath,
        readSource(facadePath).replace(
          "import { create } from 'zustand'",
          "import { create as makeStore } from 'zustand'"
        )
      )
    ).toContain('facade does not use the canonical Zustand create import')
  })

  it('rejects duplicate and shadow owner composition', () => {
    expect(
      compositionViolations(
        `${readSource(facadePath)}\ncreateSessionPersistenceOwner(() => undefined)`
      )
    ).toContain('createSessionPersistenceOwner called 2 times')
    expect(
      compositionViolations(
        `${readSource(facadePath)}\nconst createSessionPersistenceOwner = () => undefined`
      )
    ).toContain('createSessionPersistenceOwner shadows its owner import')
  })
})
