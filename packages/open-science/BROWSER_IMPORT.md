# Import a browser-held `.science` package

The `@aipoch/open-science/browser-import` entry point runs in a browser. The website downloads a
complete `Blob` or `File`, launches the installed desktop app through `open-science://`, and sends
the bytes to a temporary receiver on `127.0.0.1`. Open-Science never downloads a remote package URL.
Open-Science receives the file automatically and validates the package before asking for a target.
The user then chooses the destination and confirms the final import.

## Website integration

Use `@aipoch/open-science/browser-import`, not the Node SDK root. The supported automatic path is:
check the already-running app, download the complete Blob in the website, prepare the transfer,
try the launch URL, then send. An unavailable app must be opened first. Discovery does not launch
an app and cannot determine whether it is installed.

The example below expects `continueButton`, `openButton`, `cancelButton`, `status`, and a visible
`downloadLink` pointing to `/open-science/download`. Keep the original page open. The manual open
button is a fresh user gesture if browser policy blocks automatic navigation after downloading.
A browser's local-network/external-app prompts cannot be bypassed. Opening a placeholder tab before
an `await` does **not** preserve transient user activation across an arbitrary download.

```js
import {
  checkBrowserImportAvailability,
  prepareBrowserImport
} from '@aipoch/open-science/browser-import'

let transfer
let controller
openButton.hidden = true
cancelButton.disabled = true

async function launchAndSend() {
  // On retry this executes directly in the manual button's click handler.
  openButton.hidden = true
  try {
    window.location.href = transfer.url
    await transfer.send({
      signal: controller.signal,
      readinessAttempts: 5,
      attemptTimeoutMs: 2000,
      readyTimeoutMs: 15000,
      onProgress: ({ sentBytes, totalBytes }) => {
        status.textContent = `Sending ${Math.round((sentBytes / totalBytes) * 100)}%`
      }
    })
    status.textContent = 'Received by Open-Science. Review and confirm the import there.'
  } catch (error) {
    if (controller.signal.aborted) {
      status.textContent = 'Transfer cancelled. Click Continue to prepare a new transfer.'
    } else {
      status.textContent = 'Could not open Open-Science. Please open the app and try again.'
      openButton.hidden = false
      downloadLink.hidden = false
    }
  }
}

continueButton.onclick = async () => {
  continueButton.disabled = true
  controller = new AbortController()
  cancelButton.disabled = false
  try {
    const availability = await checkBrowserImportAvailability({ signal: controller.signal })
    if (availability.status !== 'available') {
      if (availability.status === 'aborted') return
      status.textContent =
        'Could not connect to Open-Science. If you have not installed it yet, download Open-Science first.'
      downloadLink.hidden = false
      // Best effort: an asynchronous popup can be blocked; the visible link always remains.
      window.open('/open-science/download', '_blank', 'noopener,noreferrer')
      return
    }
    status.textContent = 'Downloading package…'
    const response = await fetch('/packages/study.science', { signal: controller.signal })
    if (!response.ok) throw new Error(`Download failed (${response.status})`)
    const file = await response.blob()
    transfer = prepareBrowserImport(file, { filename: 'study.science' })
    await launchAndSend()
  } catch (error) {
    status.textContent = controller.signal.aborted ? 'Cancelled.' : error.message
  } finally {
    continueButton.disabled = false
    cancelButton.disabled = true
  }
}
openButton.onclick = () => {
  cancelButton.disabled = false
  // Keep the same in-memory transfer so a still-live receiver can resume. For expired receivers,
  // use Continue again to prepare a fresh transfer and protocol secret.
  void launchAndSend().finally(() => {
    cancelButton.disabled = true
  })
}
cancelButton.onclick = () => controller?.abort()
```

