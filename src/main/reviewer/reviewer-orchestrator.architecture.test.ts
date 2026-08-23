import { dirname, extname, relative, resolve, sep } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isModuleDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceExport,
  isNamespaceImport,
  isStringLiteralLike,
  isTypeAliasDeclaration,
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
import { RENDERER_CONTRACT_CATALOG } from '../../shared/renderer-contract-catalog'
import { REVIEWER_MCP_TOOLS } from '../../shared/reviewer'
import { REVIEWER_BRIDGE_NAMESPACED_TOOLS } from './bridge-tools'

const projectRoot = resolve(__dirname, '../../..')
const mainRoot = resolve(projectRoot, 'src/main')
const orchestrationRoot = resolve(mainRoot, 'orchestration')
const manifestPath = resolve(projectRoot, 'scripts/ci/module-impact.json')
const prismaSchemaPath = resolve(projectRoot, 'prisma/schema.prisma')
const sharedReviewerPath = resolve(projectRoot, 'src/shared/reviewer.ts')
const architectureTestPath = 'src/main/reviewer/reviewer-orchestrator.architecture.test.ts'
const reviewerPaths = {
  facade: resolve(mainRoot, 'reviewer/orchestrator.ts'),
  assessmentOwner: resolve(mainRoot, 'reviewer/review-assessment-owner.ts'),
  fixLoopOwner: resolve(mainRoot, 'reviewer/reviewer-fix-loop-owner.ts'),
  sessionDriver: resolve(mainRoot, 'reviewer/reviewer-session-driver.ts')
} as const

const privateOwnerPaths = [
  reviewerPaths.assessmentOwner,
  reviewerPaths.fixLoopOwner,
  reviewerPaths.sessionDriver
] as const

const readSource = (path: string): string => readProductionSource(path, projectRoot)
const rawLineCount = (source: string): number =>
  source.split(/\r?\n/).length - Number(source.endsWith('\n'))
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

const productionSources = (): readonly string[] => listProductionSources(projectRoot)

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

const exportInventoryFromFacade = (): string[] => {
  const names: string[] = []
  const sourceFile = sourceFileFor(reviewerPaths.facade)
  for (const statement of sourceFile.statements) {
    if (isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        names.push(
          `${statement.isTypeOnly ? 'type' : 'value'}:export-all:${statement.moduleSpecifier?.getText(sourceFile) ?? '<local>'}`
        )
      } else if (isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.push(
            `${statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${element.name.text}`
          )
        }
      } else if (isNamespaceExport(statement.exportClause)) {
        names.push(`${statement.isTypeOnly ? 'type' : 'value'}:${statement.exportClause.name.text}`)
      }
      continue
    }
    if (isExportAssignment(statement)) names.push('value:default')
    const exported =
      canHaveModifiers(statement) &&
      getModifiers(statement)?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) {
      if (statement.name) names.push(`type:${statement.name.text}`)
    } else if (
      isClassDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isFunctionDeclaration(statement) ||
      isModuleDeclaration(statement)
    ) {
      names.push(`value:${statement.name?.getText(sourceFile) ?? '<anonymous>'}`)
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

const importedNamesFrom = (sourcePath: string, targetPath: string): string[] => {
  const names: string[] = []
  for (const statement of sourceFileFor(sourcePath).statements) {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteralLike(statement.moduleSpecifier) ||
      resolveImportTarget(sourcePath, statement.moduleSpecifier.text) !== modulePath(targetPath)
    ) {
      continue
    }
    const clause = statement.importClause
    if (!clause) {
      names.push('<side-effect>')
      continue
    }
    if (clause.name) names.push(`default:${clause.name.text}`)
    if (clause.namedBindings && isNamedImports(clause.namedBindings)) {
      names.push(
        ...clause.namedBindings.elements.map(
          (element) => element.propertyName?.text ?? element.name.text
        )
      )
    } else if (clause.namedBindings && isNamespaceImport(clause.namedBindings)) {
      names.push(`namespace:${clause.namedBindings.name.text}`)
    }
  }
  return names.sort()
}

