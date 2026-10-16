import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('runs real WASM inference with the local translation worker configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'translation-worker-'))
  try {
    const model = join(directory, '模型 # identity.onnx')
    // ONNX IR 8 / opset 13: Identity(x: float[3]) -> y: float[3]. No downloaded weights.
    await writeFile(
      model,
      Buffer.from(
        'CAg6RwoQCgF4EgF5IghJZGVudGl0eRIRcGFja2FnZWQtaWRlbnRpdHlaDwoBeBIKCggIARIECgIIA2IPCgF5EgoKCAgBEgQKAggDQgQKABAN',
        'base64'
      )
    )
    const worker = pathToFileURL(resolve(__dirname, '../resources/local-worker.mjs')).href
    // EOF lets the actual worker finish its request loop. Its unmodified ONNX configuration
    // remains available in the child; no mocks or test-only wasmPaths overrides are used.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          try {
            await import(${JSON.stringify(worker)});
            const ort = globalThis[Symbol.for('onnxruntime')];
            const session = await ort.InferenceSession.create(${JSON.stringify(model)}, {
              executionProviders: ['wasm']
            });
            try {
              const output = await session.run({
                x: new ort.Tensor('float32', new Float32Array([2, 4, 8]), [3])
              });
              console.log(JSON.stringify(Array.from(output.y.data)));
            } finally {
              await session.release();
            }
          } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
          }
        `
      ],
      { input: '', encoding: 'utf8', windowsHide: true, timeout: 30_000 }
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual([2, 4, 8])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 40_000)
