import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { Agent, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const preload = fileURLToPath(new URL('./node-local-service-preload.mjs', import.meta.url))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.skipIf(process.platform === 'win32')(
  'serves a private generation proof and business response on the same connection',
  async () => {
    const { root, socket } = await fixture()
    const proof = 'a'.repeat(64)
    const proofPath = '/__open_science_proof_' + 'b'.repeat(32)
    const path = join(root, 'proof-service.mjs')
    await writeFile(
      path,
      `import http from 'node:http';
    let requests = 0;
    const server = http.createServer((req, res) => res.end(JSON.stringify({ requests: ++requests,
      proofVisible: Object.keys(process.env).some(key => key.startsWith('OPEN_SCIENCE_SERVICE_PROOF')) })));
    server.listen(4173, '127.0.0.1', () => console.log('ready'));
    process.on('SIGTERM', () => server.close());`
    )
    const child = spawn(process.execPath, ['--import', preload, path], {
      env: childEnvironment(socket, {
        OPEN_SCIENCE_SERVICE_PROOF: proof,
        OPEN_SCIENCE_SERVICE_PROOF_PATH: proofPath
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const closed = once(child, 'close')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const sockets: unknown[] = []
    const get = (route: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            agent,
            socketPath: socket,
            hostname: 'localhost',
            port: 80,
            path: route,
            headers: { host: '127.0.0.1:4173' }
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (part) => {
              body += part
            })
            res.on('end', () => resolve(body))
            res.on('error', reject)
          }
        )
        req.on('socket', (value) => sockets.push(value))
        req.on('error', reject)
        req.end()
      })
    try {
      await once(child.stdout, 'data')
      expect(await get(proofPath)).toBe(proof)
      expect(JSON.parse(await get('/business'))).toEqual({ requests: 1, proofVisible: false })
      expect(sockets).toHaveLength(2)
      expect(sockets[0]).toBe(sockets[1])
      const helper = await execute(root, socket, "console.log('helper remains usable')")
      expect(helper).toEqual({ code: 0, stdout: 'helper remains usable\n', stderr: '' })
      expect(JSON.parse(await get('/business')).requests).toBe(2)
    } finally {
      agent.destroy()
      child.kill('SIGTERM')
      await closed
      clearTimeout(timeout)
    }
  }
)

async function fixture(): Promise<{ root: string; socket: string }> {
  // Canonical /tmp avoids macOS's symlink alias and keeps sun_path below its byte limit.
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'os-svc-')))
  roots.push(root)
  await chmod(root, 0o700)
  return { root, socket: join(root, 'service.sock') }
}

function childEnvironment(
  socket: string,
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return {
    OPEN_SCIENCE_SERVICE_SOCKET: socket,
    OPEN_SCIENCE_SERVICE_PORT: '4173',
    ...overrides
  }
}

