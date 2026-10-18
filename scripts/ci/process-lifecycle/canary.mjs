import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { LifecycleObserver, identityKey } from './observer.mjs'

// These commands intentionally fail for leak/orphan/timeout. The parent test verifies both the
// nonzero exit and the pre-cleanup evidence, not merely that an exception was caught in-process.
const kind = process.argv[2]
const observer = new LifecycleObserver(`canary-${kind}`)
let child
try {
  await observer.start()
  const descendant = `process.title='renamed-lifecycle-child'; process.send('ready'); process.disconnect(); setInterval(()=>{},1000);`
  const code = `
process.title = 'renamed-lifecycle-parent';
process.send('ready');
process.on('message', message => {
  if (message === 'stop') process.exit(0);
  if (message === 'prepare') {
    const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {detached:true,stdio:['ignore','ignore','ignore','ipc']});
    c.once('message', () => { c.unref(); process.send('descendant-ready'); });
  }
});
setInterval(()=>{},1000);`
  child = spawn(process.execPath, ['-e', code], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  await once(child, 'message', { signal: AbortSignal.timeout(5000) })
  const identity = await observer.observe(child.pid, kind === 'borrowed' ? 'borrowed' : 'owned', 1)
  if (kind === 'orphan') {
    const ready = once(child, 'message', { signal: AbortSignal.timeout(5000) })
    child.send('prepare')
    await ready
    await observer.observe(child.pid, 'owned', 2)
  }
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
    if (child && !observer.seen.size && child.exitCode === null && child.signalCode === null) {
      observer.errors.push('canary-not-observed')
      try {
        await observer.save()
      } finally {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
    await observer.finish()
  } catch {
    process.exitCode = 1
  }
}
