import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('publishes the complete safe Connector and credential contracts', () => {
  const path = resolve('packages/open-science/connector-contract.fixture.ts')
  const source = `
    import type { OpenScienceClient } from './index'
    import type * as Shared from '../../src/shared/settings'
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
    type Assert<T extends true> = T
    type List = Assert<Equal<Awaited<ReturnType<OpenScienceClient['listConnectors']>>, Shared.ConnectorsSnapshot>>
    type Detail = Assert<Equal<Awaited<ReturnType<OpenScienceClient['getConnector']>>, Shared.ConnectorDetailView | Shared.CustomServerView>>
    type Add = Assert<Equal<Parameters<OpenScienceClient['addConnector']>[0], Shared.AddCustomServerRequest>>
    type Update = Assert<Equal<Parameters<OpenScienceClient['updateConnector']>[1], Omit<Shared.UpdateCustomServerRequest, 'id'>>>
    type Credentials = Assert<Equal<Awaited<ReturnType<OpenScienceClient['listCredentials']>>, Shared.DeviceCredentialsSnapshot>>
    type Create = Assert<Equal<Parameters<OpenScienceClient['createCredential']>[0], Shared.CreateDeviceCredentialRequest>>
    type Created = Assert<Equal<Awaited<ReturnType<OpenScienceClient['createCredential']>>, Shared.CreateDeviceCredentialResult>>
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
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === path
      ? ts.createSourceFile(path, source, languageVersion)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([path], options, host)
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === path)
  expect(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  ).toEqual([])
}, 15_000)
