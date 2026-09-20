# AIPOCH Open-Science — Développement et empaquetage

AIPOCH Open-Science est une application Electron construite avec React, TypeScript, Prisma/SQLite, et un environnement d'exécution d'agent basé sur ACP.

Prérequis pour le développement à partir des sources :

- Node.js 22 (voir [`.nvmrc`](../../.nvmrc)), avec npm
- Git
- L’exécution Notebook est facultative et utilise des environnements Python/R gérés par l’application ou un interpréteur compatible que vous configurez.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` génère automatiquement le client Prisma et installe les dépendances natives Electron. `npm run dev` construit les bundles Electron main/preload, démarre le renderer, et ouvre l'application de bureau. Les données de développement sont isolées sous `~/.open-science-project`.

Commandes utiles :

| Commande               | Objet                                             |
| ---------------------- | ------------------------------------------------- |
| `npm run dev`          | Démarrer l'application de développement           |
| `npm run dev:web`      | Application de dev + UI web localhost (127.0.0.1) |
| `npm run dev:headless` | Backend de dev + UI web, sans fenêtre Electron    |
| `npm run lint`         | Exécuter ESLint                                   |
| `npm run typecheck`    | Vérifier les types du code main et renderer       |
| `npm test`             | Exécuter la suite Vitest                          |
| `npm run build`        | Vérifier les types et construire l'application    |
| `npm run build:web`    | Construire l'UI web localhost optionnelle         |
| `npm run build:mac`    | Empaqueter les builds macOS                       |
| `npm run build:win`    | Empaqueter les builds Windows                     |
| `npm run build:linux`  | Empaqueter les builds Linux                       |

La sortie empaquetée est écrite sous `dist/`.

[README](README.md)
