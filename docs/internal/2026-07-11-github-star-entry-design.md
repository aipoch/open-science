# GitHub Star Entry — Design

Date: 2026-07-11

## Goal

Encourage users to star the project's GitHub repository. Surface a GitHub entry
point in three locations, each showing the current star count when available and
gracefully degrading to an icon-only link when the count cannot be fetched.
Additionally, make the "Open Science" title in the home header link to the
official website.

## Locations

1. **Home header** (`src/renderer/src/pages/home/HomePage.tsx`, the icon row at
   line ~214 alongside the Settings and Account buttons).
2. **Chat page** (`src/renderer/src/pages/workspace/WorkspaceSidebar.tsx`, the
   sidebar footer at line ~223, next to the Settings button).
3. **Settings › General** (`src/renderer/src/pages/settings/GeneralPanel.tsx`,
   as a new "Open source" section).

## Requirements

- Show a low-key "icon + star count" badge. Clicking it opens the repository in
  the system browser.
- If the star count cannot be obtained (offline, rate-limited, non-200), show
  the GitHub icon entry only — no number, no error, no noise.
- The "Open Science" title in the home header links to
  `https://www.aipoch.com/open-science`, opening in the system browser.
- No new dependencies. Use the existing `lucide-react` `Github` icon.
- All code, UI strings, and comments in English.

## Non-Goals

- No persistence of the star count across app launches (in-memory only for the
  current session).
- No authentication with the GitHub API. Anonymous requests only.
- No auto-refresh loop or manual refresh button.

## Architecture

One shared renderer component backed by one main-process IPC handler.

### 1. Shared constants (`src/shared/github.ts`)

```
GITHUB_OWNER = 'aipoch'
GITHUB_REPO = 'open-science'
GITHUB_REPO_URL = 'https://github.com/aipoch/open-science'
OFFICIAL_SITE_URL = 'https://www.aipoch.com/open-science'
```

Consumed by both the main process (API URL) and the renderer (link targets).

### 2. Main process — star fetch + cache

New IPC handler `github:get-stars`:

- Uses Node's global `fetch` (Electron 39 / Node 22) to GET
  `https://api.github.com/repos/aipoch/open-science` with headers
  `Accept: application/vnd.github+json` and a `User-Agent` (GitHub requires one).
- Parses `stargazers_count` and returns it as `number`.
- On any failure (network error, non-200, unexpected body) returns `null`.
- **In-memory cache:** a module-level variable holds the first successful count
  for the session; an in-flight promise dedupes concurrent calls so three
  simultaneous mounts trigger only one request. A failed attempt is not cached
  as a permanent `null` — a later call may retry.
- Registered alongside the existing IPC handlers, following the `logs-ipc.ts`
  pattern (injectable `fetch` dependency for testability).

Returns: `Promise<number | null>`.

### 3. Preload

Expose `window.api.github.getStars(): Promise<number | null>` in
`src/preload/index.ts` and add the type to `src/preload/index.d.ts`.

### 4. Renderer — shared component

`src/renderer/src/components/GitHubStarBadge.tsx`:

- On mount, calls `window.api.github.getStars()` and stores the result.
- Renders an `<a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">` — the
  main process `setWindowOpenHandler` (`src/main/windows.ts:37`) already routes
  such links to the system browser.
- With a count: GitHub icon + formatted count (e.g. `1.2k`).
- Without a count (`null`): GitHub icon only.
- Accepts a `variant`/size prop so it fits all three containers (header icon
  row, compact sidebar footer, settings panel).
- `aria-label` describes the action ("Star Open Science on GitHub") and includes
  the count when present.

Star count formatting helper in its own file
(`src/renderer/src/lib/format-star-count.ts`) for unit testing:
`1234 → "1.2k"`, `999 → "999"`, `12000 → "12k"`.

### 5. Wiring the three locations

- **Home header:** insert `<GitHubStarBadge>` into the icon row; wrap the
  "Open Science" title in an `<a>` to `OFFICIAL_SITE_URL`.
- **Sidebar footer:** insert `<GitHubStarBadge>` next to the Settings button.
- **General panel:** add an "Open source" section containing the badge plus a
  short line inviting users to star the repo.

## Error Handling & Degradation

- Fetch failure / rate limit / non-200 → main returns `null` → badge shows
  icon-only entry. No thrown errors surface to the user.
- The renderer treats `null` and a pending state the same way visually (icon
  entry stays usable throughout).

## Testing

Following existing vitest patterns:

- Unit test for `format-star-count.ts` (small numbers, thousands, edge cases).
- Main-process handler test (mock injected `fetch`: success returns the count;
  non-200 returns `null`; thrown error returns `null`; concurrent calls dedupe
  to a single fetch).
- Render test for `GitHubStarBadge` (renders count when provided; renders
  icon-only when the API resolves `null`; link points at the repo URL).

## Out of Scope / Future

- Persisting the last known count across launches.
- Periodic refresh.
