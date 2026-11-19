import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createWslMemoryReader } from './memory-policy-wsl-reader'

const fakeHelper = (body: string): ChildProcessWithoutNullStreams =>
  spawn(
    process.execPath,
    [
      '-e',
      `const readline = require('node:readline');
       readline.createInterface({input:process.stdin}).on('line', line => {
         const request = JSON.parse(line);
         ${body}
       });`
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )

describe('authenticated WSL memory reader transport', () => {
  it('routes concurrent fragmented replies and releases pinned namespace handles', async () => {
    const child = fakeHelper(`
      const values = {
        read: request.path,
        pinNamespace: {pin: 1, identity: '4:4026531835'},
        closeNamespace: null,
        validateExecutionTree: null,
        pageSize: 4096
      };
      const responseLine = JSON.stringify({id:request.id,ok:true,value:values[request.op]}) + '\\n';
      process.stdout.write(responseLine.slice(0, 3));
      process.stdout.write(responseLine.slice(3));
    `)
    const signal = new AbortController().signal
    const transport = createWslMemoryReader(child, signal)
    try {
      const [first, second, proof, pageSize] = await Promise.all([
        transport.reader.read('/proc/42/cgroup', signal, 0x9fa0n),
        transport.reader.read('/proc/42/stat', signal, 0x9fa0n),
        transport.reader.pinInitialNamespace(signal),
        transport.reader.pageSize(signal)
      ])
      await expect(
        Promise.all(
          Array.from({ length: 32 }, () =>
            transport.reader.read('/proc/42/cgroup', signal, 0x9fa0n)
          )
        )
      ).resolves.toHaveLength(32)
      expect(first).toBe('/proc/42/cgroup')
      expect(second).toBe('/proc/42/stat')
      expect(proof.identity).toBe('4:4026531835')
      expect(pageSize).toBe(4096)
      await proof.close()
      await proof.close()
      await transport.validateExecutionTree(
        {
          pid: 42,
          birth: '123',
          token: 'open-science-execution-00000000-0000-4000-8000-000000000000'
        },
        signal
      )
    } finally {
      await transport.close()
    }
    expect(child.exitCode).toBe(0)
  })

  it.each([
    "process.stdout.write('not json\\n')",
    "process.stdout.write(JSON.stringify({id:request.id+1,ok:true,value:'wrong'})+'\\n')",
    "process.stdout.write('x'.repeat(801*1024))"
  ])('rejects malformed or unbounded transport output: %s', async (body) => {
    const child = fakeHelper(body)
    const signal = new AbortController().signal
    const transport = createWslMemoryReader(child, signal)
    try {
      await expect(transport.reader.read('/proc/42/cgroup', signal, 0x9fa0n)).rejects.toMatchObject(
        {
          code: 'linux-memory-unavailable'
        }
      )
    } finally {
      await expect(transport.close()).rejects.toMatchObject({ code: 'linux-memory-unavailable' })
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('rejects oversized facts and closes the owned helper after abort', async () => {
    const child = fakeHelper(`
      process.stdout.write(JSON.stringify({id:request.id,ok:true,value:'x'.repeat(128*1024+1)})+'\\n');
    `)
    const controller = new AbortController()
    const transport = createWslMemoryReader(child, controller.signal)
    try {
      await expect(
        transport.reader.read('/proc/meminfo', controller.signal, 0x9fa0n)
      ).rejects.toMatchObject({ code: 'linux-memory-unavailable' })
      controller.abort()
      await expect(transport.reader.pageSize(controller.signal)).rejects.toMatchObject({
        code: 'linux-memory-unavailable'
      })
    } finally {
      await expect(transport.close()).rejects.toMatchObject({ code: 'linux-memory-unavailable' })
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('rejects pending reads when the helper exits without a complete response', async () => {
    const child = fakeHelper('process.stdout.write(\'{"id":\'); process.exit(0)')
    const signal = new AbortController().signal
    const transport = createWslMemoryReader(child, signal)
    try {
      await expect(transport.reader.read('/proc/meminfo', signal, 0x9fa0n)).rejects.toMatchObject({
        code: 'linux-memory-unavailable'
      })
    } finally {
      await transport.close()
    }
  })

  it('aborts a pending authenticated read instead of accepting a late reply', async () => {
    const child = fakeHelper(`
      setTimeout(() => process.stdout.write(JSON.stringify({id:request.id,ok:true,value:'late'})+'\\n'), 2000);
    `)
    const controller = new AbortController()
    const transport = createWslMemoryReader(child, controller.signal)
    const pending = transport.reader.read('/proc/meminfo', controller.signal, 0x9fa0n)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'linux-memory-unavailable' })
    await expect(transport.close()).rejects.toMatchObject({ code: 'linux-memory-unavailable' })
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })
})
