import { expect, it } from 'vitest'
import { sessionDiagnosticCommandContracts } from './session-diagnostics-contracts'

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
