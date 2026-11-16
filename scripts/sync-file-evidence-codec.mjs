import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- plain Node helper
export async function syncFileEvidenceCodec({
  root = resolve(import.meta.dirname, '..'),
  target = resolve(root, 'resources/notebook/file_evidence_codec.mjs'),
  check = false
} = {}) {
  const source = resolve(root, 'src/main/artifacts/file-evidence-codec.mjs')
  const [sourceText, targetText] = await Promise.all([
    readFile(source, 'utf8'),
    readFile(target, 'utf8').catch((error) =>
      error.code === 'ENOENT' ? undefined : Promise.reject(error)
    )
  ])
  if (check) {
    if (sourceText !== targetText)
      throw new Error(`Generated file-evidence codec is stale: ${target}`)
    return false
  }
  if (sourceText !== targetText) {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }
  return sourceText !== targetText
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const check = process.argv.includes('--check')
  const changed = await syncFileEvidenceCodec({ check })
  console.log(
    check
      ? 'file-evidence codec is up to date'
      : changed
        ? 'synced file-evidence codec'
        : 'file-evidence codec already synced'
  )
}
