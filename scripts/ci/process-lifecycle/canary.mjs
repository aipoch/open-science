import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { LifecycleObserver, identityKey } from './observer.mjs'

// These commands intentionally fail for leak/orphan/timeout. The parent test verifies both the
// nonzero exit and the pre-cleanup evidence, not merely that an exception was caught in-process.
const kind = process.argv[2]
const observer = new LifecycleObserver(`canary-${kind}`)
try {
  await observer.start()
  const descendant = `process.title='renamed-lifecycle-child'; setInterval(()=>{},1000);`
  const code = `
process.title = 'renamed-lifecycle-parent';
${kind === 'orphan' ? `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {detached:true,stdio:'ignore'}); c.unref();` : ''}
process.send('ready');
process.on('message', () => process.exit(0));
setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ['-e', code], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  await once(child, 'message')
  const identity = await observer.observe(
    child.pid,
    kind === 'borrowed' ? 'borrowed' : 'owned',
    kind === 'orphan' ? 2 : 1
  )
  if (kind === 'borrowed')
    await observer.checkpoint('borrowed-before-owner-stop', { surviving: [identityKey(identity)] })
  if (['clean', 'borrowed', 'orphan'].includes(kind)) {
    const exited = once(child, 'exit')
    child.send('stop')
    await exited
  }
  if (kind !== 'timeout') await observer.checkpoint('before-fixture-cleanup', { timeoutMs: 200 })
} catch {
  process.exitCode = 1
} finally {
  try {
    await observer.finish()
  } catch {
    process.exitCode = 1
  }
}
