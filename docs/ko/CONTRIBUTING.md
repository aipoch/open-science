# Open Science 기여 가이드

기여에 관심을 가져 주셔서 감사합니다. 이 문서에서는 프로젝트 설정 방법, 개발 워크플로, 변경 사항이 병합되기 전에 통과해야 하는 검사를 설명합니다.

> 이 문서는 영어 `CONTRIBUTING.md`의 번역본입니다. 내용이 다르면 [영문 원본](../../CONTRIBUTING.md)을 기준으로 합니다.

## 행동 강령

모든 상호 작용에서 서로를 존중하고 건설적인 태도를 유지하세요. 선의를 전제로 기술적 내용에 토론을 집중하고 모두가 편하게 참여할 수 있는 프로젝트를 만드는 데 도움을 주세요.

## 시작하기

### 요구 사항

- [Node.js](https://nodejs.org/) 22([`.nvmrc`](../../.nvmrc) 참고) 및 npm
- Git

### 설정

```bash
# https://github.com/aipoch/open-science/fork 에서 저장소를 포크한 다음:
git clone https://github.com/<your-username>/open-science.git
cd open-science

# 동기화를 위해 원본 저장소를 upstream으로 추가
git remote add upstream https://github.com/aipoch/open-science.git

npm install
```

`npm install`은 `postinstall` 단계를 실행하여 Prisma 클라이언트를 생성하고 Electron 앱의 네이티브 종속성을 설치합니다.

### 개발 모드로 실행

```bash
npm run dev
```

## 코딩 에이전트 탐색

설치, 개발 및 검증 명령은 저장소 루트에서 실행합니다.

| 목적           | 루트 명령                                                   |
| -------------- | ----------------------------------------------------------- |
| 설치           | `npm install`                                               |
| 실행           | `npm run dev`                                               |
| 대상 테스트    | `npm test -- <affected-test-path> [-t '<test pattern>']`    |
| 모듈 테스트    | `npm run test:module -- <module-id>`                        |
| 영향 테스트    | `npm run test:affected -- --base <base> --head <head>`      |
| Node 타입 검사 | `npm run typecheck:node`                                    |
| 웹 타입 검사   | `npm run typecheck:web`                                     |
| 린트           | `npm run lint`                                              |
| 전체 폴백      | `npm run typecheck`, `npm run lint`, `npm test` 순서로 실행 |
| UI E2E         | `npm run build:e2e` 후 `npm run test:e2e`                   |
| UI 여정        | `npm run build:e2e` 후 `npm run test:e2e:journey`           |
| 워크스페이스   | `npm run build:e2e` 후 `npm run test:e2e:workspace`         |
| 접근성         | `npm run build:e2e` 후 `npm run test:e2e:accessibility`     |
| 시각           | `npm run build:e2e` 후 `npm run test:e2e:visual`            |

Git worktree는 저장소의 `.worktree/<name>` 디렉터리 안에만 만들고, 각 변경 브랜치는 기본 브랜치를 기준으로 만드세요. 다른 worktree를 제거하거나 옮기지 마세요.

파괴적인 Git 또는 파일 시스템 작업, 새 코드를 다운로드하거나 실행하는 종속성 설치, 패키지 또는 릴리스 게시, 프로젝트의 기존 흐름 밖에서 자격 증명 처리, 작업에서 요청하지 않은 외부 쓰기(push, Pull Request, 이슈, 메시지 등)를 수행하기 전에는 명시적인 승인을 받으세요.

다음 영역을 변경하기 전에 기존 소유자 문서를 읽고 해당 집중 검사를 실행하세요.

| 영역     | 소유자 문서                                                                    | 집중 검사                                                                                        |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Renderer | [설계 사양](../design.md)                                                      | `npm run typecheck:web`, `src/renderer/` 아래 대상 테스트                                        |
| Notebook | [현재 아키텍처](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`, `src/main/notebook/` 아래 대상 테스트                                  |
| Settings | [설정 설계](../design.md#settings)                                             | `npm run typecheck`, `src/main/settings/` 및 `src/renderer/src/pages/settings/` 아래 대상 테스트 |
| ACP      | [현재 아키텍처](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`, `src/main/acp/` 아래 대상 테스트                                       |

## 프로젝트 구조

이 프로젝트는 electron-vite, React, TypeScript로 구축한 Electron 앱입니다. 세 개의 런타임 프로세스 계층과 공유 모듈이 `src/` 아래에 있습니다.

- `src/main/` — Electron 메인 프로세스(ACP 런타임, 세션 영구 저장, 아티팩트, Notebook, 프로젝트, IPC 핸들러).
- `src/preload/` — 타입이 지정된 `window.api`를 렌더러에 제공하는 preload 브리지.
- `src/renderer/` — React UI(페이지, 스토어, 컴포넌트).
- `src/shared/` — 프로세스 간에 공유하는 타입과 도우미.

## 개발 워크플로

1. 기본 브랜치에서 변경용 브랜치를 만듭니다.
2. 변경 범위를 명확하고 자체 완결적으로 유지합니다.
3. 변경한 동작을 다루는 테스트를 추가하거나 업데이트합니다.
4. 최종 Test Impact Set을 만들고 마지막 실질적 편집 후 실행합니다. 소유권, 소비자 또는 위험을 확인할 수 없으면 전체 폴백을 사용합니다.
5. 변경 내용과 이유를 명확히 설명하는 Pull Request를 만듭니다.

### 데이터베이스 스키마 변경

`prisma/schema.prisma`는 테이블, 열, 기본값, 인덱스, 외래 키를 관리합니다. Prisma에서 표현할 수 없는 SQLite CHECK 제약 조건은 `prisma/sqlite-check-constraints.json`에 있습니다. 런타임 스키마 모듈은 생성 파일이므로 직접 편집하거나 기능 DDL을 시작 코드에 추가하지 마세요.

1. Prisma 스키마를 변경하고 필요한 경우에만 SQLite CHECK 계약을 변경합니다.
2. `npm run db:schema:generate`를 실행하고 생성된 대상 스키마를 검토합니다.
3. `src/main/database/migrations/` 아래에 새 불변 항목을 추가합니다. 출시된 마이그레이션을 변경하거나 고정된 `0001` 레거시 복구 목록을 확장하지 마세요.
4. 커밋 전에 `npm run db:schema:check`와 마이그레이션 테스트를 실행합니다.

Prisma CLI는 개발 및 CI 전용 도구입니다. 패키지 앱은 체크인된 마이그레이션 매니페스트를 실행하며 Prisma migrate engine을 포함하지 않습니다.

마이그레이션 기록은 `src/main/database/`에서 관리합니다. 모듈 테스트는 `migrateApplicationDatabase`를 실행해 현재 스키마 픽스처를 만들 수 있지만, 수동으로 만든 과거 스키마, 업그레이드 어설션, 마이그레이션 원장 기대값은 기능 모듈 모음이 아니라 데이터베이스 마이그레이션 테스트에 둡니다.

### 브랜치 이름

소문자와 하이픈으로 구분한 설명을 사용해 `<type>/<short-description>` 형식으로 작성합니다.

```text
feat/project-sidebar-filter
fix/notebook-kernel-timeout
ci/ai-pr-review
```

다음 표준 타입 접두사 중 하나를 사용합니다.

- `feat` — 새 기능
- `fix` — 버그 수정
- `docs` — 문서만 변경
- `style` — 형식 등 동작에 영향을 주지 않는 변경
- `refactor` — 버그 수정이나 기능 추가가 아닌 코드 변경
- `perf` — 성능 개선
- `test` — 테스트 추가 또는 수정
- `build` — 빌드 시스템 또는 종속성 변경
- `ci` — CI 구성 또는 스크립트 변경
- `chore` — 다른 타입에 속하지 않는 유지 관리
- `revert` — 이전 변경 되돌리기

### 코딩 스타일

- 이름, 구조, 관용적 표현을 포함해 주변 코드 스타일을 따릅니다.
- 형식 지정은 Prettier가 처리합니다. `npm run format`은 선택 사항이지만 저장소 전체의 파일을 다시 쓰므로 커밋 전에 변경 사항을 검토하세요.
- ESLint로 린트를 강제합니다. `npm run lint`를 실행하세요.
- 사용자에게 보이는 문자열을 `react-i18next`의 `t()` 번역 함수로 감싸세요. 해당 번역을 `src/shared/i18n/locales/de.json`(독일어), `src/shared/i18n/locales/es.json`(스페인어), `src/shared/i18n/locales/fr.json`(프랑스어), `src/shared/i18n/locales/ja.json`(일본어), `src/shared/i18n/locales/ko.json`(한국어), `src/shared/i18n/locales/pt-BR.json`(브라질 포르투갈어), `src/shared/i18n/locales/ru.json`(러시아어), `src/shared/i18n/locales/zh-Hans.json`(중국어 간체), `src/shared/i18n/locales/zh-Hant.json`(중국어 번체)의 `renderer` 네임스페이스에 추가합니다. 영어 텍스트를 번역 키로 사용하고 코드 주석과 문서는 영어로 유지합니다.

## 검증 정책

### 안정적인 테스트 명령 의미

- `npm test`는 항상 전체 이식 가능 Vitest 모음을 실행합니다. 현재 브랜치나 변경된 파일에 따라 의미가 달라지지 않습니다.
- `npm test -- <paths> [-t '<pattern>']`는 호출자가 명시한 대상만 실행합니다. 영향 테스트를 찾지 않으며 전체 검증이라고 설명하면 안 됩니다.
- 영향 선택은 최종 diff를 바탕으로 별도로 판단합니다. `npm test`에 암시적 Git diff 동작을 넣지 마세요.

### 내부 반복

구현 중에는 변경한 동작을 실행하는 최소 프로젝트 소유 테스트를 실행합니다. 동작이 변경될 때마다 다시 실행하세요. 이전 구현 상태의 내부 반복 결과는 최종 증거가 아닙니다.

### 최종 로컬 Test Impact Set

인계 전에 최종 실질적 diff에서 최소 집합을 도출합니다.

1. 변경된 모듈이 소유하는 동작의 테스트.
2. 변경된 인터페이스와 어댑터의 계약 테스트.
3. 인터페이스가 변경되었을 수 있을 때 소비자 또는 기능 슬라이스 테스트.
4. 영향을 받는 각 런타임 프로세스의 타입 검사.
5. 소스 또는 린트 대상 구성이 변경되었을 때 `npm run lint`.
6. 로컬에서 실행할 수 있는 플랫폼, 영구 저장, 마이그레이션, 빌드 또는 E2E 위험 검사.

디렉터리가 가깝다는 사실만으로는 영향 증거가 되지 않습니다. 파일이 여러 책임을 혼합하면 인터페이스에 영향을 주는 것으로 취급하거나 전체 폴백을 사용합니다.

`test:module`은 `scripts/ci/module-impact.json`에 선언된 모듈 ID만 지원합니다. 해당 모듈에서 선별한 소유자, 계약, 대표 소비자 테스트를 실행하지만 인터페이스 변경에 대한 완전한 다운스트림 검증은 아닙니다. 인터페이스나 소비자가 변경되었을 수 있으면 `test:affected` 또는 정확한 head의 PR Gate 계획을 사용합니다.

### 전체 폴백

다음 중 하나에 해당하면 `npm run typecheck`, `npm run lint`, `npm test`를 실행합니다.

- 소유자 모듈, 변경된 인터페이스 또는 소비자를 확인할 수 없습니다.
- 패키지 메타데이터, TypeScript/Vitest/빌드 구성, PR Gate 워크플로나 분류기, 모듈 영향 매니페스트의 소유권·소비자·기능·폴백 라우팅과 같은 전역 검증 입력이 변경됩니다.
- 명확한 영향 맵 없이 여러 런타임 영역을 가로지릅니다.
- 릴리스 후보 워크플로나 유지 관리자가 전체 로컬 모음을 명시적으로 요청합니다.

전체 폴백은 안전 장치이며 모든 Pull Request의 무조건적인 전제 조건은 아닙니다. 기여자가 모든 운영 체제 CI 레인을 로컬에서 재현할 필요는 없습니다.

소유된 모듈의 `testFiles`만 변경해도 전체 폴백이 실행되지는 않습니다. 매니페스트 검증 테스트, `npm run test:module -- <module-id>`, 영향받는 프로세스의 타입 검사와 린트를 실행하세요. 정확한 head의 CI가 전체 이식 가능 및 플랫폼 모음의 최종 기준입니다.

### CI 기준 및 증거

PR Gate는 신뢰할 수 있는 입력에서 최종 base-to-head diff를 분류하고 소비자 및 플랫폼 위험 레인을 추가합니다. 알 수 없거나 모호한 소유권에는 전체 계획을 사용해 실패 시 닫힙니다. 선택된 검사는 차단되며 선택되지 않은 검사는 건너뜀으로 보고되고 증거로 간주되지 않습니다.

최종 인계에는 실질적인 변경을 나열하고 영향을 받는 각 동작을 프로젝트 소유 검사 및 최종 결과에 매핑하며(`동작 -> 명령 -> 결과`), 소비자 또는 플랫폼 레인을 포함하거나 제외한 이유와 다루지 못한 위험을 명시합니다. 검사가 마지막 실질적 편집 후 실행되었다고 밝히세요. 독립적인 리뷰에서 이 매핑이 최종 상태를 다룬다고 확인하기 전에는 변경을 검증됨으로 표시하지 마세요.

## 커밋 메시지

모든 커밋 제목은 범위가 있는 Conventional Commits 형식을 따라야 합니다.

```text
<type>(<scope>): <description>
```

Pull Request의 모든 커밋에서 이 형식을 검사합니다.

[브랜치 이름](#브랜치-이름)과 같은 표준 타입 접두사를 사용하세요. 범위는 소문자로 시작하는 짧은 하이픈 구분 이름이어야 합니다. `macOS`와 같은 고유 명사나 기술 용어 안에서는 대문자를 사용할 수 있습니다.

```text
feat(projects): add sidebar filter
fix(notebook): prevent kernel startup timeout
ci(review): unify automated AI reviews
```

- 명확한 명령형으로 소문자로 시작하는 설명을 작성하세요. `detect user-installed CRAN R on Windows`처럼 고유 명사나 기술 용어 안에서는 대문자를 사용할 수 있습니다.
- 제목을 간결하게 유지하세요. diff에서 이유가 명확하지 않으면 본문에 설명합니다.
- 호환성이 깨지는 변경은 콜론 앞에 `!`를 추가하고 `BREAKING CHANGE:` 푸터를 포함합니다. 예: `feat(api)!: remove legacy session endpoint`.

## Pull Request

- 제목에도 같은 `<type>(<scope>): <description>` 형식을 사용하세요. 예: `feat(projects): add sidebar filter`.
- 설명에서 관련 이슈를 참조하세요.
- 동작을 변경하는 작업은 리뷰어가 diff를 읽기 전에 의도, 범위, 검증을 평가할 수 있도록 간결하게 설명합니다. 해당하는 경우 다음 구조를 사용하세요.

  ```md
  ## Problem

  ## Proposed change

  ## Scope and non-goals

  ## Acceptance criteria and validation

  ## Review focus
  ```

- 아키텍처 변경, 데이터 흐름, 상태 전환 또는 여러 컴포넌트 간 상호 작용은 설계를 이해하고 검토하는 데 도움이 된다면 Mermaid 다이어그램을 고려하세요.
- 작은 문서, 유지 관리, 범위가 좁은 수정은 간결한 요약을 사용할 수 있지만 예상 동작과 검증은 명시해야 합니다.
- [검증 정책](#검증-정책)의 최종 증거 매핑을 포함하고, 나열한 검사가 마지막 실질적 편집 후 실행되었으며 다루지 못한 위험이 무엇인지 명시하세요.
- 검토하기 쉬운 적절한 크기와 범위로 유지하세요.
- 최종 Test Impact Set 또는 필요한 전체 폴백이 통과하는지 확인하세요.
- Pull Request 검사가 통과한 후 **squash merge만** 사용해 직접 병합하세요. `main`이 진행되었다는 이유만으로 브랜치를 업데이트하지 말고, 병합 충돌이 있거나 유지 관리자가 요청할 때만 업데이트하세요. squash 커밋 제목은 Pull Request 제목의 Conventional Commit 형식을 유지해야 합니다.
- `main`에 병합된 문서 외 변경은 [Nightly 워크플로](../../.github/workflows/nightly.yml)를 실행하여 결과 커밋에 대한 병합 후 검증과 크로스 플랫폼 패키지 인증을 수행합니다.

## 이슈 보고

버그를 보고할 때 다음 정보를 포함하세요.

- 기대한 결과와 실제 결과.
- 재현 단계.
- 운영 체제와 앱 버전.
- 관련 로그 또는 스크린샷(있는 경우).

## npm 패키지 게시

유지 관리자는 [npm 패키지 릴리스 가이드](../npm-release.md)를 따라야 합니다. npm 패키지 버전은 `npm-v*` 태그를 사용하며 보호된 `Publish npm package` 워크플로를 통해 게시됩니다.

## 라이선스

기여하면 기여 내용이 프로젝트와 같은 [Apache License 2.0](../../LICENSE)에 따라 라이선스되는 데 동의하는 것입니다.
