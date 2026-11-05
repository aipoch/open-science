import { describe, expect, it, vi } from 'vitest'
import { ResearchVideoPlaybackClock, type PlaybackMedia } from './playback.js'

function setup(play = async (): Promise<void> => {}): {
  media: PlaybackMedia
  draw: ReturnType<typeof vi.fn>
  clock: ResearchVideoPlaybackClock
} {
  const media: PlaybackMedia = { currentTime: 0, ended: false, play, pause: vi.fn() }
  const draw = vi.fn()
  return { media, draw, clock: new ResearchVideoPlaybackClock(media, 10, draw) }
}

describe('research video media clock', () => {
  it('draws the audio position even after a stalled frame', () => {
    const { media, clock, draw } = setup()
    media.currentTime = 4.25
    clock.tick()
    expect(draw).toHaveBeenLastCalledWith(4.25)
    clock.seek(12)
    expect(media.currentTime).toBe(10)
    clock.seek(-3)
    expect(media.currentTime).toBe(0)
    expect(() => clock.seek(NaN)).toThrow('Invalid playback position')
  })

  it('preserves pause when an outstanding play request completes', async () => {
    let resolve!: () => void
    const { clock, media } = setup(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const pending = clock.play()
    clock.pause()
    resolve()
    await pending
    expect(media.pause).toHaveBeenCalledTimes(2)
  })

  it('restarts at zero and exposes playback rejection', async () => {
    const { clock, media } = setup(async () => {
      throw new Error('Audio unavailable')
    })
    media.currentTime = 10
    await expect(clock.play()).rejects.toThrow('Audio unavailable')
    expect(media.currentTime).toBe(0)
  })

  it('stops drawing and rejects commands after disposal', async () => {
    const { clock, draw } = setup()
    clock.dispose()
    clock.tick()
    expect(draw).not.toHaveBeenCalled()
    await expect(clock.play()).rejects.toThrow('disposed')
    expect(() => clock.seek(1)).toThrow('disposed')
  })
})
