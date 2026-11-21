import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'

const [source, destination] = process.argv.slice(2)
if (!source || !destination || process.argv.length !== 4)
  throw new Error('Usage: node scripts/prepare-science-comment-control.mjs SOURCE DESTINATION')

const sampleLimit = 16 * 1024 * 1024
const { size } = await stat(source)
if (size > sampleLimit) throw new Error('Only small synthetic test packages are supported.')
const treatment = await readFile(source)
if (
  treatment.length < 19 ||
  treatment.length > sampleLimit ||
  !treatment.subarray(0, 4).equals(Buffer.from([0x1f, 0x8b, 8, 0x10]))
) {
  throw new Error('Expected a gzip member with FCOMMENT and no other optional header fields.')
}
const bodyStart = treatment.indexOf(0, 10) + 1
if (bodyStart <= 10 || bodyStart >= treatment.length - 8)
  throw new Error('Invalid gzip comment or body.')

const control = Buffer.concat([treatment.subarray(0, 10), treatment.subarray(bodyStart)])
control[3] &= ~0x10
const treatmentTar = gunzipSync(treatment, { maxOutputLength: sampleLimit })
const controlTar = gunzipSync(control, { maxOutputLength: sampleLimit })
if (!control.subarray(10).equals(treatment.subarray(bodyStart)) || !controlTar.equals(treatmentTar))
  throw new Error('The compressed body, trailer or tar changed.')

await writeFile(destination, control, { flag: 'wx' })
console.log(
  JSON.stringify({
    comment: treatment.toString('ascii', 10, bodyStart - 1),
    treatmentSha256: createHash('sha256').update(treatment).digest('hex'),
    controlSha256: createHash('sha256').update(control).digest('hex'),
    tarSha256: createHash('sha256').update(treatmentTar).digest('hex')
  })
)
