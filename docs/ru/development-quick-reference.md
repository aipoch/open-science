# AIPOCH Open-Science — Разработка и сборка

Веб-интерфейс работает с обычным сервером Node без Electron и графического окружения.

Для разработки из исходного кода нужны:

- Node.js 24 (см. [`.nvmrc`](../../.nvmrc)) и npm
- Git
- Выполнение Notebook необязательно: используйте управляемые приложением среды Python/R или настроенный вами совместимый интерпретатор.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` → Prisma / Electron. `npm run dev` собирает сервер Node, подготавливает исполняемый файл и открывает Electron. Наблюдатель пересобирает пакеты и сервер; после успешной сборки штатно закройте приложение и перезапустите команду для загрузки backend/Main/Preload. Renderer использует HMR.

`~/.open-science-project` · `~/Open-Science-DEV`

Полезные команды:

| Команда                | Назначение                                          |
| ---------------------- | --------------------------------------------------- |
| `npm run dev`          | Запустить приложение для разработки                 |
| `npm run dev:web`      | Сервер Node и локальный веб-интерфейс, без Electron |
| `npm run dev:headless` | Сервер Node и локальный веб-интерфейс, без Electron |
| `npm run lint`         | Запустить ESLint                                    |
| `npm run typecheck`    | Проверить типы основного процесса и renderer        |
| `npm test`             | Запустить тесты Vitest                              |
| `npm run build`        | Проверить типы и собрать приложение                 |
| `npm run build:web`    | Собрать необязательный локальный веб-интерфейс      |
| `npm run build:mac`    | Собрать пакет для macOS                             |
| `npm run build:win`    | Собрать пакет для Windows                           |
| `npm run build:linux`  | Собрать пакет для Linux                             |

Собранные пакеты записываются в каталог `dist/`.

[README](README.md)

Для разработки нужен Node.js 24. Автономный npm tarball требует Node >=22.13.0, облегчённый CLI/SDK — Node >=22.5. Архивы Release, формула Homebrew и настольный запускатель команд содержат собственную среду исполнения.

`npm run build:backend` → Node; `npm run pack:backend` → tarball.

[Node](../standalone-runtime.md)
