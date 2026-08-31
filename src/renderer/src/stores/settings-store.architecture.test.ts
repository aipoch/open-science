import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionTypeNode,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamedExports,
  isObjectLiteralExpression,
  isParameter,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertySignature,
  isSpreadAssignment,
  isStringLiteralLike,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isVariableDeclaration,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(__dirname, '..')
const storePath = resolve(__dirname, 'settings-store.ts')
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

const coordinatorTarget = modulePath(resolve(__dirname, 'settings-write-coordinator'))
const runtimeSliceTarget = modulePath(resolve(__dirname, 'settings-runtime-slice'))
const sliceTargets = new Set(
  [
    'settings-runtime-slice',
    'settings-provider-auth-slice',
    'settings-preferences-slice',
    'settings-navigation-slice',
    'settings-skills-slice',
    'settings-connectors-slice'
  ].map((name) => modulePath(resolve(__dirname, name)))
)
const coordinatorConsumers = new Set(
  ['settings-provider-auth-slice', 'settings-preferences-slice'].map((name) =>
    modulePath(resolve(__dirname, name))
  )
)
const publicStoreTarget = modulePath(storePath)
const publicImports = new Set([
  'useSettingsStore',
  'createInitialSettingsState',
  'selectAnyInstalling',
  'selectFrameworkApiEndpoints',
  'selectProviderModelOptions',
  'selectVisionRelayAvailable',
  'ProviderModelOption',
  'SaveProviderResult'
])

type ImportReference = Readonly<{
  target: string | undefined
  names: readonly string[] | undefined
  aliased: boolean
  literal: boolean
  kind: 'import' | 'export' | 'dynamic' | 'require'
}>

