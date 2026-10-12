# AIPOCH Open-Science — Développement et empaquetage

L’interface Web fonctionne avec un backend Node ordinaire, sans Electron ni affichage graphique.

Prérequis pour le développement à partir des sources :

- Node.js 24 (voir [`.nvmrc`](../../.nvmrc)), avec npm
- Git
- L’exécution Notebook est facultative et utilise des environnements Python/R gérés par l’application ou un interpréteur compatible que vous configurez.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` → Prisma / Electron. `npm run dev` construit le backend Node, prépare son exécutable et ouvre Electron. Le watcher reconstruit les paquets et le backend ; après un build réussi, quittez normalement l’application et relancez la commande pour charger backend/Main/Preload. Le renderer utilise HMR.

`~/.open-science-project` · `~/Open-Science-DEV`

Commandes utiles :

| Commande               | Objet                                               |
| ---------------------- | --------------------------------------------------- |
| `npm run dev`          | Démarrer l'application de développement             |
| `npm run dev:web`      | Backend Node + interface Web locale ; sans Electron |
| `npm run dev:headless` | Backend Node + interface Web locale ; sans Electron |
| `npm run lint`         | Exécuter ESLint                                     |
| `npm run typecheck`    | Vérifier les types du code main et renderer         |
| `npm test`             | Exécuter la suite Vitest                            |
| `npm run build`        | Vérifier les types et construire l'application      |
| `npm run build:web`    | Construire l'UI web localhost optionnelle           |
| `npm run build:mac`    | Empaqueter les builds macOS                         |
| `npm run build:win`    | Empaqueter les builds Windows                       |
| `npm run build:linux`  | Empaqueter les builds Linux                         |

La sortie empaquetée est écrite sous `dist/`.

[README](README.md)

Le développement nécessite Node.js 24. Le tarball npm autonome exige Node >=22.13.0 ; le CLI/SDK léger exige Node >=22.5. Les archives Release, la formule Homebrew et le lanceur du bureau incluent leur propre runtime.

`npm run build:backend` → Node; `npm run pack:backend` → tarball.

[Node](../standalone-runtime.md)
