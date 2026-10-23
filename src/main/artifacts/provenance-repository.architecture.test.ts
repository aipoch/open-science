import {
  expectBoundaryPaths,
  expectBoundaryOwnerTests
} from '../../../test/module-boundary-assertions'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  listProductionSources,
  readProductionSource
} from '../../../test/architecture-source-index'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isParameter,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isReturnStatement,
  isVariableStatement,
  preProcessFile,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type ClassDeclaration,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

import { loadModuleImpactManifest } from '../../../scripts/ci/load-module-impact.mjs'

const productionFiles = [
  'artifact-provenance-graph.ts',
  'reproducibility-host.ts',
  'artifact-reproducibility-export.ts',
  'artifact-reproducibility-ipc.ts',
  'artifact-reproducibility-lifecycle.ts',
  'artifact-reproducibility-receipts.ts',
  'provenance-canonical.ts',
  'provenance-content-status.ts',
  'compute-output-evidence.ts',
  'provenance-core-evidence.ts',
  'provenance-dependency-reader.ts',
  'provenance-execution-evidence.ts',
  'provenance-finalization-recovery.ts',
  'provenance-message-finalization.ts',
  'provenance-message-snapshot.ts',
  'provenance-producer-capture.ts',
  'provenance-read-model.ts',
  'provenance-reproducibility-execution-evidence.ts',
  'provenance-repository.ts',
  'reviewer-turn-file-evidence-reader.ts',
  'provenance-staging-recovery.ts',
  'provenance-storage.ts',
  'provenance-storage-contract.ts',
  'provenance-unindexed-recovery.ts',
  'provenance-version-writer.ts',
  'write-budget-owner.ts'
] as const
const sources = new Map(
  productionFiles.map((file) => [file, readFileSync(resolve(__dirname, file), 'utf8')])
)
const sourceFileFor = (file: (typeof productionFiles)[number]): SourceFile =>
  createSourceFile(file, sources.get(file)!, ScriptTarget.Latest, true, ScriptKind.TS)

const classFrom = (file: (typeof productionFiles)[number], name: string): ClassDeclaration => {
  const candidate = sourceFileFor(file).statements.find(
    (statement) => isClassDeclaration(statement) && statement.name?.text === name
  )
  if (!candidate || !isClassDeclaration(candidate)) throw new Error(`${name} class not found`)
  return candidate
}

const hasModifier = (node: Node, kind: SyntaxKind): boolean =>
  canHaveModifiers(node) &&
  (getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)

const memberName = (node: Node | undefined): string | undefined =>
  node && isIdentifier(node) ? node.text : undefined

const methods = (declaration: ClassDeclaration, visibility: 'public' | 'private'): string[] =>
  declaration.members
    .filter(isMethodDeclaration)
    .filter((member) =>
      visibility === 'private'
        ? hasModifier(member, SyntaxKind.PrivateKeyword)
        : !hasModifier(member, SyntaxKind.PrivateKeyword) &&
          !hasModifier(member, SyntaxKind.ProtectedKeyword)
    )
    .map((member) => memberName(member.name))
    .filter((name): name is string => name !== undefined)
    .sort()

const fields = (declaration: ClassDeclaration): string[] => {
  const result = declaration.members
    .filter(isPropertyDeclaration)
    .map((member) => memberName(member.name))
    .filter((name): name is string => name !== undefined)

  for (const constructor of declaration.members.filter(isConstructorDeclaration)) {
    result.push(
      ...constructor.parameters
        .filter(
          (parameter) =>
            isParameter(parameter) &&
            (hasModifier(parameter, SyntaxKind.PrivateKeyword) ||
              hasModifier(parameter, SyntaxKind.PublicKeyword) ||
              hasModifier(parameter, SyntaxKind.ProtectedKeyword))
        )
        .map((parameter) => memberName(parameter.name))
        .filter((name): name is string => name !== undefined)
    )
  }
  return result.sort()
}