const importsFrom = (path: string, source = readSource(path)): readonly ImportReference[] => {
  const imports: ImportReference[] = []
  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const elements =
        clause && !clause.name && bindings && isNamedImports(bindings)
          ? bindings.elements
          : undefined
      imports.push({
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
      imports.push({
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
        imports.push({
          target:
            argument && isStringLiteralLike(argument)
              ? resolveImportTarget(path, argument.text)
              : undefined,
          names: undefined,
          aliased: false,
          literal: argument !== undefined && isStringLiteralLike(argument),
          kind
        })
      }
    } else if (
      isIdentifier(node) &&
      node.text === 'require' &&
      !(isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      imports.push({
        target: undefined,
        names: undefined,
        aliased: false,
        literal: false,
        kind: 'require'
      })
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(path, source))
  return imports
}

const callCounts = (path: string, source = readSource(path)): Map<string, number> => {
  const counts = new Map<string, number>()
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isIdentifier(node.expression)) {
      counts.set(node.expression.text, (counts.get(node.expression.text) ?? 0) + 1)
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(path, source))
  return counts
}

const ownerModule = (name: string): string => modulePath(resolve(__dirname, name))
const creatorTargets = new Map<string, string>([
  ['createInitialRuntimeSetupState', ownerModule('settings-runtime-slice')],
  ['createRuntimeSetupSlice', ownerModule('settings-runtime-slice')],
  ['createProviderAuthSlice', ownerModule('settings-provider-auth-slice')],
  ['createSettingsPreferencesSlice', ownerModule('settings-preferences-slice')],
  ['createInitialSettingsNavigationState', ownerModule('settings-navigation-slice')],
  ['createSettingsNavigationSlice', ownerModule('settings-navigation-slice')],
  ['createInitialSettingsSkillsState', ownerModule('settings-skills-slice')],
  ['createSettingsSkillsSlice', ownerModule('settings-skills-slice')],
  ['createInitialSettingsConnectorsState', ownerModule('settings-connectors-slice')],
  ['createSettingsConnectorsSlice', ownerModule('settings-connectors-slice')],
  ['createSettingsWriteCoordinator', coordinatorTarget]
])

const compositionViolations = (source: string): readonly string[] => {
  const sourceFile = sourceFileFor(storePath, source)
  const counts = callCounts(storePath, source)
  const importCounts = new Map<string, number>()
  const violations: string[] = []

  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement) || !isStringLiteralLike(statement.moduleSpecifier)) continue
    const target = resolveImportTarget(storePath, statement.moduleSpecifier.text)
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const importedName = (element.propertyName ?? element.name).text
      const expectedTarget = creatorTargets.get(importedName)
      if (!expectedTarget) continue
      importCounts.set(importedName, (importCounts.get(importedName) ?? 0) + 1)
      if (target !== expectedTarget || element.propertyName || element.name.text !== importedName) {
        violations.push(`${importedName} is not a canonical owner import`)
      }
    }
  }

  const visit = (node: Node): void => {
    const declaredName =
      isVariableDeclaration(node) || isParameter(node)
        ? node.name.getText(sourceFile)
        : isFunctionDeclaration(node) && node.name
          ? node.name.text
          : undefined
    for (const creator of creatorTargets.keys()) {
      if (declaredName?.includes(creator)) {
        violations.push(`${creator} shadows its owner import`)
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)

  for (const creator of creatorTargets.keys()) {
    if (importCounts.get(creator) !== 1) {
      violations.push(`${creator} imported ${importCounts.get(creator) ?? 0} times`)
    }
    if (counts.get(creator) !== 1) {
      violations.push(`${creator} called ${counts.get(creator) ?? 0} times`)
    }
  }
  return violations
}

const importBoundaryViolations = (path: string, source = readSource(path)): readonly string[] => {
  const violations: string[] = []
  for (const reference of importsFrom(path, source)) {
    if ((reference.kind === 'dynamic' || reference.kind === 'require') && !reference.literal) {
      violations.push(`${relative(rendererRoot, path)} uses unresolved ${reference.kind}`)
    }
    if (path === storePath) {
      const allowedOwnerExport =
        reference.kind === 'export' &&
        reference.target === runtimeSliceTarget &&
        reference.names?.join(',') === 'selectAnyInstalling' &&
        !reference.aliased
      if (
        (reference.target === coordinatorTarget ||
          (reference.target && sliceTargets.has(reference.target))) &&
        !allowedOwnerExport &&
        (reference.kind !== 'import' || !reference.names || reference.aliased)
      ) {
        violations.push('the facade uses a non-canonical owner import')
      }
      continue
    }
    if (reference.target && sliceTargets.has(reference.target)) {
      violations.push(`${relative(rendererRoot, path)} imports a Settings slice`)
    }
    if (
      reference.target === coordinatorTarget &&
      (!coordinatorConsumers.has(modulePath(path)) ||
        reference.kind !== 'import' ||
        !reference.names ||
        reference.aliased)
    ) {
      violations.push(`${relative(rendererRoot, path)} imports the Settings write coordinator`)
    }
    if (
      reference.target === publicStoreTarget &&
      (reference.kind !== 'import' ||
        !reference.names ||
        reference.aliased ||
        reference.names.some((name) => !publicImports.has(name)))
    ) {
      violations.push(`${relative(rendererRoot, path)} imports unsupported public bindings`)
    }
  }
  return violations
}

// Exact declaration counts for every facade binding. `load` publishes the Settings snapshot before
// capability probes finish, so its probe-result locals stay inventoried here instead of being
// treated as new facade state.
const allowedFacadeVariableCounts = new Map<string, number>([
  ['createInitialSettingsState', 1],
  ['applySnapshot', 1],
  ['canApplySnapshot', 1],
  ['mergeSnapshot', 1],
  ['DEFAULT_FRAMEWORK_API_ENDPOINTS', 1],
  ['selectFrameworkApiEndpoints', 1],
  ['selectVisionRelayAvailable', 1],
  ['configuration', 1],
  ['selectedKey', 1],
  ['selectProviderModelOptions', 1],
  ['settingsLoadPromise', 1],
  ['SAFE_SETTINGS_LOAD_ERROR', 1],
  ['reportSettingsLoadError', 1],
  ['createSettingsStoreState', 1],
  ['generation', 1],
  ['shouldInitializeRuntime', 1],
  ['settingsPromise', 1],
  ['encryptionAvailability', 1],
  ['runtimeInitialization', 1],
  ['snapshot', 1],
  ['[[encryptionResult], runtimeResults]', 1],
  ['[preflightResult, npmAvailableResult]', 1],
  ['loadPromise', 1],
  ['error', 1],
  ['useSettingsStore', 1]
])

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

const isSettingsRoot = (node: Node): boolean => {
  const path = staticMemberPath(node)?.join('.')
  return path === 'window.api.settings' || path === 'globalThis.window.api.settings'
}

type SettingsAccessAudit = Readonly<{
  violations: readonly string[]
  reads: readonly string[]
}>

const settingsAccessAudit = (source: string): SettingsAccessAudit => {
  const sourceFile = sourceFileFor(storePath, source)
  const violations: string[] = []
  const reads: string[] = []
  const variableCounts = new Map<string, number>()
  const visit = (node: Node): void => {
    if (isVariableDeclaration(node)) {
      const name = node.name.getText(sourceFile)
      variableCounts.set(name, (variableCounts.get(name) ?? 0) + 1)
      if (!allowedFacadeVariableCounts.has(name)) violations.push(`${name} is new facade state`)
      const directPath = node.initializer
        ? staticMemberPath(node.initializer)?.join('.')
        : undefined
      const functionPath =
        node.initializer && isArrowFunction(node.initializer)
          ? staticMemberPath(node.initializer.body)?.join('.')
          : undefined
      if (
        directPath === 'window.api' ||
        directPath === 'globalThis.window.api' ||
        functionPath === 'window.api' ||
        functionPath === 'globalThis.window.api'
      ) {
        violations.push(`${name} aliases window.api`)
      }
    } else if (isFunctionDeclaration(node)) {
      violations.push(`${node.name?.text ?? '<anonymous>'} is a new facade function`)
    }
    if (isElementAccessExpression(node) && !isStringLiteralLike(node.argumentExpression)) {
      const base = staticMemberPath(node.expression)?.join('.')
      if (
        base === 'window' ||
        base === 'window.api' ||
        base === 'globalThis.window' ||
        base === 'globalThis.window.api'
      ) {
        violations.push(`dynamic access through ${base}`)
      }
    }
    if (isSettingsRoot(node)) {
      const parent = node.parent
      const member =
        isPropertyAccessExpression(parent) && parent.expression === node
          ? parent.name.text
          : isElementAccessExpression(parent) &&
              parent.expression === node &&
              isStringLiteralLike(parent.argumentExpression)
            ? parent.argumentExpression.text
            : undefined
      const isDirectRead =
        member !== undefined &&
        ['getSettings', 'getPreflight', 'isEncryptionAvailable', 'isNpmAvailable'].includes(
          member
        ) &&
        isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      const isSliceCommandProvider =
        isArrowFunction(parent) &&
        parent.body === node &&
        isPropertyAssignment(parent.parent) &&
        parent.parent.name.getText(sourceFile) === 'getCommands'
      if (isDirectRead) reads.push(member)
      else if (!isSliceCommandProvider) violations.push('Settings API escapes the slice boundary')
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  for (const [name, expectedCount] of allowedFacadeVariableCounts) {
    if (variableCounts.get(name) !== expectedCount) {
      violations.push(`${name} declared ${variableCounts.get(name) ?? 0} times`)
    }
  }
  return { violations, reads }
}

const facadeBoundaryViolations = (source: string): readonly string[] => {
  const sourceFile = sourceFileFor(storePath, source)
  const actionNames: string[] = []
  const ownActionNames: string[] = []
  const ownSpreadNames: string[] = []
  let dataContainsFunction = false
  const visit = (node: Node): void => {
    if (
      isTypeAliasDeclaration(node) &&
      node.name.text === 'SettingsStoreActions' &&
      isTypeLiteralNode(node.type)
    ) {
      actionNames.push(
        ...node.type.members
          .filter(isPropertySignature)
          .map((member) => member.name.getText(sourceFile))
      )
    }
    if (isTypeAliasDeclaration(node) && node.name.text === 'SettingsStoreData') {
      const findFunctionType = (typeNode: Node): void => {
        if (isFunctionTypeNode(typeNode)) dataContainsFunction = true
        forEachChild(typeNode, findFunctionType)
      }
      findFunctionType(node.type)
    }
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === 'createSettingsStoreState' &&
      node.initializer &&
      isArrowFunction(node.initializer)
    ) {
      const body = node.initializer.body
      const object =
        isParenthesizedExpression(body) && isObjectLiteralExpression(body.expression)
          ? body.expression
          : undefined
      ownActionNames.push(
        ...(object?.properties
          .filter((property) => !isSpreadAssignment(property))
          .map((property) => property.name.getText(sourceFile)) ?? [])
      )
      ownSpreadNames.push(
        ...(object?.properties.filter(isSpreadAssignment).map((property) => {
          const expression = property.expression
          return isCallExpression(expression) && isIdentifier(expression.expression)
            ? expression.expression.text
            : '<non-owner>'
        }) ?? [])
      )
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)

  const settingsAudit = settingsAccessAudit(source)
  const violations = [
    ...compositionViolations(source),
    ...importBoundaryViolations(storePath, source),
    ...settingsAudit.violations
  ]
  if (actionNames.join(',') !== 'load,acceptCommittedSnapshot,clearSettingsWriteError') {
    violations.push(`facade actions are ${actionNames.join(',')}`)
  }
  if (ownActionNames.join(',') !== 'load,clearSettingsWriteError,acceptCommittedSnapshot') {
    violations.push(`facade implementation actions are ${ownActionNames.join(',')}`)
  }
  if (
    ownSpreadNames.join(',') !==
    [
      'createInitialSettingsState',
      'createRuntimeSetupSlice',
      'createProviderAuthSlice',
      'createSettingsPreferencesSlice',
      'createSettingsNavigationSlice',
      'createSettingsSkillsSlice',
      'createSettingsConnectorsSlice'
    ].join(',')
  ) {
    violations.push(`facade spreads are ${ownSpreadNames.join(',')}`)
  }
  if (dataContainsFunction) violations.push('SettingsStoreData contains a feature action')
  if (
    [...settingsAudit.reads].sort().join(',') !==
    'getPreflight,getSettings,isEncryptionAvailable,isNpmAvailable'
  ) {
    violations.push(`facade Settings reads are ${settingsAudit.reads.join(',')}`)
  }
  return violations
}

describe('settings store architecture', () => {
  it('composes every owner exactly once', () => {
    expect(compositionViolations(readSource(storePath))).toEqual([])
  })

  it('keeps feature actions and Settings writes out of the facade', () => {
    expect(facadeBoundaryViolations(readSource(storePath))).toEqual([])
  })

  it('keeps owner imports private and consumers on the documented public store surface', () => {
    const violations = productionSources().flatMap((path) => importBoundaryViolations(path))
    expect(violations).toEqual([])
  })
})

describe('settings store architecture guard regressions', () => {
  const consumerFixture = resolve(rendererRoot, 'pages/settings/architecture-fixture.ts')
  const windowsStyleConsumerFixture = consumerFixture.replace(/\//g, '\\')

  it.each([
    [
      '@renderer alias',
      "import { createSettingsSkillsSlice } from '@renderer/stores/settings-skills-slice'"
    ],
    ['dynamic import', "void import('@/stores/settings-connectors-slice')"],
    ['require', "require('@/stores/settings-write-coordinator')"],
    [
      'non-literal dynamic import',
      "const path = '@/stores/settings-skills-slice'; void import(path)"
    ],
    ['non-literal require', "const path = '@/stores/settings-write-coordinator'; require(path)"],
    ['aliased require', "const load = require; load('@/stores/settings-connectors-slice')"]
  ])('rejects owner access through %s', (_kind, source) => {
    expect(importBoundaryViolations(consumerFixture, source)).not.toEqual([])
  })

  it.each([
    [
      'private owner import',
      "import { createSettingsSkillsSlice } from '../../stores/settings-skills-slice'"
    ],
    ['unsupported public binding', "import { internalAction } from '../../stores/settings-store'"]
  ])('rejects %s from a Windows-style source path', (_kind, source) => {
    expect(importBoundaryViolations(windowsStyleConsumerFixture, source)).not.toEqual([])
  })

  it('rejects aliased owner bindings in the facade', () => {
    const source =
      "import { createSettingsWriteCoordinator as makeCoordinator } from './settings-write-coordinator'"

    expect(importBoundaryViolations(storePath, source)).toContain(
      'the facade uses a non-canonical owner import'
    )
  })

  it('rejects an owner star export from the facade', () => {
    const source = "export * from './settings-runtime-slice'"

    expect(importBoundaryViolations(storePath, source)).toContain(
      'the facade uses a non-canonical owner import'
    )
  })

  it('rejects a second write coordinator', () => {
    const source = `${readSource(storePath)}\ncreateSettingsWriteCoordinator(() => undefined)`

    expect(compositionViolations(source)).toContain('createSettingsWriteCoordinator called 2 times')
  })

  it('rejects a local owner shadow', () => {
    const source = `${readSource(storePath)}\n{ const createSettingsWriteCoordinator = () => undefined }`

    expect(compositionViolations(source)).toContain(
      'createSettingsWriteCoordinator shadows its owner import'
    )
  })

  it.each([
    ['direct alias', 'const settings = window.api.settings'],
    ['parenthesized function alias', 'const commands = () => (window.api.settings)'],
    ['function declaration alias', 'function commands() { return window.api.settings }'],
    ['function expression alias', 'const commands = function () { return window.api.settings }'],
    ['computed write', "window.api['settings']['saveProvider']()"]
  ])('rejects a Settings API %s', (_kind, source) => {
    expect(settingsAccessAudit(source).violations).toContain(
      'Settings API escapes the slice boundary'
    )
  })

  it.each([
    ['destructured parent alias', 'const { settings } = window.api', '{ settings }'],
    ['parent alias', 'const api = window.api; api.settings.saveProvider()', 'api']
  ])('rejects a Settings API %s', (_kind, source, name) => {
    expect(settingsAccessAudit(source).violations).toContain(`${name} aliases window.api`)
  })

  it.each([
    ['named queue', 'let settingsWriteQueue = Promise.resolve()', 'settingsWriteQueue'],
    ['opaque Map queue', 'const serial = new Map()', 'serial'],
    ['opaque Promise queue', 'const updates = Promise.resolve()', 'updates']
  ])('rejects %s', (_kind, source, name) => {
    expect(
      settingsAccessAudit(source).violations.some((violation) => violation.startsWith(name))
    ).toBe(true)
  })

  it('rejects a method-shorthand feature action', () => {
    const source = readSource(storePath).replace(
      'clearSettingsWriteError: () => writeCoordinator.clearFailures()',
      `clearSettingsWriteError() {
        writeCoordinator.clearFailures()
      },
      featureAction() {}`
    )

    expect(facadeBoundaryViolations(source)).toContain(
      'facade implementation actions are load,clearSettingsWriteError,featureAction,acceptCommittedSnapshot'
    )
  })
})
