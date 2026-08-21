import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

describe('database JSON and remaining domain constraints', () => {
  let client: PrismaClient | undefined
  let storageRoot: string | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { force: true, recursive: true })
  })

  it('rejects invalid closed values, JSON roots, and field combinations', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-json-constraints-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)

    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id","name","updatedAt") VALUES ('project','Project',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ProjectPreviewState" ("projectId","panelState","items","updatedAt") VALUES ('project','collapsed','[]',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "NotificationInboxItem" ("id","dedupeKey","kind","sessionId","originId","title","summary") VALUES ('notification','notification','task.completed','session','origin','Title','Summary')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "Review" ("id","projectId","sessionId","turnMessageId","lifecycle","scope","reviewerLog","updatedAt") VALUES ('review','project','session','message','running','{}','[]',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "Finding" ("id","reviewId","status","locator") VALUES ('finding','review','warn','{}')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ReviewFindingDisposition" ("id","sourceFindingId","sequence","trigger","outcome") VALUES ('disposition','finding',1,'aborted','unaddressed')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ReviewScopeSnapshot" ("id","projectId","sessionId","reviewId","scopeTurnMessageId","snapshotJson","checksum","storageKey","blockCount") VALUES ('scope-snapshot','project','session','review','message','{}','checksum','snapshot.json',0)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "FileOriginSession" ("projectId","sessionId","updatedAt") VALUES ('project','session',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactLineage" ("id","projectId","sessionId","normalizedFilename","filename","updatedAt") VALUES ('lineage','project','session','result.txt','result.txt',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactVersion" (
        "id","artifactId","versionNumber","filename","artifactRunId","rootFrameId","agentFrameId",
        "messageBranchId","runtimeSegmentId","promptMessageId","state","contentStorageKey",
        "evidenceStorageKey","sizeBytes","checksum","evidenceJson","evidenceChecksum",
        "evidenceSchemaVersion","updatedAt"
      ) VALUES (
        'version','lineage',1,'result.txt','run','root','agent','branch','segment','prompt','staging',
        'content','evidence.json',0,'checksum','{}','evidence-checksum',1,CURRENT_TIMESTAMP
      )`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactVersionInput" (
        "id","artifactVersionId","ordinal","inputFileVersionId","sourceKind","sourceFileId",
        "sourceArtifactVersionId","sourceProjectId","sourceSessionId","filename","sizeBytes",
        "checksum","storageKey","strongestAssociation"
      ) VALUES (
        'input','version',0,'version','artifact-version','lineage','version','project','session',
        'result.txt',0,'checksum','content','turn-attached'
      )`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ManagedFile" (
        "source","sourceFileId","projectId","sessionId","displayName","storageKey","sizeBytes",
        "sortAtMs","updatedAt"
      ) VALUES ('artifact','lineage','project','session','result.txt','content',0,0,CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeJob" (
        "id","providerId","shape","sessionId","projectId","status","intent","command","commandHash"
      ) VALUES ('job','ssh:host','direct_ssh','session','project','submitted','intent','command','hash')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeHost" ("id","providerId","displayName","sshAlias","updatedAt") VALUES ('host','ssh:host','Host','host',CURRENT_TIMESTAMP)`
    )

    const invalidWrites = [
      ['ProjectPreviewState.panelState', `UPDATE "ProjectPreviewState" SET "panelState"='unknown'`],
      ['ProjectPreviewState.items syntax', `UPDATE "ProjectPreviewState" SET "items"='not-json'`],
      ['ProjectPreviewState.items root', `UPDATE "ProjectPreviewState" SET "items"='{}'`],
      ['NotificationInboxItem.kind', `UPDATE "NotificationInboxItem" SET "kind"='unknown'`],
      [
        'NotificationInboxItem.actionState',
        `UPDATE "NotificationInboxItem" SET "actionState"='unknown'`
      ],
      [
        'NotificationInboxItem settled without action',
        `UPDATE "NotificationInboxItem" SET "settledAt"=CURRENT_TIMESTAMP`
      ],
      [
        'NotificationInboxItem terminal action without settlement',
        `UPDATE "NotificationInboxItem" SET "actionState"='resolved'`
      ],
      [
        'NotificationInboxItem non-actionable kind',
        `UPDATE "NotificationInboxItem" SET "actionState"='pending'`
      ],
      [
        'NotificationInboxItem invalidated without read time',
        `UPDATE "NotificationInboxItem" SET "targetInvalidatedAt"=CURRENT_TIMESTAMP`
      ],
      ['Review.scope syntax', `UPDATE "Review" SET "scope"='not-json'`],
      ['Review.scope root', `UPDATE "Review" SET "scope"='[]'`],
      ['Review.reviewerLog syntax', `UPDATE "Review" SET "reviewerLog"='not-json'`],
      ['Review.reviewerLog root', `UPDATE "Review" SET "reviewerLog"='{}'`],
      ['Finding.locator syntax', `UPDATE "Finding" SET "locator"='not-json'`],
      ['Finding.locator root', `UPDATE "Finding" SET "locator"='[]'`],
      [
        'ReviewFindingDisposition.assessmentSnapshot syntax',
        `UPDATE "ReviewFindingDisposition" SET "assessmentSnapshot"='not-json'`
      ],
      [
        'ReviewFindingDisposition.assessmentSnapshot root',
        `UPDATE "ReviewFindingDisposition" SET "assessmentSnapshot"='[]'`
      ],
      [
        'ReviewScopeSnapshot.snapshotJson syntax',
        `UPDATE "ReviewScopeSnapshot" SET "snapshotJson"='not-json'`
      ],
      [
        'ReviewScopeSnapshot.snapshotJson root',
        `UPDATE "ReviewScopeSnapshot" SET "snapshotJson"='[]'`
      ],
      [
        'FileOriginSession.retainedReviewIdsJson syntax',
        `UPDATE "FileOriginSession" SET "retainedReviewIdsJson"='not-json'`
      ],
      [
        'FileOriginSession.retainedReviewIdsJson root',
        `UPDATE "FileOriginSession" SET "retainedReviewIdsJson"='{}'`
      ],
      [
        'FileOriginSession active retention state',
        `UPDATE "FileOriginSession" SET "retainedReviewIdsJson"='[]'`
      ],
      [
        'FileOriginSession incomplete deleting state',
        `UPDATE "FileOriginSession" SET "state"='deleting'`
      ],
      ['ManagedFile.source', `UPDATE "ManagedFile" SET "source"='unknown'`],
      [
        'ArtifactVersion.evidenceJson syntax',
        `UPDATE "ArtifactVersion" SET "evidenceJson"='not-json'`
      ],
      ['ArtifactVersion.evidenceJson root', `UPDATE "ArtifactVersion" SET "evidenceJson"='[]'`],
      [
        'ArtifactVersion.executionSnapshotJson syntax',
        `UPDATE "ArtifactVersion" SET "executionSnapshotJson"='not-json'`
      ],
      [
        'ArtifactVersion.executionSnapshotJson root',
        `UPDATE "ArtifactVersion" SET "executionSnapshotJson"='[]'`
      ],
      [
        'ArtifactVersion incomplete execution snapshot',
        `UPDATE "ArtifactVersion" SET "executionSnapshotJson"='{}'`
      ],
      [
        'ArtifactVersionInput.strongestAssociation',
        `UPDATE "ArtifactVersionInput" SET "strongestAssociation"='unknown'`
      ],
      ['ComputeJob.resourceRequest syntax', `UPDATE "ComputeJob" SET "resourceRequest"='not-json'`],
      ['ComputeJob.resourceRequest root', `UPDATE "ComputeJob" SET "resourceRequest"='[]'`],
      ['ComputeJob.inputManifest syntax', `UPDATE "ComputeJob" SET "inputManifest"='not-json'`],
      ['ComputeJob.inputManifest root', `UPDATE "ComputeJob" SET "inputManifest"='{}'`],
      ['ComputeJob.outputManifest syntax', `UPDATE "ComputeJob" SET "outputManifest"='not-json'`],
      ['ComputeJob.outputManifest root', `UPDATE "ComputeJob" SET "outputManifest"='{}'`],
      ['ComputeJob.harvestConfig syntax', `UPDATE "ComputeJob" SET "harvestConfig"='not-json'`],
      ['ComputeJob.harvestConfig root', `UPDATE "ComputeJob" SET "harvestConfig"='[]'`],
      ['ComputeJob.remoteHandle syntax', `UPDATE "ComputeJob" SET "remoteHandle"='not-json'`],
      ['ComputeJob.remoteHandle root', `UPDATE "ComputeJob" SET "remoteHandle"='[]'`],
      [
        'ComputeJob.leftOnRemote syntax',
        `UPDATE "ComputeJob" SET "leftOnRemote"='not-json',"harvestedAt"=CURRENT_TIMESTAMP,"status"='success'`
      ],
      [
        'ComputeJob.leftOnRemote root',
        `UPDATE "ComputeJob" SET "leftOnRemote"='{}',"harvestedAt"=CURRENT_TIMESTAMP,"status"='success'`
      ],
      ['ComputeHost.sshOverrides syntax', `UPDATE "ComputeHost" SET "sshOverrides"='not-json'`],
      ['ComputeHost.sshOverrides root', `UPDATE "ComputeHost" SET "sshOverrides"='[]'`],
      ['ComputeHost.probeResult syntax', `UPDATE "ComputeHost" SET "probeResult"='not-json'`],
      ['ComputeHost.probeResult root', `UPDATE "ComputeHost" SET "probeResult"='[]'`]
    ] as const

    const accepted: string[] = []
    for (const [name, sql] of invalidWrites) {
      const acceptedWrite = new Error(`accepted: ${name}`)
      try {
        await client.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(sql)
          throw acceptedWrite
        })
      } catch (error) {
        if (error === acceptedWrite) accepted.push(name)
      }
    }
    expect(accepted).toEqual([])

    await expect(
      client.$transaction([
        client.notificationInboxItem.update({
          where: { id: 'notification' },
          data: { kind: 'task.needs-attention', actionState: 'pending' }
        }),
        client.fileOriginSession.update({
          where: { projectId_sessionId: { projectId: 'project', sessionId: 'session' } },
          data: {
            state: 'deleting',
            deletionOperationId: 'delete-operation',
            retainedReviewIdsJson: '[]'
          }
        }),
        client.artifactVersion.update({
          where: { id: 'version' },
          data: {
            executionSnapshotJson: '{}',
            executionSnapshotChecksum: 'execution-checksum',
            executionSnapshotStorageKey: 'execution.json',
            executionSnapshotSchemaVersion: 2
          }
        }),
        client.computeJob.update({
          where: { id: 'job' },
          data: {
            resourceRequest: '{}',
            inputManifest: '[]',
            outputManifest: '[]',
            harvestConfig: '{}',
            remoteHandle: '{}'
          }
        }),
        client.computeHost.update({
          where: { id: 'host' },
          data: { sshOverrides: '{}', probeResult: '{}' }
        })
      ])
    ).resolves.toBeDefined()
  })
})
