import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { createManagedShellExecutionCapability } from './managed-shell-execution'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const fixture = String.raw`
const fs = require('node:fs'), http = require('node:http'), net = require('node:net');
const [privatePath, inputPath, mode] = process.argv.slice(2);
const server = http.createServer((req,res)=>res.end('ready'));
(async()=>{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(process.env.OPEN_SCIENCE_SERVICE_SOCKET,resolve)});
  const result = {};
  result.http = await new Promise((resolve,reject)=>{
    http.get({socketPath:process.env.OPEN_SCIENCE_SERVICE_SOCKET,path:'/status'}, res=>{
      let body='';res.on('data', chunk=>body+=chunk);res.on('end',()=>resolve(body));
    }).on('error',reject);
  });
  result.tcp = await new Promise(resolve=>{
    const tcp=net.createServer();tcp.once('error',error=>resolve(error.code));
    tcp.listen({port:0,host:'127.0.0.1'},()=>tcp.close(()=>resolve('allowed')));
  });
  try { fs.readFileSync(privatePath); result.privateRead='allowed'; }
  catch(error) { result.privateRead=error.code; }
  result.inputRead = fs.readFileSync(inputPath,'utf8');
  try { fs.writeFileSync(inputPath,'changed'); result.inputWrite='allowed'; }
  catch(error) { result.inputWrite=error.code; }
  fs.writeFileSync('result.json',JSON.stringify(result));
  console.log(JSON.stringify(result));
  if(mode==='normal') await new Promise(resolve=>server.close(resolve));
})().catch(error=>{console.error(error);process.exit(1)});
`

describe.skipIf(process.platform !== 'darwin')(
  'managed invocation in the real macOS sandbox',
  () => {
    it.each(['normal', 'cancel', 'timeout'] as const)(
      'contains and reaps one %s invocation without a bounded Runtime',
      async (mode) => {
        if (process.versions.electron || Number(process.versions.node.split('.')[0]) < 22) {
          throw new Error('This integration test requires an independent Node >=22.')
        }
        const root = await realpath(await mkdtemp(join(tmpdir(), 'os-managed-native-')))
        const work = join(root, 'work'),
          inputs = join(root, 'inputs'),
          ordinary = join(root, 'ordinary')
        await Promise.all([work, inputs, ordinary].map((path) => mkdir(path)))
        const inputPath = join(inputs, 'input.txt'),
          script = join(inputs, 'fixture.cjs'),
          privatePath = join(root, 'private.txt')
        await Promise.all([
          writeFile(script, fixture),
          writeFile(inputPath, 'immutable'),
          writeFile(privatePath, 'private')
        ])
        const node = await realpath(process.execPath)
        const owner = new NotebookNetworkSandboxOwner({
          resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
          temporaryRoot: join(root, 'commands'),
          getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
          persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
          requestDecision: async () => 'deny'
        })
        const repository = new NotebookRunRepository(root)
        const service = new NotebookRuntimeService({
          configRoot: root,
          dataRoot: root,
          projectId: 'project',
          repository,
          processSandbox: owner
        })
        const scope = {
          projectId: 'project',
          sessionId: 'session',
          executionInvocationId: `managed-${mode}`
        }
        const sockets: string[] = []
        const lifetime = new AbortController()
        const capability = createManagedShellExecutionCapability({
          ...scope,
          cwd: work,
          environment: { HOME: work, PATH: `${dirname(node)}:/usr/bin:/bin` },
          filesystem: { readOnlyRoots: [inputs, dirname(node)], readWriteRoots: [work] },
          signal: lifetime.signal,
          localService: {
            logicalPort: 4173,
            prepareSocket: async ({ runId }) => {
              const directory = await mkdtemp(`/private/tmp/os-service-${runId}-`)
              sockets.push(directory)
              await chmod(directory, 0o700)
              return join(directory, 'service.sock')
            }
          }
        })
        let completion: ReturnType<NotebookRuntimeService['executeManagedShell']> | undefined
        try {
          await service.recoverInterruptedOperations()
          completion = service.executeManagedShell(
            {
              ...scope,
              workspaceCwd: ordinary,
              command: [node, script, privatePath, inputPath, mode].map(quote).join(' '),
              timeoutMs: mode === 'timeout' ? 1000 : 10_000
            },
            capability
          )
          if (mode === 'cancel') {
            await vi.waitFor(
              async () =>
                expect(JSON.parse(await readFile(join(work, 'result.json'), 'utf8')).http).toBe(
                  'ready'
                ),
              { timeout: 10_000 }
            )
            expect(await service.confirmManagedShellCleanup(scope)).toMatchObject({
              state: 'running',
              reaped: false
            })
            lifetime.abort()
          }
          const result = await completion
          expect(result.exitCode).toBe(mode === 'normal' ? 0 : null)
          const permissions = JSON.parse(await readFile(join(work, 'result.json'), 'utf8'))
          expect(permissions).toMatchObject({ http: 'ready', inputRead: 'immutable' })
          for (const key of ['tcp', 'privateRead', 'inputWrite'])
            expect(['EPERM', 'EACCES']).toContain(permissions[key])
          expect(await readFile(inputPath, 'utf8')).toBe('immutable')
          const proof = await service.confirmManagedShellCleanup(scope, { retry: true })
          expect(proof).toMatchObject({
            scope,
            state: 'verified',
            reaped: true,
            proof: 'process-owner'
          })
          const [run] = await repository.readSessionRuns(scope.projectId, scope.sessionId)
          expect(proof.runId).toBe(run.runId)
          expect(run.frozenShellContext?.environment).not.toHaveProperty(
            'OPEN_SCIENCE_SERVICE_SOCKET'
          )
          expect(run.status).toBe(
            mode === 'normal' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'timeout'
          )
        } finally {
          lifetime.abort()
          await completion?.catch(() => undefined)
          const stopped = await service.shutdownAll()
          await service.dispose()
          await owner.dispose()
          expect(stopped.reaped).toBe(true)
          if (stopped.reaped) {
            await Promise.all(sockets.map((path) => rm(path, { recursive: true, force: true })))
            await rm(root, { recursive: true, force: true })
          }
        }
      },
      25_000
    )
  }
)

;(await import('../../../test/runtime-metadata')).configureTestRuntimeMetadata()
