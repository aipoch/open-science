import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  rename as renameFile,
  rm,
  rmdir,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

let cleanupRoot: string | undefined

// NTFS refuses to rename a directory while a descendant file handle is still open, so parent-swap
// cases that depend on that TOCTOU stay POSIX-only. Windows still fail-closes at the OS rename.
const posixIt = process.platform === 'win32' ? it.skip : it

afterEach(async () => {
  if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true })
  cleanupRoot = undefined
})

describe('NodeVersionFileOperator', () => {
  it('plans a deterministic immutable artifact destination for an operation candidate', async () => {
    const module = await import('./version-file-operator').catch(() => undefined)

    expect(module).toBeDefined()
    if (!module) return

    const operator = new module.NodeVersionFileOperator({ storageRoot: '/data' })
    const input = {
      operationId: 'operation-123',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }

    const first = operator.planImmutable(input)
    const replay = operator.planImmutable(input)

    expect(replay).toEqual(first)
    expect(first.versionToken).toMatch(/^[a-z0-9]{8}$/u)
    expect(first.storedFilename).toBe(`v${first.versionToken}_README.md`)
    expect(first.storageRef).toBe(
      `artifacts/project-1/session-1/artifact-1/managed-versions/${first.storedFilename}`
    )
    expect(first.candidateIndex).toBe(0)
  })

  it('publishes the planned bytes and returns their measured integrity', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-publish',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('immutable content\n')

    const stored = await operator.publishImmutable({ ...planInput, plannedFile, content })

    expect(stored).toEqual({
      storageRef: plannedFile.storageRef,
      storedFilename: plannedFile.storedFilename,
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex'),
      versionToken: plannedFile.versionToken
    })
    await expect(
      readFile(join(cleanupRoot, ...plannedFile.storageRef.split('/')))
    ).resolves.toEqual(content)
  })

  it('publishes when the configured file system does not support hard links', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        link: async () => {
          throw Object.assign(new Error('hard links are not supported'), { code: 'ENOTSUP' })
        }
      }
    })
    const planInput = {
      operationId: 'operation-no-hard-links',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('publish without hard links')

    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).resolves.toMatchObject({
      storageRef: plannedFile.storageRef,
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    })
  })

  it('recovers a publication interrupted after the final exclusive create', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    let interruptAfterCreate = true
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (!interruptAfterCreate || typeof args[1] !== 'string' || !args[1].startsWith('wx')) {
            return handle
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'stat') {
                return async () => {
                  interruptAfterCreate = false
                  throw Object.assign(new Error('interrupted after create'), { code: 'EIO' })
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const planInput = {
      operationId: 'operation-interrupted-after-final-create',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('retry the same operation after cleanup')
    const expectedIntegrity = {
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    }

    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    const inspection = await operator.inspectRecovery({
      ...planInput,
      plannedFile,
      expectedIntegrity
    })
    expect(inspection).toMatchObject({ state: 'incomplete' })
    if (inspection.state !== 'incomplete') return

    await operator.removeIncomplete({
      ...planInput,
      plannedFile,
      actualIntegrity: inspection.actualIntegrity
    })
    await expect(
      readFile(join(cleanupRoot, ...plannedFile.storageRef.split('/')))
    ).resolves.toHaveLength(0)
    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED', reason: 'DESTINATION_COLLISION' })
    const retryInput = { ...planInput, candidateIndex: 1 }
    const retryPlan = operator.planImmutable(retryInput)
    await expect(
      operator.publishImmutable({ ...retryInput, plannedFile: retryPlan, content })
    ).resolves.toMatchObject(expectedIntegrity)
  })

  it('fails closed when the version parent changes during recovery reservation', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    const replacementParent = join(outsideRoot, 'replacement-managed-versions')
    const movedParent = join(outsideRoot, 'moved-managed-versions')
    await mkdir(replacementParent)
    let managedParent = ''
    let finalPath = ''
    let swapped = false
    const swapBeforeClaimMutation = async (mutationPath: string): Promise<void> => {
      if (
        swapped ||
        !managedParent ||
        mutationPath === finalPath ||
        dirname(mutationPath) !== managedParent
      ) {
        return
      }
      swapped = true
      await renameFile(managedParent, movedParent)
      await symlink(
        replacementParent,
        managedParent,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        mkdir: async (path, options) => {
          await swapBeforeClaimMutation(String(path))
          return mkdir(path, options)
        },
        open: async (...args) => {
          await swapBeforeClaimMutation(String(args[0]))
          return openFile(...args)
        }
      }
    })
    const planInput = {
      operationId: 'operation-parent-swap-during-reservation',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    finalPath = join(cleanupRoot, ...plannedFile.storageRef.split('/'))
    managedParent = dirname(finalPath)

    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('must not escape during reservation')
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(swapped).toBe(true)
    await expect(readdir(replacementParent)).resolves.toEqual([])
    await expect(readdir(movedParent)).resolves.toEqual([])
    await rm(outsideRoot, { recursive: true, force: true })
  })

  posixIt('fails closed when the version parent changes during a claim transition', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    const replacementParent = join(outsideRoot, 'replacement-managed-versions')
    const movedParent = join(outsideRoot, 'moved-managed-versions')
    await mkdir(replacementParent)
    let finalPath = ''
    let finalCreated = false
    let swapped = false
    const swapBeforeTransition = async (): Promise<void> => {
      if (!finalCreated || swapped) return
      swapped = true
      const managedParent = dirname(finalPath)
      await renameFile(managedParent, movedParent)
      await symlink(
        replacementParent,
        managedParent,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        mkdir: async (path, options) => {
          await swapBeforeTransition()
          return mkdir(path, options)
        },
        open: async (...args) => {
          const path = String(args[0])
          const flags = args[1]
          if (
            path !== finalPath &&
            typeof flags === 'number' &&
            (flags & constants.O_CREAT) !== 0
          ) {
            await swapBeforeTransition()
          }
          const handle = await openFile(...args)
          if (path === finalPath && typeof args[1] === 'string' && args[1].startsWith('wx')) {
            finalCreated = true
          }
          return handle
        }
      }
    })
    const planInput = {
      operationId: 'operation-parent-swap-during-transition',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    finalPath = join(cleanupRoot, ...plannedFile.storageRef.split('/'))

    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('must not escape during transition')
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(swapped).toBe(true)
    await expect(readdir(replacementParent)).resolves.toEqual([])
    await expect(readFile(join(movedParent, plannedFile.storedFilename))).resolves.toHaveLength(0)
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('replays an already-published operation when the immutable bytes match', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-replay',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('same immutable bytes')

    const first = await operator.publishImmutable({ ...planInput, plannedFile, content })
    const replay = await operator.publishImmutable({ ...planInput, plannedFile, content })

    expect(replay).toEqual(first)
  })

  it('coalesces concurrent publication replays across operator instances', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const firstOperator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const secondOperator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const planInput = {
        operationId: `operation-concurrent-publish-${iteration}`,
        scope: {
          source: 'artifact' as const,
          projectId: 'project-1',
          sessionId: 'session-1',
          logicalFileId: `artifact-${iteration}`
        },
        logicalFilename: 'README.md',
        candidateIndex: 0
      }
      const plannedFile = firstOperator.planImmutable(planInput)
      const content = Buffer.from(`publish concurrently ${iteration}`)

      const [first, second] = await Promise.all([
        firstOperator.publishImmutable({ ...planInput, plannedFile, content }),
        secondOperator.publishImmutable({ ...planInput, plannedFile, content })
      ])

      expect(second).toEqual(first)
    }
  })

  it('waits for an active publication before inspecting its recovery state', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    let signalWriteStarted!: () => void
    let allowWrite!: () => void
    const writeStarted = new Promise<void>((resolveStarted) => {
      signalWriteStarted = resolveStarted
    })
    const writeAllowed = new Promise<void>((resolveWrite) => {
      allowWrite = resolveWrite
    })
    const publisher = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (typeof args[1] !== 'string' || !args[1].startsWith('wx')) return handle
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'write') {
                return async (
                  buffer: Uint8Array,
                  offset: number,
                  length: number,
                  position: number
                ) => {
                  signalWriteStarted()
                  await writeAllowed
                  return target.write(buffer, offset, length, position)
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const inspector = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-publish-inspect-race',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = publisher.planImmutable(planInput)
    const content = Buffer.from('publish before recovery inspection')
    const expectedIntegrity = {
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    }
    const publication = publisher.publishImmutable({ ...planInput, plannedFile, content })
    await writeStarted
    const inspection = inspector.inspectRecovery({ ...planInput, plannedFile, expectedIntegrity })
    const inspectionState = await Promise.race([
      inspection.then(() => 'settled' as const),
      new Promise<'pending'>((resolvePending) => {
        setTimeout(() => resolvePending('pending'), 50)
      })
    ])
    expect(inspectionState).toBe('pending')

    allowWrite()
    const [stored, inspected] = await Promise.all([publication, inspection])
    expect(inspected).toEqual({ state: 'complete', integrity: expectedIntegrity })
    expect(stored).toMatchObject(expectedIntegrity)
  })

  it('does not overwrite an existing destination whose immutable bytes differ', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-collision',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const original = Buffer.from('original')
    await operator.publishImmutable({ ...planInput, plannedFile, content: original })

    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('replacement')
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(
      readFile(join(cleanupRoot, ...plannedFile.storageRef.split('/')))
    ).resolves.toEqual(original)
  })

  it('opens a verified lease that reads and copies from the same immutable file handle', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-read',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('verified immutable content')
    const stored = await operator.publishImmutable({ ...planInput, plannedFile, content })
    const destinationPath = join(cleanupRoot, 'downloaded.md')

    const lease = await operator.openImmutable(stored.storageRef, stored)
    expect(lease.localPath).toBe(join(cleanupRoot, ...stored.storageRef.split('/')))
    await expect(lease.readRange(9, 18)).resolves.toEqual(new Uint8Array(Buffer.from('immutable')))
    await expect(lease.assertCanCopyTo(destinationPath)).resolves.toBeUndefined()
    await expect(lease.assertCanCopyTo(lease.localPath)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED'
    })
    await lease.copyTo(destinationPath)
    await expect(readFile(destinationPath)).resolves.toEqual(content)
    await lease.verifyUnchanged()
    await lease.close()
    await lease.close()
    await expect(lease.readRange(0, 1)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(lease.verifyUnchanged()).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(lease.copyTo(join(cleanupRoot, 'closed.md'))).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED'
    })

    const invalidRangeLease = await operator.openImmutable(stored.storageRef, stored)
    await expect(invalidRangeLease.readRange(1, 1)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED'
    })
    await invalidRangeLease.close()
  })

  it('does not hash the same unchanged immutable file again on a later open', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    let verifiedBytesRead = 0
    let immutablePath = ''
    const options: ConstructorParameters<typeof module.NodeVersionFileOperator>[0] = {
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (String(args[0]) !== immutablePath) return handle
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'read') {
                return async (
                  buffer: Uint8Array,
                  offset: number,
                  length: number,
                  position: number
                ) => {
                  const result = await target.read(buffer, offset, length, position)
                  verifiedBytesRead += result.bytesRead
                  return result
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    }
    const operator = new module.NodeVersionFileOperator(options)
    const planInput = {
      operationId: 'operation-repeated-read',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'large.bin',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    immutablePath = join(cleanupRoot, ...plannedFile.storageRef.split('/'))
    const content = Buffer.alloc(256 * 1024, 7)
    const stored = await operator.publishImmutable({ ...planInput, plannedFile, content })
    const fixedTime = new Date('2000-01-01T00:00:00.000Z')
    await utimes(immutablePath, fixedTime, fixedTime)
    verifiedBytesRead = 0

    const firstLease = await operator.openImmutable(stored.storageRef, stored)
    await firstLease.close()
    const secondOperator = new module.NodeVersionFileOperator(options)
    const secondLease = await secondOperator.openImmutable(stored.storageRef, stored)

    expect(verifiedBytesRead).toBe(content.byteLength)

    const auditLease = await secondOperator.openImmutable(stored.storageRef, stored, {
      forceVerify: true
    })
    await auditLease.close()
    expect(verifiedBytesRead).toBe(content.byteLength * 2)

    await writeFile(immutablePath, Buffer.alloc(content.byteLength, 8))
    await utimes(immutablePath, fixedTime, fixedTime)
    await expect(secondLease.readRange(0, content.byteLength)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED'
    })
    await secondLease.close()
    expect(verifiedBytesRead).toBe(content.byteLength * 4)

    await expect(secondOperator.openImmutable(stored.storageRef, stored)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED'
    })
    expect(verifiedBytesRead).toBe(content.byteLength * 5)
  })

  it('removes a verified immutable file idempotently', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-remove',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const stored = await operator.publishImmutable({
      ...planInput,
      plannedFile,
      content: Buffer.from('remove me')
    })
    const localPath = join(cleanupRoot, ...stored.storageRef.split('/'))

    await operator.removeImmutable(stored.storageRef, stored)
    await operator.removeImmutable(stored.storageRef, stored)

    await expect(readFile(localPath)).resolves.toHaveLength(0)
  })

  it('serializes concurrent idempotent removals across operator instances', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const firstOperator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const secondOperator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const planInput = {
        operationId: `operation-concurrent-remove-${iteration}`,
        scope: {
          source: 'upload' as const,
          projectId: 'project-1',
          sessionId: 'session-1',
          logicalFileId: `upload-${iteration}`
        },
        logicalFilename: 'notes.txt',
        candidateIndex: 0
      }
      const plannedFile = firstOperator.planImmutable(planInput)
      const stored = await firstOperator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from(`remove concurrently ${iteration}`)
      })

      await expect(
        Promise.all([
          firstOperator.removeImmutable(stored.storageRef, stored),
          secondOperator.removeImmutable(stored.storageRef, stored)
        ])
      ).resolves.toEqual([undefined, undefined])
    }
  })

  it('normalizes a disk-full publication failure', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async () => {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        }
      }
    })
    const planInput = {
      operationId: 'operation-no-space',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)

    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('content')
      })
    ).rejects.toMatchObject({ code: 'OUT_OF_SPACE' })
  })

  it('does not claim or remove incomplete bytes that were not created by the operation', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-crash-recovery',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('complete immutable content')
    const expectedIntegrity = {
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    }
    const localPath = join(cleanupRoot, ...plannedFile.storageRef.split('/'))
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, content.subarray(0, 8))

    const inspection = await operator.inspectRecovery({
      ...planInput,
      plannedFile,
      expectedIntegrity
    })

    expect(inspection).toEqual({
      state: 'occupied',
      actualIntegrity: {
        sizeBytes: 8,
        checksum: createHash('sha256').update(content.subarray(0, 8)).digest('hex')
      }
    })
    await expect(readFile(localPath)).resolves.toEqual(content.subarray(0, 8))
  })

  it('removes an incomplete publication only when its durable claim belongs to the operation', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    let corruptPublication = true
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (!corruptPublication || typeof args[1] !== 'string' || !args[1].startsWith('wx')) {
            return handle
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'write') {
                return async (
                  buffer: Uint8Array,
                  offset: number,
                  length: number,
                  position: number
                ) => {
                  const changed = Buffer.from(buffer.subarray(offset, offset + length))
                  if (changed.byteLength > 0) changed[0] = changed[0]! ^ 0xff
                  return target.write(changed, 0, changed.byteLength, position)
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const planInput = {
      operationId: 'operation-owned-partial',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('complete immutable content')
    const expectedIntegrity = {
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    }

    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    const inspection = await operator.inspectRecovery({
      ...planInput,
      plannedFile,
      expectedIntegrity
    })
    expect(inspection.state).toBe('incomplete')
    if (inspection.state !== 'incomplete') return

    await operator.removeIncomplete({
      ...planInput,
      plannedFile,
      actualIntegrity: inspection.actualIntegrity
    })
    corruptPublication = false
    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED', reason: 'DESTINATION_COLLISION' })
    const retryInput = { ...planInput, candidateIndex: 1 }
    const retryPlan = operator.planImmutable(retryInput)
    await expect(
      operator.publishImmutable({ ...retryInput, plannedFile: retryPlan, content })
    ).resolves.toMatchObject(expectedIntegrity)
  })

  it.each([
    { failure: 'claim-read', nativeCode: 'EIO', expectedCode: 'STORAGE_UNAVAILABLE' },
    { failure: 'transition', nativeCode: 'EACCES', expectedCode: 'PERMISSION_DENIED' },
    { failure: 'content-remove', nativeCode: 'ENOSPC', expectedCode: 'OUT_OF_SPACE' }
  ] as const)(
    'normalizes $nativeCode during incomplete cleanup as $expectedCode',
    async ({ failure, nativeCode, expectedCode }) => {
      const module = await import('./version-file-operator')
      cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
      let interruptPublication = true
      const failureState: { armed?: typeof failure } = {}
      const operator = new module.NodeVersionFileOperator({
        storageRoot: cleanupRoot,
        fileSystem: {
          mkdir: async (path, options) => {
            if (
              failureState.armed === 'transition' &&
              String(path).includes('.claim-') &&
              String(path).includes('deleting-')
            ) {
              throw Object.assign(new Error('claim transition failed'), { code: nativeCode })
            }
            return mkdir(path, options)
          },
          open: async (...args) => {
            const handle = await openFile(...args)
            if (
              failureState.armed === 'content-remove' &&
              typeof args[1] === 'number' &&
              (args[1] & constants.O_RDWR) === constants.O_RDWR
            ) {
              return new Proxy(handle, {
                get(target, property) {
                  if (property === 'truncate') {
                    return async () => {
                      throw Object.assign(new Error('content scrub failed'), { code: nativeCode })
                    }
                  }
                  const value = Reflect.get(target, property, target)
                  return typeof value === 'function' ? value.bind(target) : value
                }
              })
            }
            if (!interruptPublication || typeof args[1] !== 'string' || !args[1].startsWith('wx')) {
              return handle
            }
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'write') {
                  return async () => {
                    interruptPublication = false
                    await target.write(Buffer.from('partial'), 0, 7, 0)
                    throw Object.assign(new Error('publication interrupted'), { code: 'EIO' })
                  }
                }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            })
          },
          readdir: async (...args) => {
            if (failureState.armed === 'claim-read' && String(args[0]).includes('.claim-')) {
              throw Object.assign(new Error('claim read failed'), { code: nativeCode })
            }
            return readdir(args[0], args[1])
          },
          remove: rm
        }
      })
      const planInput = {
        operationId: `operation-cleanup-${failure}`,
        scope: {
          source: 'upload' as const,
          projectId: 'project-1',
          sessionId: 'session-1',
          logicalFileId: 'upload-1'
        },
        logicalFilename: 'notes.txt',
        candidateIndex: 0
      }
      const plannedFile = operator.planImmutable(planInput)
      const content = Buffer.from('expected complete immutable bytes')
      const expectedIntegrity = {
        sizeBytes: content.byteLength,
        checksum: createHash('sha256').update(content).digest('hex')
      }
      await expect(
        operator.publishImmutable({ ...planInput, plannedFile, content })
      ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
      const inspection = await operator.inspectRecovery({
        ...planInput,
        plannedFile,
        expectedIntegrity
      })
      expect(inspection.state).toBe('incomplete')
      if (inspection.state !== 'incomplete') return
      failureState.armed = failure

      await expect(
        operator.removeIncomplete({
          ...planInput,
          plannedFile,
          actualIntegrity: inspection.actualIntegrity
        })
      ).rejects.toMatchObject({ code: expectedCode })
    }
  )

  it('retains the last durable claim state when a claim transition is interrupted', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    let interruptClaimUpdate = true
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        mkdir: async (path, options) => {
          if (interruptClaimUpdate && /[\\/]publishing$/u.test(String(path))) {
            throw Object.assign(new Error('claim transition interrupted'), { code: 'EIO' })
          }
          return mkdir(path, options)
        }
      }
    })
    const planInput = {
      operationId: 'operation-claim-transition-crash',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('must not become an unowned partial')
    const expectedIntegrity = {
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    }

    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    interruptClaimUpdate = false

    await expect(
      operator.inspectRecovery({ ...planInput, plannedFile, expectedIntegrity })
    ).resolves.toMatchObject({ state: 'incomplete' })
    await expect(
      readFile(join(cleanupRoot, ...plannedFile.storageRef.split('/')))
    ).resolves.toHaveLength(0)
  })

  it('recovers an initial reservation interrupted after its directory is created', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    let interruptReservation = true
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        mkdir: async (path, options) => {
          const result = await mkdir(path, options)
          if (interruptReservation && /[\\/]\.claim-[a-f0-9]{64}$/u.test(String(path))) {
            throw Object.assign(new Error('initial reservation interrupted'), { code: 'EIO' })
          }
          return result
        }
      }
    })
    const planInput = {
      operationId: 'operation-initial-claim-crash',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('retry after initial claim interruption')
    const expectedIntegrity = {
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    }

    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    interruptReservation = false
    await expect(
      operator.inspectRecovery({ ...planInput, plannedFile, expectedIntegrity })
    ).resolves.toEqual({ state: 'missing' })
    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).resolves.toMatchObject(expectedIntegrity)
  })

  it('does not overwrite or remove an existing unowned recovery claim', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const externalClaim = Buffer.from('claim owned by another writer')
    let claimPath: string | undefined
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        mkdir: async (path, options) => {
          if (!claimPath && /[\\/]\.claim-[a-f0-9]{64}$/u.test(String(path))) {
            claimPath = String(path)
            await writeFile(path, externalClaim, { flag: 'wx' })
          }
          return mkdir(path, options)
        }
      }
    })
    const planInput = {
      operationId: 'operation-external-claim',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('must not replace external claim')
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(claimPath).toBeDefined()
    await expect(readFile(claimPath!)).resolves.toEqual(externalClaim)
  })

  it('rejects recovery for a planned file that does not belong to the operation', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-recovery-owner',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)

    await expect(
      operator.inspectRecovery({
        ...planInput,
        plannedFile: {
          ...plannedFile,
          storageRef: 'artifacts/project-1/session-1/other/managed-versions/forged.md'
        },
        expectedIntegrity: {
          sizeBytes: 0,
          checksum: createHash('sha256').update('').digest('hex')
        }
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  })

  it('rejects a publication parent that escapes through a symbolic link', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    await symlink(
      outsideRoot,
      join(cleanupRoot, 'artifacts'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const planInput = {
      operationId: 'operation-symlink',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)

    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('must stay inside')
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(readFile(join(outsideRoot, 'project-1'))).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('rejects a symbolic-link storage root before creating version directories', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const storageRoot = join(cleanupRoot, 'storage')
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    await symlink(outsideRoot, storageRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const operator = new module.NodeVersionFileOperator({ storageRoot })
    const planInput = {
      operationId: 'operation-root-symlink',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)

    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('must not escape through root')
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(readFile(join(outsideRoot, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('rejects a version parent replaced by a symbolic link before the final file opens', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    let replacedParent = false
    let movedParentPath: string | undefined
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          if (!replacedParent && typeof args[1] === 'string' && args[1].startsWith('wx')) {
            replacedParent = true
            const originalParentPath = dirname(String(args[0]))
            movedParentPath = join(outsideRoot, 'moved-managed-versions')
            await renameFile(originalParentPath, movedParentPath)
            await symlink(
              movedParentPath,
              originalParentPath,
              process.platform === 'win32' ? 'junction' : 'dir'
            )
          }
          return openFile(...args)
        }
      }
    })
    const planInput = {
      operationId: 'operation-parent-swap',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)

    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('must not be written through replacement parent')
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(movedParentPath).toBeDefined()
    await expect(
      readFile(join(movedParentPath!, plannedFile.storedFilename))
    ).resolves.toHaveLength(0)
    const movedEntries = await readdir(movedParentPath!)
    expect(movedEntries).toContain(plannedFile.storedFilename)
    expect(movedEntries.some((entry) => /^\.claim-[a-f0-9]{64}$/u.test(entry))).toBe(true)
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('rejects a same-byte replay reached through a replaced version parent', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    const externalParentPath = join(outsideRoot, 'external-managed-versions')
    const movedParentPath = join(outsideRoot, 'moved-managed-versions')
    await mkdir(externalParentPath)
    let replacedParent = false
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          if (!replacedParent && typeof args[1] === 'string' && args[1].startsWith('wx')) {
            replacedParent = true
            const originalParentPath = dirname(String(args[0]))
            await renameFile(originalParentPath, movedParentPath)
            await symlink(
              externalParentPath,
              originalParentPath,
              process.platform === 'win32' ? 'junction' : 'dir'
            )
          }
          return openFile(...args)
        }
      }
    })
    const planInput = {
      operationId: 'operation-parent-swap-replay',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('same bytes must not authenticate an external parent')
    const externalFinalPath = join(externalParentPath, plannedFile.storedFilename)
    await writeFile(externalFinalPath, content)

    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(readFile(externalFinalPath)).resolves.toEqual(content)
    await rm(outsideRoot, { recursive: true, force: true })
  })

  posixIt('fails closed when the version parent changes after content is synced', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    let movedParentPath: string | undefined
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (typeof args[1] !== 'string' || !args[1].startsWith('wx')) return handle
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'sync') {
                return async () => {
                  await target.sync()
                  const originalParentPath = dirname(String(args[0]))
                  movedParentPath = join(outsideRoot, 'moved-managed-versions')
                  await renameFile(originalParentPath, movedParentPath)
                  await symlink(
                    movedParentPath,
                    originalParentPath,
                    process.platform === 'win32' ? 'junction' : 'dir'
                  )
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const planInput = {
      operationId: 'operation-parent-swap-after-sync',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('durable content retained after parent identity changes')

    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(movedParentPath).toBeDefined()
    await expect(readFile(join(movedParentPath!, plannedFile.storedFilename))).resolves.toEqual(
      content
    )
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('rejects recovery inspection and immutable removal through a symbolic-link parent', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-recovery-symlink',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('outside bytes')
    const expectedIntegrity = {
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    }
    const outsideFile = join(
      outsideRoot,
      'project-1',
      'session-1',
      'artifact-1',
      'managed-versions',
      plannedFile.storedFilename
    )
    await mkdir(dirname(outsideFile), { recursive: true })
    await writeFile(outsideFile, content)
    await symlink(
      outsideRoot,
      join(cleanupRoot, 'artifacts'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      operator.inspectRecovery({ ...planInput, plannedFile, expectedIntegrity })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(
      operator.removeImmutable(plannedFile.storageRef, expectedIntegrity)
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(readFile(outsideFile)).resolves.toEqual(content)
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('rejects a plan candidate outside the bounded collision range', async () => {
    const module = await import('./version-file-operator')
    const operator = new module.NodeVersionFileOperator({ storageRoot: '/data' })

    expect(() =>
      operator.planImmutable({
        operationId: 'operation-too-many-collisions',
        scope: {
          source: 'upload',
          projectId: 'project-1',
          sessionId: 'session-1',
          logicalFileId: 'upload-1'
        },
        logicalFilename: 'notes.txt',
        candidateIndex: 16
      })
    ).toThrow('bounded')
  })

  it('reports a missing recorded storage parent as unavailable', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })

    await expect(
      operator.openImmutable('uploads/project/session/file/legacy.txt', {
        sizeBytes: 1,
        checksum: createHash('sha256').update('x').digest('hex')
      })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
  })

  it('verifies the bytes actually stored through the publishing file handle', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (typeof args[1] !== 'string' || !args[1].startsWith('wx')) return handle
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'write') {
                return async (
                  buffer: Uint8Array,
                  offset: number,
                  length: number,
                  position: number
                ) => {
                  const changed = Buffer.from(buffer.subarray(offset, offset + length))
                  if (changed.byteLength > 0) changed[0] = changed[0]! ^ 0xff
                  return target.write(changed, 0, changed.byteLength, position)
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const planInput = {
      operationId: 'operation-corrupt-write',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)

    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('expected bytes')
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(
      operator.inspectRecovery({
        ...planInput,
        plannedFile,
        expectedIntegrity: {
          sizeBytes: Buffer.byteLength('expected bytes'),
          checksum: createHash('sha256').update('expected bytes').digest('hex')
        }
      })
    ).resolves.toMatchObject({ state: 'incomplete' })
  })

  it('does not depend on path rename or removal to delete immutable bytes', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    let deleting = false
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        rename: async (...args) => {
          if (!deleting) return renameFile(...args)
          throw new Error('removeImmutable must not rename paths')
        },
        remove: async (...args) => {
          if (!deleting) return rm(...args)
          throw new Error('removeImmutable must not unlink paths')
        },
        removeDirectory: async (...args) => {
          if (!deleting) return rmdir(...args)
          throw new Error('removeImmutable must not remove directories')
        }
      }
    })
    const planInput = {
      operationId: 'operation-delete-race',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const stored = await operator.publishImmutable({
      ...planInput,
      plannedFile,
      content: Buffer.from('expected immutable bytes')
    })
    const publishedPath = join(cleanupRoot, ...stored.storageRef.split('/'))
    deleting = true

    await expect(operator.removeImmutable(stored.storageRef, stored)).resolves.toBeUndefined()
    await expect(readFile(publishedPath)).resolves.toHaveLength(0)
  })

  it('does not scrub an external replacement when the parent changes inside final open', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    const replacementParent = join(outsideRoot, 'replacement-managed-versions')
    const movedParent = join(outsideRoot, 'moved-managed-versions')
    let localPath = ''
    let swapped = false
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const flags = args[1]
          if (
            !swapped &&
            String(args[0]) === localPath &&
            typeof flags === 'number' &&
            (flags & constants.O_RDWR) === constants.O_RDWR
          ) {
            swapped = true
            const managedParent = dirname(localPath)
            await renameFile(managedParent, movedParent)
            await symlink(
              replacementParent,
              managedParent,
              process.platform === 'win32' ? 'junction' : 'dir'
            )
          }
          return openFile(...args)
        }
      }
    })
    const planInput = {
      operationId: 'operation-delete-parent-swap',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('immutable bytes must remain in the trusted directory')
    const stored = await operator.publishImmutable({ ...planInput, plannedFile, content })
    localPath = join(cleanupRoot, ...stored.storageRef.split('/'))
    await mkdir(replacementParent, { recursive: true })
    const decoyPath = join(replacementParent, plannedFile.storedFilename)
    await writeFile(decoyPath, content)

    try {
      await expect(operator.removeImmutable(stored.storageRef, stored)).rejects.toMatchObject({
        code: 'INTEGRITY_FAILED'
      })
      expect(swapped).toBe(true)
      await expect(readFile(decoyPath)).resolves.toEqual(content)
      await expect(readFile(join(movedParent, plannedFile.storedFilename))).resolves.toEqual(
        content
      )
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when the final path inode changes after checksum verification', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const replacement = Buffer.from('replacement owned elsewhere')
    let localPath = ''
    let heldAsidePath = ''
    let swapped = false
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          const flags = args[1]
          if (
            String(args[0]) !== localPath ||
            typeof flags !== 'number' ||
            (flags & constants.O_RDWR) !== constants.O_RDWR
          ) {
            return handle
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'read') {
                return async (
                  buffer: Uint8Array,
                  offset: number,
                  length: number,
                  position: number
                ) => {
                  const result = await target.read(buffer, offset, length, position)
                  if (!swapped) {
                    swapped = true
                    await renameFile(localPath, heldAsidePath)
                    await writeFile(localPath, replacement)
                  }
                  return result
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const planInput = {
      operationId: 'operation-final-inode-swap',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('held immutable bytes')
    const stored = await operator.publishImmutable({ ...planInput, plannedFile, content })
    localPath = join(cleanupRoot, ...stored.storageRef.split('/'))
    heldAsidePath = join(dirname(localPath), '.held-aside-direct')

    await expect(operator.removeImmutable(stored.storageRef, stored)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED'
    })
    expect(swapped).toBe(true)
    await expect(readFile(localPath)).resolves.toEqual(replacement)
    await expect(readFile(heldAsidePath)).resolves.toHaveLength(0)
  })

  posixIt('fails closed when the version parent changes during incomplete cleanup', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    const replacementParent = join(outsideRoot, 'replacement-managed-versions')
    const movedParent = join(outsideRoot, 'moved-managed-versions')
    let interruptPublication = true
    let localPath = ''
    let swapped = false
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          const flags = args[1]
          if (interruptPublication && typeof flags === 'string' && flags.startsWith('wx')) {
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'write') {
                  return async () => {
                    interruptPublication = false
                    await target.write(Buffer.from('partial'), 0, 7, 0)
                    throw Object.assign(new Error('publication interrupted'), { code: 'EIO' })
                  }
                }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            })
          }
          if (typeof flags === 'number' && (flags & constants.O_RDWR) === constants.O_RDWR) {
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'truncate') {
                  return async (length?: number) => {
                    if (!swapped) {
                      swapped = true
                      const managedParent = dirname(localPath)
                      await renameFile(managedParent, movedParent)
                      await symlink(
                        replacementParent,
                        managedParent,
                        process.platform === 'win32' ? 'junction' : 'dir'
                      )
                    }
                    return target.truncate(length)
                  }
                }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            })
          }
          return handle
        }
      }
    })
    const planInput = {
      operationId: 'operation-incomplete-delete-parent-swap',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('expected complete immutable bytes')
    const expectedIntegrity = {
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    }
    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    const inspection = await operator.inspectRecovery({
      ...planInput,
      plannedFile,
      expectedIntegrity
    })
    expect(inspection.state).toBe('incomplete')
    if (inspection.state !== 'incomplete') return
    localPath = join(cleanupRoot, ...plannedFile.storageRef.split('/'))
    const managedParent = dirname(localPath)
    const claimName = (await readdir(managedParent)).find((entry) =>
      /^\.claim-[a-f0-9]{64}$/u.test(entry)
    )
    expect(claimName).toBeDefined()
    const externalClaimPath = join(replacementParent, claimName!)
    await mkdir(join(externalClaimPath, 'publishing'), { recursive: true })
    const partialContent = Buffer.from('partial')
    const decoyPath = join(replacementParent, plannedFile.storedFilename)
    await writeFile(decoyPath, partialContent)

    try {
      await expect(
        operator.removeIncomplete({
          ...planInput,
          plannedFile,
          actualIntegrity: inspection.actualIntegrity
        })
      ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
      expect(swapped).toBe(true)
      await expect(readFile(decoyPath)).resolves.toEqual(partialContent)
      await expect(readdir(externalClaimPath)).resolves.toEqual(['publishing'])
      await expect(readFile(join(movedParent, plannedFile.storedFilename))).resolves.toHaveLength(0)
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('fails incomplete cleanup when the final path inode changes after checksum verification', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const replacement = Buffer.from('foreign partial replacement')
    let interruptPublication = true
    let cleanupArmed = false
    let localPath = ''
    let heldAsidePath = ''
    let swapped = false
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          const flags = args[1]
          if (interruptPublication && typeof flags === 'string' && flags.startsWith('wx')) {
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'write') {
                  return async () => {
                    interruptPublication = false
                    await target.write(Buffer.from('partial'), 0, 7, 0)
                    throw Object.assign(new Error('publication interrupted'), { code: 'EIO' })
                  }
                }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            })
          }
          if (
            !cleanupArmed ||
            String(args[0]) !== localPath ||
            typeof flags !== 'number' ||
            (flags & constants.O_RDWR) !== constants.O_RDWR
          ) {
            return handle
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'read') {
                return async (
                  buffer: Uint8Array,
                  offset: number,
                  length: number,
                  position: number
                ) => {
                  const result = await target.read(buffer, offset, length, position)
                  if (!swapped) {
                    swapped = true
                    await renameFile(localPath, heldAsidePath)
                    await writeFile(localPath, replacement)
                  }
                  return result
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const planInput = {
      operationId: 'operation-incomplete-final-inode-swap',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('expected complete immutable bytes')
    const expectedIntegrity = {
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex')
    }
    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    const inspection = await operator.inspectRecovery({
      ...planInput,
      plannedFile,
      expectedIntegrity
    })
    expect(inspection.state).toBe('incomplete')
    if (inspection.state !== 'incomplete') return
    localPath = join(cleanupRoot, ...plannedFile.storageRef.split('/'))
    heldAsidePath = join(dirname(localPath), '.held-aside-incomplete')
    cleanupArmed = true

    await expect(
      operator.removeIncomplete({
        ...planInput,
        plannedFile,
        actualIntegrity: inspection.actualIntegrity
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(swapped).toBe(true)
    await expect(readFile(localPath)).resolves.toEqual(replacement)
    await expect(readFile(heldAsidePath)).resolves.toHaveLength(0)
  })

  it('scrubs only the held immutable inode when the parent changes during content removal', async () => {
    if (process.platform === 'win32') return
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-outside-'))
    const replacementParent = join(outsideRoot, 'replacement-managed-versions')
    const movedParent = join(outsideRoot, 'moved-managed-versions')
    let managedParent = ''
    let swapped = false
    const swapParent = async (): Promise<void> => {
      if (swapped) return
      swapped = true
      await renameFile(managedParent, movedParent)
      await symlink(
        replacementParent,
        managedParent,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          const flags = args[1]
          if (typeof flags !== 'number' || (flags & constants.O_RDWR) !== constants.O_RDWR) {
            return handle
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'truncate') {
                return async (length?: number) => {
                  await swapParent()
                  return target.truncate(length)
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const planInput = {
      operationId: 'operation-parent-swap-during-scrub',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('only the intended immutable inode may be scrubbed')
    const stored = await operator.publishImmutable({ ...planInput, plannedFile, content })
    const localPath = join(cleanupRoot, ...stored.storageRef.split('/'))
    managedParent = dirname(localPath)
    await mkdir(replacementParent, { recursive: true })
    const externalDecoyPath = join(replacementParent, plannedFile.storedFilename)
    await writeFile(externalDecoyPath, content)

    try {
      await expect(operator.removeImmutable(stored.storageRef, stored)).rejects.toMatchObject({
        code: 'INTEGRITY_FAILED'
      })
      expect(swapped).toBe(true)
      await expect(readFile(externalDecoyPath)).resolves.toEqual(content)
      await expect(readFile(join(movedParent, plannedFile.storedFilename))).resolves.toHaveLength(0)
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('treats a missing immutable parent below an available storage root as already removed', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-missing-parent-remove',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const stored = await operator.publishImmutable({
      ...planInput,
      plannedFile,
      content: Buffer.from('already removed with its parent')
    })
    const localPath = join(cleanupRoot, ...stored.storageRef.split('/'))
    await rm(dirname(localPath), { recursive: true })

    await expect(operator.removeImmutable(stored.storageRef, stored)).resolves.toBeUndefined()
  })

  it.each([
    ['non-empty', Buffer.from('republished immutable bytes')],
    ['empty', Buffer.alloc(0)]
  ])(
    'scrubs a %s immutable file in place and durably re-scrubs its tombstone',
    async (_caseName, content) => {
      const module = await import('./version-file-operator')
      cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
      const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
      const planInput = {
        operationId: `operation-republished-${_caseName}`,
        scope: {
          source: 'artifact' as const,
          projectId: 'project-1',
          sessionId: 'session-1',
          logicalFileId: `artifact-${_caseName}`
        },
        logicalFilename: 'README.md',
        candidateIndex: 0
      }
      const plannedFile = operator.planImmutable(planInput)
      const stored = await operator.publishImmutable({
        ...planInput,
        plannedFile,
        content
      })
      const localPath = join(cleanupRoot, ...stored.storageRef.split('/'))

      await operator.removeImmutable(stored.storageRef, stored)
      await expect(readFile(localPath)).resolves.toHaveLength(0)
      await expect(operator.removeImmutable(stored.storageRef, stored)).resolves.toBeUndefined()
      await expect(readFile(localPath)).resolves.toHaveLength(0)
    }
  )

  it.each(['sync', 'close'] as const)(
    're-scrubs an in-place tombstone after the first held-handle %s fails',
    async (failingMethod) => {
      const module = await import('./version-file-operator')
      cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
      let injectedFailure = false
      let scrubSyncCalls = 0
      const operator = new module.NodeVersionFileOperator({
        storageRoot: cleanupRoot,
        fileSystem: {
          open: async (...args) => {
            const handle = await openFile(...args)
            if (typeof args[1] !== 'number' || (args[1] & constants.O_RDWR) !== constants.O_RDWR) {
              return handle
            }
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'sync') {
                  return async () => {
                    scrubSyncCalls += 1
                    if (failingMethod === 'sync' && !injectedFailure) {
                      injectedFailure = true
                      throw Object.assign(new Error('sync failed'), { code: 'EIO' })
                    }
                    return target.sync()
                  }
                }
                if (property === 'close') {
                  return async () => {
                    if (failingMethod === 'close' && !injectedFailure) {
                      injectedFailure = true
                      throw Object.assign(new Error('close failed'), { code: 'EIO' })
                    }
                    return target.close()
                  }
                }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            })
          }
        }
      })
      const planInput = {
        operationId: `operation-${failingMethod}-retry`,
        scope: {
          source: 'artifact' as const,
          projectId: 'project-1',
          sessionId: 'session-1',
          logicalFileId: `artifact-${failingMethod}`
        },
        logicalFilename: 'README.md',
        candidateIndex: 0
      }
      const plannedFile = operator.planImmutable(planInput)
      const stored = await operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('durable deletion')
      })
      const localPath = join(cleanupRoot, ...stored.storageRef.split('/'))

      await expect(operator.removeImmutable(stored.storageRef, stored)).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE'
      })
      expect(scrubSyncCalls).toBe(1)

      await expect(operator.removeImmutable(stored.storageRef, stored)).resolves.toBeUndefined()
      expect(scrubSyncCalls).toBe(2)
      await expect(readFile(localPath)).resolves.toHaveLength(0)
    }
  )

  it('does not treat an unavailable storage root as a missing immutable file', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-offline-root',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('immutable bytes')
    const stored = await operator.publishImmutable({ ...planInput, plannedFile, content })
    const offlineRoot = `${cleanupRoot}-offline`
    await renameFile(cleanupRoot, offlineRoot)

    try {
      await expect(operator.openImmutable(stored.storageRef, stored)).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE'
      })
      await expect(
        operator.inspectRecovery({ ...planInput, plannedFile, expectedIntegrity: stored })
      ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
      await expect(operator.removeImmutable(stored.storageRef, stored)).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE'
      })
    } finally {
      await renameFile(offlineRoot, cleanupRoot)
    }
  })

  it('fails closed when an in-place tombstone is replaced with different non-empty bytes', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const racedBytes = Buffer.from('replacement owned elsewhere')
    const operator = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-delete-destination-race',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const content = Buffer.from('immutable bytes')
    const stored = await operator.publishImmutable({ ...planInput, plannedFile, content })
    const localPath = join(cleanupRoot, ...stored.storageRef.split('/'))
    await operator.removeImmutable(stored.storageRef, stored)
    await expect(readFile(localPath)).resolves.toHaveLength(0)
    await writeFile(localPath, racedBytes)

    await expect(operator.removeImmutable(stored.storageRef, stored)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED'
    })
    await expect(readFile(localPath)).resolves.toEqual(racedBytes)
  })

  it('replays an in-place tombstone idempotently and normalizes scrub permission failures', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    let scrubMode: 'normal' | 'denied' = 'normal'
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (
            scrubMode !== 'denied' ||
            typeof args[1] !== 'number' ||
            (args[1] & constants.O_RDWR) !== constants.O_RDWR
          ) {
            return handle
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'truncate') {
                return async () => {
                  throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const planInput = {
      operationId: 'operation-concurrent-delete',
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'artifact-1'
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const first = await operator.publishImmutable({
      ...planInput,
      plannedFile,
      content: Buffer.from('first')
    })

    await expect(operator.removeImmutable(first.storageRef, first)).resolves.toBeUndefined()
    await expect(operator.removeImmutable(first.storageRef, first)).resolves.toBeUndefined()

    const secondInput = { ...planInput, operationId: 'operation-permission-delete' }
    const secondPlan = operator.planImmutable(secondInput)
    const second = await operator.publishImmutable({
      ...secondInput,
      plannedFile: secondPlan,
      content: Buffer.from('second')
    })
    scrubMode = 'denied'
    await expect(operator.removeImmutable(second.storageRef, second)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    })
  })

  it('normalizes read-lease source and destination storage failures', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const publisher = new module.NodeVersionFileOperator({ storageRoot: cleanupRoot })
    const planInput = {
      operationId: 'operation-lease-errors',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = publisher.planImmutable(planInput)
    const stored = await publisher.publishImmutable({
      ...planInput,
      plannedFile,
      content: Buffer.from('lease content')
    })
    const localPath = join(cleanupRoot, ...stored.storageRef.split('/'))
    let failSourceRead = false
    let failSourceStat = false
    let failSourceClose = false
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        open: async (...args) => {
          if (String(args[0]).endsWith('download.txt')) {
            throw Object.assign(new Error('destination full'), { code: 'ENOSPC' })
          }
          const handle = await openFile(...args)
          if (String(args[0]).endsWith('combined-failure.txt')) {
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'close') {
                  return async () => {
                    await target.close()
                    throw Object.assign(new Error('destination close denied'), { code: 'EACCES' })
                  }
                }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            })
          }
          if (String(args[0]) !== localPath) return handle
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'read' && failSourceRead) {
                return async () => {
                  throw Object.assign(new Error('source unavailable'), { code: 'EIO' })
                }
              }
              if (property === 'stat' && failSourceStat) {
                return async () => {
                  throw Object.assign(new Error('source denied'), { code: 'EACCES' })
                }
              }
              if (property === 'close' && failSourceClose) {
                return async () => {
                  failSourceClose = false
                  await target.close()
                  throw Object.assign(new Error('source close failed'), { code: 'EIO' })
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })

    const readLease = await operator.openImmutable(stored.storageRef, stored)
    failSourceRead = true
    await expect(readLease.readRange(0, 1)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE'
    })
    failSourceRead = false
    await readLease.close()

    const statLease = await operator.openImmutable(stored.storageRef, stored)
    failSourceStat = true
    await expect(statLease.verifyUnchanged()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    })
    failSourceStat = false
    await statLease.close()

    const copyLease = await operator.openImmutable(stored.storageRef, stored)
    await expect(copyLease.copyTo(join(cleanupRoot, 'download.txt'))).rejects.toMatchObject({
      code: 'OUT_OF_SPACE'
    })
    await copyLease.close()

    const combinedFailureLease = await operator.openImmutable(stored.storageRef, stored)
    failSourceRead = true
    await expect(
      combinedFailureLease.copyTo(join(cleanupRoot, 'combined-failure.txt'))
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    failSourceRead = false
    await combinedFailureLease.close()

    const closeLease = await operator.openImmutable(stored.storageRef, stored)
    failSourceClose = true
    await expect(closeLease.close()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
  })

  it('does not remove an externally occupied recovery state marker', async () => {
    const module = await import('./version-file-operator')
    cleanupRoot = await mkdtemp(join(tmpdir(), 'open-science-version-file-'))
    const externalBytes = Buffer.from('external recovery state')
    let occupiedPath: string | undefined
    const operator = new module.NodeVersionFileOperator({
      storageRoot: cleanupRoot,
      fileSystem: {
        mkdir: async (path, options) => {
          if (!occupiedPath && /[\\/]publishing$/u.test(String(path))) {
            occupiedPath = String(path)
            await writeFile(path, externalBytes, { flag: 'wx' })
          }
          return mkdir(path, options)
        }
      }
    })
    const planInput = {
      operationId: 'operation-external-state-marker',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'notes.txt',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)

    await expect(
      operator.publishImmutable({
        ...planInput,
        plannedFile,
        content: Buffer.from('immutable content')
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(occupiedPath).toBeDefined()
    await expect(readFile(occupiedPath!)).resolves.toEqual(externalBytes)
  })
})