const prismaModelFields = (modelName: string): string[] => {
  const match = readSource(prismaSchemaPath).match(
    new RegExp(`(?:^|\\n)model ${modelName} \\{\\n([\\s\\S]*?)\\n\\}`, 'u')
  )
  if (!match) throw new Error(`Prisma model not found: ${modelName}`)
  return match[1]!
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll(/\s+/g, ' '))
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('@@'))
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

describe('Reviewer orchestrator architecture', () => {
  it('keeps the facade and private owners within their completion gates', () => {
    expect(rawLineCount(readSource(reviewerPaths.facade))).toBeLessThanOrEqual(600)
    for (const ownerPath of privateOwnerPaths) {
      expect(
        rawLineCount(readSource(ownerPath)),
        portableProjectPath(ownerPath)
      ).toBeLessThanOrEqual(660)
    }
  })

  it('locks the stable facade export inventory', () => {
    expect(exportInventoryFromFacade()).toEqual([
      'type:RunReviewOptions',
      'value:buildReviewerPrompt',
      'value:driveReviewerToStop',
      'value:runReview'
    ])
  })

  it('keeps the public facade behind the Reviewer IPC command owner', () => {
    const importers = productionSources().filter((sourcePath) =>
      importSpecifiersFrom(sourcePath).some(
        (specifier) =>
          resolveImportTarget(sourcePath, specifier) === modulePath(reviewerPaths.facade)
      )
    )
    expect(importers.map(portableProjectPath)).toEqual(['src/main/reviewer/ipc.ts'])
    expect(importedNamesFrom(importers[0]!, reviewerPaths.facade)).toEqual(['runReview'])
  })

  it('keeps private owners behind the approved Reviewer relationships', () => {
    const expectedImporters = new Map<string, string[]>([
      [
        modulePath(reviewerPaths.assessmentOwner),
        ['src/main/reviewer/orchestrator.ts', 'src/main/reviewer/reviewer-fix-loop-owner.ts']
      ],
      [modulePath(reviewerPaths.fixLoopOwner), ['src/main/reviewer/orchestrator.ts']],
      [
        modulePath(reviewerPaths.sessionDriver),
        ['src/main/reviewer/orchestrator.ts', 'src/main/reviewer/review-assessment-owner.ts']
      ]
    ])
    const actualImporters = new Map(
      privateOwnerPaths.map((path) => [modulePath(path), new Set<string>()])
    )

    for (const sourcePath of productionSources()) {
      for (const specifier of importSpecifiersFrom(sourcePath)) {
        const target = resolveImportTarget(sourcePath, specifier)
        if (target && actualImporters.has(target)) {
          actualImporters.get(target)?.add(portableProjectPath(sourcePath))
        }
      }
    }

    for (const ownerPath of privateOwnerPaths) {
      const target = modulePath(ownerPath)
      expect(
        [...(actualImporters.get(target) ?? [])].sort(),
        portableProjectPath(ownerPath)
      ).toEqual(expectedImporters.get(target))
    }
  })

  it('keeps Reviewer ownership independent of the future orchestration domain', () => {
    const reviewerRoot = resolve(mainRoot, 'reviewer')
    const reviewerSources = productionSources().filter(
      (sourcePath) => sourcePath === sharedReviewerPath || sourcePath.startsWith(reviewerRoot + sep)
    )
    for (const sourcePath of reviewerSources) {
      const orchestrationImports = importSpecifiersFrom(sourcePath).filter((specifier) => {
        const target = resolveImportTarget(sourcePath, specifier)
        return target === orchestrationRoot || target?.startsWith(orchestrationRoot + sep)
      })
      expect(orchestrationImports, portableProjectPath(sourcePath)).toEqual([])
    }

    const orchestrationSources = productionSources().filter(
      (sourcePath) =>
        sourcePath === orchestrationRoot || sourcePath.startsWith(orchestrationRoot + sep)
    )
    for (const sourcePath of orchestrationSources) {
      const reviewerImports = importSpecifiersFrom(sourcePath).filter((specifier) => {
        const target = resolveImportTarget(sourcePath, specifier)
        return (
          target === modulePath(sharedReviewerPath) ||
          target === reviewerRoot ||
          target?.startsWith(reviewerRoot + sep)
        )
      })
      expect(reviewerImports, portableProjectPath(sourcePath)).toEqual([])
    }
  })

  it('keeps orchestration metadata out of the Reviewer persistence leaf', () => {
    expect(prismaModelFields('Review')).toEqual([
      'id String @id @default(cuid())',
      'projectId String',
      'sessionId String',
      'turnMessageId String',
      'scope String @default("{}")',
      'lifecycle String @default("running")',
      'outcome String?',
      'errorMessage String?',
      'model String @default("")',
      'reviewerLog String @default("[]")',
      'createdAt DateTime @default(now())',
      'updatedAt DateTime @updatedAt',
      'findings Finding[]',
      'causedDispositions ReviewFindingDisposition[]',
      'scopeSnapshot ReviewScopeSnapshot?'
    ])
    expect(prismaModelFields('Finding')).toEqual([
      'id String @id @default(cuid())',
      'reviewId String',
      'status String @default("pass")',
      'resolution String @default("open")',
      'claim String @default("")',
      'evidence String @default("")',
      'locator String @default("{}")',
      'artifactVersionId String?',
      'artifactBindingState String @default("legacy_unverified")',
      'sortIndex Int @default(0)',
      'reflagCount Int @default(0)',
      'review Review @relation(fields: [reviewId], references: [id], onDelete: Cascade)',
      'dispositions ReviewFindingDisposition[]'
    ])
    expect(prismaModelFields('ReviewFindingDisposition')).toEqual([
      'id String @id',
      'sourceFindingId String',
      'causeReviewId String?',
      'sequence Int',
      'trigger String',
      'outcome String',
      'note String?',
      'assessedArtifactVersionId String?',
      'assessmentSnapshot String?',
      'createdAt DateTime @default(now())',
      'sourceFinding Finding @relation(fields: [sourceFindingId], references: [id], onDelete: Cascade)',
      'causeReview Review? @relation(fields: [causeReviewId], references: [id], onDelete: Restrict)'
    ])
    expect(prismaModelFields('ReviewScopeSnapshot')).toEqual([
      'id String @id',
      'projectId String',
      'sessionId String',
      'reviewId String @unique',
      'scopeTurnMessageId String',
      'state String @default("staging")',
      'snapshotJson String',
      'checksum String',
      'storageKey String',
      'schemaVersion Int @default(1)',
      'blockCount Int',
      'createdAt DateTime @default(now())',
      'review Review @relation(fields: [reviewId], references: [id], onDelete: Cascade)'
    ])
  })

  it('locks Reviewer Electron and Web method/event inventory', () => {
    const contracts = RENDERER_CONTRACT_CATALOG.filter(
      (contract) => contract.capability === 'reviewer'
    )
    expect(
      contracts.map(({ publicPath, channel, kind }) => ({ publicPath, channel, kind }))
    ).toEqual([
      { publicPath: 'reviewer.abortFixLoop', channel: 'reviewer:abort-fix-loop', kind: 'method' },
      { publicPath: 'reviewer.getForSession', channel: 'reviewer:get-for-session', kind: 'method' },
      { publicPath: 'reviewer.onFixLoopEnd', channel: 'reviewer:fix-loop-end', kind: 'event' },
      { publicPath: 'reviewer.onFixLoopStart', channel: 'reviewer:fix-loop-start', kind: 'event' },
      {
        publicPath: 'reviewer.onSuppressNextAutoReview',
        channel: 'reviewer:suppress-next-auto-review',
        kind: 'event'
      },
      { publicPath: 'reviewer.onUpdated', channel: 'reviewer:updated', kind: 'event' },
      { publicPath: 'reviewer.run', channel: 'reviewer:run', kind: 'method' }
    ])
    for (const contract of contracts) {
      expect(contract.surfaceInstallation.electron).toBe('preload')
      expect(contract.surfaceInstallation.localWeb).toBe(
        contract.kind === 'event' ? 'web-event' : 'web-rpc'
      )
      expect(contract.surfaceInstallation.remoteWeb).toBe(
        contract.kind === 'event' ? 'web-event' : 'web-rpc'
      )
    }
  })

  it('locks the isolated Reviewer MCP tool inventory', () => {
    expect(REVIEWER_MCP_TOOLS).toEqual({
      readTurn: 'read_turn',
      queryExecutionLog: 'query_execution_log',
      readArtifact: 'read_artifact',
      submitFindings: 'submit_findings'
    })
    expect(REVIEWER_BRIDGE_NAMESPACED_TOOLS.map((tool) => tool.name)).toEqual([
      'read_turn',
      'query_execution_log',
      'read_artifact',
      'submit_findings'
    ])
  })

  it('routes interface changes through every cross-surface and downstream certification suite', () => {
    const manifest = JSON.parse(readSource(manifestPath)) as ModuleImpactManifest
    const module = manifest.modules.reviewer_orchestrator

    expect(module).toEqual({
      ownerPaths: [
        'src/main/reviewer/acp-runtime.ts',
        'src/main/reviewer/orchestrator.ts',
        'src/main/reviewer/model-runtime-owner.ts',
        'src/main/reviewer/review-assessment-owner.ts',
        'src/main/reviewer/reviewer-fix-loop-owner.ts',
        'src/main/reviewer/reviewer-session-driver.ts'
      ],
      interfacePaths: [
        'src/main/reviewer/orchestrator.ts',
        'src/main/reviewer/ipc.ts',
        'src/shared/reviewer.ts'
      ],
      consumerModules: ['workspace_runtime', 'workspace_page', 'artifact_provenance'],
      testFiles: {
        owner: [
          architectureTestPath,
          'src/main/reviewer/model-runtime-owner.test.ts',
          'src/main/reviewer/review-assessment-owner.test.ts',
          'src/main/reviewer/orchestrator.test.ts',
          'src/main/reviewer/orchestrator-drive.test.ts',
          'src/main/reviewer/log-capture.test.ts',
          'src/main/reviewer/orchestrator-prompt.test.ts',
          'src/main/reviewer/orchestrator-prompt-prefix.test.ts',
          'src/main/reviewer/orchestrator.start-contract.test.ts',
          'src/main/reviewer/fix-loop.test.ts',
          'src/main/reviewer/reviewer-fix-loop-owner.test.ts',
          'src/main/reviewer/correction.test.ts'
        ],
        contract: [
          'src/main/reviewer/ipc.test.ts',
          'src/main/reviewer/lifecycle.test.ts',
          'src/main/reviewer/mcp-server.test.ts',
          'src/main/application-command-wiring.test.ts',
          'src/main/host-application-commands.test.ts',
          'src/main/application-command-composition.test.ts',
          'src/main/web-service/application-event-projections.test.ts',
          'src/shared/renderer-contract-catalog.test.ts',
          'src/preload/index.test.ts',
          'src/renderer/web/api-installer.test.ts'
        ],
        consumer: [
          'packages/open-science/cli.test.ts',
          'src/main/notebook/local-rpc-notebook-adapter.test.ts',
          'src/renderer/src/lib/acp/workspace-events.test.ts',
          'src/renderer/src/stores/review-store.test.ts',
          'src/renderer/src/pages/workspace/WorkspacePage.send-gate.test.tsx'
        ]
      },
      capabilityOverlays: ['windows_sensitive'],
      fallbackCapability: 'main_runtime'
    })
  })
})
