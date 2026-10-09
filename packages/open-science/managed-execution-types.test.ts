import { resolve, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('publishes managed execution requests compatible with strict application schemas', () => {
  const path = resolve('packages/open-science/managed-execution-contract.fixture.ts')
    .split(sep)
    .join('/')
  const source = `
    import type * as SDK from './index'
    import type * as Shared from '../../src/shared/managed-execution'
    import type { SessionPackagePreview, SessionPackageImportRequest } from '../../src/shared/session-package'
    type Assert<T extends true> = T
    type Compatible<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
    type Create = Assert<Compatible<SDK.CreateManagedSessionRequest, Shared.CreateManagedSessionRequest>>
    type Inspect = Assert<Compatible<SDK.InspectManagedMaterialsRequest, Shared.InspectManagedMaterialsRequest>>
    type Prepare = Assert<Compatible<SDK.PrepareManagedEnvironmentRequest, Shared.PrepareManagedEnvironmentRequest>>
    type Execute = Assert<Compatible<SDK.ExecuteManagedEnvironmentRequest, Shared.ExecuteManagedEnvironmentRequest>>
    type Environment = Assert<Compatible<SDK.ManagedEnvironmentReference, Shared.ManagedEnvironmentReference>>
    type Collection = Assert<Compatible<SDK.ManagedCollectionReference, Shared.ManagedCollectionReference>>
    type Collect = Assert<Compatible<SDK.CollectManagedOutputsRequest, Shared.CollectManagedOutputsRequest>>
    type CollectResult = Assert<Compatible<Awaited<ReturnType<SDK.ManagedExecutionClient['collectOutputs']>>, SDK.SessionOperationSnapshot>>
    type DiscardResult = Assert<Compatible<Awaited<ReturnType<SDK.ManagedExecutionClient['discardOutputs']>>, SDK.ManagedEnvironment>>
    type NoRecoveryAuthority = Assert<'recoveryAuthority' extends keyof SDK.CollectManagedOutputsRequest ? false : true>
    type NoWriteAttempt = Assert<'writeAttempt' extends keyof SDK.CollectManagedOutputsRequest ? false : true>
    type NoProvenance = Assert<'provenance' extends keyof SDK.ManagedCollectionReference ? false : true>
    type Operation = Assert<Compatible<SDK.ManagedOperationReference, Shared.ManagedOperationReference>>
    type NoRuntimePath = Assert<'executable' extends keyof SDK.ManagedRuntime ? false : true>
    type NoRoots = Assert<'readOnlyRoots' extends keyof SDK.ManagedRuntime ? false : true>
    type RuntimeDiagnostics = Assert<Compatible<SDK.ManagedRuntimeDiagnostics, Shared.ManagedRuntimeDiagnostics>>
    type DiagnosticCodes = Assert<Compatible<SDK.ManagedRuntimeDiagnosticCode, Shared.ManagedRuntimeDiagnosticCode>>
    type RuntimeDiscovery = Assert<Compatible<Awaited<ReturnType<SDK.ManagedExecutionClient['runtimes']>>, SDK.ManagedRuntimeDiscovery>>
    type NoDiagnosticPath = Assert<'candidate' extends keyof SDK.ManagedRuntimeDiagnostics['issues'][number] ? false : true>
    const legacyRuntimeDiscovery: SDK.ManagedRuntimeDiscovery = { available: false, runtimes: [] }
    type NoCapability = Assert<'capability' extends keyof SDK.ManagedEnvironment ? false : true>
    type PackagePreview = Assert<Compatible<SDK.PackagePreview, SessionPackagePreview>>
    type PackageTarget = Assert<SDK.PackageImportTarget extends SessionPackageImportRequest ? true : false>
    declare const client: SDK.OpenScienceClient
    client.execution.runtimes().then(result => result.diagnostics?.issues.map(issue => issue.code))
    client.execution.getEnvironment({ projectId: 'p', sessionId: 's', environmentId: 'e' }).then(result => result.pendingCollection?.collectionId)
    client.execution.collectOutputs({ projectId: 'p', sessionId: 's', environmentId: 'e', collectionId: 'c', requestId: 'collect-1' })
    client.execution.discardOutputs({ projectId: 'p', sessionId: 's', environmentId: 'e', collectionId: 'c' })
    // @ts-expect-error Collection never accepts caller-issued provenance.
    client.execution.collectOutputs({ projectId: 'p', sessionId: 's', environmentId: 'e', collectionId: 'c', requestId: 'r', provenance: {} })
    // @ts-expect-error Discard requires an explicit pending collection.
    client.execution.discardOutputs({ projectId: 'p', sessionId: 's', environmentId: 'e' })
    client.packages.preflightImport({ filePath: '/research.science', target: { projectId: 'p' } })
    client.packages.commitImport({ preflightId: 'review' })
    // @ts-expect-error An explicit import destination is required.
    client.packages.preflightImport({ filePath: '/research.science', target: {} })
    // @ts-expect-error Sensitive content bypass is not offered to automation.
    client.packages.export({ projectId: 'p', sessionId: 's', filePath: '/export.science', allowSensitiveContent: true })
    client.execution.execute({ projectId: 'p', sessionId: 's', environmentId: 'e', requestId: 'r', command: 'node --version' })
  `
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: []
  }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, onError, fresh) =>
    name === path
      ? ts.createSourceFile(path, source, version)
      : original(name, version, onError, fresh)
  const program = ts.createProgram([path], options, host)
  expect(program.getSourceFile(path)).toBeDefined()
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === path)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  ).toEqual([])
}, 15_000)
