# AIPOCH Open-Science — Desarrollo y empaquetado

La interfaz web funciona con un backend Node independiente, sin Electron ni entorno gráfico.

Requisitos previos para desarrollar desde el código fuente:

- Node.js 24 (consulte [`.nvmrc`](../../.nvmrc)) con npm
- Git
- La ejecución de Notebook es opcional y usa entornos Python/R gestionados por la aplicación o un intérprete compatible que usted configure.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` → Prisma / Electron. `npm run dev` compila el backend Node, prepara su ejecutable y abre Electron. El observador recompila los cambios de paquetes y backend; tras una compilación correcta, cierre la aplicación normalmente y reinicie el comando para cargar backend/Main/Preload. El renderer utiliza HMR.

`~/.open-science-project` · `~/Open-Science-DEV`

Comandos útiles:

| Comando                | Propósito                                                   |
| ---------------------- | ----------------------------------------------------------- |
| `npm run dev`          | Iniciar la aplicación de desarrollo                         |
| `npm run dev:web`      | Backend Node + interfaz web local; sin Electron             |
| `npm run dev:headless` | Backend Node + interfaz web local; sin Electron             |
| `npm run lint`         | Ejecute ESLint                                              |
| `npm run typecheck`    | Comprobar los tipos del código principal y del renderizador |
| `npm test`             | Ejecute la suite Vitest                                     |
| `npm run build`        | Verifique el tipo y cree la aplicación                      |
| `npm run build:web`    | Cree la interfaz de usuario web localhost opcional          |
| `npm run build:mac`    | Empaquetar las compilaciones de macOS                       |
| `npm run build:win`    | Empaquetar las compilaciones de Windows                     |
| `npm run build:linux`  | Empaquetar las compilaciones de Linux                       |

La salida empaquetada está escrita en `dist/`.

[README](README.md)

El desarrollo desde el código fuente requiere Node.js 24. El tarball npm independiente requiere Node >=22.13.0; el CLI/SDK ligero requiere Node >=22.5. Los archivos de Release, la fórmula Homebrew y el lanzador del escritorio incluyen su propio entorno de ejecución.

`npm run build:backend` → Node; `npm run pack:backend` → tarball.

[Node](../standalone-runtime.md)
