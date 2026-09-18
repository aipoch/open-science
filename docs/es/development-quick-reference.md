# AIPOCH Open-Science — Desarrollo y empaquetado

AIPOCH Open-Science es una aplicación Electron creada con React, TypeScript, Prisma/SQLite y un entorno de ejecución de agentes basado en ACP.

Requisitos previos para desarrollar desde el código fuente:

- Node.js 22 (consulte [`.nvmrc`](../../.nvmrc)) con npm
- Git
- La ejecución de Notebook es opcional y usa entornos Python/R gestionados por la aplicación o un intérprete compatible que usted configure.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` genera automáticamente el cliente Prisma e instala las dependencias nativas Electron. `npm run dev` crea los paquetes principales/precargados Electron, inicia el renderizador y abre la aplicación de escritorio. Los datos de desarrollo están aislados en `~/.open-science-project`.

Comandos útiles:

| Comando                | Propósito                                                                    |
| ---------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`          | Iniciar la aplicación de desarrollo                                          |
| `npm run dev:web`      | Aplicación de desarrollo + interfaz de usuario web de host local (127.0.0.1) |
| `npm run dev:headless` | Backend de desarrollo + interfaz de usuario web, sin ventana Electron        |
| `npm run lint`         | Ejecute ESLint                                                               |
| `npm run typecheck`    | Comprobar los tipos del código principal y del renderizador                  |
| `npm test`             | Ejecute la suite Vitest                                                      |
| `npm run build`        | Verifique el tipo y cree la aplicación                                       |
| `npm run build:web`    | Cree la interfaz de usuario web localhost opcional                           |
| `npm run build:mac`    | Empaquetar las compilaciones de macOS                                        |
| `npm run build:win`    | Empaquetar las compilaciones de Windows                                      |
| `npm run build:linux`  | Empaquetar las compilaciones de Linux                                        |

La salida empaquetada está escrita en `dist/`.

[README](README.md)
