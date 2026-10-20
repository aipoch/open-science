// Sliding-window download speed + ETA. Pure and clock-injectable so it unit-tests without wall time
// and stays usable in sandboxes that restrict Date.now.
type Sample = { t: number; bytes: number }

export class SpeedMeter {
  private readonly windowMs: number
  private readonly now: () => number
  private readonly samples: Sample[] = []

  constructor(opts: { windowMs?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? 3000
    this.now = opts.now ?? (() => Date.now())
  }

  // Record a cumulative byte count at the current time, evicting samples outside the window.
  record(cumulativeBytes: number): void {
    const t = this.now()
    this.samples.push({ t, bytes: cumulativeBytes })
    const cutoff = t - this.windowMs
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift()
  }

  // Average bytes/s across the retained window; 0 until two samples span a non-zero interval.
  bytesPerSecond(): number {
    if (this.samples.length < 2) return 0
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const elapsedMs = last.t - first.t
    if (elapsedMs <= 0) return 0
    return ((last.bytes - first.bytes) / elapsedMs) * 1000
  }

  // Seconds until `total` at the current speed; undefined when total unknown or speed is 0.
  etaSeconds(totalBytes?: number): number | undefined {
    if (totalBytes == null) return undefined
    const speed = this.bytesPerSecond()
    if (speed <= 0) return undefined
    const last = this.samples[this.samples.length - 1]
    const remaining = Math.max(0, totalBytes - (last?.bytes ?? 0))
    return Math.ceil(remaining / speed)
  }
}
