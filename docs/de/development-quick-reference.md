# AIPOCH Open-Science — Entwicklung & Verpackung

Die Web-Oberfläche läuft mit einem gewöhnlichen Node-Backend, ohne Electron oder grafische Anzeige.

Voraussetzungen für die Quellentwicklung:

- Node.js 24 (siehe [`.nvmrc`](../../.nvmrc)) mit npm
- Git
- Notebook-Ausführung ist optional und verwendet App-verwaltete Python/R-Umgebungen oder einen von Ihnen eingerichteten kompatiblen Interpreter.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` → Prisma / Electron. `npm run dev` baut das Node-Backend, stellt dessen ausführbare Datei bereit und öffnet Electron. Der Watcher baut Paket-/Backend-Änderungen neu; nach erfolgreichem Build die App normal beenden und den Befehl neu starten, um Backend/Main/Preload zu laden. Renderer-Änderungen verwenden HMR.

`~/.open-science-project` · `~/Open-Science-DEV`

Nützliche Befehle:

| Befehl                 | Zweck                                                |
| ---------------------- | ---------------------------------------------------- |
| `npm run dev`          | Entwicklungs-App starten                             |
| `npm run dev:web`      | Node-Backend + lokale Web-Oberfläche; ohne Electron  |
| `npm run dev:headless` | Node-Backend + lokale Web-Oberfläche; ohne Electron  |
| `npm run lint`         | ESLint ausführen                                     |
| `npm run typecheck`    | Typüberprüfung des Haupt- und Renderercodes          |
| `npm test`             | Vitest-Suite ausführen                               |
| `npm run build`        | Typüberprüfung und Erstellung der Anwendung          |
| `npm run build:web`    | Optionale Localhost-Web-Benutzeroberfläche erstellen |
| `npm run build:mac`    | macOS-Paket erstellen                                |
| `npm run build:win`    | Windows-Paket erstellen                              |
| `npm run build:linux`  | Linux-Paket erstellen                                |

Die gepackte Ausgabe wird unter `dist/` geschrieben.

[README](README.md)

Quellentwicklung benötigt Node.js 24. Ein lokal gebautes eigenständiges npm-Tarball benötigt Node >=22.13.0; das leichte CLI/SDK benötigt Node >=22.5. Release-Archive, Homebrew-Formula und Desktop-Befehlsstarter enthalten ihre eigene Laufzeit.

`npm run build:backend` → Node; `npm run pack:backend` → tarball.

[Node](../standalone-runtime.md)
