import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { withFileIoPacing } from '../file-io-pacing'
import { SpeedMeter } from '../net/download-speed'
import { PACKAGE_DEFAULT_IO_BYTES_PER_SECOND } from '../../shared/session-package'

const transfers = new AsyncLocalStorage<PackageTransfer>()

class PackageTransfer {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private timer?: ReturnType<typeof setTimeout>
  private next = 0
  private waits = 0
  private readonly speed = new SpeedMeter()
  private completedBytes = 0
  private lastSampleAt = -Infinity
  private closed = false

  constructor(
    private readonly bytesPerSecond: () => number,
    private readonly reportIo?: (speed: number) => void
  ) {
    this.speed.record(0)
    this.progress()
  }

  private progress(): void {
    if (this.waits || this.closed) return
    if (this.timer) {
      this.timer.refresh()
      return
    }
    this.timer = setTimeout(() => {
      this.controller.abort(new Error('Session package made no progress for ten minutes.'))
    }, 10 * 60_000)
  }

  pace = async (bytes: number, signal?: AbortSignal): Promise<void> => {
    if (this.closed) return
    const combined = signal ? AbortSignal.any([signal, this.signal]) : this.signal
    combined.throwIfAborted()
    const rate = this.bytesPerSecond()
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid package transfer rate.')
    // A short scheduling horizon prevents idle/user waits from banking a later burst. Each
    // stream charges this same clock; copies charge both read and write bytes.
    const now = performance.now()
    this.next = Math.max(now, this.next) + (bytes / rate) * 1000
    this.progress()
    // Amortize sub-millisecond chunks: a timer per inflater chunk otherwise imposes an accidental
    // ~16 MiB/s ceiling and unnecessary wakeups. The bounded burst is at most 8 ms plus one chunk.
    if (this.next - now >= 8) await delay(this.next - now, undefined, { signal: combined })
    this.progress()
    this.completedBytes += bytes
    if (this.reportIo && performance.now() - this.lastSampleAt >= 150) {
      this.lastSampleAt = performance.now()
      this.speed.record(this.completedBytes)
      this.reportIo(this.speed.bytesPerSecond())
    }
  }

  async waitForUser<T>(work: () => Promise<T>): Promise<T> {
    this.waits++
    clearTimeout(this.timer)
    this.timer = undefined
    try {
      return await work()
    } finally {
      if (--this.waits === 0) this.progress()
    }
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
  }
}

export const withPackageTransfer = async <T>(
  work: (transfer: PackageTransfer) => Promise<T>,
  bytesPerSecond: () => number = () => PACKAGE_DEFAULT_IO_BYTES_PER_SECOND,
  reportIo?: (speed: number) => void
): Promise<T> => {
  const existing = transfers.getStore()
  if (existing) return work(existing)
  const transfer = new PackageTransfer(bytesPerSecond, reportIo)
  try {
    return await transfers.run(transfer, () =>
      withFileIoPacing(transfer.pace, () => work(transfer))
    )
  } finally {
    transfer.close()
  }
}
