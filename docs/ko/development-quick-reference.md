# AIPOCH Open-Science — 개발 및 패키징

AIPOCH Open-Science는 React, TypeScript, Prisma/SQLite, ACP 기반 에이전트 런타임으로 구축된 Electron 앱입니다.

소스 개발 요구 사항:

- Node.js 24([`.nvmrc`](../../.nvmrc) 참고)와 npm
- Git
- Notebook 실행은 선택 사항이며 앱 관리 Python/R 환경이나 직접 설정한 호환 인터프리터를 사용할 수 있습니다.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install`은 Prisma 클라이언트를 자동 생성하고 Electron 네이티브 종속성을 설치합니다. `npm run dev`는 Electron main/preload 번들을 빌드하고 렌더러를 시작하여 데스크톱 앱을 엽니다. 개발 데이터는 `~/.open-science-project`에 격리됩니다.

유용한 명령:

| 명령                   | 용도                                 |
| ---------------------- | ------------------------------------ |
| `npm run dev`          | 개발 앱 시작                         |
| `npm run dev:web`      | 개발 앱 + localhost 웹 UI(127.0.0.1) |
| `npm run dev:headless` | Electron 창 없는 개발 백엔드 + 웹 UI |
| `npm run lint`         | ESLint 실행                          |
| `npm run typecheck`    | main 및 renderer 코드 타입 검사      |
| `npm test`             | Vitest 모음 실행                     |
| `npm run build`        | 타입 검사 및 앱 빌드                 |
| `npm run build:web`    | 선택적 localhost 웹 UI 빌드          |
| `npm run build:mac`    | macOS 빌드 패키징                    |
| `npm run build:win`    | Windows 빌드 패키징                  |
| `npm run build:linux`  | Linux 빌드 패키징                    |

패키지 출력은 `dist/`에 기록됩니다.

[README](README.md)