const mutableFields = (declaration: ClassDeclaration): string[] => {
  const result = declaration.members
    .filter(isPropertyDeclaration)
    .filter((member) => !hasModifier(member, SyntaxKind.ReadonlyKeyword))
    .map((member) => memberName(member.name))
    .filter((name): name is string => name !== undefined)

  for (const constructor of declaration.members.filter(isConstructorDeclaration)) {
    result.push(
      ...constructor.parameters
        .filter(
          (parameter) =>
            isParameter(parameter) &&
            (hasModifier(parameter, SyntaxKind.PrivateKeyword) ||
              hasModifier(parameter, SyntaxKind.PublicKeyword) ||
              hasModifier(parameter, SyntaxKind.ProtectedKeyword)) &&
            !hasModifier(parameter, SyntaxKind.ReadonlyKeyword)
        )
        .map((parameter) => memberName(parameter.name))
        .filter((name): name is string => name !== undefined)
    )
  }
  return result.sort()
}

const constructionSite = (node: Node): string => {
  let current: Node | undefined = node.parent
  while (current) {
    if (isConstructorDeclaration(current)) return 'constructor'
    if (isMethodDeclaration(current)) return `method:${memberName(current.name) ?? '<computed>'}`
    current = current.parent
  }
  return 'module'
}

const newExpressionSites = (className: string): string[] => {
  const sites: string[] = []
  for (const file of productionFiles) {
    const visit = (node: Node): void => {
      if (
        isNewExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === className
      ) {
        sites.push(`${file}:${constructionSite(node)}`)
      }
      forEachChild(node, visit)
    }
    visit(sourceFileFor(file))
  }
  return sites
}

const delegationTarget = (
  declaration: ClassDeclaration,
  sourceFile: SourceFile,
  methodName: string
): string => {
  const method = declaration.members.find(
    (member) => isMethodDeclaration(member) && memberName(member.name) === methodName
  )
  if (!method || !isMethodDeclaration(method) || method.body?.statements.length !== 1) {
    throw new Error(`${methodName} must be a single-return delegation`)
  }
  const [statement] = method.body.statements
  if (
    !isReturnStatement(statement) ||
    !statement.expression ||
    !isCallExpression(statement.expression) ||
    !isPropertyAccessExpression(statement.expression.expression)
  ) {
    throw new Error(`${methodName} is not a direct owner delegation`)
  }
  return statement.expression.expression.getText(sourceFile)
}

const topLevelValues = (sourceFile: SourceFile): string[] =>
  sourceFile.statements
    .filter(isVariableStatement)
    .flatMap((statement) =>
      statement.declarationList.declarations.map((declaration) =>
        declaration.name.getText(sourceFile)
      )
    )
    .sort()