`send()` returns `{ received: true }` after the entire file reaches the local import queue. The
desktop automatically validates the archive before presenting destination selection, then requires
final import confirmation. Those steps do not block the transport acknowledgment: receipt alone
does not mean package validation succeeded or a session was created. No website receives desktop data
or general API credentials. The website owns fetching bytes; do not put a remote URL, blob URL or
file contents in the protocol. Never log, persist, send to analytics, or publish `transfer.url`.

### Availability and errors

`checkBrowserImportAvailability({ signal?, timeoutMs?, origin?, port? })` probes exactly one
endpoint, `http://127.0.0.1:49151/v1/browser-import/capabilities`, with a default 2,000 ms budget,
including the response body. It returns:

- `{ status: 'available' }`: a compatible running receiver.
- `unavailable`: no reachable receiver, including opaque network/CORS/local-network denials.
- `unsupported-browser`, `incompatible`, `timeout`, or `aborted`.

An unreachable receiver is not proof that Open-Science is uninstalled. Browser privacy rules often
make permission denial indistinguishable from connection refusal. Local-network access may prompt,
so availability is not guaranteed to be silent. Discovery is advisory: a local
port occupant can forge it. **Only** the secret-bound readiness proof authenticates the receiver;
the SDK never sends credentials or plaintext file bytes based on discovery alone.

`send()` accepts `readinessAttempts` (1–5, default 5), `attemptTimeoutMs` (default 2,000 ms, at most
30,000 ms), `readyTimeoutMs` (overall readiness deadline, default 120,000 ms, capped at 300,000 ms),
and `signal`. Attempts have 1,000 ms gaps, stop after the first verified response, and dispose all
readiness timers. The attempt timeout covers headers and body reads. The overall deadline can stop
an attempt or a gap. These budgets end at readiness and **do not limit the subsequent file transfer**.
Failures use `BrowserImportError.code`: `readiness-exhausted`, `timeout`, `incompatible`, or
`unsupported-browser`; caller cancellation preserves the abort signal's reason. Identity failures
stop immediately. Browser prompt time may exceed readiness attempts; retry after allowing the browser to open the app.

### Receipt, validation and repeated imports

There is no website permission dialog, persistent origin allowlist, or authorization/revocation API.
The launch protocol binds a fresh secret, exact Origin, transfer port, filename and size. Host/Origin
checks, authenticated requests/receipts, encrypted chunks and staging limits apply to every transfer.
The desktop uses the existing package inspector before destination selection, including archive
path and content validation. Final import revalidates the staged archive and retains the existing
`packageOrigin` and `receipt.json` provenance; no separate browser import ledger is created.

Repeated delivery of the same protocol secret is handled once. The desktop queue also deduplicates
the same active/queued local path. These are transport/queue protections, **not** a ban on repeated
imports: sending and importing the same package again with a new transfer creates an independent
session using the existing import rules. Package content may be shared while session identities
and import receipts remain independent.

Discovery starts when an authenticated Electron desktop attaches to the Node receiver, and closes
with that runtime. A surviving background runtime can still answer discovery; the protocol launch
brings the desktop forward. The headless general API is unchanged. `OPEN_SCIENCE_BROWSER_IMPORT_DISCOVERY_PORT` can override the single discovery
port for isolated development; pass the same `port` to discovery SDK calls. `port` in
`prepareBrowserImport` remains the separate ephemeral **transfer** port. If another profile owns
the discovery port, discovery is unavailable for this profile; existing protocol imports still work.
Do not scan ports or substitute the general desktop API.

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
- Filenames must fit both 160 UTF-16 code units and 255 UTF-8 bytes, and cannot use Windows reserved
  device names such as `CON.science`. Both the SDK and receiver validate these portable limits.
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

When the protocol launches a transfer, the app binds only `127.0.0.1:<port>`. Every request must have the exact
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
cold argv and warm `open-url` events at Electron's boundary and exercises automatic receipt
within the isolated test fixture. Installed OS protocol registration and browser permission
dialogs still require packaged macOS/Windows/Linux manual validation.
