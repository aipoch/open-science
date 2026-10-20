// Only failures attributable to the remote representation/transport permit trying another source.
// Local storage failures and caller cancellation retain their original errors and fail closed.
export class DownloadSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DownloadSourceError'
  }
}

export class DownloadChecksumError extends DownloadSourceError {
  constructor(message = 'Checksum mismatch') {
    super(message)
    this.name = 'DownloadChecksumError'
  }
}
