import { expect, it } from 'vitest'
import { sessionDiagnosticCommandContracts } from './session-diagnostics-contracts'

it('accepts application diagnostics without a session and rejects mixed or unscoped identities', () => {
  const request = {
    scope: 'application',
    operationId: 'export-1',
    selectedItems: ['resource-logs']
  }
  expect(sessionDiagnosticCommandContracts.export.args.parse([request])).toEqual([request])
  for (const invalid of [
    { ...request, projectId: 'p', sessionId: 's' },
    { operationId: 'export-1' },
    { scope: 'unknown', operationId: 'export-1' }
  ])
    expect(() => sessionDiagnosticCommandContracts.inspect.args.parse([invalid])).toThrow()
})

it('accepts explicit execution-code opt-in and rejects non-boolean values at the command boundary', () => {
  const request = {
    projectId: 'project',
    sessionId: 'session',
    operationId: 'operation',
    selectedItems: ['notebook'],
    includeExecutionCode: true
  }
  expect(sessionDiagnosticCommandContracts.export.args.parse([request])).toEqual([request])
  expect(() =>
    sessionDiagnosticCommandContracts.export.args.parse([
      { ...request, includeExecutionCode: 'true' }
    ])
  ).toThrow()
})
