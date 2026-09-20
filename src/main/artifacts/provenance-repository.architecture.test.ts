import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  'artifact-reproducibility-execution.ts',
  'artifact-reproducibility-export.ts',
  'artifact-reproducibility-ipc.ts',
  'artifact-reproducibility-lifecycle.ts',
  'artifact-reproducibility-receipts.ts',
  'artifact-reproducibility-recipe.ts',
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
  'provenance-reproducibility-projection.ts',
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

    expect(module.ownerPaths).toEqual([
      'src/main/artifacts/artifact-provenance-graph.ts',
      'src/main/artifacts/artifact-reproducibility-execution.ts',
      'src/main/artifacts/artifact-reproducibility-export.ts',
      'src/main/artifacts/artifact-reproducibility-ipc.ts',
      'src/main/artifacts/artifact-reproducibility-lifecycle.ts',
      'src/main/artifacts/artifact-reproducibility-receipts.ts',
      'src/main/artifacts/artifact-reproducibility-recipe.ts',
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
      'src/main/artifacts/provenance-reproducibility-projection.ts',
      'src/main/artifacts/provenance-staging-recovery.ts',
      'src/main/artifacts/provenance-storage-contract.ts',
      'src/main/artifacts/provenance-storage.ts',
      'src/main/artifacts/provenance-unindexed-recovery.ts',
      'src/main/artifacts/provenance-version-writer.ts',
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
      'src/main/artifacts/durability.test.ts',
      'src/main/artifacts/durability.ts',
      'src/main/artifacts/ipc.test.ts',
      'src/main/artifacts/ipc.ts',
      'src/main/artifacts/literature-manifest.test.ts',
      'src/main/artifacts/literature-manifest.ts',
      'src/main/artifacts/mcp-server.test.ts',
      'src/main/artifacts/mcp-server.ts',
      'src/main/artifacts/output-comparison-worker.ts',
      'src/main/artifacts/output-comparison.test.ts',
      'src/main/artifacts/output-comparison.ts',
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
      'src/main/artifacts/reproduction-preflight.test.ts',
      'src/main/artifacts/reproduction-preflight.ts',
      'src/main/artifacts/reviewer-turn-file-evidence-reader.test.ts',
      'src/main/artifacts/run-registry.ts',
      'src/main/artifacts/save-request.test.ts',
      'src/main/artifacts/save-request.ts',
      'src/main/artifacts/save-test-fixtures.ts',
      'src/main/artifacts/scientific-output-comparison.test.ts',
      'src/main/artifacts/scientific-output-comparison.ts',
      'src/main/artifacts/session-reproducibility-store.test.ts',
      'src/main/artifacts/session-reproducibility-store.ts',
      'src/main/artifacts/session-reproducibility.test.ts',
      'src/main/artifacts/session-reproducibility.ts',
      'src/main/artifacts/storage-access.context.test.ts',
      'src/main/artifacts/test-support/save-crash-child.ts',
      'src/main/artifacts/write-budget-owner.test.ts',
      'src/main/notebook/reproduction-runtime.test.ts',
      'src/renderer/src/pages/workspace/ArtifactReproducibilityPanel.test.tsx',
      'src/main/notebook/dependency-analysis.stdlib-replay.test.ts'
    ])
    expect(module.interfacePaths).toEqual([
      'src/main/artifacts/provenance-message-snapshot.ts',
      'src/main/artifacts/provenance-repository.ts',
      'src/main/artifacts/provenance-storage-contract.ts',
      'src/shared/artifact-reproducibility.ts',
      'src/main/artifacts/artifact-provenance-graph.ts',
      'src/main/artifacts/artifact-reproducibility-export.ts',
      'src/main/artifacts/artifact-reproducibility-ipc.ts',
      'src/main/artifacts/artifact-reproducibility-lifecycle.ts',
      'src/main/artifacts/artifact-reproducibility-receipts.ts',
      'src/main/artifacts/artifact-reproducibility-recipe.ts',
      'src/main/artifacts/artifact-test-fixtures.ts',
      'src/main/artifacts/code-reconstruction.ts',
      'src/main/artifacts/content-type.ts',
      'src/main/artifacts/durability.ts',
      'src/main/artifacts/ipc.ts',
      'src/main/artifacts/literature-manifest.ts',
      'src/main/artifacts/mcp-server.ts',
      'src/main/artifacts/provenance-canonical.ts',
      'src/main/artifacts/provenance-execution-evidence.ts',
      'src/main/artifacts/provenance-message-finalization.ts',
      'src/main/artifacts/provenance-reproducibility-execution-evidence.ts',
      'src/main/artifacts/provenance-reproducibility-projection.ts',
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
      'src/renderer/src/pages/workspace/ArtifactReproducibilityPanel.tsx'
    ])
    expect(module.consumerModules).toEqual(['session_persistence'])
    expect(module.testFiles.owner).toEqual([
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
      'src/main/notebook/dependency-analysis.stdlib-replay.test.ts',
      'src/main/notebook/reproduction-runtime.test.ts',
      'src/renderer/src/pages/workspace/ArtifactReproducibilityPanel.test.tsx',
      'src/main/artifacts/artifact-reproducibility-outputs.test.ts',
      'src/main/artifacts/artifact-save-crash.integration.test.ts',
      'src/main/artifacts/artifact-save.integration.test.ts',
      'src/main/artifacts/content-type.test.ts',
      'src/main/artifacts/durability.test.ts',
      'src/main/artifacts/literature-manifest.test.ts',
      'src/main/artifacts/output-comparison.test.ts',
      'src/main/artifacts/prepared-literature-sidecar.test.ts',
      'src/main/artifacts/provenance-analysis-revision.test.ts',
      'src/main/artifacts/provenance-helper-evidence.test.ts',
      'src/main/artifacts/provenance-snapshot-decoder.test.ts',
      'src/main/artifacts/provenance-version-kind.test.ts',
      'src/main/artifacts/repository.characterization.test.ts',
      'src/main/artifacts/reproduction-preflight.test.ts',
      'src/main/artifacts/save-request.test.ts',
      'src/main/artifacts/scientific-output-comparison.test.ts',
      'src/main/artifacts/session-reproducibility-store.test.ts',
      'src/main/artifacts/session-reproducibility.test.ts',
      'src/main/artifacts/storage-access.context.test.ts'
    ])
    expect(module.testFiles.contract).toEqual([
      'src/main/artifacts/artifact-reproducibility-ipc.test.ts',
      'src/main/artifacts/ipc.test.ts',
      'src/main/artifacts/mcp-server.test.ts',
      'src/main/data-content-application-commands.test.ts',
      'src/main/database/managed-file-version-domain.test.ts',
      'src/main/notebook/local-rpc-notebook-adapter.test.ts',
      'src/preload/index.test.ts',
      'src/shared/renderer-contract-catalog.test.ts',
      'src/shared/renderer-surface-inventory.test.ts',
      'src/shared/renderer-surface-matrix.test.ts'
    ])
    expect(module.testFiles.consumer).toEqual([
      'src/main/session-persistence/runtime-session-owner.test.ts',
      'src/main/session-plan/adversarial-session-plan.test.ts',
      'src/main/acp/file-reference-resolver.test.ts',
      'src/main/acp/runtime.test.ts',
      'src/main/artifacts/code-reconstruction.test.ts',
      'src/main/notebook/local-rpc-server.test.ts',
      'src/main/reviewer/ipc.test.ts',
      'src/main/session-persistence/artifact-finalization-recovery.integration.test.ts',
      'src/main/session-persistence/coordinator.test.ts',
      'src/main/session-persistence/deletion-integration.test.ts',
      'src/main/tasks/task-runner.test.ts',
      'src/renderer/src/lib/acp/workspace-events.test.ts',
      'src/renderer/src/pages/workspace/ArtifactProvenancePanel.render.test.tsx',
      'src/renderer/src/pages/workspace/PreviewFileSurface.test.tsx',
      'src/renderer/src/pages/workspace/WorkspaceMessageScroller.interaction.test.tsx',
      'src/renderer/src/pages/workspace/artifact-publication-preview.integration.test.tsx',
      'src/main/acp/application-commands.test.ts',
      'src/main/acp/artifact-code-reconstruction-runner.test.ts',
      'src/main/acp/artifact-turn-owner.test.ts',
      'src/main/acp/codex-completion-handoff.integration.test.ts',
      'src/main/acp/context-compaction-workflow.test.ts',
      'src/main/acp/context-usage-policy.test.ts',
      'src/main/acp/context-usage-static-context.test.ts',
      'src/main/acp/durable-continuation-context-owner.test.ts',
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
      'src/main/application-command-composition.test.ts',
      'src/main/application-command-electron-adapter.test.ts',
      'src/main/artifacts/repository.rollback.test.ts',
      'src/main/artifacts/repository.test.ts',
      'src/main/bookmarks/pdf-source-diagnostics.test.ts',
      'src/main/bookmarks/service.test.ts',
      'src/main/compute/application-commands.test.ts',
      'src/main/compute/compute-job-workflow-owner.test.ts',
      'src/main/compute/compute-service.architecture.test.ts',
      'src/main/compute/job-deletion-runtime-drain.test.ts',
      'src/main/compute/job-deletion-runtime-isolation.test.ts',
      'src/main/compute/session-catalog-hydration.integration.test.ts',
      'src/main/connectors/application.test.ts',
      'src/main/database/literature-inbox-integrity-migration.test.ts',
      'src/main/database/migration-service.test.ts',
      'src/main/delegation/delegated-artifact-evidence.test.ts',
      'src/main/delegation/production-composition.test.ts',
      'src/main/delegation/production-framework-runtime.test.ts',
      'src/main/delegation/session-record-adapter.test.ts',
      'src/main/host-application-commands.test.ts',
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
      'src/main/managed-preview-protocol.test.ts',
      'src/main/managed-preview-resources.test.ts',
      'src/main/notebook/cross-turn-input-repro.integration.test.ts',
      'src/main/notebook/delegated-lane-capability.test.ts',
      'src/main/notebook/dependency-analysis.r-directory.test.ts',
      'src/main/notebook/dependency-analysis.r-plot-repro.test.ts',
      'src/main/notebook/e2e.certification.test.ts',
      'src/main/notebook/environment-state-tracker.test.ts',
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
      'src/main/notebook/local-rpc-server.user-input.test.ts',
      'src/main/notebook/local-rpc-server.wsl-setup.test.ts',
      'src/main/notebook/mcp-management-lifecycle.integration.test.ts',
      'src/main/notebook/mcp-server.test.ts',
      'src/main/notebook/no-legacy-bridge.test.ts',
      'src/main/notebook/python-loop.integration.test.ts',
      'src/main/notebook/repl-loop.integration.test.ts',
      'src/main/notebook/reproduction-runtime.integration.test.ts',
      'src/main/notebook/runtime-application-commands.test.ts',
      'src/main/notebook/working-file-observer.test.ts',
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
      'src/main/reviewer/artifact-digest.test.ts',
      'src/main/reviewer/correction-context.test.ts',
      'src/main/reviewer/correction-owner.test.ts',
      'src/main/reviewer/correction.test.ts',
      'src/main/reviewer/fix-loop.test.ts',
      'src/main/reviewer/flag-stale-reviews.test.ts',
      'src/main/reviewer/host-sdk-tabular.test.ts',
      'src/main/reviewer/host-sdk.test.ts',
      'src/main/reviewer/image-content.integration.test.ts',
      'src/main/reviewer/image-generation-trace.integration.test.ts',
      'src/main/reviewer/lifecycle.test.ts',
      'src/main/reviewer/log-capture.test.ts',
      'src/main/reviewer/mcp-server.test.ts',
      'src/main/reviewer/model-runtime-owner.test.ts',
      'src/main/reviewer/orchestrator-drive.test.ts',
      'src/main/reviewer/orchestrator-prompt-prefix.test.ts',
      'src/main/reviewer/orchestrator-prompt.test.ts',
      'src/main/reviewer/orchestrator.start-contract.test.ts',
      'src/main/reviewer/orchestrator.test.ts',
      'src/main/reviewer/paged-preview-electron.test.ts',
      'src/main/reviewer/paged-preview-resolver.test.ts',
      'src/main/reviewer/review-assessment-owner.test.ts',
      'src/main/reviewer/reviewer-fix-loop-owner.test.ts',
      'src/main/reviewer/reviewer-orchestrator.architecture.test.ts',
      'src/main/reviewer/reviewer-regression-gate.integration.test.ts',
      'src/main/reviewer/reviewer-resilience.test.ts',
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
      'src/main/session-persistence/claude-replay.test.ts',
      'src/main/session-persistence/coordinator-contract.test.ts',
      'src/main/session-persistence/delegated-work-records.test.ts',
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
      'src/main/update/legacy-shell-recovery.integration.test.ts',
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
      'src/preload/electron-renderer-contract-adapter.test.ts',
      'src/renderer/src/App.test.tsx',
      'src/renderer/src/components/global-search/GlobalSearchDialog.i18n.render.test.tsx',
      'src/renderer/src/components/global-search/GlobalSearchDialog.test.tsx',
      'src/renderer/src/hooks/useLifecycleSync.test.tsx',
      'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.test.ts',
      'src/renderer/src/lib/session-persistence/session-persistence.test.ts',
      'src/renderer/src/main.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureFullTextLookup.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureLibraryPage.render.test.tsx',
      'src/renderer/src/pages/literature/LiteratureMetadataEditor.test.tsx',
      'src/renderer/src/pages/onboarding/NotebookStep.render.test.tsx',
      'src/renderer/src/pages/onboarding/OnboardingWizard.regressions.test.tsx',
      'src/renderer/src/pages/onboarding/OnboardingWizard.render.test.tsx',
      'src/renderer/src/pages/settings/RuntimesPanel.render.test.tsx',
      'src/renderer/src/pages/settings/SettingsPage.render.test.tsx',
      'src/renderer/src/pages/workspace/ArtifactProvenanceMessages.integration.test.tsx',
      'src/renderer/src/pages/workspace/FilePreviewDialog.escape.test.tsx',
      'src/renderer/src/pages/workspace/FilePreviewDialog.focus.test.tsx',
      'src/renderer/src/pages/workspace/FilePreviewDialog.lifecycle.test.tsx',
      'src/renderer/src/pages/workspace/FilePreviewDialog.versioning.test.tsx',
      'src/renderer/src/pages/workspace/MobilePreviewSheet.annotation.test.tsx',
      'src/renderer/src/pages/workspace/PreviewFileSurface.freshness.test.tsx',
      'src/renderer/src/pages/workspace/PreviewPanel.test.tsx',
      'src/renderer/src/pages/workspace/SessionReproducibilityDialog.test.tsx',
      'src/renderer/src/pages/workspace/SubagentReleaseSurfaces.render.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.customize-prefill.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.draft-preservation.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.edit-message.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.image-staging.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.notebook-hydration.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.pending-switch.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.preview-panel-resize.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.send-gate.test.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.specialist-barrier.test.tsx',
      'src/renderer/src/pages/workspace/artifact-environment-lock-store.test.ts',
      'src/renderer/src/pages/workspace/handoff-lifecycle-source.test.ts',
      'src/renderer/src/pages/workspace/preview-draft-lifecycle.test.tsx',
      'src/renderer/src/pages/workspace/previews/preview-pagination-contract.test.tsx',
      'src/renderer/web/api-installer.test.ts',
      'src/renderer/web/bootstrap.test.ts',
      'src/renderer/web/renderer-argument-shape-characterization.test.ts',
      'src/main/settings/skill-catalog.test.ts',
      'src/main/session-package/fork.test.ts',
      'src/main/storage/brand-location.test.ts',
      'src/main/storage/migration-target-race.test.ts',
      'src/renderer/src/components/LegacyDataMoveDialog.storage.test.tsx',
      'src/main/settings/provider-runtime-health-owner.test.ts',
      'src/renderer/src/pages/workspace/workspace-message-queue-controller.test.ts',
      'src/main/session-persistence/runtime-authority.test.ts',
      'src/main/session-persistence/runtime-resume-recovery.test.ts',
      'src/renderer/src/lib/acp/workspace-runtime-interrupted-recovery.test.ts'
    ])
    expect(module.capabilityOverlays).toEqual([
      'windows_sensitive',
      'e2e_regressions',
      'e2e_delegation'
    ])
    expect(module.fallbackCapability).toBe('main_runtime')
  })
})
