# AIPOCH Open-Science — Development & Packaging

AIPOCH Open-Science is an Electron application built with React, TypeScript, Prisma/SQLite, and an ACP-based agent runtime.

Prerequisites for source development:

- Node.js 24 (see [`.nvmrc`](../.nvmrc)) with npm
- Git
- Notebook execution optionally uses app-managed Python/R environments or a compatible interpreter you configure.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` automatically generates the Prisma client and installs Electron native dependencies. `npm run dev` builds the Electron main/preload bundles, starts the renderer, and opens the desktop app. Development data is isolated under `~/.open-science-project`.

Useful commands:

| Command                | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `npm run dev`          | Start the development application        |
| `npm run dev:web`      | Dev app + localhost web UI (127.0.0.1)   |
| `npm run dev:headless` | Dev backend + web UI, no Electron window |
| `npm run lint`         | Run ESLint                               |
| `npm run typecheck`    | Type-check main and renderer code        |
| `npm test`             | Run the Vitest suite                     |
| `npm run build`        | Type-check and build the application     |
| `npm run build:web`    | Build the optional localhost web UI      |
| `npm run build:mac`    | Package macOS builds                     |
| `npm run build:win`    | Package Windows builds                   |
| `npm run build:linux`  | Package Linux builds                     |

Packaged output is written under `dist/`.

## Windows efficiency mode

On Windows 11, Electron/Chromium automatically lowers the priority of background UI renderer
processes and enables EcoQoS when the application window is minimized or hidden. Showing or
restoring the window returns its renderer to normal scheduling. Open-Science retains Electron's
default `backgroundThrottling` behavior for its main window; no additional setting or native
process controller is needed.

To observe this, minimize Open-Science or choose **Minimize to tray** under **Settings → General →
When closing the window**, then close the window. In Task Manager, expand Open-Science and inspect
the child processes' **Status** column. Windows can display the green double-leaf **Efficiency mode**
indicator for a qualifying child process and its application group. The foreground application does
not need to keep a leaf visible. Appearance depends on the Windows version and process state.

The main process and scientific execution processes retain their existing scheduling; hiding the
interface does not pause research tasks. Hidden document-generation windows intentionally disable
background throttling so that rendering can finish. No project/session migration, new persisted
status, or saved efficiency preference is introduced.

The source-app Windows window-system E2E regression reads the real renderer priority and power-throttling
flags on Windows 11 22H2 or later, covering minimize, tray hide, restoration, and reload. A test-only
preloader drives the production window without attaching a debugger: Playwright's source-app
loader disables backgrounding, and its CDP focus emulation keeps renderers foregrounded during
ordinary UI tests. Measurements are attached to the test report as JSON.

Run the regression with:

```bash
npm run build:e2e
npx playwright test e2e/windows-window-system.spec.ts -g "renderer efficiency mode"
```

See Microsoft's [Task Manager efficiency-mode explanation](https://devblogs.microsoft.com/performance-diagnostics/reduce-process-interference-with-task-manager-efficiency-mode/)
and Electron's [`backgroundThrottling` documentation](https://www.electronjs.org/docs/latest/api/structures/web-preferences).

[README](../README.md)
