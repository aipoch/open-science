/* eslint-disable @typescript-eslint/no-require-imports -- Node fixture runs as CommonJS. */
const fs = require('node:fs')
const path = require('node:path')
const marker = path.join(process.cwd(), 'fixture-started')
if (fs.existsSync(marker)) {
  require('../../../../resources/notebook/repl_loop.js')
} else {
  fs.writeFileSync(marker, 'started')
  const child = require('node:child_process').spawn(
    process.execPath,
    [
      '-e',
      `const fs = require('node:fs');
      fs.writeFileSync('descendant.pid', String(process.pid));
      console.log('ready');
      setInterval(() => {
        if (fs.existsSync('descendant.stop')) {
          fs.writeFileSync('descendant.stopped', 'stopped');
          process.exit(0);
        }
      }, 50)`
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  child.stdout.once('data', () => process.exit(23))
}
