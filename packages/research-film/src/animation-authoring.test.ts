import { researchFilmResources } from './resources.js'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { writeResearchVideoAnimations } from './animation-authoring.js'
import { parseResearchVideoScreenplay } from './screenplay.js'
import { buildResearchVideoPlayer } from './build-player.js'
import { ResearchFilmOutputLimitError } from './authoring-correction.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-animation-'))
  roots.push(root)
  return root
}
const original = {
  version: 1,
  title: 'Heat in orbit',
  case: 'heat-in-orbit',
  session: 'session.json',
  scenes: [
    {
      id: 'hook',
      role: 'hook',
      msg: 0,
      lines: [{ caption: 'Where does heat go?' }],
      panels: [
        { type: 'title', text: 'Where does heat go?' },
        {
          type: 'animation',
          script: 'anims/hook.js',
          use: ['anims/satellite.js'],
          size: 'band',
          box: 'plain'
        }
      ]
    }
  ]
}

it.each(['```json\n', '```\n', '```json \r\n\t\n'])(
  'parses the original screenplay inside a %j fence',
  (opening) => {
    expect(
      parseResearchVideoScreenplay(opening + JSON.stringify(original) + '\n```', 1)
    ).toMatchObject(original)
  }
)

it('rejects an unterminated fence with long whitespace and preserves the source size limit', () => {
  expect(() => parseResearchVideoScreenplay('```\n' + '\n\t'.repeat(50_000) + '{}', 1)).toThrow(
    SyntaxError
  )
  expect(() =>
    parseResearchVideoScreenplay(JSON.stringify({ text: 'a'.repeat(128 * 1024) }), 1)
  ).toThrow('Explanation source exceeds 128 KiB')
})

it('preserves original skill fields and bundles generated shared and scene scripts into the player', async () => {
  const root = await directory()
  const spec = parseResearchVideoScreenplay(JSON.stringify(original), 1)
  expect(spec).toMatchObject(original)
  const helper = 'function satellite(k) { k.ctx.fillRect(0, 0, 20, 20); }'
  const writer = vi.fn(async (input) => (input.shared ? helper : 'satellite(k);'))
  await writeResearchVideoAnimations(spec, root, writer, new AbortController().signal)
  expect(writer.mock.calls.map(([input]) => input.path)).toEqual([
    'anims/satellite.js',
    'anims/hook.js'
  ])
  expect(writer.mock.calls[1][0].sharedFiles).toEqual({ 'anims/satellite.js': helper })
  await writeFile(join(root, 'video.json'), JSON.stringify(spec))
  await writeFile(
    join(root, 'session.json'),
    JSON.stringify({ messages: [{ md: 'Where does heat go?' }] })
  )
  await mkdir(join(root, 'voice'))
  await writeFile(
    join(root, 'voice/timings.json'),
    JSON.stringify({ say: { hook_0: 'Where does heat go?' }, lines: { hook_0: 1 } })
  )
  await writeFile(
    join(root, 'voice/word-times.json'),
    JSON.stringify({
      hook_0: [
        [0, 0.2],
        [0.2, 0.4],
        [0.4, 0.6],
        [0.6, 1]
      ]
    })
  )
  await writeFile(join(root, 'voice/hook_0.wav'), 'test audio')
  await writeFile(join(root, 'mix.wav'), 'test audio')
  const result = await buildResearchVideoPlayer({
    specPath: join(root, 'video.json'),
    voiceDirectory: join(root, 'voice'),
    engineDirectory: join(researchFilmResources().stageDirectory, ''),
    outputDirectory: join(root, 'output')
  })
  const archive = unzipSync(await readFile(result.sourcePath))
  expect(Buffer.from(archive['anims/satellite.js']).toString()).toBe(helper)
  expect(Buffer.from(archive['anims/hook.js']).toString()).toBe('satellite(k);')
  expect(await readFile(result.playerPath, 'utf8')).toContain(helper)
})

it('corrects invalid script syntax once without executing generated code in Node', async () => {
  const root = await directory()
  const writer = vi
    .fn()
    .mockResolvedValueOnce('function satellite( {')
    .mockResolvedValueOnce('function satellite(k) { throw new Error("browser only"); }')
    .mockResolvedValueOnce('```js\nsatellite(k);\n```')
  await writeResearchVideoAnimations(original, root, writer, new AbortController().signal)
  expect(writer.mock.calls[1][2]).toMatchObject({
    draft: 'function satellite( {',
    error: expect.any(String)
  })
  expect(await readFile(join(root, 'anims/hook.js'), 'utf8')).toBe('satellite(k);')
})

it.each(['../escape.js', 'anims/../escape.js', 'C:\\escape.js', 'anims/SATELLITE.js'])(
  'rejects unsafe or conflicting animation paths before asking the model: %s',
  async (script) => {
    const root = await directory()
    const spec = structuredClone(original)
    spec.scenes[0].panels[1].script = script
    const writer = vi.fn()
    await expect(
      writeResearchVideoAnimations(spec, root, writer, new AbortController().signal)
    ).rejects.toThrow()
    expect(writer).not.toHaveBeenCalled()
  }
)

