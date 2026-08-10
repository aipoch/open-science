import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  SyntaxKind,
  type Node
} from 'typescript'
import { describe, expect, it } from 'vitest'

import { RENDERER_CONTRACT_CATALOG } from '../../shared/renderer-contract-catalog'

const projectRoot = resolve(__dirname, '../../..')
const mainRoot = resolve(projectRoot, 'src/main')
const manifestPath = resolve(projectRoot, 'scripts/ci/module-impact.json')
const architectureTestPath = 'src/main/compute/compute-service.architecture.test.ts'
const computePaths = {
  facade: resolve(mainRoot, 'compute/compute-service.ts'),
  hostOwner: resolve(mainRoot, 'compute/compute-host-profile-owner.ts'),
  remoteOwner: resolve(mainRoot, 'compute/compute-remote-operation-owner.ts'),
  jobOwner: resolve(mainRoot, 'compute/compute-job-workflow-owner.ts'),
  jobLifecycle: resolve(mainRoot, 'compute/compute-job-lifecycle.ts'),
  jobRepository: resolve(mainRoot, 'compute/job-repository.ts'),
  concurrencyManager: resolve(mainRoot, 'compute/concurrency-manager.ts'),
  jobDispatcher: resolve(mainRoot, 'compute/job-dispatcher.ts'),
  jobPoller: resolve(mainRoot, 'compute/job-poller.ts'),
  ipc: resolve(mainRoot, 'compute/ipc.ts'),
  applicationCommands: resolve(mainRoot, 'compute/application-commands.ts'),
  jobRuntime: resolve(mainRoot, 'compute/job-runtime.ts'),
  localRpc: resolve(mainRoot, 'notebook/local-rpc-server.ts')
} as const

const readSource = (path: string): string => readFileSync(path, 'utf8')
const rawLineCount = (source: string): number => source.trimEnd().split(/\r?\n/).length
const modulePath = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, '')
const portableProjectPath = (path: string): string =>
  relative(projectRoot, path).replaceAll('\\', '/')
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(
    path,
    readSource(path),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )

const productionSources = (): string[] => {
  const sources: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        ['.ts', '.tsx'].includes(extname(path)) &&
        !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
      ) {
        sources.push(path)
      }
    }
  }
  visit(mainRoot)
  return sources.sort()
}

const importSpecifiersFrom = (sourcePath: string): string[] => {
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
  return specifiers
}

const resolveImportTarget = (sourcePath: string, specifier: string): string | undefined =>
  specifier.startsWith('.') ? modulePath(resolve(dirname(sourcePath), specifier)) : undefined

const importedNamesFrom = (sourcePath: string, target: string): string[] => {
  const names: string[] = []
  for (const statement of sourceFileFor(sourcePath).statements) {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteralLike(statement.moduleSpecifier) ||
      resolveImportTarget(sourcePath, statement.moduleSpecifier.text) !== modulePath(target)
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings && 'elements' in bindings) {
      names.push(
        ...bindings.elements.map((element) => element.propertyName?.text ?? element.name.text)
      )
    }
  }
  return names.sort()
}

const calledMembersOn = (sourcePath: string, receiver: readonly string[]): string[] => {
  const calls = new Set<string>()
  const matchesReceiver = (node: Node): boolean => {
    let current: Node = node
    for (let index = receiver.length - 1; index >= 0; index -= 1) {
      if (index === 0) {
        return receiver[index] === 'this'
          ? current.kind === SyntaxKind.ThisKeyword
          : isIdentifier(current) && current.text === receiver[index]
      }
      if (!isPropertyAccessExpression(current) || current.name.text !== receiver[index])
        return false
      current = current.expression
    }
    return false
  }
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      matchesReceiver(node.expression.expression)
    ) {
      calls.add(node.expression.name.text)
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(sourcePath))
  return [...calls].sort()
}

