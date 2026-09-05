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

const productionFiles = [
  'provenance-canonical.ts',
  'provenance-content-status.ts',
  'provenance-core-evidence.ts',
  'provenance-dependency-reader.ts',
  'provenance-execution-evidence.ts',
  'provenance-finalization-recovery.ts',
  'provenance-message-finalization.ts',
  'provenance-message-snapshot.ts',
  'provenance-producer-capture.ts',
  'provenance-read-model.ts',
  'provenance-repository.ts',
  'reviewer-turn-file-evidence-reader.ts',
  'provenance-staging-recovery.ts',
  'provenance-storage.ts',
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

describe('Artifact Provenance repository architecture', () => {
  const facadeFile = sourceFileFor('provenance-repository.ts')
  const facade = classFrom('provenance-repository.ts', 'ArtifactProvenanceRepository')

  it('keeps the established public facade and private projection helpers', () => {
    expect(methods(facade, 'public')).toEqual(
      [
        'activateFinalizedRun',
        'createVersion',
        'deleteProjectProvenance',
        'finalizeRun',
        'getLineage',
        'getReviewerVersionTrace',
        'getVersionCore',
        'readDependencyRelations',
        'getVersionExecution',
        'getVersionMessages',
        'getVersionProvenance',
        'getVersionReview',
        'listRunVersions',
        'prepareProjectReconciliation',
        'readCodeReconstructionCache',
        'reconcileSession',
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
      ['resolveVersionDerivedPath', 'toArtifactVersionFile', 'toDescriptor'].sort()
    )
  })

  it('composes each state owner exactly once without mutable facade fields', () => {
    for (const owner of [
      'ArtifactProvenanceDependencyReader',
      'ArtifactProvenanceFinalizationRecovery',
      'ArtifactProvenanceMessageFinalizer',
      'ArtifactProvenanceProducerCapture',
      'ArtifactProvenanceReadModel',
      'ReviewerTurnFileEvidenceReader',
      'ArtifactProvenanceStagingRecovery',
      'ArtifactProvenanceUnindexedRecovery',
      'ArtifactProvenanceVersionWriter',
      'ArtifactWriteBudgetOwner'
    ]) {
      expect(newExpressionSites(owner), owner).toEqual(['provenance-repository.ts:constructor'])
    }
    expect(fields(facade)).toEqual(
      [
        'compatibilityRepository',
        'createId',
        'durability',
        'dependencyReader',
        'finalizationRecovery',
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
    const manifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'scripts', 'ci', 'module-impact.json'), 'utf8')
    ) as ModuleImpactManifest
    const module = manifest.modules.artifact_provenance

    expect(module.ownerPaths).toEqual(
      productionFiles.map((file) => `src/main/artifacts/${file}`).sort()
    )
    expect(module.interfacePaths).toEqual(
      [
        'src/main/artifacts/provenance-message-snapshot.ts',
        'src/main/artifacts/provenance-repository.ts'
      ].sort()
    )
    expect(module.consumerModules).toEqual(['session_persistence'])
    expect(module.testFiles.owner).toEqual(
      [
        'src/main/artifacts/provenance-lifecycle-contract.test.ts',
        'src/main/artifacts/provenance-dependency-read.test.ts',
        'src/main/artifacts/provenance-message-snapshot-durability.test.ts',
        'src/main/artifacts/provenance-message-snapshot.test.ts',
        'src/main/artifacts/provenance-repository.architecture.test.ts',
        'src/main/artifacts/provenance-repository.test.ts',
        'src/main/artifacts/reviewer-turn-file-evidence-reader.test.ts',
        'src/main/artifacts/provenance-write-contract.test.ts',
        'src/main/artifacts/write-budget-owner.test.ts'
      ].sort()
    )
    expect(module.testFiles.contract).toEqual(
      [
        'src/main/artifacts/ipc.test.ts',
        'src/main/artifacts/mcp-server.test.ts',
        'src/main/data-content-application-commands.test.ts',
        'src/main/notebook/local-rpc-notebook-adapter.test.ts',
        'src/preload/index.test.ts'
      ].sort()
    )
    expect(module.testFiles.consumer).toEqual(
      [
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
        'src/renderer/src/pages/workspace/artifact-publication-preview.integration.test.tsx'
      ].sort()
    )
    expect(module.capabilityOverlays).toEqual(['windows_sensitive'])
    expect(module.fallbackCapability).toBe('main_runtime')
  })
})
