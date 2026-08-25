import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { app } from 'electron'

import {
  NodeVersionFileOperator,
  VersionFileOperatorError
} from '../src/main/managed-file-versions/version-file-operator'

const runContract = async (): Promise<void> => {
  assert.equal(process.type, 'browser', 'Contract must run in the Electron main process.')
  assert.ok(process.versions.electron, 'Electron version must be available to the contract.')

  await app.whenReady()

  const storageRoot = process.env.OPEN_SCIENCE_VERSION_FILE_OPERATOR_STORAGE_ROOT
  assert.ok(storageRoot, 'Electron contract storage root must be owned by the parent runner.')
  const operator = new NodeVersionFileOperator({ storageRoot })
  const planInput = {
    operationId: 'electron-main-process-contract',
    scope: {
      source: 'artifact' as const,
      projectId: 'project-electron',
      sessionId: 'session-electron',
      logicalFileId: 'artifact-electron'
    },
    logicalFilename: 'contract.txt',
    candidateIndex: 0
  }
  const plannedFile = operator.planImmutable(planInput)
  const content = Buffer.from('Electron main-process immutable version contract.\n')
  const expectedChecksum = createHash('sha256').update(content).digest('hex')

  // Exercise the immutable publication and read lease against the host OS filesystem.
  const stored = await operator.publishImmutable({ ...planInput, plannedFile, content })
  assert.deepEqual(stored, {
    storageRef: plannedFile.storageRef,
    storedFilename: plannedFile.storedFilename,
    sizeBytes: content.byteLength,
    checksum: expectedChecksum,
    versionToken: plannedFile.versionToken
  })

  const lease = await operator.openImmutable(plannedFile.storageRef, stored)
  try {
    assert.deepEqual(Buffer.from(await lease.readRange(0, content.byteLength)), content)
    await lease.verifyUnchanged()
  } finally {
    await lease.close()
  }

  // A retry of the same operation and bytes must resolve to the original immutable result.
  assert.deepEqual(await operator.publishImmutable({ ...planInput, plannedFile, content }), stored)

  // The same immutable destination rejects different bytes without changing the published version.
  await assert.rejects(
    operator.publishImmutable({
      ...planInput,
      plannedFile,
      content: Buffer.from('Different Electron main-process contract bytes.\n')
    }),
    (error: unknown) => {
      assert.ok(error instanceof VersionFileOperatorError)
      assert.equal(error.code, 'INTEGRITY_FAILED')
      assert.equal(error.reason, 'DESTINATION_COLLISION')
      return true
    }
  )
  const preservedLease = await operator.openImmutable(plannedFile.storageRef, stored)
  try {
    assert.deepEqual(Buffer.from(await preservedLease.readRange(0, content.byteLength)), content)
    await preservedLease.verifyUnchanged()
  } finally {
    await preservedLease.close()
  }

  await operator.removeImmutable(plannedFile.storageRef, stored)
  await assert.rejects(operator.openImmutable(plannedFile.storageRef, stored), (error: unknown) => {
    assert.ok(error instanceof VersionFileOperatorError)
    assert.equal(error.code, 'INTEGRITY_FAILED')
    return true
  })
  await operator.removeImmutable(plannedFile.storageRef, stored)
}

void runContract().then(
  () => {
    console.log(`VersionFileOperator Electron contract passed on ${process.platform}.`)
    app.exit(0)
  },
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
)
