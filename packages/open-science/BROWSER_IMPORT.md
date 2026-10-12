# Import a browser-held `.science` package

The `@aipoch/open-science/browser-import` entry point runs in a browser. The website downloads a
complete `Blob` or `File`, launches the installed desktop app through `open-science://`, and sends
the bytes to a temporary receiver on `127.0.0.1`. Open-Science never downloads a remote package URL.
The user approves the sending website, chooses a destination project, and reviews the package
before importing it.

## Website integration

Bundle the browser entry point with your website. Do not import the Node SDK's root entry point.
This example expects `downloadButton`, `openButton`, `cancelButton`, and `status` DOM elements.
Show the open button after downloading: a second click preserves the browser's user activation for
launching an external application. Keep the page open until local receipt is acknowledged.

```js
import { prepareBrowserImport } from '@aipoch/open-science/browser-import'

let transfer
let controller
openButton.disabled = true
cancelButton.disabled = true

downloadButton.onclick = async () => {
  downloadButton.disabled = true
  try {
    status.textContent = 'Downloading package…'
    const response = await fetch('/packages/study.science')
    if (!response.ok) throw new Error(`Download failed (${response.status})`)
    const file = await response.blob()
    transfer = prepareBrowserImport(file, { filename: 'study.science' })
    openButton.disabled = false
    status.textContent = 'Ready. Open Open-Science to import.'
  } catch (error) {
    status.textContent = error.message
  } finally {
    downloadButton.disabled = false
  }
}

openButton.onclick = async () => {
  // Do this synchronously in the click handler, before any await.
  window.location.href = transfer.url
  controller = new AbortController()
  openButton.disabled = true
  cancelButton.disabled = false
  try {
    await transfer.send({
      signal: controller.signal,
      onProgress: ({ sentBytes, totalBytes }) => {
        status.textContent = `Sending ${Math.round((sentBytes / totalBytes) * 100)}%`
      }
    })
    status.textContent = 'Received by Open-Science. Review and confirm the import there.'
  } catch (error) {
    status.textContent = error.message
    openButton.disabled = false
  } finally {
    cancelButton.disabled = true
  }
}
cancelButton.onclick = () => controller?.abort()
```

`send()` returns `{ received: true }` when the entire file has reached the local import queue.
It does **not** indicate that the user confirmed import, that package validation succeeded, or that
a session was created. No website receives desktop session data or general API credentials.

## Requirements and recovery

- An installed desktop build with the `open-science` protocol association. Development builds do
  not take over the user's installed application's protocol association.
- An HTTPS website, or an HTTP loopback origin for local development. Cross-origin package
  downloads must already be permitted by the package host's CORS policy.
- Browser support for Web Crypto, `Blob`, `fetch`, and `AbortSignal.any/timeout`. The browser may
  ask permission to open Open-Science and to access the local network. Users must allow both.
  Browser/enterprise policies may prohibit loopback requests; offer a normal file download and
  local file-open import as the fallback. HTTPS-to-loopback compatibility is browser-dependent;
  the integration tests exercise Chromium without disabling web security.
- If the website uses CSP, allow the loopback receiver in `connect-src`, for example
  `http://127.0.0.1:*`, in addition to the site's existing download destinations.
- Version 1 accepts nonempty packages up to **2 GiB**, sent in **4 MiB** chunks. The website owns
  storage of the completed Blob; the SDK only reads one chunk at a time. This browser transfer
  limit is intentionally separate from the desktop archive format's larger limit.
- A transfer has a two-minute idle timeout. Keep the same transfer object and call `send()` again
  after a transient connection failure to resume from the acknowledged offset while the receiver
  is alive. Cancellation removes a partial transfer; prepare a new transfer before retrying it.
- If the app declines receipt, the port is occupied, the app is absent, or the receiver expires,
  sending fails or times out. Prepare a new transfer (a new secret and port), then click Open again.
  There is no silent port scanning, external-app detection, or remote download fallback.
- Received files remain available for the desktop import queue and retry UI. They are removed when
  consumed, explicitly discarded, replaced as a retry source, or the runtime shuts down. Abandoned
  files from a crashed runtime are cleaned before the next browser transfer starts.

## Transport contract (version 1)

The launch URL carries `version=1`, the exact website `origin`, a random 32-byte hexadecimal
`secret`, a random `port` in 49152–65535, the safe `.science` filename `name`, and byte `size`.
There is no package URL, filesystem path, Blob URL, or file body in the launch URL. Treat the URL as
a credential: do not put it in analytics, logs, persistent links, or error reports.

After native consent, the app binds only `127.0.0.1:<port>`. Every request must have the exact
`Host` and website `Origin`. CORS is scoped to that origin, without cookies. This receiver is
separate from the authenticated general-purpose web service; that service's CORS policy stays
unchanged. At most 16 transfer records and 2 GiB of advertised unconsumed data are admitted.

- `GET /v1/import/ready?challenge=<random 32-byte hex>` proves receiver identity using
  HMAC-SHA256 with the launch secret bytes over
  `open-science-import-v1:<challenge>:<offset>:<accepted as 0 or 1>`.
- Mutating requests authenticate with `Authorization: HMAC <hex signature>` over
  `<METHOD>\n<pathname plus query>\n<X-Chunk-SHA256 or empty>`, using the secret bytes. The secret
  itself is never sent in an HTTP request.
- `PUT /v1/import/chunk?offset=<offset>` carries a 12-byte random IV followed by AES-256-GCM
  ciphertext and its 16-byte tag. The AES key is SHA-256 of the UTF-8 string
  `open-science-encryption-v1:<secret hex>`, and additional authenticated data is `offset:<offset>`.
  `X-Chunk-SHA256` is the plaintext chunk digest. Offsets, digest, decrypted length and total size
  are checked before publishing bytes. Acknowledgments authenticate `offset:<new offset>`.
- `POST /v1/import/complete` requires the complete declared length, syncs and closes the file, and
  enqueues it once. The 202 receipt authenticates `received:<total size>`. Repeated completion is
  idempotent while the receiver is alive.
- `DELETE /v1/import` cancels a partial transfer. After receipt, the desktop owns the queued import;
  cancel it in the app.

The SDK verifies handshake and acknowledgment proofs and encrypts chunks even on loopback. If an
unrelated local process occupies or later takes over the port, it cannot read package plaintext,
learn the launch secret from HTTP, or forge successful receipt. This does not defend against an
attacker already able to inspect the browser/app process or intercept OS protocol delivery.

## Development

Use task-local isolated configuration, for example from the repository root:

```sh
mkdir -p .dev-isolate/browser-import/user-data .dev-isolate/browser-import/config
OPEN_SCIENCE_USER_DATA="$PWD/.dev-isolate/browser-import/user-data" \
OPEN_SCIENCE_CONFIG_ROOT="$PWD/.dev-isolate/browser-import/config" \
OPEN_SCIENCE_ALLOW_MULTI_INSTANCE=1 npm run dev
```

The source E2E journey in `e2e/session-package.spec.ts` downloads a fixture into a real Chromium
Blob, transfers bytes through actual HTTP/CORS, and completes the desktop import. It delivers
cold argv and warm `open-url` events at Electron's boundary and substitutes the native consent
answer within the isolated test fixture. Installed OS protocol registration and user permission
dialogs still require packaged macOS/Windows/Linux manual validation.
