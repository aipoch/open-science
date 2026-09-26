# AIPOCH Open-Science — Entwicklung & Verpackung

AIPOCH Open-Science ist eine Electron-Anwendung auf Basis von React, TypeScript, Prisma/SQLite und einer ACP-basierten Agent-Runtime.

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

`npm install` generiert automatisch den Prisma-Client und installiert die nativen Electron-Abhängigkeiten. `npm run dev` erstellt die Main- und Preload-Bundles, startet den Renderer und öffnet die Desktop-App. Entwicklungsdaten werden unter `~/.open-science-project` isoliert.

Nützliche Befehle:

| Befehl                 | Zweck                                                  |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev`          | Entwicklungs-App starten                               |
| `npm run dev:web`      | Dev-App + Localhost-Web-Benutzeroberfläche (127.0.0.1) |
| `npm run dev:headless` | Dev-Backend + Web-UI, kein Electron-Fenster            |
| `npm run lint`         | ESLint ausführen                                       |
| `npm run typecheck`    | Typüberprüfung des Haupt- und Renderercodes            |
| `npm test`             | Vitest-Suite ausführen                                 |
| `npm run build`        | Typüberprüfung und Erstellung der Anwendung            |
| `npm run build:web`    | Optionale Localhost-Web-Benutzeroberfläche erstellen   |
| `npm run build:mac`    | macOS-Paket erstellen                                  |
| `npm run build:win`    | Windows-Paket erstellen                                |
| `npm run build:linux`  | Linux-Paket erstellen                                  |

Die gepackte Ausgabe wird unter `dist/` geschrieben.

[README](README.md)
