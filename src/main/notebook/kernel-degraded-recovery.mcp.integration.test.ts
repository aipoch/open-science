import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import {
  KernelProcessLifecycleOwner,
  type KernelProcessRecoveryController
} from './kernel-process-lifecycle.windows-posix'
import { createRootNotebookLane, notebookLaneKey } from './lane-identity'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { createNotebookMcpServer } from './mcp-server'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import { NotebookRuntimeService } from './runtime-service'

const resetRuntimeOwnership = configureTestRuntimeMetadata()

it.skipIf(process.platform === 'win32').each(['execute', 'shutdown'] as const)(
  'runs a real replacement REPL through MCP and rechecks late ownership evidence on %s',
  async (recheck) => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-degraded-mcp-'))
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    const rootFrameId = 'root-frame-session'
    const lane = createRootNotebookLane(scope.projectId, scope.sessionId, rootFrameId)
    const laneKey = notebookLaneKey(lane)
    const processKey = 'repl'
    const ledgerPrefix = createHash('sha256')
      .update(laneKey + '\0' + processKey)
      .digest('hex')
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: scope.projectId,
      memoryPolicy: healthyNotebookMemoryPolicy()
    })
    const rpc = new NotebookLocalRpcServer(service, { transport: 'tcp' })
    const client = new Client({ name: 'notebook-recovery-test', version: '1.0.0' })
    let server: ReturnType<typeof createNotebookMcpServer> | undefined
    try {
      const previous = new KernelProcessLifecycleOwner({ storageRoot: root })
      const oldEpoch = 'old-epoch'
      const intent = previous.beginSpawn({ laneKey, processKey, kernelEpochId: oldEpoch })
      const oldPid = 4242
      const receipt = previous.recordSpawned(intent, { pid: oldPid, posixBirthToken: 'fixture' })
      const ledger = dirname(receipt.path)
      const oldName = `${ledgerPrefix}.active.${oldPid}.${receipt.receiptId}.json`
      const oldPath = join(ledger, oldName)
      await rename(receipt.path, oldPath)
      const oldRecord = await readFile(oldPath, 'utf8')
      // Inject only the inconclusive OS observation. Receipt recovery, the RPC, and the new
      // kernel process use the production path, with no signals sent to the synthetic PID.
      const lifecycle = (
        service as unknown as {
          kernelProcessLifecycle: { controller: KernelProcessRecoveryController }
        }
      ).kernelProcessLifecycle
      const probe = vi.spyOn(lifecycle.controller, 'probe').mockResolvedValue('unknown')
      const terminate = vi.spyOn(lifecycle.controller, 'terminate')
      await service.recoverInterruptedOperations()

      const connection = await rpc.issueSessionConnection(
        scope.sessionId,
        scope.projectId,
        rootFrameId,
        true,
        service.createExecutionIntent(scope)
      )
      server = createNotebookMcpServer({ ...scope, ...connection })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)

      const response = await client.callTool({
        name: 'repl_execute',
        arguments: { code: 'console.log("replacement-kernel-ok")' }
      })
      const result = JSON.stringify(response)
      expect(response.isError, result).not.toBe(true)
      expect(result).not.toMatch(/KERNEL_STARTUP_FENCE|cleanup-verified/u)
      const reply = (response.content as Array<{ type: string; text?: string }>).find(
        (item) => item.type === 'text'
      )
      expect(JSON.parse(reply?.text ?? '{}')).toMatchObject({
        status: 'completed',
        stdout: 'replacement-kernel-ok\n'
      })
      await vi.waitFor(() =>
        expect(probe).toHaveBeenCalledWith(
          expect.objectContaining({ laneKey, processKey, kernelEpochId: oldEpoch }),
          ...(process.platform === 'darwin' ? [expect.any(Function)] : [])
        )
      )
      expect(terminate).not.toHaveBeenCalled()
      expect(await readFile(oldPath, 'utf8')).toBe(oldRecord)
      const entries = await readdir(ledger)
      const replacements = entries.filter(
        (name) =>
          name.startsWith(`${ledgerPrefix}.`) && name.includes('.active.') && name !== oldName
      )
      expect(replacements).toHaveLength(1)
      const replacementRecord = JSON.parse(await readFile(join(ledger, replacements[0]), 'utf8'))
      expect(replacementRecord).toMatchObject({ laneKey, processKey })
      expect(replacementRecord.kernelEpochId).not.toBe(oldEpoch)
      expect(replacementRecord.ownerToken === intent.record.ownerToken).toBe(false)
      expect((await service.state(scope)).runs.at(-1)).toMatchObject({
        status: 'completed',
        kernelEpochId: replacementRecord.kernelEpochId
      })

      if (recheck === 'execute') {
        probe.mockResolvedValue('dead')
        const continued = await client.callTool({
          name: 'repl_execute',
          arguments: { code: 'console.log("continued")' }
        })
        expect(continued.isError, JSON.stringify(continued)).not.toBe(true)
        expect((await service.state(scope)).runs.at(-1)).toMatchObject({
          status: 'completed',
          kernelEpochId: replacementRecord.kernelEpochId
        })
        await vi.waitFor(() =>
          expect(readFile(oldPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        )
      } else {
        await expect(service.shutdownAll()).resolves.toMatchObject({ reaped: false })
        probe.mockResolvedValue('dead')
        const afterShutdown = vi.fn(async () => undefined)
        await expect(service.shutdownAll({ afterShutdown })).resolves.toMatchObject({
          reaped: true
        })
        expect(afterShutdown).toHaveBeenCalledOnce()
        await expect(readFile(oldPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await client.close()
      await server?.close()
      await rpc.close()
      await service.dispose()
      await resetRuntimeOwnership()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000
)
