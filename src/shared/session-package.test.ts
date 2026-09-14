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
