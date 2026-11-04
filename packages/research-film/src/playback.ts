/** The media clock owns playback; dropped frames must not move narration out of sync. */
export type PlaybackMedia = {
  currentTime: number
  ended: boolean
  play(): Promise<void>
  pause(): void
}

export class ResearchVideoPlaybackClock {
  private wantsPlayback = false
  private disposed = false

  constructor(
    private readonly media: PlaybackMedia,
    private readonly duration: number,
    private readonly draw: (seconds: number) => void
  ) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video duration')
  }

  get time(): number {
    return Math.min(this.duration, Math.max(0, this.media.currentTime))
  }

  async play(): Promise<void> {
    if (this.disposed) throw new Error('Player is disposed')
    this.wantsPlayback = true
    if (this.media.ended || this.time >= this.duration) this.seek(0)
    await this.media.play()
    if (this.disposed || !this.wantsPlayback) this.media.pause()
  }

  pause(): void {
    this.wantsPlayback = false
    this.media.pause()
    this.tick()
  }

  seek(seconds: number): void {
    if (this.disposed) throw new Error('Player is disposed')
    if (!Number.isFinite(seconds)) throw new Error('Invalid playback position')
    this.media.currentTime = Math.min(this.duration, Math.max(0, seconds))
    this.tick()
  }

  tick(): void {
    if (!this.disposed) this.draw(this.time)
  }

  dispose(): void {
    this.disposed = true
    this.wantsPlayback = false
    this.media.pause()
  }
}
