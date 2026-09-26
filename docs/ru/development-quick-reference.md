# AIPOCH Open-Science — Разработка и сборка

AIPOCH Open-Science — Electron-приложение на React, TypeScript, Prisma/SQLite и среде агента на основе ACP.

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

Команда `npm install` автоматически создаёт клиент Prisma и устанавливает нативные зависимости Electron. `npm run dev` собирает основные и preload-модули Electron, запускает renderer и открывает настольное приложение. Данные разработки изолированы в `~/.open-science-project`.

Полезные команды:

| Команда                | Назначение                                                      |
| ---------------------- | --------------------------------------------------------------- |
| `npm run dev`          | Запустить приложение для разработки                             |
| `npm run dev:web`      | Приложение для разработки и локальный веб-интерфейс (127.0.0.1) |
| `npm run dev:headless` | Сервер разработки и веб-интерфейс без окна Electron             |
| `npm run lint`         | Запустить ESLint                                                |
| `npm run typecheck`    | Проверить типы основного процесса и renderer                    |
| `npm test`             | Запустить тесты Vitest                                          |
| `npm run build`        | Проверить типы и собрать приложение                             |
| `npm run build:web`    | Собрать необязательный локальный веб-интерфейс                  |
| `npm run build:mac`    | Собрать пакет для macOS                                         |
| `npm run build:win`    | Собрать пакет для Windows                                       |
| `npm run build:linux`  | Собрать пакет для Linux                                         |

Собранные пакеты записываются в каталог `dist/`.

[README](README.md)
