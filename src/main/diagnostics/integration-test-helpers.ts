import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import * as tar from 'tar'
import type { Logger } from '@aipoch/diagnostics/node'
import {
  createSessionDiagnosticsDesktop,
  type SessionDiagnosticsOptions
} from '../session-diagnostics/desktop'
import type { SessionDiagnosticExportRequest } from '../../shared/session-diagnostics'

// Host integration fixtures exercise installed public operations, never package internals.
export async function captureDiagnosticLogs(
  write: (log: Logger) => void | Promise<void>
): Promise<string[]> {
  const { createLogger, initLogger, flushLogs } = await import('@aipoch/diagnostics/node')
  const logDir = await mkdtemp(join(tmpdir(), 'diagnostic-log-contract-'))
  try {
    initLogger({ logDir, mirrorToConsole: false })
    await write(createLogger('host-contract'))
    await flushLogs()
    return (await readFile(join(logDir, 'main.log'), 'utf8')).trim().split('\n')
  } finally {
    await flushLogs()
    await rm(logDir, { recursive: true, force: true })
  }
}

export async function exportDiagnosticFiles(
  sources: ReturnType<SessionDiagnosticsOptions['resolveSources']>,
  request: Omit<SessionDiagnosticExportRequest, 'operationId'>
): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-export-contract-'))
  const archive = join(root, 'diagnostic.tar.gz')
  const worker = await build({
    entryPoints: [resolve(__dirname, '../session-diagnostics/worker-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false
  })
  const owner = createSessionDiagnosticsDesktop({
    createWorker: (options) => new Worker(worker.outputFiles[0].text, { ...options, eval: true }),
    resolveSources: () => sources,
    chooseDestination: async () => archive,
    temporaryRoot: root
  })
  try {
    const result = await owner.export({ ...request, operationId: 'host-contract' })
    if (result.status !== 'exported') throw new Error(JSON.stringify(result))
    const content = join(root, 'content')
    await mkdir(content)
    await tar.x({ file: archive, cwd: content })
    const files: Record<string, string> = {}
    for (const path of await readdir(content, { recursive: true })) {
      if ((await stat(join(content, path))).isFile())
        files[path.replaceAll('\\', '/')] = await readFile(join(content, path), 'utf8')
    }
    return files
  } finally {
    await owner.close()
    await rm(root, { recursive: true, force: true })
  }
}