describe('Artifact Provenance repository architecture', () => {
  const facadeFile = sourceFileFor('provenance-repository.ts')
  const facade = classFrom('provenance-repository.ts', 'ArtifactProvenanceRepository')

  it('keeps the established public facade and private projection helpers', () => {
    expect(methods(facade, 'public')).toEqual(
      [
        'saveVersion',
        'withSessionMutation',
        'activateFinalizedRun',
        'createVersion',
        'deleteProjectProvenance',
        'finalizeRun',
        'getLineage',
        'getReviewerVersionTrace',
        'getVersionCore',
        'readDependencyRelations',
        'getVersionExecution',
        'getVersionLiterature',
        'getVersionMessages',
        'getVersionProvenance',
        'getVersionReview',
        'listRunVersions',
        'prepareProjectReconciliation',
        'readCodeReconstructionCache',
        'reconcileSession',
        'recordLiteratureAbstractRead',
        'recordLiteraturePdfRead',
        'recordLiteratureSearch',
        'releaseAllWriteReservations',
        'releaseRunWriteReservations',
        'releaseWriteReservation',
        'replayVersion',
        'reserveWrite',
        'resolveReviewerTurnFileEvidence',
        'resolveVersionDescriptors',
        'validateFinalizationOwnership',
        'writeAppGeneratedVersion',
        'writeCodeReconstructionCache'
      ].sort()
    )
    expect(methods(facade, 'private')).toEqual(
      [
        'writeGeneratedVersion',
        'replayVersionWithinSession',
        'replayRoutingPublisher',
        'reconcileSessionWithinSession',
        'hasRecoverableFinalization',
        'inspectVersionContent',
        'openVersionContent',
        'resolveOwnedVersion',
        'resolveVersionDerivedPath',
        'resolveVersionDirectory',
        'toArtifactVersionFile',
        'toDescriptor'
      ].sort()
    )
  })

  it('composes each state owner exactly once without mutable facade fields', () => {
    for (const owner of [
      'ArtifactReproducibilityReceiptStore',
      'ArtifactProvenanceDependencyReader',
      'ArtifactProvenanceFinalizationRecovery',
      'ArtifactLiteratureManifestOwner',
      'ArtifactProvenanceMessageFinalizer',
      'ArtifactProvenanceProducerCapture',
      'ArtifactProvenanceReadModel',
      'ReviewerTurnFileEvidenceReader',
      'ArtifactProvenanceStagingRecovery',
      'ArtifactProvenanceUnindexedRecovery',
      'ArtifactProvenanceVersionWriter',
      'ArtifactWriteBudgetOwner',
      'ContentRepository'
    ]) {
      expect(newExpressionSites(owner), owner).toEqual(['provenance-repository.ts:constructor'])
    }
    expect(fields(facade)).toEqual(
      [
        'compatibilityRepository',
        'contentRepository',
        'createId',
        'durability',
        'dependencyReader',
        'finalizationRecovery',
        'literatureManifestOwner',
        'messageFinalizer',
        'notebookRepository',
        'now',
        'options',
        'producerCapture',
        'readModel',
        'reviewerTurnFileEvidenceReader',
        'stagingRecovery',
        'unindexedRecovery',
        'versionFileOperator',
        'versionWriter',
        'writeBudgetOwner'
      ].sort()
    )
    expect(mutableFields(facade)).toEqual([])
    expect(topLevelValues(facadeFile)).toEqual(
      [
        'SAFE_SEGMENT_PATTERN',
        'assertSafeSegment',
        'hasServerInferredProducer',
        'journalRecoveryPlan',
        'recordValue'
      ].sort()
    )
  })

  it('keeps moved lifecycle and read methods as direct owner delegations', () => {
    expect(
      Object.fromEntries(
        [
          'activateFinalizedRun',
          'createVersion',
          'finalizeRun',
          'getLineage',
          'getVersionCore',
          'readDependencyRelations',
          'getVersionExecution',
          'getVersionMessages',
          'getVersionProvenance',
          'getVersionReview',
          'readCodeReconstructionCache',
          'releaseAllWriteReservations',
          'releaseRunWriteReservations',
          'releaseWriteReservation',
          'reserveWrite',
          'validateFinalizationOwnership',
          'writeCodeReconstructionCache'
        ].map((method) => [method, delegationTarget(facade, facadeFile, method)])
      )
    ).toEqual({
      activateFinalizedRun: 'this.messageFinalizer.activateFinalizedRun',
      createVersion: 'this.versionWriter.writeVersion',
      finalizeRun: 'this.messageFinalizer.finalizeRun',
      getLineage: 'this.readModel.getLineage',
      getVersionCore: 'this.readModel.getVersionCore',
      readDependencyRelations: 'this.dependencyReader.readDependencyRelations',
      getVersionExecution: 'this.readModel.getVersionExecution',
      getVersionMessages: 'this.readModel.getVersionMessages',
      getVersionProvenance: 'this.readModel.getVersionProvenance',
      getVersionReview: 'this.readModel.getVersionReview',
      readCodeReconstructionCache: 'this.readModel.readCodeReconstructionCache',
      releaseAllWriteReservations: 'this.writeBudgetOwner.releaseAll',
      releaseRunWriteReservations: 'this.writeBudgetOwner.releaseRun',
      releaseWriteReservation: 'this.writeBudgetOwner.release',
      reserveWrite: 'this.writeBudgetOwner.reserve',
      validateFinalizationOwnership: 'this.messageFinalizer.validateOwnership',
      writeCodeReconstructionCache: 'this.readModel.writeCodeReconstructionCache'
    })
  })

  it('keeps portable persisted keys separate from native filesystem paths', () => {
    const storage = sources.get('provenance-storage.ts')!
    const readModel = sources.get('provenance-read-model.ts')!

    expect(storage).toContain("segments.join('/')")
    expect(storage).toContain("key.split('/')")
    expect(storage).toContain("key.includes('\\\\')")
    expect(readModel).toContain("resolveVersionDerivedPath(request, 'code-reconstruction.json')")
    expect(readModel).toContain('syncDirectory(dirname(path))')
    expect(readModel).not.toContain("lastIndexOf('/')")
  })

  it('shares the Reviewer-owned submission projection with command history', () => {
    const readModel = sources.get('provenance-read-model.ts')!
    const reviewerRepository = readFileSync(resolve(__dirname, '../reviewer/repository.ts'), 'utf8')
    const submissionOwner = readFileSync(
      resolve(__dirname, '../reviewer/review-submission-read-model.ts'),
      'utf8'
    )

    for (const consumer of [readModel, reviewerRepository]) {
      expect(consumer).toContain('loadReviewSubmissionProjection')
      expect(consumer).not.toContain('include: { sourceFinding: true }')
    }
    expect(submissionOwner).toContain('client.finding.findMany')
    expect(submissionOwner).toContain('client.reviewFindingDisposition.findMany')
    expect(submissionOwner).toContain('include: { sourceFinding: true }')
  })

  it('keeps submitted-check Artifact Version ownership in the Reviewer projection', () => {
    const reviewerProjection = readFileSync(
      resolve(__dirname, '../reviewer/artifact-version-review.ts'),
      'utf8'
    )
    const artifactPanel = readFileSync(
      resolve(__dirname, '../../renderer/src/pages/workspace/ArtifactProvenancePanel.tsx'),
      'utf8'
    )

    expect(reviewerProjection).toContain('item.assessedArtifactVersionId ??')
    expect(reviewerProjection).toContain('selectedVersionAssessment')
    expect(artifactPanel).toContain('reviewProjection?.selectedVersionAssessment')
    expect(artifactPanel).not.toContain('assessedArtifactVersionId')
    expect(artifactPanel).not.toContain('submittedCheckMatchesArtifactVersion')
  })

  it('keeps owner, interface, consumer and Windows-sensitive impact coverage complete', () => {
    const repositoryRoot = resolve(__dirname, '..', '..', '..')
    const manifest = loadModuleImpactManifest(
      resolve(repositoryRoot, 'scripts', 'ci', 'module-impact.json')
    )
    const module = manifest.modules.artifact_provenance

    expectBoundaryPaths(manifest, 'artifact_provenance', [
      'src/main/artifacts/artifact-provenance-graph.ts',
      'src/main/artifacts/artifact-reproducibility-export.ts',
      'src/main/artifacts/artifact-reproducibility-ipc.ts',
      'src/main/artifacts/artifact-reproducibility-lifecycle.ts',
      'src/main/artifacts/artifact-reproducibility-receipts.ts',
      'src/main/artifacts/compute-output-evidence.ts',
      'src/main/artifacts/provenance-canonical.ts',
      'src/main/artifacts/provenance-content-status.ts',
      'src/main/artifacts/provenance-core-evidence.ts',
      'src/main/artifacts/provenance-dependency-reader.ts',
      'src/main/artifacts/provenance-execution-evidence.ts',
      'src/main/artifacts/provenance-finalization-recovery.ts',
      'src/main/artifacts/provenance-message-finalization.ts',
      'src/main/artifacts/provenance-message-snapshot.ts',
      'src/main/artifacts/provenance-producer-capture.ts',
      'src/main/artifacts/provenance-read-model.ts',
      'src/main/artifacts/provenance-repository.ts',
      'src/main/artifacts/provenance-reproducibility-execution-evidence.ts',
      'src/main/artifacts/provenance-staging-recovery.ts',
      'src/main/artifacts/provenance-storage-contract.ts',
      'src/main/artifacts/provenance-storage.ts',
      'src/main/artifacts/provenance-unindexed-recovery.ts',
      'src/main/artifacts/provenance-version-writer.ts',
      'src/main/artifacts/ro-crate-export.test.ts',
      'src/main/artifacts/ro-crate-export.ts',
      'src/main/artifacts/reviewer-turn-file-evidence-reader.ts',
      'src/main/artifacts/write-budget-owner.ts',
      'src/main/notebook/reproduction-runtime.ts',
      'src/main/notebook/stdlib-replay.fixture.ts',
      'src/renderer/src/pages/workspace/ArtifactReproducibilityPanel.tsx',
      'src/shared/artifact-reproducibility.ts',
      'src/main/artifacts/artifact-provenance-graph.test.ts',
      'src/main/artifacts/artifact-reproducibility-execution.test.ts',
      'src/main/artifacts/artifact-reproducibility-export.test.ts',
      'src/main/artifacts/artifact-reproducibility-ipc.test.ts',
      'src/main/artifacts/artifact-reproducibility-lifecycle.test.ts',
      'src/main/artifacts/artifact-reproducibility-outputs.test.ts',
      'src/main/artifacts/artifact-reproducibility-outputs.ts',
      'src/main/artifacts/artifact-reproducibility-receipts.test.ts',
      'src/main/artifacts/artifact-reproducibility-recipe.test.ts',
      'src/main/artifacts/artifact-save-crash.integration.test.ts',
      'src/main/artifacts/artifact-save.integration.test.ts',
      'src/main/artifacts/artifact-test-fixtures.ts',
      'src/main/artifacts/code-reconstruction.test.ts',
      'src/main/artifacts/code-reconstruction.ts',
      'src/main/artifacts/content-type.test.ts',
      'src/main/artifacts/content-type.ts',
      'src/main/artifacts/ipc.test.ts',
      'src/main/artifacts/ipc.ts',
      'src/main/artifacts/literature-manifest.test.ts',
      'src/main/artifacts/literature-manifest.ts',
      'src/main/artifacts/mcp-server.test.ts',
      'src/main/artifacts/mcp-server.ts',
      'src/main/artifacts/prepared-literature-sidecar.test.ts',
      'src/main/artifacts/prepared-literature-sidecar.ts',
      'src/main/artifacts/provenance-analysis-revision.test.ts',
      'src/main/artifacts/provenance-analysis-revision.ts',
      'src/main/artifacts/provenance-dependency-read.test.ts',
      'src/main/artifacts/provenance-execution-projection.ts',
      'src/main/artifacts/provenance-execution-snapshot-decoder.ts',
      'src/main/artifacts/provenance-helper-evidence.test.ts',
      'src/main/artifacts/provenance-lifecycle-contract.test.ts',
      'src/main/artifacts/provenance-message-snapshot-durability.test.ts',
      'src/main/artifacts/provenance-message-snapshot.test.ts',
      'src/main/artifacts/provenance-reconstruction-evidence.ts',
      'src/main/artifacts/provenance-repository.architecture.test.ts',
      'src/main/artifacts/provenance-repository.test.ts',
      'src/main/artifacts/provenance-reproducibility-projection.test.ts',
      'src/main/artifacts/provenance-snapshot-decoder.test.ts',
      'src/main/artifacts/provenance-snapshot-decoder.ts',
      'src/main/artifacts/provenance-startup.integration.test.ts',
      'src/main/artifacts/provenance-test-fixtures.ts',
      'src/main/artifacts/provenance-version-kind.test.ts',
      'src/main/artifacts/provenance-version-kind.ts',
      'src/main/artifacts/provenance-write-contract.test.ts',
      'src/main/artifacts/repository.characterization.test.ts',
      'src/main/artifacts/reproducibility-notebook-lifecycle.ts',
      'src/main/artifacts/reproducibility-source.ts',
      'src/main/artifacts/reviewer-turn-file-evidence-reader.test.ts',
      'src/main/artifacts/run-registry.ts',
      'src/main/artifacts/save-request.test.ts',
      'src/main/artifacts/save-request.ts',
      'src/main/artifacts/save-test-fixtures.ts',
      'src/main/artifacts/session-reproducibility-store.test.ts',
      'src/main/artifacts/session-reproducibility-store.ts',
      'src/main/artifacts/session-reproducibility.test.ts',
      'src/main/artifacts/session-reproducibility.ts',
      'src/main/artifacts/storage-access.context.test.ts',
      'src/main/artifacts/test-support/save-crash-child.ts',
      'src/main/artifacts/write-budget-owner.test.ts',
      'src/main/notebook/reproduction-runtime.test.ts',
      'src/renderer/src/pages/workspace/ArtifactReproducibilityPanel.test.tsx',
      'src/main/artifacts/resumed-finalization-ownership.test.ts',
      'src/main/artifacts/export-filename.ts',
      'src/main/artifacts/artifact-reproducibility-commands.test.ts',
      'src/main/artifacts/artifact-reproducibility-commands.ts',
      'src/main/artifacts/reproducibility-host.ts',
      'src/main/artifacts/reproducibility-host.test.ts'
    ])
    expect(module.interfacePaths).toEqual(
      expect.arrayContaining([
        'src/main/artifacts/provenance-message-snapshot.ts',
        'src/main/artifacts/provenance-repository.ts',
        'src/main/artifacts/provenance-storage-contract.ts',
        'src/shared/artifact-reproducibility.ts',
        'src/main/artifacts/artifact-provenance-graph.ts',
        'src/main/artifacts/artifact-reproducibility-export.ts',
        'src/main/artifacts/artifact-reproducibility-ipc.ts',
        'src/main/artifacts/artifact-reproducibility-lifecycle.ts',
        'src/main/artifacts/artifact-reproducibility-receipts.ts',
        'src/main/artifacts/artifact-test-fixtures.ts',
        'src/main/artifacts/code-reconstruction.ts',
        'src/main/artifacts/content-type.ts',
        'src/main/artifacts/ipc.ts',
        'src/main/artifacts/literature-manifest.ts',
        'src/main/artifacts/mcp-server.ts',
        'src/main/artifacts/provenance-canonical.ts',
        'src/main/artifacts/provenance-execution-evidence.ts',
        'src/main/artifacts/provenance-message-finalization.ts',
        'src/main/artifacts/provenance-reproducibility-execution-evidence.ts',
        'src/main/artifacts/provenance-snapshot-decoder.ts',
        'src/main/artifacts/provenance-storage.ts',
        'src/main/artifacts/provenance-test-fixtures.ts',
        'src/main/artifacts/provenance-version-kind.ts',
        'src/main/artifacts/provenance-version-writer.ts',
        'src/main/artifacts/reproducibility-notebook-lifecycle.ts',
        'src/main/artifacts/reproducibility-source.ts',
        'src/main/artifacts/run-registry.ts',
        'src/main/artifacts/save-request.ts',
        'src/main/artifacts/save-test-fixtures.ts',
        'src/main/artifacts/session-reproducibility-store.ts',
        'src/main/notebook/reproduction-runtime.ts',
        'src/renderer/src/pages/workspace/ArtifactReproducibilityPanel.tsx',
        'src/main/artifacts/ro-crate-export.ts',
        'src/main/artifacts/artifact-reproducibility-commands.ts',
        'src/main/artifacts/reproducibility-host.ts'
      ])
    )
    expect(module.consumerModules).toEqual(expect.arrayContaining(['session_persistence']))
    expectBoundaryOwnerTests(manifest, 'artifact_provenance', [
      'src/main/artifacts/artifact-provenance-graph.test.ts',
      'src/main/artifacts/artifact-reproducibility-execution.test.ts',
      'src/main/artifacts/artifact-reproducibility-export.test.ts',
      'src/main/artifacts/artifact-reproducibility-lifecycle.test.ts',
      'src/main/artifacts/artifact-reproducibility-receipts.test.ts',
      'src/main/artifacts/artifact-reproducibility-recipe.test.ts',
      'src/main/artifacts/provenance-dependency-read.test.ts',
      'src/main/artifacts/provenance-lifecycle-contract.test.ts',
      'src/main/artifacts/provenance-message-snapshot-durability.test.ts',
      'src/main/artifacts/provenance-message-snapshot.test.ts',
      'src/main/artifacts/provenance-repository.architecture.test.ts',
      'src/main/artifacts/provenance-repository.test.ts',
      'src/main/artifacts/provenance-reproducibility-projection.test.ts',
      'src/main/artifacts/provenance-startup.integration.test.ts',
      'src/main/artifacts/provenance-write-contract.test.ts',
      'src/main/artifacts/reviewer-turn-file-evidence-reader.test.ts',
      'src/main/artifacts/write-budget-owner.test.ts',
      'src/main/notebook/reproduction-runtime.test.ts',
      'src/renderer/src/pages/workspace/ArtifactReproducibilityPanel.test.tsx',
      'src/main/artifacts/artifact-reproducibility-outputs.test.ts',
      'src/main/artifacts/artifact-save-crash.integration.test.ts',
      'src/main/artifacts/artifact-save.integration.test.ts',
      'src/main/artifacts/content-type.test.ts',
      'src/main/artifacts/literature-manifest.test.ts',
      'src/main/artifacts/prepared-literature-sidecar.test.ts',
      'src/main/artifacts/provenance-analysis-revision.test.ts',
      'src/main/artifacts/provenance-helper-evidence.test.ts',
      'src/main/artifacts/provenance-snapshot-decoder.test.ts',
      'src/main/artifacts/provenance-version-kind.test.ts',
      'src/main/artifacts/repository.characterization.test.ts',
      'src/main/artifacts/ro-crate-export.test.ts',
      'src/main/artifacts/save-request.test.ts',
      'src/main/artifacts/session-reproducibility-store.test.ts',
      'src/main/artifacts/session-reproducibility.test.ts',
      'src/main/artifacts/storage-access.context.test.ts',
      'src/main/artifacts/resumed-finalization-ownership.test.ts',
      'src/main/artifacts/artifact-reproducibility-commands.test.ts'
    ])
    expect(module.testFiles.contract).toEqual(
      expect.arrayContaining([
        'src/main/artifacts/artifact-reproducibility-ipc.test.ts',
        'src/main/artifacts/ipc.test.ts',
        'src/main/artifacts/mcp-server.test.ts',
        'src/main/data-content-application-commands.test.ts',
        'src/main/database/managed-file-version-domain.test.ts',
        'src/main/notebook/local-rpc-notebook-adapter.test.ts',
        'src/preload/index.test.ts',
        'src/shared/renderer-contract-catalog.test.ts',
        'src/shared/renderer-surface-inventory.test.ts',
        'src/shared/renderer-surface-matrix.test.ts',
        'src/main/artifacts/reproducibility-host.test.ts'
      ])
    )
    expect(module.capabilityOverlays).toEqual(
      expect.arrayContaining(['windows_sensitive', 'e2e_regressions', 'e2e_delegation'])
    )
    expect(module.fallbackCapability).toBe('main_runtime')
  })
})

it('keeps Literature and Artifact implementations connected only through injected capabilities', () => {
  const root = resolve(__dirname, '../../..')
  const artifacts = resolve(root, 'src/main/artifacts') + sep
  const literature = resolve(root, 'src/main/literature') + sep
  const violations: string[] = []
  for (const file of listProductionSources(root, ['src/main/artifacts', 'src/main/literature'])) {
    const forbidden = file.startsWith(artifacts) ? literature : artifacts
    for (const { fileName: specifier } of preProcessFile(
      readProductionSource(file, root),
      true,
      true
    ).importedFiles) {
      if (specifier.startsWith('.') && resolve(dirname(file), specifier).startsWith(forbidden)) {
        violations.push(`${relative(root, file)} -> ${specifier}`)
      }
    }
  }
  expect(violations).toEqual([])
})
