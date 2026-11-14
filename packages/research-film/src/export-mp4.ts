export type { VideoEncoderPaths } from './ports.js'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, link } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  assertVideoEncoderReady,
  ownVideoProcess,
  reapVideoProcesses,
  waitForVideoProcess
} from './encoder-process.js'
export { assertVideoEncoderReady, ResearchVideoEncoderCleanupError } from './encoder-process.js'

const ENCODER_IDLE_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 120_000
let exporting = false

export type VideoFrameRenderer = {
  /** Return a PNG of the stage alone at exactly width × height, after drawing this time. */
  capture(seconds: number, signal: AbortSignal): Promise<Uint8Array>
}

/** Encoder paths are supplied by the host; no browser or encoder discovery/download occurs here. */
export async function exportResearchVideoMp4(options: {
  renderer: VideoFrameRenderer
  audioPath: string
  outputPath: string
  encoderPath: string
  probePath: string
  width: number
  height: number
  duration: number
  signal: AbortSignal
  onProgress?: (frames: number, total: number) => void
  onPhase?: (phase: 'encoding' | 'verifying') => void
}): Promise<void> {
  const { width, height, duration } = options
  const deadline = new AbortController()
  const signal = AbortSignal.any([options.signal, deadline.signal])
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armDeadline = (message: string, timeout: number): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => deadline.abort(new Error(message)), timeout)
  }
  if (
    ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096 && n % 2 === 0) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 3600
  )
    throw new Error('Invalid video dimensions or duration')
  assertVideoEncoderReady()
  if (exporting) throw new Error('A Film export is already running.')
  signal.throwIfAborted()
  exporting = true
  let directory: string
  try {
    directory = await mkdtemp(join(dirname(options.outputPath), '.research-video-'))
  } catch (error) {
    exporting = false
    throw error
  }
  const temporaryPath = join(directory, 'video.mp4')
  const frames = Math.ceil(duration * 30)
  const children: ReturnType<typeof ownVideoProcess>[] = []
  let feed: Promise<void> | undefined
  const remove = async (): Promise<void> => {
    await feed?.catch(() => {})
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
  try {
    signal.throwIfAborted()
    armDeadline('Video encoding timed out without progress', ENCODER_IDLE_TIMEOUT_MS)
    const encoder = spawn(
      options.encoderPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-framerate',
        '30',
        '-vcodec',
        'png',
        '-i',
        'pipe:0',
        '-i',
        options.audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-t',
        String(frames / 30),
        '-movflags',
        '+faststart',
        '-y',
        temporaryPath
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }
    )
    children.push(ownVideoProcess(encoder))
    let diagnostics = ''
    encoder.stderr!.on('data', (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-8192)
    })
    const completion = new Promise<void>((resolve, reject) => {
      encoder.once('error', reject)
      encoder.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Video encoder failed (${code}): ${diagnostics}`))
      )
    })
    async function* renderFrames(
      { signal: frameSignal }: { signal: AbortSignal } = { signal }
    ): AsyncGenerator<Uint8Array> {
      for (let frame = 0; frame < frames; frame++) {
        frameSignal.throwIfAborted()
        let timer: ReturnType<typeof setTimeout> | undefined
        let abort: (() => void) | undefined
        let png: Uint8Array
        try {
          png = await new Promise<Uint8Array>((resolve, reject) => {
            abort = (): void => reject(frameSignal.reason)
            timer = setTimeout(() => reject(new Error('Video frame rendering timed out')), 10_000)
            frameSignal.addEventListener('abort', abort, { once: true })
            void Promise.resolve()
              .then(() => options.renderer.capture(frame / 30, frameSignal))
              .then(resolve, reject)
            if (frameSignal.aborted) abort()
          })
        } finally {
          clearTimeout(timer)
          if (abort) frameSignal.removeEventListener('abort', abort)
        }
        yield png
        armDeadline('Video encoding timed out without progress', ENCODER_IDLE_TIMEOUT_MS)
        options.onProgress?.(frame + 1, frames)
      }
      options.onPhase?.('encoding')
    }
    // Let the pipeline own backpressure instead of subscribing to child exit for every frame.
    feed = pipeline(renderFrames, encoder.stdin!, { signal })
    await waitForVideoProcess(Promise.all([completion, feed]), signal)
    signal.throwIfAborted()
    options.onPhase?.('verifying')
    armDeadline('Video verification timed out', PROBE_TIMEOUT_MS)
    const verifier = spawn(
      options.probePath,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', temporaryPath],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    children.push(ownVideoProcess(verifier))
    let output = '',
      probeError = '',
      outputTooLarge = false
    verifier.stdout.on('data', (chunk: Buffer) => {
      if (outputTooLarge) return
      const text = chunk.toString()
      if (output.length + text.length > 1024 * 1024) {
        outputTooLarge = true
        deadline.abort(new Error('Video verification output exceeds the limit'))
      } else output += text
    })
    verifier.stderr.on('data', (chunk) => {
      probeError = (probeError + chunk.toString()).slice(-8192)
    })
    const verification = new Promise<void>((resolve, reject) => {
      verifier.once('error', reject)
      verifier.once('close', (code) =>
        code === 0 && !outputTooLarge
          ? resolve()
          : reject(new Error(`Video verification failed: ${probeError}`))
      )
    })
    await waitForVideoProcess(verification, signal)
    clearTimeout(idleTimer)
    signal.throwIfAborted()
    const metadata = JSON.parse(output) as {
      streams: Array<{
        codec_type: string
        codec_name: string
        width?: number
        height?: number
        sample_rate?: string
        channels?: number
      }>
      format: { duration: string }
    }
    const video = metadata.streams.find((s) => s.codec_type === 'video'),
      audio = metadata.streams.find((s) => s.codec_type === 'audio')
    if (
      video?.codec_name !== 'h264' ||
      video.width !== width ||
      video.height !== height ||
      audio?.codec_name !== 'aac' ||
      audio.sample_rate !== '48000' ||
      audio.channels !== 2 ||
      !Number.isFinite(Number(metadata.format.duration)) ||
      Math.abs(Number(metadata.format.duration) - frames / 30) > 0.1
    )
      throw new Error('Encoded video does not match the requested media contract')
    signal.throwIfAborted()
    // Same-filesystem exclusive publication preserves an existing output on retries or failure.
    await link(temporaryPath, options.outputPath)
  } catch (error) {
    if (deadline.signal.aborted && signal.reason === deadline.signal.reason) throw signal.reason
    throw error
  } finally {
    clearTimeout(idleTimer)
    try {
      await reapVideoProcesses(children, remove)
      await remove()
    } finally {
      exporting = false
    }
  }
}
