import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { NotebookKernelExecutor } from './kernel-executor'
import { callNotebookRpc, type NotebookMcpEnvironment } from './mcp-server'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService, resolveLoopScriptPaths } from './runtime-service'
import type { NotebookOutput, NotebookRunSummary } from '../../shared/notebook'
import type { NotebookControlResult, NotebookShellResult } from './runtime-service'

// End-to-end capability certification. Wires the REAL stack the way main/ipc.ts wires it: a real
// NotebookRuntimeService driving real NotebookKernelExecutor loops (python_loop.py / r_loop.R /
// repl_loop.js) over a temp storageRoot, plus a real NotebookLocalRpcServer whose mcpCall bridge is
// backed by a stub connectorService. Capabilities are exercised both directly through the service
// methods and through the MCP tool -> callNotebookRpc -> local-rpc-server dispatch layer, so the tool
// schemas are certified alongside the runtime.
//
// Gated like the other kernel integration tests so it is inert in normal CI. Run with:
//   RUN_KERNEL=1 OPEN_SCIENCE_TEST_PY_ENV=/opt/homebrew/bin/python3 \
//   OPEN_SCIENCE_TEST_R_ENV=/usr/local \
//   npx vitest run src/main/notebook/e2e.certification.test.ts
const pyBin = process.env.OPEN_SCIENCE_TEST_PY_ENV
const rEnvPrefix = process.env.OPEN_SCIENCE_TEST_R_ENV
const gate = process.env.RUN_KERNEL && pyBin ? describe : describe.skip
// R capabilities need a real R env prefix on top of the base gate.
const rIt = process.env.RUN_KERNEL && pyBin && rEnvPrefix ? it : it.skip

const PROJECT = 'default-project'
const SESSION = 'cert-session'

// Prints a labelled evidence snippet into the vitest run output so the certification report can quote
// the actual values the real stack produced (rather than paraphrased claims).
const evidence = (label: string, value: unknown): void => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  console.log(`[CERT] ${label}: ${text}`)
}

const findDisplay = (
  outputs: NotebookOutput[]
): Extract<NotebookOutput, { type: 'display' }> | undefined =>
  outputs.find((o): o is Extract<NotebookOutput, { type: 'display' }> => o.type === 'display')

type Harness = {
  service: NotebookRuntimeService
  rpcServer: NotebookLocalRpcServer
  env: NotebookMcpEnvironment
  connectorCalls: Array<{ server: string; method: string; args: Record<string, unknown> }>
  storageRoot: string
  cleanup: () => Promise<void>
}

// Builds the full wiring: runtime service + real executor loops + local RPC server + stub connector.
// idleTimeoutMs, when set, is forwarded to every executor so the lifecycle test can drive idle
// shutdown on a short window. onIdleShutdown mirrors NotebookRuntimeService.createExecutor so an idle
// proc surfaces a 'terminated' kernel status exactly as the default (non-test) executor path does.
const makeHarness = async (opts: { idleTimeoutMs?: number } = {}): Promise<Harness> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-cert-'))
  const loops = resolveLoopScriptPaths()
  const connectorCalls: Harness['connectorCalls'] = []
  const connectorService = {
    call: async (
      server: string,
      method: string,
      args: Record<string, unknown>
    ): Promise<unknown> => {
      connectorCalls.push({ server, method, args })
      // Canned connector payload; the stub stands in for the real ConnectorService.call dispatch.
      return {
        server,
        method,
        echoedArgs: args,
        properties: [{ CID: 1, MolecularWeight: '16.043' }]
      }
    }
  }

  // executorFactory runs lazily (first ensureSession), never during construction, so the closure can
  // safely reference `service` even though it is declared in this same statement.
  const service: NotebookRuntimeService = new NotebookRuntimeService({
    configRoot: storageRoot,
    dataRoot: storageRoot,
    projectName: PROJECT,
    repository: new NotebookRunRepository(storageRoot),
    // The real kernel executor, but pointed at the system interpreters (no micromamba provisioning is
    // available on this machine) with the shipped loop scripts. This is exactly what the default
    // createExecutor builds, minus the provisioned-env paths it cannot resolve here.
    executorFactory: (sessionId) =>
      new NotebookKernelExecutor({
        pythonBin: pyBin,
        rEnvPrefix,
        pythonLoopPath: loops.pythonLoopPath,
        rLoopPath: loops.rLoopPath,
        replLoopPath: loops.replLoopPath,
        idleTimeoutMs: opts.idleTimeoutMs,
        onIdleShutdown: () => {
          void (
            service as unknown as {
              handleKernelIdleShutdown: (sessionId: string, projectName: string) => Promise<void>
            }
          ).handleKernelIdleShutdown(sessionId, PROJECT)
        }
      })
  })

  const rpcServer = new NotebookLocalRpcServer(service, { connectorService })
  // Same wiring order as main/ipc.ts: the repl kernel gets the RPC server's connection for host.mcp().
  service.setMcpRpcConnectionResolver(() => rpcServer.ensureStarted())
  const conn = await rpcServer.ensureStarted()

  const env: NotebookMcpEnvironment = {
    endpoint: conn.endpoint,
    token: conn.token,
    projectName: PROJECT,
    sessionId: SESSION,
    workspaceCwd: storageRoot
  }

  const cleanup = async (): Promise<void> => {
    await service.shutdownAll()
    await rpcServer.close()
    await rm(storageRoot, { recursive: true, force: true })
  }

  return { service, rpcServer, env, connectorCalls, storageRoot, cleanup }
}

