import { appendFile, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { SessionRepository } from './repository'
import { initDataRoot } from '../storage-root'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// This measures application payload bytes, not filesystem/SSD write amplification. The same
// fixture is used before and after the storage change; report output is opt-in and contains no
// user data. A new repository checks cold recovery instead of accepting an in-memory result.
it('measures accepted long-session saves and verifies their cold recovery', async () => {
  const measurements: unknown[] = []
  const sizes =
    process.env.OPEN_SCIENCE_STORAGE_BENCHMARK_LARGE === '1' ? [100, 1_000, 10_000] : [100, 1_000]
  // The store checkpoints a full 128-record suffix before accepting the following record.
  const updates = process.env.OPEN_SCIENCE_STORAGE_BENCHMARK_CHECKPOINT === '1' ? 129 : 6
  for (const count of sizes) {
    const root = await mkdtemp(join(tmpdir(), 'open-science-storage-benchmark-'))
    roots.push(root)
    initDataRoot(root)
    let writtenBytes = 0
    let checkpointPublications = 0
    const repository = new SessionRepository(root, {
      journalDependencies: {
        appendFile: async (path, contents) => {
          await appendFile(path, contents, 'utf8')
          writtenBytes += Buffer.byteLength(contents)
        }
      },
      renameFile: async (source, target) => {
        writtenBytes += (await stat(source)).size
        await rename(source, target)
        if (target.endsWith('bench-session.json')) checkpointPublications++
      }
    })
    let session: PersistedChatSession = {
      id: 'bench-session',
      projectId: 'bench-project',
      title: 'Synthetic session',
      cwd: root,
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      messages: Array.from({ length: count }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
        content: `synthetic-${index}: ${'x'.repeat(256)}`,
        status: 'complete',
        eventIds: [],
        createdAt: index + 1,
        updatedAt: index + 1,
        ...(index % 2 === 1 ? { completedAt: index + 1 } : {})
      }))
    }
    session = await repository.saveSession(session)
    const initialBytes = writtenBytes
    writtenBytes = 0
    checkpointPublications = 0
    const samples: number[] = []
    for (let update = 0; update < updates; update++) {
      const last = session.messages.at(-1)!
      const changed = {
        ...session,
        updatedAt: count + update + 1,
        messages: [
          ...session.messages.slice(0, -1),
          {
            ...last,
            content: last.content + 'y'.repeat(100),
            updatedAt: count + update + 1
          }
        ],
        // Feed the same canonical edit to both representations, as a real runtime mutation does.
        ...(session.conversationGraph
          ? {
              conversationGraph: {
                ...session.conversationGraph,
                messages: session.conversationGraph.messages.map((message) =>
                  message.id === last.id
                    ? {
                        ...message,
                        content: last.content + 'y'.repeat(100),
                        updatedAt: count + update + 1
                      }
                    : message
                )
              }
            }
          : {})
      }
      const start = performance.now()
      session = await repository.saveSession(changed, session.revision)
      samples.push(performance.now() - start)
    }
    const start = performance.now()
    const restored = await new SessionRepository(root).loadSessionWithDiagnostics(
      'bench-project',
      'bench-session',
      {
        preserveRuntimeState: true
      }
    )
    const restoreMs = performance.now() - start
    expect(restored.status).toBe('found')
    if (restored.status !== 'found') throw new Error('Synthetic session was not restored')
    expect(restored.session.messages).toEqual(session.messages)
    expect(restored.session.revision).toBe(session.revision)
    expect(restored.session.messages.at(-1)!.content.endsWith('y'.repeat(updates * 100))).toBe(true)
    expect(checkpointPublications).toBe(updates === 129 ? 1 : 0)
    measurements.push({
      count,
      initialBytes,
      updates: samples.length,
      changedTextBytes: updates * 100,
      checkpointPublications,
      cumulativeApplicationWriteBytes: writtenBytes,
      saveMs: samples,
      restoreMs
    })
  }
  if (process.env.OPEN_SCIENCE_STORAGE_BENCHMARK_REPORT) {
    await writeFile(
      process.env.OPEN_SCIENCE_STORAGE_BENCHMARK_REPORT,
      JSON.stringify(
        {
          note: 'Synthetic repository saves; application payload bytes, no SQLite/IPC/device write measurement.',
          measurements
        },
        null,
        2
      ) + '\n'
    )
  }
}, 120_000)
