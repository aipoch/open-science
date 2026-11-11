export type { VideoEncoderPaths } from './ports.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, link } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
  const { width, height, duration, signal } = options
  if (
    ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096 && n % 2 === 0) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 3600
  )
    throw new Error('Invalid video dimensions or duration')
  signal.throwIfAborted()
  const directory = await mkdtemp(join(dirname(options.outputPath), '.research-video-'))
  const temporaryPath = join(directory, 'video.mp4')
  const frames = Math.ceil(duration * 30)
  let encoder: ReturnType<typeof spawn> | undefined
  try {
    encoder = spawn(
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
      { stdio: ['pipe', 'ignore', 'pipe'], signal }
    )
    let diagnostics = ''
    encoder.stderr!.on('data', (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-8192)
    })
    const completion = new Promise<void>((resolve, reject) => {
      encoder!.once('error', reject)
      encoder!.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Video encoder failed (${code}): ${diagnostics}`))
      )
    })
    // The frame producer and process completion can fail independently.
    void completion.catch(() => {})
    encoder.stdin!.on('error', () => {})
    for (let frame = 0; frame < frames; frame++) {
      signal.throwIfAborted()
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      let png: Uint8Array
      try {
        png = await new Promise<Uint8Array>((resolve, reject) => {
          abort = (): void => reject(signal.reason)
          timer = setTimeout(() => reject(new Error('Video frame rendering timed out')), 10_000)
          signal.addEventListener('abort', abort, { once: true })
          void Promise.resolve()
            .then(() => options.renderer.capture(frame / 30, signal))
            .then(resolve, reject)
          if (signal.aborted) abort()
        })
      } finally {
        clearTimeout(timer)
        if (abort) signal.removeEventListener('abort', abort)
      }
      if (encoder.exitCode !== null) throw new Error(`Video encoder stopped: ${diagnostics}`)
      if (!encoder.stdin!.write(png))
        await Promise.race([
          once(encoder.stdin!, 'drain'),
          completion.then(() => {
            throw new Error('Encoder closed before all frames')
          })
        ])
      options.onProgress?.(frame + 1, frames)
    }
    options.onPhase?.('encoding')
    encoder.stdin!.end()
    await completion
    signal.throwIfAborted()
    options.onPhase?.('verifying')
    const probe = spawn(
      options.probePath,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', temporaryPath],
      { stdio: ['ignore', 'pipe', 'pipe'], signal }
    )
    let output = '',
      probeError = ''
    probe.stdout.on('data', (chunk) => {
      output += chunk.toString()
      if (output.length > 1024 * 1024) probe.kill()
    })
    probe.stderr.on('data', (chunk) => {
      probeError = (probeError + chunk.toString()).slice(-8192)
    })
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Video verification failed: ${probeError}`))
      )
    })
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
  } finally {
    if (encoder && encoder.exitCode === null && encoder.signalCode === null) {
      const closed = once(encoder, 'close').catch(() => {})
      encoder.kill('SIGKILL')
      await closed
    }
    await rm(directory, { recursive: true, force: true })
  }
}