let active: Harness | undefined
afterEach(async () => {
  if (active) {
    await active.cleanup()
    active = undefined
  }
})

// Drives one capability through the MCP tool surface: callNotebookRpc is exactly what the registered
// MCP tool handler calls, so this exercises the tool input schema + local-rpc-server dispatch.
const viaMcp = async <T>(
  env: NotebookMcpEnvironment,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> => (await callNotebookRpc(env, method, params)) as T

gate('notebook capability certification (E2E)', () => {
  it('1. python persistence + rich matplotlib output (via MCP notebook_execute)', async () => {
    const h = (active = await makeHarness())

    const first = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
      code: 'x = 41',
      language: 'python'
    })
    expect(first.status).toBe('completed')

    const second = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
      code: 'x + 1',
      language: 'python'
    })
    expect(second.status).toBe('completed')
    const display = findDisplay(second.outputs)
    expect(display?.data['text/plain']).toBe('42')
    evidence('py persistence x+1 text/plain', display?.data['text/plain'])

    const plot = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
      code: [
        'import matplotlib',
        'import matplotlib.pyplot as plt',
        'plt.plot([1, 2, 3], [1, 4, 9])',
        'plt.title("cert")'
      ].join('\n'),
      language: 'python'
    })
    expect(plot.status).toBe('completed')
    const png = findDisplay(plot.outputs)
    expect(png && 'image/png' in png.data).toBe(true)
    const b64 = png?.data['image/png']
    evidence('py matplotlib image/png bytes(base64 len)', typeof b64 === 'string' ? b64.length : 0)
    expect(typeof b64 === 'string' && b64.length > 100).toBe(true)
  }, 60_000)

  rIt(
    '2. r kernel: print(41+1) stdout + ggplot image/png (via MCP notebook_execute language=r)',
    async () => {
      const h = (active = await makeHarness())

      const scalar = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
        code: 'print(41 + 1)',
        language: 'r'
      })
      expect(scalar.status).toBe('completed')
      expect(scalar.text.stdout).toContain('42')
      evidence('r print(41+1) stdout', scalar.text.stdout.trim())

      const plot = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
        code: [
          'library(ggplot2)',
          'ggplot(data.frame(x=1:3, y=1:3), aes(x, y)) + geom_point()'
        ].join('\n'),
        language: 'r'
      })
      expect(plot.status).toBe('completed')
      const png = findDisplay(plot.outputs)
      expect(png && 'image/png' in png.data).toBe(true)
      evidence('r ggplot image/png present', Boolean(png && 'image/png' in png.data))
    },
    120_000
  )

  it('3. repl + host.mcp reaches the connector over the loopback RPC (via MCP repl_execute)', async () => {
    const h = (active = await makeHarness())

    const result = await viaMcp<NotebookControlResult>(h.env, 'executeControl', {
      code: "const r = await host.mcp('chemistry','pubchem_get_properties',{ cids: [1] }); return r.properties[0].MolecularWeight"
    })
    expect(result.status).toBe('completed')
    const display = findDisplay(result.outputs)
    expect(display?.data['text/plain']).toBe('16.043')
    evidence('repl host.mcp returned value', display?.data['text/plain'])
    // The call actually traversed repl -> loopback RPC mcpCall -> stub connector.
    expect(h.connectorCalls).toEqual([
      { server: 'chemistry', method: 'pubchem_get_properties', args: { cids: [1] } }
    ])
    evidence('connector received call', h.connectorCalls[0])
  }, 60_000)

  it('4. cross-kernel handoff: repl fetches via host.mcp, writes ./handoff, python reads + computes', async () => {
    const h = (active = await makeHarness())

    const write = await viaMcp<NotebookControlResult>(h.env, 'executeControl', {
      code: [
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        "const r = await host.mcp('chemistry','pubchem_get_properties',{ cids: [1] })",
        'const dir = process.env.OPEN_SCIENCE_HANDOFF_DIR',
        'fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(r.properties))',
        'return "wrote " + path.join(dir, "data.json")'
      ].join('\n')
    })
    expect(write.status).toBe('completed')
    evidence('repl handoff write', findDisplay(write.outputs)?.data['text/plain'])

    const read = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
      code: [
        'import os, json',
        'p = os.path.join(os.environ["OPEN_SCIENCE_HANDOFF_DIR"], "data.json")',
        'rows = json.load(open(p))',
        'float(rows[0]["MolecularWeight"]) * 2'
      ].join('\n'),
      language: 'python'
    })
    expect(read.status).toBe('completed')
    const display = findDisplay(read.outputs)
    expect(display?.data['text/plain']).toBe('32.086')
    evidence('python read-from-handoff computed', display?.data['text/plain'])
  }, 60_000)

  it('5. bash: echo stdout + exitCode 0, and a non-zero exit surfaces (via MCP bash_execute)', async () => {
    const h = (active = await makeHarness())

    const ok = await viaMcp<NotebookShellResult>(h.env, 'executeShell', { command: 'echo hi' })
    expect(ok.stdout).toContain('hi')
    expect(ok.exitCode).toBe(0)
    evidence('bash echo', { stdout: ok.stdout.trim(), exitCode: ok.exitCode })

    const fail = await viaMcp<NotebookShellResult>(h.env, 'executeShell', { command: 'exit 7' })
    expect(fail.exitCode).toBe(7)
    evidence('bash non-zero exit', fail.exitCode)
  }, 30_000)

  it('6a. TRUST BOUNDARY: python has no host and no connector RPC env; repl in the same session does', async () => {
    const h = (active = await makeHarness())

    // Adversarial: probe the data kernel's own view of the connector channel.
    const probe = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
      code: [
        'import os',
        'print("ENDPOINT_IN_ENV=", "OPEN_SCIENCE_MCP_RPC_ENDPOINT" in os.environ)',
        'print("TOKEN_IN_ENV=", "OPEN_SCIENCE_MCP_RPC_TOKEN" in os.environ)',
        'try:',
        '    host',
        '    print("HOST=present")',
        'except NameError:',
        '    print("HOST=undefined")'
      ].join('\n'),
      language: 'python'
    })
    expect(probe.status).toBe('completed')
    expect(probe.text.stdout).toContain('ENDPOINT_IN_ENV= False')
    expect(probe.text.stdout).toContain('TOKEN_IN_ENV= False')
    expect(probe.text.stdout).toContain('HOST=undefined')
    evidence('python trust probe stdout', probe.text.stdout.trim())

    // Adversarial: actually try to call the connector from python; it must fail with NameError.
    const attack = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
      code: "host.mcp('chemistry','pubchem_get_properties',{'cids':[1]})",
      language: 'python'
    })
    expect(attack.status).toBe('failed')
    expect(attack.text.traceback).toMatch(/name 'host' is not defined/)
    evidence(
      'python host.mcp attack traceback tail',
      attack.text.traceback.trim().split('\n').slice(-1)[0]
    )

    // The connector stub was never reached from python.
    expect(h.connectorCalls).toHaveLength(0)

    // Contrast: the repl kernel in the SAME session DOES see the connector RPC endpoint.
    const replEnv = await h.service.executeControl({
      sessionId: SESSION,
      workspaceCwd: h.storageRoot,
      code: 'return String(process.env.OPEN_SCIENCE_MCP_RPC_ENDPOINT || "")'
    })
    const replEndpoint = findDisplay(replEnv.outputs)?.data['text/plain']
    expect(typeof replEndpoint === 'string' && replEndpoint.startsWith('http://')).toBe(true)
    evidence('repl sees connector endpoint', replEndpoint)
  }, 60_000)

  rIt(
    '6b. TRUST BOUNDARY: r has no host object and no connector RPC env',
    async () => {
      const h = (active = await makeHarness())

      const probe = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
        code: [
          'cat("ENDPOINT=[", Sys.getenv("OPEN_SCIENCE_MCP_RPC_ENDPOINT"), "]\\n", sep="")',
          'cat("TOKEN=[", Sys.getenv("OPEN_SCIENCE_MCP_RPC_TOKEN"), "]\\n", sep="")',
          'cat("HOST_EXISTS=", exists("host"), "\\n", sep="")'
        ].join('\n'),
        language: 'r'
      })
      expect(probe.status).toBe('completed')
      expect(probe.text.stdout).toContain('ENDPOINT=[]')
      expect(probe.text.stdout).toContain('TOKEN=[]')
      expect(probe.text.stdout).toContain('HOST_EXISTS=FALSE')
      evidence('r trust probe stdout', probe.text.stdout.trim())
    },
    60_000
  )

  rIt(
    '7. language routing: python and r are independent persistent processes (no shared state)',
    async () => {
      const h = (active = await makeHarness())

      const pySet = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
        code: 'route_marker = 123',
        language: 'python'
      })
      expect(pySet.status).toBe('completed')

      // r cannot see the python-defined name: they are separate processes in one session.
      const rSee = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
        code: 'cat("R_SEES_PY=", exists("route_marker"), "\\n", sep="")',
        language: 'r'
      })
      expect(rSee.status).toBe('completed')
      expect(rSee.text.stdout).toContain('R_SEES_PY=FALSE')
      evidence('r cannot see python state', rSee.text.stdout.trim())

      // python still has its own state; r state is likewise invisible to python.
      await viaMcp<NotebookRunSummary>(h.env, 'execute', { code: 'r_marker <- 9', language: 'r' })
      const pySee = await viaMcp<NotebookRunSummary>(h.env, 'execute', {
        code: [
          'print("PY_HAS_OWN=", route_marker == 123)',
          "print('PY_SEES_R=', 'r_marker' in dir())"
        ].join('\n'),
        language: 'python'
      })
      expect(pySee.status).toBe('completed')
      expect(pySee.text.stdout).toContain('PY_HAS_OWN= True')
      expect(pySee.text.stdout).toContain('PY_SEES_R= False')
      evidence('python routing stdout', pySee.text.stdout.trim())
    },
    90_000
  )

  it('8. lifecycle: idle kernel auto-shuts-down (terminated), next run respawns with a cleared namespace', async () => {
    const h = (active = await makeHarness({ idleTimeoutMs: 300 }))

    const seed = await h.service.execute({
      sessionId: SESSION,
      workspaceCwd: h.storageRoot,
      code: 'life_marker = 77'
    })
    expect(seed.status).toBe('completed')

    // Wait out the short idle window: the executor drops the proc and surfaces a 'terminated' status.
    const terminated = await waitForStatus(h, 'terminated', 8_000)
    expect(terminated).toBe('terminated')
    evidence('kernel status after idle window', terminated)

    // The next run transparently respawns a fresh python proc; its namespace is cleared, so the
    // previously-defined name is gone (NameError) and the status settles back to 'idle'.
    const afterRespawn = await h.service.execute({
      sessionId: SESSION,
      workspaceCwd: h.storageRoot,
      code: 'life_marker'
    })
    expect(afterRespawn.status).toBe('failed')
    expect(afterRespawn.text.traceback).toMatch(/name 'life_marker' is not defined/)
    evidence(
      'respawned namespace cleared',
      afterRespawn.text.traceback.trim().split('\n').slice(-1)[0]
    )

    const state = await h.service.state({ sessionId: SESSION, workspaceCwd: h.storageRoot })
    expect(state.kernelStatus).toBe('idle')
    evidence('kernel status after respawn run', state.kernelStatus)
  }, 30_000)
})

// Polls notebook state until the kernel reaches the wanted status or the deadline elapses.
async function waitForStatus(
  h: Harness,
  wanted: string,
  timeoutMs: number
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  let last: string | undefined
  while (Date.now() < deadline) {
    const state = await h.service.state({ sessionId: SESSION, workspaceCwd: h.storageRoot })
    last = state.kernelStatus
    if (last === wanted) return last
    await new Promise((r) => setTimeout(r, 100))
  }
  return last
}
