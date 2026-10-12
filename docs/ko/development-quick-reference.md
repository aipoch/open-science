# AIPOCH Open-Science — 개발 및 패키징

웹 UI는 일반 Node 백엔드에서 실행되며 Electron이나 그래픽 화면이 필요하지 않습니다.

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

`npm install` → Prisma / Electron. `npm run dev`는 Node 백엔드를 빌드하고 실행 파일을 준비한 뒤 Electron을 엽니다. 감시기는 패키지와 백엔드를 다시 빌드합니다. 성공한 후 앱을 정상 종료하고 명령을 다시 실행해야 backend/Main/Preload 변경이 적용됩니다. renderer는 HMR을 사용합니다.

`~/.open-science-project` · `~/Open-Science-DEV`

유용한 명령:

| 명령                   | 용도                                    |
| ---------------------- | --------------------------------------- |
| `npm run dev`          | 개발 앱 시작                            |
| `npm run dev:web`      | Node 백엔드와 로컬 웹 UI, Electron 없음 |
| `npm run dev:headless` | Node 백엔드와 로컬 웹 UI, Electron 없음 |
| `npm run lint`         | ESLint 실행                             |
| `npm run typecheck`    | main 및 renderer 코드 타입 검사         |
| `npm test`             | Vitest 모음 실행                        |
| `npm run build`        | 타입 검사 및 앱 빌드                    |
| `npm run build:web`    | 선택적 localhost 웹 UI 빌드             |
| `npm run build:mac`    | macOS 빌드 패키징                       |
| `npm run build:win`    | Windows 빌드 패키징                     |
| `npm run build:linux`  | Linux 빌드 패키징                       |

패키지 출력은 `dist/`에 기록됩니다.

[README](README.md)

소스 개발에는 Node.js 24가 필요합니다. 독립 npm tarball에는 Node >=22.13.0, 경량 CLI/SDK에는 Node >=22.5가 필요합니다. Release 압축 파일, Homebrew Formula, 데스크톱 명령 실행기는 런타임을 포함합니다.

`npm run build:backend` → Node; `npm run pack:backend` → tarball.

[Node](../standalone-runtime.md)
