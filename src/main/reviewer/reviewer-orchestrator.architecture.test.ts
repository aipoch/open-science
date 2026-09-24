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

import { loadModuleImpactManifest } from '../../../scripts/ci/load-module-impact.mjs'

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
const sourceMentions = (sourcePath: string, needle: string): boolean =>
  readSource(sourcePath).includes(needle)

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

describe('Reviewer orchestrator architecture', () => {
  it('locks the stable facade export inventory', () => {
    expect(exportInventoryFromFacade()).toEqual([
      'type:RunReviewOptions',
      'value:buildReviewerPrompt',
      'value:driveReviewerToStop',
      'value:runReview'
    ])
  })

  it('keeps the public facade behind the Reviewer IPC command owner', () => {
    const importers = productionSources().filter(
      (sourcePath) =>
        sourceMentions(sourcePath, 'orchestrator') &&
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
      if (
        !sourceMentions(sourcePath, 'review-assessment-owner') &&
        !sourceMentions(sourcePath, 'reviewer-fix-loop-owner') &&
        !sourceMentions(sourcePath, 'reviewer-session-driver')
      ) {
        continue
      }
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
    const manifest = loadModuleImpactManifest(manifestPath)
    const module = manifest.modules.reviewer_orchestrator

    expect(module).toEqual({
      ownerPaths: [
        'src/main/reviewer/acp-runtime.ts',
        'src/main/reviewer/orchestrator.ts',
        'src/main/reviewer/model-runtime-owner.ts',
        'src/main/reviewer/review-assessment-owner.ts',
        'src/main/reviewer/reviewer-fix-loop-owner.ts',
        'src/main/reviewer/reviewer-session-driver.ts',
        'src/main/reviewer/paged-preview-electron.ts',
        'src/main/reviewer/correction.ts',
        'src/main/reviewer/scope.ts',
        'src/main/reviewer/artifact-digest.test.ts',
        'src/main/reviewer/artifact-digest.ts',
        'src/main/reviewer/artifact-version-review.test.ts',
        'src/main/reviewer/artifact-version-review.ts',
        'src/main/reviewer/bounded-artifact-content.ts',
        'src/main/reviewer/bridge-tools.ts',
        'src/main/reviewer/correction-context.test.ts',
        'src/main/reviewer/correction-context.ts',
        'src/main/reviewer/correction-owner.test.ts',
        'src/main/reviewer/correction.test.ts',
        'src/main/reviewer/fix-loop.test.ts',
        'src/main/reviewer/flag-stale-reviews.test.ts',
        'src/main/reviewer/host-sdk-tabular.test.ts',
        'src/main/reviewer/host-sdk.test.ts',
        'src/main/reviewer/host-sdk.ts',
        'src/main/reviewer/image-content.integration.test.ts',
        'src/main/reviewer/image-generation-trace.integration.test.ts',
        'src/main/reviewer/ipc.test.ts',
        'src/main/reviewer/ipc.ts',
        'src/main/reviewer/lifecycle.test.ts',
        'src/main/reviewer/log-capture.test.ts',
        'src/main/reviewer/mcp-server.test.ts',
        'src/main/reviewer/mcp-server.ts',
        'src/main/reviewer/mcp-stdio-proxy.ts',
        'src/main/reviewer/model-runtime-owner.test.ts',
        'src/main/reviewer/orchestrator-drive.test.ts',
        'src/main/reviewer/orchestrator-prompt-prefix.test.ts',
        'src/main/reviewer/orchestrator-prompt.test.ts',
        'src/main/reviewer/orchestrator.start-contract.test.ts',
        'src/main/reviewer/orchestrator.test.ts',
        'src/main/reviewer/paged-preview-electron.test.ts',
        'src/main/reviewer/paged-preview-resolver.test.ts',
        'src/main/reviewer/paged-preview-resolver.ts',
        'src/main/reviewer/project-runtime-owner.test.ts',
        'src/main/reviewer/project-runtime-owner.ts',
        'src/main/reviewer/repository.test.ts',
        'src/main/reviewer/repository.ts',
        'src/main/reviewer/review-assessment-owner.test.ts',
        'src/main/reviewer/review-json.test.ts',
        'src/main/reviewer/review-json.ts',
        'src/main/reviewer/review-submission-read-model.ts',
        'src/main/reviewer/reviewer-fix-loop-owner.test.ts',
        'src/main/reviewer/reviewer-mcp-test-client.ts',
        'src/main/reviewer/reviewer-orchestrator.architecture.test.ts',
        'src/main/reviewer/reviewer-regression-gate.integration.test.ts',
        'src/main/reviewer/reviewer-resilience.test.ts',
        'src/main/reviewer/rubric.test.ts',
        'src/main/reviewer/rubric.ts',
        'src/main/reviewer/scope-snapshot.test.ts',
        'src/main/reviewer/scope-snapshot.ts',
        'src/main/reviewer/scope.test.ts',
        'src/main/reviewer/stale-reviews.ts',
        'src/main/reviewer/submission-limits.ts',
        'src/main/reviewer/turn-evidence.test.ts',
        'src/main/reviewer/turn-evidence.ts'
      ],
      interfacePaths: [
        'src/main/reviewer/orchestrator.ts',
        'src/main/reviewer/ipc.ts',
        'src/shared/reviewer.ts',
        'src/main/reviewer/paged-preview-electron.ts',
        'src/main/reviewer/artifact-version-review.ts',
        'src/main/reviewer/bridge-tools.ts',
        'src/main/reviewer/host-sdk.ts',
        'src/main/reviewer/mcp-server.ts',
        'src/main/reviewer/mcp-stdio-proxy.ts',
        'src/main/reviewer/model-runtime-owner.ts',
        'src/main/reviewer/project-runtime-owner.ts',
        'src/main/reviewer/repository.ts',
        'src/main/reviewer/review-submission-read-model.ts',
        'src/main/reviewer/rubric.ts',
        'src/main/reviewer/scope.ts',
        'src/main/reviewer/stale-reviews.ts',
        'src/main/reviewer/turn-evidence.ts'
      ],
      consumerModules: ['workspace_runtime', 'workspace_page', 'artifact_provenance'],
      testFiles: {
        owner: [
          'src/main/reviewer/reviewer-orchestrator.architecture.test.ts',
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
          'src/main/reviewer/correction-context.test.ts',
          'src/main/reviewer/correction.test.ts',
          'src/main/reviewer/correction-owner.test.ts',
          'src/main/reviewer/paged-preview-electron.test.ts',
          'src/main/reviewer/scope.test.ts',
          'src/main/reviewer/artifact-digest.test.ts',
          'src/main/reviewer/artifact-version-review.test.ts',
          'src/main/reviewer/flag-stale-reviews.test.ts',
          'src/main/reviewer/host-sdk-tabular.test.ts',
          'src/main/reviewer/image-content.integration.test.ts',
          'src/main/reviewer/image-generation-trace.integration.test.ts',
          'src/main/reviewer/project-runtime-owner.test.ts',
          'src/main/reviewer/repository.test.ts',
          'src/main/reviewer/review-json.test.ts',
          'src/main/reviewer/reviewer-regression-gate.integration.test.ts',
          'src/main/reviewer/reviewer-resilience.test.ts',
          'src/main/reviewer/rubric.test.ts',
          'src/main/reviewer/scope-snapshot.test.ts',
          'src/main/reviewer/turn-evidence.test.ts'
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
          'src/renderer/web/api-installer.test.ts',
          'src/main/reviewer/paged-preview-resolver.test.ts',
          'src/main/reviewer/host-sdk.test.ts',
          'src/main/managed-preview-resources.test.ts',
          'src/main/managed-preview-protocol.test.ts',
          'src/main/office-preview/office-preview-electron.test.ts',
          'src/main/office-preview/office-preview-runtime-protocol.test.ts',
          'src/main/uploads/attachment-media.pdf-preview.test.ts'
        ],
        consumer: [
          'src/main/session-persistence/runtime-session-owner.test.ts',
          'src/main/session-plan/adversarial-session-plan.test.ts',
          'packages/open-science/cli.test.ts',
          'src/main/notebook/local-rpc-notebook-adapter.test.ts',
          'src/renderer/src/lib/acp/workspace-events.test.ts',
          'src/renderer/src/stores/review-store.test.ts',
          'src/renderer/src/pages/workspace/WorkspacePage.send-gate.test.tsx',
          'src/renderer/src/reviewer-paged-preview/main.test.ts',
          'src/main/acp/application-commands.test.ts',
          'src/main/acp/artifact-code-reconstruction-runner.test.ts',
          'src/main/acp/codex-completion-handoff.integration.test.ts',
          'src/main/acp/context-compaction-workflow.test.ts',
          'src/main/acp/context-usage-policy.test.ts',
          'src/main/acp/durable-continuation-context-owner.test.ts',
          'src/main/acp/file-reference-resolver.test.ts',
          'src/main/acp/file-reference-resolver.windows-scope.test.ts',
          'src/main/acp/image-input-compatibility-owner.test.ts',
          'src/main/acp/ipc.test.ts',
          'src/main/acp/isolated-execution-preflight.test.ts',
          'src/main/acp/mcp-http-host.test.ts',
          'src/main/acp/native-follow-up-workflow.test.ts',
          'src/main/acp/opencode-immediate-handoff.integration.test.ts',
          'src/main/acp/opencode-immediate-handoff.test.ts',
          'src/main/acp/permission-broker-registry.test.ts',
          'src/main/acp/permission-wait-owner.test.ts',
          'src/main/acp/prompt-attachment-notebook-sandbox.integration.test.ts',
          'src/main/acp/prompt-content-owner.test.ts',
          'src/main/acp/prompt-image-privacy.test.ts',
          'src/main/acp/prompt-outcome-finalizer.test.ts',
          'src/main/acp/prompt-preparation-owner.test.ts',
          'src/main/acp/prompt-turn-workflow.test.ts',
          'src/main/acp/provider-prompt-executor.test.ts',
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
          'src/main/acp/session-deletion-workflow.test.ts',
          'src/main/acp/session-environment-policy.test.ts',
          'src/main/acp/session-plan-delivery-owner.test.ts',
          'src/main/acp/session-presentation-policy.test.ts',
          'src/main/acp/session-replacement-workflow.test.ts',
          'src/main/acp/session-update-projector.test.ts',
          'src/main/acp/shutdown-guard.test.ts',
          'src/main/acp/side-chat-interaction-admission.test.ts',
          'src/main/acp/turn-skill-owner.test.ts',
          'src/main/agents/agents-repl.integration.test.ts',
          'src/main/agents/agents-repl.mutations.integration.test.ts',
          'src/main/agents/agents-repl.privileged.integration.test.ts',
          'src/main/agents/agents-repl.runtime-consumption.integration.test.ts',
          'src/main/agents/app-handoff-runtime.integration.test.ts',
          'src/main/agents/completion-gate.execute-control.integration.test.ts',
          'src/main/agents/completion-gate.integration.test.ts',
          'src/main/application-command-client.test.ts',
          'src/main/application-command-electron-adapter.test.ts',
          'src/main/artifacts/artifact-provenance-graph.test.ts',
          'src/main/artifacts/artifact-save.integration.test.ts',
          'src/main/artifacts/code-reconstruction.test.ts',
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
          'src/main/artifacts/reviewer-turn-file-evidence-reader.test.ts',
          'src/main/bookmarks/pdf-source-diagnostics.test.ts',
          'src/main/bookmarks/service.test.ts',
          'src/main/compute/compute-job-workflow-owner.test.ts',
          'src/main/compute/job-deletion-runtime-drain.test.ts',
          'src/main/compute/job-deletion-runtime-isolation.test.ts',
          'src/main/compute/session-catalog-hydration.integration.test.ts',
          'src/main/connectors/application.test.ts',
          'src/main/data-content-application-commands.test.ts',
          'src/main/database/application-database.integration.test.ts',
          'src/main/database/literature-inbox-integrity-migration.test.ts',
          'src/main/database/managed-file-version-domain.test.ts',
          'src/main/database/migration-service.test.ts',
          'src/main/delegation/delegated-review-evidence.test.ts',
          'src/main/delegation/production-composition.test.ts',
          'src/main/delegation/production-framework-runtime.test.ts',
          'src/main/delegation/session-record-adapter.test.ts',
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
          'src/main/managed-file-versions/diff-task.test.ts',
          'src/main/managed-file-versions/ipc.test.ts',
          'src/main/managed-file-versions/service.integration.test.ts',
          'src/main/managed-preview-ipc.test.ts',
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
          'src/main/notebook/local-rpc-server.mcpcall.test.ts',
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
          'src/main/settings/application-commands.test.ts',
          'src/main/settings/backend-resolver.test.ts',
          'src/main/settings/backend-route-planner.test.ts',
          'src/main/settings/bootstrap.integration.test.ts',
          'src/main/settings/claude-provider-configuration.integration.test.ts',
          'src/main/settings/connector-credential-recovery.integration.test.ts',
          'src/main/settings/integration-application-commands.test.ts',
          'src/main/settings/ipc.test.ts',
          'src/main/settings/network-proxy-settings.test.ts',
          'src/main/settings/provider-transport-owner.test.ts',
          'src/main/settings/responses-bridge.integration.test.ts',
          'src/main/settings/runtime-application-commands.test.ts',
          'src/main/settings/service.connectors.test.ts',
          'src/main/settings/service.providers.test.ts',
          'src/main/settings/service.test.ts',
          'src/main/settings/session-details-model-owner.test.ts',
          'src/main/settings/workflows.test.ts',
          'src/main/settings/workflows/connectors-diagnostic.test.ts',
          'src/main/side-chat/ipc.test.ts',
          'src/main/side-chat/runtime-owner.test.ts',
          'src/main/skills/conversation-import.test.ts',
          'src/main/specialist/application-commands.test.ts',
          'src/main/specialist/ipc.test.ts',
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
          'src/renderer/src/components/ReviewerCard.render.test.tsx',
          'src/renderer/src/hooks/useLifecycleSync.test.tsx',
          'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.test.ts',
          'src/renderer/src/pages/literature/LiteratureFullTextLookup.render.test.tsx',
          'src/renderer/src/pages/literature/LiteratureLibraryPage.render.test.tsx',
          'src/renderer/src/pages/literature/LiteratureMetadataEditor.test.tsx',
          'src/renderer/src/pages/workspace/artifact-publication-preview.integration.test.tsx',
          'src/renderer/src/pages/workspace/previews/preview-pagination-contract.test.tsx',
          'src/shared/renderer-surface-inventory.test.ts',
          'src/shared/renderer-surface-matrix.test.ts',
          'src/main/settings/skill-catalog.test.ts',
          'src/main/session-package/fork.test.ts',
          'src/main/storage/brand-location.test.ts',
          'src/main/storage/migration-target-race.test.ts',
          'src/renderer/src/components/LegacyDataMoveDialog.storage.test.tsx',
          'src/main/settings/provider-runtime-health-owner.test.ts',
          'src/renderer/src/lib/session-persistence/session-persistence.test.ts',
          'src/renderer/src/pages/workspace/workspace-message-queue-controller.test.ts',
          'src/main/session-persistence/resumed-artifact-publication.integration.test.ts',
          'src/main/artifacts/resumed-finalization-ownership.test.ts',
          'src/main/pdf-annotations/repository.integration.test.ts',
          'src/main/pdf-annotations/service.test.ts',
          'src/main/session-package/ro-crate.integration.test.ts',
          'src/main/session-package/ro-crate.test.ts',
          'src/main/settings/codex-bridge-tools.test.ts',
          'src/main/notebook/runtime-service.rpc-retirement.test.ts',
          'src/main/literature/smart-collections.test.ts',
          'src/main/notebook/runtime-service.macos-isolation.integration.test.ts'
        ]
      },
      capabilityOverlays: ['windows_sensitive', 'e2e_regressions', 'e2e_delegation'],
      fallbackCapability: 'main_runtime'
    })
  })
})