it('does not persist model output after cancellation', async () => {
  const root = await directory()
  const controller = new AbortController()
  await expect(
    writeResearchVideoAnimations(
      original,
      root,
      async () => {
        controller.abort()
        return 'function satellite() {}'
      },
      controller.signal
    )
  ).rejects.toThrow()
  await expect(readFile(join(root, 'anims/satellite.js'))).rejects.toThrow()
})

it.each(['complete', 'invalid', 'truncated', 'cancelled'])(
  'bounds animation truncation recovery when the replacement is %s',
  async (replacement) => {
    const root = await directory()
    const controller = new AbortController()
    const writer = vi.fn().mockRejectedValueOnce(new ResearchFilmOutputLimitError('output limit'))
    writer.mockImplementation(async () => {
      if (replacement === 'cancelled') controller.abort()
      if (replacement === 'truncated') throw new ResearchFilmOutputLimitError('output limit')
      return replacement === 'invalid' ? 'function(' : 'function satellite() {}'
    })
    const result = writeResearchVideoAnimations(original, root, writer, controller.signal)
    if (replacement === 'complete') {
      await result
      expect(writer).toHaveBeenCalledTimes(3) // Two helper attempts, then one scene.
      expect(await readFile(join(root, 'anims/satellite.js'), 'utf8')).toBe(
        'function satellite() {}'
      )
    } else {
      await expect(result).rejects.toThrow()
      expect(writer).toHaveBeenCalledTimes(2)
      await expect(readFile(join(root, 'anims/satellite.js'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
    expect(writer.mock.calls[1][2]).toMatchObject({
      draft: '',
      error: expect.stringContaining('shorter')
    })
  }
)

it('accepts the original checklist type and rejects added artwork fields', () => {
  const spec = structuredClone(original)
  const panels: unknown[] = spec.scenes[0].panels
  panels.push({ type: 'checklist', items: [{ text: 'Measured', state: 'pass' }] })
  expect(parseResearchVideoScreenplay(JSON.stringify(spec), 1).scenes[0].panels[2].type).toBe(
    'checklist'
  )
  Object.assign(spec.scenes[0].panels[1], { artwork: {} })
  expect(() => parseResearchVideoScreenplay(JSON.stringify(spec), 1)).toThrow()
})

it('finishes helpers before scheduling at most two scene writers with identical helper inputs', async () => {
  const root = await directory()
  const spec = structuredClone(original)
  spec.scenes = ['first', 'second', 'third'].map((id) => ({
    ...structuredClone(original.scenes[0]),
    id,
    panels: [
      {
        type: 'animation',
        script: `anims/${id}.js`,
        use: ['anims/satellite.js'],
        size: 'band',
        box: 'plain'
      }
    ]
  }))
  let active = 0,
    peak = 0,
    helpersReady = false
  const started: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const result = writeResearchVideoAnimations(
    spec,
    root,
    async (input) => {
      if (input.shared) {
        helpersReady = true
        return 'function satellite() {}'
      }
      expect(helpersReady).toBe(true)
      expect(input.sharedFiles).toEqual({ 'anims/satellite.js': 'function satellite() {}' })
      peak = Math.max(peak, ++active)
      started.push(input.path)
      if (started.length <= 2) await gate
      active--
      return 'satellite(k);'
    },
    new AbortController().signal
  )
  await vi.waitFor(() => expect(started).toHaveLength(2))
  release()
  await result
  expect(peak).toBe(2)
  expect(started).toHaveLength(3)
})

it('aborts and drains the other animation writer before rejecting and starts no queued scenes', async () => {
  const root = await directory()
  const spec = structuredClone(original)
  spec.scenes[0].panels = ['fail', 'wait', 'queued'].map((name) => ({
    type: 'animation',
    script: `anims/${name}.js`,
    use: [],
    size: 'band',
    box: 'plain'
  }))
  let release: () => void = () => {},
    fail: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const failure = new Promise<void>((resolve) => {
    fail = resolve
  })
  let otherSignal: AbortSignal | undefined
  let settled = false
  const started: string[] = []
  const result = writeResearchVideoAnimations(
    spec,
    root,
    async (input, signal) => {
      started.push(input.path)
      if (input.path === 'anims/fail.js') {
        await failure
        throw new Error('authoring failed')
      }
      otherSignal = signal
      await gate
      return 'k.ctx.fillRect(0, 0, 1, 1);'
    },
    new AbortController().signal
  )
  const rejection = expect(
    result.finally(() => {
      settled = true
    })
  ).rejects.toThrow('authoring failed')
  await vi.waitFor(() => expect(started).toHaveLength(2))
  fail()
  await vi.waitFor(() => expect(otherSignal?.aborted).toBe(true))
  expect(settled).toBe(false)
  release()
  await rejection
  expect(started).toEqual(['anims/fail.js', 'anims/wait.js'])
  await expect(readFile(join(root, 'anims/wait.js'))).rejects.toMatchObject({ code: 'ENOENT' })
})
