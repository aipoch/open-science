import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteralLike,
  isTypeLiteralNode,
  isVariableDeclaration,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type ArrowFunction,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(__dirname, '../..')
const facadePath = resolve(__dirname, 'useWorkspaceAgentRuntime.ts')
const manifestPath = resolve(__dirname, '../../../../../scripts/ci/module-impact.json')
const architectureTestPath =
  'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.architecture.test.ts'
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

const ownerNames = [
  'workspace-runtime-event-owner',
  'workspace-runtime-prompt-preparation-owner',
  'workspace-runtime-command-owner',
  'workspace-runtime-session-lifecycle-owner'
] as const
const ownerTargets = new Map(ownerNames.map((name) => [name, modulePath(resolve(__dirname, name))]))
const privateOwnerTargets = new Set(ownerTargets.values())
const facadeTarget = modulePath(facadePath)

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
}>

const importsFrom = (path: string, source = readSource(path)): readonly ImportReference[] => {
  const references: ImportReference[] = []
  const visit = (node: Node): void => {
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
            : undefined
      })
    } else if (isCallExpression(node)) {
      const kind =
        isIdentifier(node.expression) && node.expression.text === 'require'
          ? 'require'
          : node.expression.kind === SyntaxKind.ImportKeyword
            ? 'dynamic'
            : undefined
      if (kind) {
        const argument = node.arguments[0]
        references.push({
          target:
            argument && isStringLiteralLike(argument)
              ? resolveImportTarget(path, argument.text)
              : undefined,
          kind,
          names: undefined
        })
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(path, source))
  return references
}

const physicalLines = (path: string): number => {
  const source = readSource(path)
  return source.split(/\r?\n/).length - Number(source.endsWith('\n'))
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
  'promptInFlightSessionIds',
  'sendPreparationInFlightSessionIds',
  'nativeContextCompactionSessionIds',
  'compactContext',
  'sendMessage',
  'resendEditedMessage',
  'cancelRun',
  'resumeInterruptedSession',
  'deleteRuntimeSession',
  'respondToPermission',
  'setPermissionProfile',
  'revokePermissionGrant'
] as const

const ownerDependencyNames = (path: string): string[] => {
  const targets = new Set(importsFrom(path).map((reference) => reference.target))
  return ownerNames.filter((name) => targets.has(ownerTargets.get(name)!))
}

describe('workspace runtime architecture', () => {
  const facadeFile = sourceFileFor(facadePath)

  it('keeps the facade and four deep owners within their completion gates', () => {
    expect(physicalLines(facadePath), 'workspace runtime facade').toBeLessThanOrEqual(600)
    for (const name of ownerNames) {
      expect(physicalLines(`${ownerTargets.get(name)}.ts`), name).toBeLessThanOrEqual(660)
    }
  })

  it('keeps the established 18-key hook interface', () => {
    const hook = variableArrow(facadeFile, 'useWorkspaceAgentRuntime')
    if (!hook.type || !isTypeLiteralNode(hook.type)) {
      throw new Error('workspace runtime hook return type not found')
    }
    const declaredKeys = hook.type.members.map((member) => {
      if (!member.name) throw new Error('expected named hook property')
      return member.name.getText()
    })
    expectSameNames(declaredKeys, hookKeys)
    expectSameNames(propertyNames(directReturnObject(hook)), hookKeys)
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
      recordPromptPlanAuthority: 1,
      compact: 1,
      resume: 1,
      cancel: 1,
      delete: 1
    })
    expect(Object.fromEntries(propertyCallCounts(facadeFile, 'runtime'))).toEqual({
      setPermissionProfile: 1,
      respondToPermission: 1,
      revokePermissionGrant: 1
    })
    const effects = effectBodies(facadeFile)
    for (const responsibility of [
      'lifecycleOwner.processRuntimeEvents',
      'processWorkspaceRuntimeEvents',
      'syncWorkspacePermissionState',
      'syncWorkspaceContextUsage',
      'markRunningSessionsDisconnectedOnDrop'
    ]) {
      expect(
        effects.some((body) => body.includes(responsibility)),
        responsibility
      ).toBe(true)
    }
    expect(readSource(facadePath)).not.toContain('window.api')
  })

  it('keeps the owner dependency DAG explicit and acyclic', () => {
    expect(ownerDependencyNames(facadePath)).toEqual(ownerNames)
    expect(
      Object.fromEntries(
        ownerNames.map((name) => [name, ownerDependencyNames(`${ownerTargets.get(name)}.ts`)])
      )
    ).toEqual({
      'workspace-runtime-event-owner': [],
      'workspace-runtime-prompt-preparation-owner': [],
      'workspace-runtime-command-owner': ['workspace-runtime-prompt-preparation-owner'],
      'workspace-runtime-session-lifecycle-owner': [
        'workspace-runtime-prompt-preparation-owner',
        'workspace-runtime-command-owner'
      ]
    })
  })

  it('keeps private owners behind the public facade', () => {
    const allowedConsumers = new Set([facadeTarget, ...privateOwnerTargets])
    const violations: string[] = []
    for (const path of productionSources()) {
      for (const reference of importsFrom(path)) {
        if (
          reference.target &&
          privateOwnerTargets.has(reference.target) &&
          !allowedConsumers.has(modulePath(path))
        ) {
          violations.push(
            `${normalizePathSeparators(relative(rendererRoot, path))} ${reference.kind} imports a private owner`
          )
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the hook consumer on the named facade interface', () => {
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
    expect(hookConsumers).toEqual(['pages/workspace/WorkspacePage.tsx'])
  })

  it('recognizes aliased, dynamic and require bypass attempts', () => {
    const syntheticPath = resolve(__dirname, 'synthetic-consumer.ts')
    const references = importsFrom(
      syntheticPath,
      [
        "import { sendWorkspaceMessage as send } from './workspace-runtime-command-owner'",
        "void import('./workspace-runtime-session-lifecycle-owner')",
        "require('./workspace-runtime-event-owner')"
      ].join('\n')
    )
    expect(references.map((reference) => reference.target)).toEqual([
      ownerTargets.get('workspace-runtime-command-owner'),
      ownerTargets.get('workspace-runtime-session-lifecycle-owner'),
      ownerTargets.get('workspace-runtime-event-owner')
    ])
    expect(references[0].names).toEqual(['sendWorkspaceMessage'])
  })

  it('prevents owners from reverse-importing the facade', () => {
    const violations = ownerNames.flatMap((name) => {
      const path = `${ownerTargets.get(name)}.ts`
      return importsFrom(path)
        .filter((reference) => reference.target === facadeTarget)
        .map(
          (reference) =>
            `${normalizePathSeparators(relative(rendererRoot, path))} ${reference.kind} imports the facade`
        )
    })
    expect(violations).toEqual([])
  })

  it('keeps the lifecycle owner interface at six operations', () => {
    const lifecyclePath = `${ownerTargets.get('workspace-runtime-session-lifecycle-owner')}.ts`
    const lifecycle = variableArrow(
      sourceFileFor(lifecyclePath),
      'createWorkspaceRuntimeSessionLifecycleOwner'
    )
    expectSameNames(propertyNames(directReturnObject(lifecycle)), [
      'recordPromptPlanAuthority',
      'processRuntimeEvents',
      'compact',
      'resume',
      'cancel',
      'delete'
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
      ...ownerNames.map((name) => `src/renderer/src/lib/acp/${name}.ts`)
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
