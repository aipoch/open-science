import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { LinuxMemoryPolicyAdapter } from './memory-policy-linux'
import { createWslMemoryReader, wslMemoryReaderProgram } from './memory-policy-wsl-reader'

const enabled =
  process.platform === 'win32' && process.env.OPEN_SCIENCE_TEST_WSL_MEMORY_READER === '1'
const anchorProgram = String.raw`
import json, os, signal, subprocess, sys, threading
signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
signal.alarm(20)
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
ready, release = threading.Event(), threading.Event()
thread_child_released = [False]
def worker():
    # A non-leader task owns this child; reading only /task/<pid>/children
    # would omit a real execution descendant.
    descendant = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    ready.set()
    try:
        release.wait(25)
    finally:
        descendant.kill()
        descendant.wait(timeout=3)
        thread_child_released[0] = descendant.returncode is not None
thread = threading.Thread(target=worker)
thread.start()
try:
    if not ready.wait(3):
        raise ValueError('thread-owned descendant not ready')
    with open('/proc/self/stat') as source:
        stat = source.read()
    birth = stat[stat.rfind(') ') + 2:].split()[19]
    print(json.dumps({'pid': os.getpid(), 'birth': birth}), flush=True)
    sys.stdin.read()
finally:
    release.set()
    thread.join(timeout=4)
    child.kill()
    child.wait(timeout=3)
    print(json.dumps({'released': child.returncode is not None and thread_child_released[0] and not thread.is_alive()}), flush=True)
`

describe.skipIf(!enabled)('real WSL authenticated memory reader', () => {
  it('reads actual Linux facts for an owned process and refuses mismatched identity', async () => {
    const distro = process.env.OPEN_SCIENCE_TEST_WSL_DISTRO
    const user = process.env.OPEN_SCIENCE_TEST_WSL_USER
    expect(
      distro,
      'Set OPEN_SCIENCE_TEST_WSL_DISTRO to the explicit test distribution'
    ).toBeTruthy()
    expect(user, 'Set OPEN_SCIENCE_TEST_WSL_USER to the explicit test user').toBeTruthy()
    const token = `open-science-execution-${randomUUID()}`
    const launch = (program: string): ChildProcessWithoutNullStreams =>
      spawn(
        'wsl.exe',
        [
          '--distribution',
          distro!,
          '--user',
          user!,
          '--exec',
          '/usr/bin/env',
          `OPEN_SCIENCE_WSL_EXECUTION_TOKEN=${token}`,
          '/usr/bin/python3',
          '-I',
          '-c',
          program
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      )
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    const anchor = launch(anchorProgram)
    const lines = createInterface({ input: anchor.stdout, crlfDelay: Infinity })
    const iterator = lines[Symbol.asyncIterator]()
    let released = false
    try {
      const identity = await iterator.next()
      expect(identity.done).toBe(false)
      const owner = { ...(JSON.parse(identity.value!) as { pid: number; birth: string }), token }
      expect(owner.pid).toBeGreaterThan(0)
      expect(owner.birth).toMatch(/^\d+$/)

      const transport = createWslMemoryReader(launch(wslMemoryReaderProgram), controller.signal)
      try {
        await transport.validateExecutionTree(owner, controller.signal)
        const namespace = await transport.reader.pinInitialNamespace(controller.signal)
        console.info('WSL memory reader identity', {
          pid: owner.pid,
          birth: owner.birth,
          namespace: namespace.identity
        })
        await namespace.close()
        const adapter = new LinuxMemoryPolicyAdapter({
          reader: transport.reader,
          pid: owner.pid,
          expectedBirth: owner.birth
        })
        const sample = await adapter.sample(controller.signal)
        expect(sample.platform).toBe('linux')
        expect(sample.facts.totalBytes).toBeGreaterThan(0)
        expect(sample.facts.availableBytes).toBeGreaterThanOrEqual(0)
        expect(sample.facts.availableBytes).toBeLessThanOrEqual(sample.facts.totalBytes!)
        expect(sample.facts.cgroup?.ancestors).toBe('complete')
        console.info('WSL memory reader facts', {
          source: sample.source,
          totalBytes: sample.facts.totalBytes,
          availableBytes: sample.facts.availableBytes,
          overcommitMode: sample.facts.overcommitMode,
          committedBytes: sample.facts.committedBytes,
          commitLimitBytes: sample.facts.commitLimitBytes,
          cgroupVersion: sample.facts.cgroup?.version,
          cgroupAncestors: sample.facts.cgroup?.ancestors,
          constraints: sample.facts.cgroup?.constraints.map(
            ({ currentBytes, maxBytes, highBytes }) => ({
              currentBytes,
              maxBytes,
              highBytes
            })
          )
        })
        await transport.validateExecutionTree(owner, controller.signal)
        await expect(
          transport.validateExecutionTree({ ...owner, birth: `${owner.birth}0` }, controller.signal)
        ).rejects.toMatchObject({ code: 'linux-memory-unavailable' })
        await expect(
          transport.validateExecutionTree(
            { ...owner, token: `open-science-execution-${randomUUID()}` },
            controller.signal
          )
        ).rejects.toMatchObject({ code: 'linux-memory-unavailable' })
        await expect(
          transport.reader.read('/etc/passwd', controller.signal, 0x9fa0n)
        ).rejects.toMatchObject({ code: 'linux-memory-unavailable' })
      } finally {
        await transport.close()
      }
    } finally {
      anchor.stdin.end()
      for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
        if ((JSON.parse(line) as { released?: boolean }).released) released = true
      }
      if (anchor.exitCode === null && anchor.signalCode === null) await once(anchor, 'close')
      lines.close()
      clearTimeout(timeout)
      expect(released, 'The original anchor must confirm its child has exited').toBe(true)
      expect(anchor.exitCode).toBe(0)
      console.info('WSL memory reader cleanup', {
        childReleased: released,
        exitCode: anchor.exitCode
      })
    }
  }, 25_000)
})
