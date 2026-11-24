/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import asar from '@electron/asar'

export async function packWebAssets(source, destination) {
  const assets = join(source, 'assets')
  await cp(source, destination, { recursive: true, filter: (file) => file !== assets })
  // Keep the container and its index outside the HTTP document root.
  const archive = join(dirname(destination), 'web-assets.asar')
  await asar.createPackage(assets, archive)
  asar.uncache(archive)
  const { headerSize } = asar.getRawHeader(archive)
  const entries = []
  for (const entry of await readdir(assets, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue
    const name = relative(assets, join(entry.parentPath, entry.name))
    if (!entry.isFile()) throw new Error(`Expected a regular web asset: ${name}`)
    const info = asar.statFile(archive, name, false)
    if ('files' in info || 'link' in info || info.unpacked)
      throw new Error(`Expected a packed web asset: ${name}`)
    // ASAR has an eight-byte size pickle followed by the header pickle and file data.
    entries.push([
      'assets/' + name.split(sep).join('/'),
      8 + headerSize + Number(info.offset),
      info.size
    ])
    if (!asar.extractFile(archive, name).equals(await readFile(join(assets, name))))
      throw new Error(`Packaged web asset differs from its input: ${name}`)
  }
  await writeFile(join(dirname(destination), 'web-assets.json'), JSON.stringify(entries))
}
