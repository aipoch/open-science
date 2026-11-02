// Ship only application-owned bootstrap code and the pinned dependency manifest.
import { cp, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const destination = join(root, 'out/pi-bootstrap')
await mkdir(destination, { recursive: true })
for (const name of ['bootstrap.mjs', 'permission-guard.mjs', 'package-lock.json']) {
  await cp(join(root, 'src/main/pi-acp', name), join(destination, name))
}
