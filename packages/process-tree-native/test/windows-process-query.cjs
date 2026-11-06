/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the native binding in a separate runtime. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

test(
  'runtime ancestry admits its worker but excludes its parent and sibling',
  {
    skip: process.platform !== 'win32',
    timeout: 10000
  },
  async () => {
    const sibling = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true })
    const runtime = spawn(
      process.execPath,
      [
        '-e',
        `
    const { spawn } = require('node:child_process');
    const native = require(process.argv[1]);
    const worker = spawn(process.execPath, ['-e', 'process.stdout.write("ready");process.stdin.resume()'], { windowsHide: true });
    worker.stdout.once('data', () => {
      process.stdout.write(JSON.stringify({ self: process.pid, worker: worker.pid, members: native.windowsCurrentProcessDescendants() }));
    });
    process.stdin.once('data', () => worker.stdin.end());
    worker.once('exit', () => process.exit());
  `,
        require.resolve('..')
      ],
      { windowsHide: true }
    )
    const runtimeExited = once(runtime, 'exit')
    const siblingExited = once(sibling, 'exit')
    try {
      const result = JSON.parse(String((await once(runtime.stdout, 'data'))[0]))
      assert.ok(result.members.includes(result.worker))
      assert.ok(!result.members.includes(result.self))
      assert.ok(!result.members.includes(process.pid))
      assert.ok(!result.members.includes(sibling.pid))
    } finally {
      runtime.stdin.end('stop')
      sibling.stdin.end()
      await Promise.all([runtimeExited, siblingExited])
    }
  }
)