async function execute(
  root: string,
  socket: string,
  script: string,
  overrides: Record<string, string | undefined> = {},
  adapter = preload
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const path = join(root, 'fixture.mjs')
  await writeFile(path, script)
  const child = spawn(process.execPath, ['--import', adapter, path], {
    env: childEnvironment(socket, overrides),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    const [code] = await once(child, 'close')
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

describe.skipIf(process.platform === 'win32')(
  'declared Node HTTP local-service transport adapter',
  () => {
    it.each(['positional', 'options'])(
      'serves HTTP over the exact Unix socket with %s listen semantics',
      async (form) => {
        const { root, socket } = await fixture()
        const script = `
      import http from 'node:http';
      const server = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host }));
      });
      const ready = function () {
        if (this !== server) throw Error('callback receiver changed');
        console.log(JSON.stringify({ ready: true, address: server.address() }));
      };
      const returned = ${form === 'positional' ? "server.listen(4173, '127.0.0.1', ready)" : "server.listen({port:4173, host:'localhost'}, ready)"};
      if (returned !== server) throw Error('listen return value changed');
      process.on('SIGTERM', () => server.close());
    `
        const path = join(root, 'fixture.mjs')
        await writeFile(path, script)
        const child = spawn(process.execPath, ['--import', preload, path], {
          env: childEnvironment(socket),
          stdio: ['ignore', 'pipe', 'pipe']
        })
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
        const closed = once(child, 'close')
        let errors = ''
        child.stderr.on('data', (chunk) => {
          errors += chunk.toString()
        })
        try {
          const ready = await new Promise<string>((resolve, reject) => {
            child.stdout.once('data', (chunk) => resolve(chunk.toString()))
            child.once('exit', () => reject(new Error(errors || 'service exited before ready')))
          })
          expect(JSON.parse(ready)).toEqual({ ready: true, address: socket })
          const result = await new Promise<{ status: number | undefined; body: string }>(
            (resolve, reject) => {
              const req = request(
                {
                  socketPath: socket,
                  path: '/capabilities?fixture=1',
                  method: 'GET',
                  headers: { host: '127.0.0.1:4173' }
                },
                (res) => {
                  let body = ''
                  res.on('data', (chunk) => {
                    body += chunk.toString()
                  })
                  res.on('end', () => resolve({ status: res.statusCode, body }))
                }
              )
              req.on('error', reject)
              req.end()
            }
          )
          expect(result.status).toBe(200)
          expect(JSON.parse(result.body)).toEqual({
            method: 'GET',
            url: '/capabilities?fixture=1',
            host: '127.0.0.1:4173'
          })
          expect(await readFile(path, 'utf8')).toBe(script)
        } finally {
          child.kill('SIGTERM')
          await closed
          clearTimeout(timeout)
        }
        expect(errors).toBe('')
      }
    )

    it.each([
      "server.listen(4173, '0.0.0.0')",
      "server.listen(4174, '127.0.0.1')",
      'server.listen(4173)',
      "server.listen({port:4173, host:'127.0.0.1', exclusive:true})",
      'server.listen(process.env.OPEN_SCIENCE_SERVICE_SOCKET)',
      "server.listen('4173', '127.0.0.1')"
    ])('rejects an undeclared listen call: %s', async (call) => {
      const { root, socket } = await fixture()
      const result = await execute(
        root,
        socket,
        `import http from 'node:http'; const server=http.createServer(); ${call};`
      )
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('OPEN_SCIENCE_SERVICE_ADAPTER_INVALID')
    })

    it('rejects a second service binding even after the first server closes', async () => {
      const { root, socket } = await fixture()
      const result = await execute(
        root,
        socket,
        `
      import http from 'node:http';
      const first = http.createServer();
      first.listen(4173, '127.0.0.1', () => first.close(() => http.createServer().listen(4173, '127.0.0.1')));
    `
      )
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('only one service binding')
    })

    it.each([
      { OPEN_SCIENCE_SERVICE_SOCKET: '' },
      { OPEN_SCIENCE_SERVICE_SOCKET: 'relative.sock' },
      { OPEN_SCIENCE_SERVICE_PORT: '' },
      { OPEN_SCIENCE_SERVICE_PORT: '04173' },
      { OPEN_SCIENCE_SERVICE_PORT: '70000' }
    ])('rejects invalid environment before executing the entrypoint: %j', async (overrides) => {
      const { root, socket } = await fixture()
      const result = await execute(root, socket, "console.log('ENTRYPOINT_EXECUTED')", overrides)
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('OPEN_SCIENCE_SERVICE_ADAPTER_INVALID')
    })

    it('requires a pre-created private nonsymlink socket directory and vacant destination', async () => {
      const { root, socket } = await fixture()
      await chmod(root, 0o755)
      expect((await execute(root, socket, "console.log('unexpected')")).stderr).toContain(
        'private directory'
      )
      await chmod(root, 0o700)
      await writeFile(socket, 'preserve existing content')
      expect(
        (
          await execute(
            root,
            socket,
            "import http from 'node:http'; http.createServer().listen(4173, '127.0.0.1')"
          )
        ).stderr
      ).toContain('destination already exists')
      expect(await readFile(socket, 'utf8')).toBe('preserve existing content')
      const nested = join(root, 'private')
      await mkdir(nested, { mode: 0o700 })
      await symlink(nested, join(root, 'alias'))
      expect(
        (await execute(root, join(root, 'alias/service.sock'), "console.log('unexpected')")).stderr
      ).toContain('private directory')
    })

    it('rejects URL parameters on the preload module before running the entrypoint', async () => {
      const { root, socket } = await fixture()
      const result = await execute(
        root,
        socket,
        "console.log('unexpected')",
        {},
        preload + '?alternate=1'
      )
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('without URL parameters')
    })
  }
)
