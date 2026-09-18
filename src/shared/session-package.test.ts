import { sessionPackageCommandContracts } from './session-package'
import { expect, it } from 'vitest'
import { packageOperationRequestSchema, sessionPackageImportRequestSchema } from './session-package'

it('accepts one bounded destination and keeps project-name drafts ephemeral', () => {
  expect(sessionPackageImportRequestSchema.parse({ projectName: '  Research  ' })).toEqual({
    projectName: 'Research'
  })
  expect(
    sessionPackageImportRequestSchema.safeParse({ projectId: 'existing', projectName: 'New' })
      .success
  ).toBe(false)
  expect(sessionPackageImportRequestSchema.safeParse({ projectName: ' ' }).success).toBe(false)
  expect(
    sessionPackageImportRequestSchema.safeParse({ projectName: 'a'.repeat(201) }).success
  ).toBe(false)
  for (const target of [{ projectId: 'existing' }, { projectName: 'New research' }]) {
    expect(
      packageOperationRequestSchema.parse({ action: 'select-project', operationId: 'op', target })
    ).toMatchObject({ target })
  }
  expect(
    packageOperationRequestSchema.safeParse({
      action: 'select-project',
      operationId: 'op',
      target: {}
    }).success
  ).toBe(false)
})

it('transports Literature selection through the package operation contract', () => {
  const snapshot = {
    id: 'operation',
    kind: 'export',
    state: 'awaiting-selection',
    progress: { phase: 'selecting' },
    files: [
      {
        storageKey: 'uploads/p/s/a/versions/v/content',
        filename: 'paper.pdf',
        sizeBytes: 42,
        groupId: 'a',
        source: 'literature',
        versionNumber: 1,
        dependentFiles: []
      }
    ]
  }
  expect(sessionPackageCommandContracts.operation.result.parse(snapshot)).toEqual(snapshot)
})