const referencedMembersOn = (sourcePath: string, receiver: readonly string[]): string[] => {
  const references = new Set<string>()
  const matchesReceiver = (node: Node): boolean => {
    let current: Node = node
    for (let index = receiver.length - 1; index >= 0; index -= 1) {
      if (index === 0) {
        return receiver[index] === 'this'
          ? current.kind === SyntaxKind.ThisKeyword
          : isIdentifier(current) && current.text === receiver[index]
      }
      if (!isPropertyAccessExpression(current) || current.name.text !== receiver[index])
        return false
      current = current.expression
    }
    return false
  }
  const visit = (node: Node): void => {
    if (isPropertyAccessExpression(node) && matchesReceiver(node.expression)) {
      references.add(node.name.text)
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(sourcePath))
  return [...references].sort()
}

const privateOwnerPaths = [
  computePaths.hostOwner,
  computePaths.remoteOwner,
  computePaths.jobOwner
] as const
const lifecyclePaths = [
  computePaths.jobLifecycle,
  computePaths.jobRepository,
  computePaths.concurrencyManager,
  computePaths.jobDispatcher,
  computePaths.jobPoller
] as const
const productionSourcePaths = productionSources()

describe('Compute service architecture', () => {
  it('keeps the facade and private owners within their completion gates', () => {
    expect(rawLineCount(readSource(computePaths.facade))).toBeLessThanOrEqual(600)
    for (const ownerPath of privateOwnerPaths) {
      expect(
        rawLineCount(readSource(ownerPath)),
        portableProjectPath(ownerPath)
      ).toBeLessThanOrEqual(660)
    }
    for (const lifecyclePath of lifecyclePaths) {
      expect(
        rawLineCount(readSource(lifecyclePath)),
        portableProjectPath(lifecyclePath)
      ).toBeLessThanOrEqual(660)
    }
    expect(rawLineCount(readSource(computePaths.ipc))).toBeLessThanOrEqual(660)
  })

  it('keeps lifecycle state ownership behind the narrow intent interface', () => {
    const lifecycle = sourceFileFor(computePaths.jobLifecycle).statements.find(
      (statement) => isClassDeclaration(statement) && statement.name?.text === 'ComputeJobLifecycle'
    )
    expect(lifecycle && isClassDeclaration(lifecycle)).toBe(true)
    if (!lifecycle || !isClassDeclaration(lifecycle)) return

    const publicMethods = lifecycle.members
      .flatMap((member) => {
        if (
          !isMethodDeclaration(member) ||
          !isIdentifier(member.name) ||
          getModifiers(member)?.some((modifier) => modifier.kind === SyntaxKind.PrivateKeyword) ===
            true
        ) {
          return []
        }
        return [member.name.text]
      })
      .sort()
    expect(publicMethods).toEqual(
      [
        'dispatchError',
        'dispatchRunning',
        'finishPolled',
        'observeRunning',
        'promoteQueued',
        'recordPollError',
        'recoverInterruptedDispatch'
      ].sort()
    )
    expect(calledMembersOn(computePaths.jobLifecycle, ['this', 'repository'])).toEqual([
      'updateIfStatus'
    ])

    const lifecycleTarget = modulePath(computePaths.jobLifecycle)
    const importers = productionSourcePaths.flatMap((sourcePath) =>
      importSpecifiersFrom(sourcePath).some(
        (specifier) => resolveImportTarget(sourcePath, specifier) === lifecycleTarget
      )
        ? [portableProjectPath(sourcePath)]
        : []
    )
    expect(importers).toEqual([
      'src/main/compute/concurrency-manager.ts',
      'src/main/compute/job-dispatcher.ts',
      'src/main/compute/job-poller.ts'
    ])

    for (const calls of [
      calledMembersOn(computePaths.concurrencyManager, ['this', 'jobRepository']),
      calledMembersOn(computePaths.jobDispatcher, ['jobRepository']),
      calledMembersOn(computePaths.jobPoller, ['this', 'deps', 'jobRepository'])
    ]) {
      expect(calls).not.toContain('update')
      expect(calls).not.toContain('updateIfStatus')
    }
  })

  it('keeps every private owner behind the public facade', () => {
    const ownerTargets = new Set(privateOwnerPaths.map(modulePath))
    const ownerModuleNames = privateOwnerPaths.map((path) => basename(modulePath(path)))
    const importers = new Map(
      privateOwnerPaths.map((path) => [modulePath(path), new Set<string>()])
    )

    for (const sourcePath of productionSourcePaths) {
      const source = readSource(sourcePath)
      if (!ownerModuleNames.some((name) => source.includes(name))) continue
      for (const specifier of importSpecifiersFrom(sourcePath)) {
        const target = resolveImportTarget(sourcePath, specifier)
        if (target && ownerTargets.has(target)) {
          importers.get(target)?.add(portableProjectPath(sourcePath))
        }
      }
    }

    for (const ownerPath of privateOwnerPaths) {
      expect(
        [...(importers.get(modulePath(ownerPath)) ?? [])],
        portableProjectPath(ownerPath)
      ).toEqual(['src/main/compute/compute-service.ts'])
    }
  })

  it('locks the stable facade operation inventory and bound update sink', () => {
    const facade = sourceFileFor(computePaths.facade).statements.find(
      (statement) => isClassDeclaration(statement) && statement.name?.text === 'ComputeService'
    )
    expect(facade && isClassDeclaration(facade)).toBe(true)
    if (!facade || !isClassDeclaration(facade)) return

    const isPrivate = (member: (typeof facade.members)[number]): boolean =>
      canHaveModifiers(member) &&
      getModifiers(member)?.some((modifier) => modifier.kind === SyntaxKind.PrivateKeyword) === true
    const publicOperations = facade.members
      .flatMap((member) => {
        if (
          isPrivate(member) ||
          (!isMethodDeclaration(member) && !isPropertyDeclaration(member)) ||
          !isIdentifier(member.name)
        ) {
          return []
        }
        return [member.name.text]
      })
      .sort()

    expect(publicOperations).toEqual(
      [
        'appendDetails',
        'callCommand',
        'download',
        'getDetails',
        'getJobResult',
        'getJobStatus',
        'getSessionConcurrencyStatus',
        'handleJobUpdated',
        'list',
        'listDir',
        'probe',
        'replaceDetails',
        'setConcurrencyLimit',
        'setScratchRoot',
        'setSessionConcurrencyLimit',
        'submitJob'
      ].sort()
    )

    const updateSink = facade.members.find(
      (member) => isPropertyDeclaration(member) && member.name.getText() === 'handleJobUpdated'
    )
    const isBoundUpdateSink =
      updateSink !== undefined &&
      isPropertyDeclaration(updateSink) &&
      updateSink.initializer !== undefined &&
      isArrowFunction(updateSink.initializer)
    expect(isBoundUpdateSink).toBe(true)
  })

  it('keeps Electron, application commands and job updates on the facade seam', () => {
    expect(importedNamesFrom(computePaths.ipc, computePaths.facade)).toEqual([
      'ArtifactResolver',
      'ComputeService'
    ])
    expect(importedNamesFrom(computePaths.jobRuntime, computePaths.facade)).toEqual([
      'ComputeService'
    ])
    expect(importedNamesFrom(computePaths.applicationCommands, computePaths.ipc)).toEqual([
      'ComputeHandlers'
    ])

    expect(referencedMembersOn(computePaths.jobRuntime, ['deps', 'computeService'])).toEqual([
      'handleJobUpdated'
    ])
  })

  it('keeps the Session-bound local RPC capability on its established facade operations', () => {
    expect(calledMembersOn(computePaths.localRpc, ['this', 'computeService'])).toEqual([
      'appendDetails',
      'callCommand',
      'download',
      'getDetails',
      'getEnabledComputeHosts',
      'getJobResult',
      'getJobStatus',
      'getSessionConcurrencyStatus',
      'list',
      'replaceDetails',
      'setSessionConcurrencyLimit',
      'submitJob'
    ])
  })

  it('preserves the registered Electron and Web capability boundary', () => {
    const computeContracts = RENDERER_CONTRACT_CATALOG.filter(
      ({ channel }) => channel?.startsWith('compute:') === true
    )
    expect(computeContracts).toHaveLength(24)
    const remoteRestricted = computeContracts.filter(
      ({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub'
    )
    expect(remoteRestricted.map(({ channel }) => channel).sort()).toEqual([
      'compute:download',
      'compute:reveal-in-folder'
    ])
    for (const contract of remoteRestricted) {
      expect(contract.surfaceInstallation).toEqual({
        electron: 'preload',
        localWeb: 'web-rpc',
        remoteWeb: 'rejecting-stub'
      })
    }
  })

  it('registers the complete facade, owner and cross-surface certification boundary', () => {
    const manifest = JSON.parse(readSource(manifestPath)) as {
      modules: {
        compute_service: {
          ownerPaths: string[]
          interfacePaths: string[]
          testFiles: { owner: string[]; contract: string[]; consumer: string[] }
        }
      }
    }
    const computeService = manifest.modules.compute_service

    expect(computeService.ownerPaths).toEqual([
      'src/main/compute/compute-host-profile-owner.ts',
      'src/main/compute/compute-job-lifecycle.ts',
      'src/main/compute/compute-job-workflow-owner.ts',
      'src/main/compute/compute-remote-operation-owner.ts',
      'src/main/compute/concurrency-manager.ts',
      'src/main/compute/job-dispatcher.ts',
      'src/main/compute/job-poller.ts',
      'src/main/compute/job-repository.ts',
      'src/main/compute/permission-grant-adapter.ts',
      'src/main/compute/compute-service.ts'
    ])
    expect(computeService.interfacePaths).toEqual([
      'src/main/compute/compute-service.ts',
      'src/main/compute/ipc.ts'
    ])
    expect(computeService.testFiles.owner).toEqual(
      expect.arrayContaining([
        architectureTestPath,
        'src/main/compute/compute-job-lifecycle.test.ts',
        'src/main/compute/compute-host-profile-owner.test.ts',
        'src/main/compute/compute-job-workflow-owner.test.ts',
        'src/main/compute/compute-remote-operation-owner.test.ts',
        'src/main/compute/permission-grant-adapter.test.ts',
        'src/main/compute/compute-service.test.ts'
      ])
    )
    expect(computeService.testFiles.contract).toEqual(
      expect.arrayContaining([
        'src/main/application-command-composition.test.ts',
        'src/main/compute/application-commands.test.ts',
        'src/main/compute/concurrency-manager.test.ts',
        'src/main/compute/ipc.test.ts',
        'src/main/compute/job-dispatcher.test.ts',
        'src/main/compute/job-poller.test.ts',
        'src/main/notebook/local-rpc-server.mcpcall.test.ts',
        'src/main/notebook/local-rpc-server.test.ts'
      ])
    )
    expect(computeService.testFiles.consumer).toEqual(
      expect.arrayContaining([
        'src/main/compute/enabled-hosts-registry.test.ts',
        'src/main/compute/job-runtime.test.ts'
      ])
    )
  })
})
