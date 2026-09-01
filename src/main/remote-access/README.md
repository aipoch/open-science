# Optional remote access integration

This directory owns the optional Remote.It lifecycle plus Open Science's remote-session verification
boundary. Open Science does not bundle, download, install, sign in to, or redistribute the
provider. The adapter only detects the user-installed CLI and invokes its documented commands
after an explicit desktop action.

App access and Browser access use separate Remote.It services that both target the app-owned
loopback Web service. Automatic setup prefers port 44100 and falls back to an available ephemeral
port only when 44100 is already occupied; explicit `--serve=<port>` requests remain strict:

- `Open Science Remote` is the App service. Its Persistent Public URL is explicitly disabled, and
  signed-in App connections complete Open Science's six-digit verification before workspace access.
- `System Service` is the Browser service. Its Persistent Public URL is enabled automatically, and
  every new browser completes six-digit two-step verification before it can see Open Science.

Provider `Host` and `Origin` headers are routing and same-origin signals only. The pairing manager
always requires an unguessable Open Science session cookie for external HTTP, RPC, and WebSocket
access; callers cannot disable that requirement for a provider route.

Only an unauthenticated `GET /` can allocate pairing state. New requests are bounded by source and
global sliding windows, and requests that stop polling expire quickly while the existing ten-minute
absolute lifetime remains in force.

The user adds this computer once through Remote.It's **This system** flow. Open Science deliberately
does not automate Device registration because the desktop-app session cannot authorize the separate
CLI account. After that one-time step, the first App or Browser setup prepares both services
together and persists their IDs independently. macOS submits any privileged create/repair commands
through one administrator approval. Windows uses the registered Desktop agent's `--noAdmin`
channel, so the same two-service setup does not add a UAC or password step. Later mode switches
reuse those exact services instead of touching unrelated Remote.It services or asking for another
privileged mutation. Turning remote access Off is a local soft-disable, so the provider
configuration remains available without repair on the next launch.
Persisted trusted-browser credentials are also retained and remain visible and revocable while Off;
they are inactive until a matching route is enabled again.

The integration deliberately touches the rest of the app through a few narrow seams:

- `web-service/http-server.ts` exposes a provider-neutral external authentication hook.
- `main/index.ts` constructs this service and gives the local Web controller to it.
- `preload/index.ts` exposes typed IPC calls; mutation handlers accept real Electron senders only.
- `SettingsPage.tsx` mounts one self-contained `RemoteControlPanel` in an independent nav group.

Persistent state lives in `remote-access.json` under the existing config root. Browser secrets are
never stored in plaintext: the desktop persists only SHA-256 token hashes. One-time grants remain
in memory and disappear when remote access is disabled, its mode changes, or the app exits. Removed
provider modes migrate to Off.
