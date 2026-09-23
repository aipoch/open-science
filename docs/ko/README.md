<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  재현 가능한 과학을 위한 AI 연구 워크벤치 — 오픈 소스, 로컬 우선, 모델 독립형.
</p>

<p align="center">
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="다운로드" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="버전" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://huggingface.co/datasets/phylobio/BiomniBench-DA">
    <img alt="BiomniBench-DA Public 50 1위" src="https://img.shields.io/badge/%F0%9F%8F%86%20%231-BiomniBench--DA%20Public%2050-f59f00?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="지원 플랫폼 macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="../../LICENSE">
    <img alt="Apache 2.0 라이선스" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="웹사이트 aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
  <a href="https://discord.gg/zxQAYjReRv">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=flat&logo=discord&logoColor=white">
  </a>
</p>

<p align="center">
  <a href="../../README.md"><img alt="English README" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="러시아어 README" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../de/README.md"><img alt="독일어 README" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../es/README.md"><img alt="Español README" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> 이 문서는 영어 `README.md`의 번역본입니다. 내용이 다르면 [영문 원본](../../README.md)을 기준으로 합니다.

AIPOCH Open-Science는 과학자와 연구자를 위한 AI 연구 워크벤치로, [AIPOCH](https://aipoch.com/open-science)가 오픈 소스, 로컬 우선, 모델 독립형 설계로 개발했습니다. 과학 AI 에이전트, Python 및 R 실행, 과학 데이터 커넥터, macOS·Windows·Linux 크로스 플랫폼 지원을 통해 재현 가능하고 검토 가능한 연구를 수행합니다. 하나의 워크스페이스에서 프로젝트를 만들고 연구 목표를 자연어로 설명하면, 에이전트가 파일을 읽고 웹을 검색하며 코드를 실행하고 과학 데이터 소스를 조회하여 추적 가능한 출처가 포함된 보고서, 표, 그림을 생성합니다.

AIPOCH Open-Science는 머신러닝, 통계학, 생명과학, 화학, 재료과학, 물리학, 환경과학을 비롯한 여러 분야의 계산 및 데이터 집약적 연구를 지원합니다. 문헌 검토와 가설 수립부터 코드 실행, 데이터 분석, 시뮬레이션, 시각화, 추적 가능한 연구 결과 생성까지 전체 연구 과정을 지원합니다.

> 💡 **[AIPOCH Open-Science v0.33.0 출시](https://github.com/aipoch/open-science/releases/latest)** _(마지막 업데이트: 2026년 9월)_. AIPOCH Open-Science v0.33.0은 스크리닝 수준의 문헌 선별을 가져옵니다: 스마트 문헌 컬렉션이 포함 및 제외 기준에 따라 참고문헌을 평가하고, 포함됨 / 검토 필요 / 제외됨 상태와 PDF 증거, 옵트인 자동 업데이트를 제공합니다. 연구 패키지는 이제 RO-Crate 메타데이터를 내장하고(새로 내보낸 패키지는 ro-crate 지원 리더가 필요하며 기존 패키지는 계속 읽을 수 있음), 커넥터 계열도 Zenodo 공개 레코드 검색, GDC 프로젝트 및 파일 메타데이터, UniProt 일괄 식별자 매핑으로 넓어집니다. 에이전트별 리소스 접근 제어로 메인 에이전트와 스페셜리스트의 스킬 및 커넥터 권한을 한곳에서 관리하고, 세션에는 로컬 진단 내보내기가 더해지며, 모델 제공업체 카탈로그는 Xiaomi MiMo v2.6, Grok 4.7, 그리고 Zen과 Go 전반의 현세대 모델로 새로워집니다. Notebook 환경 및 복구 알림을 닫을 수 있게 되고, Windows 패키지 초기화는 읽기 전용 속성을 정리하며, Linux 패키지는 Fedora 쿼리 엔진을 포함하고, 상한이 적용된 토큰 추정으로 스트리밍은 응답성을 유지합니다. 자세한 내용은 [최신 릴리스 노트](https://github.com/aipoch/open-science/releases/latest)를 확인하세요.

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science 히어로 배너: Science, Open to All — 오픈 소스, 모델 독립적, 자체 호스팅 가능한 과학 AI 연구 워크벤치" src="../images/readme/open-science-banner.png" />
</p>

## 목차

- [빠른 시작](#-빠른-시작)
- [제품 둘러보기](#제품-둘러보기)
- [벤치마크 성능](#벤치마크-성능)
- [핵심 기능](#핵심-기능)
- [모델 제공업체](#모델-제공업체)
- [데이터, 권한 및 신뢰](#데이터-권한-및-신뢰)
- [개발 및 패키징](#개발-및-패키징)
- [자주 묻는 질문](#자주-묻는-질문)
- [참여하기](#참여하기)
- [라이선스](#라이선스)

## 🚀 빠른 시작

### 1. 앱 다운로드

[최신 릴리스](https://github.com/aipoch/open-science/releases/latest)를 열고 **Assets**를 펼친 다음 컴퓨터에 맞는 설치 프로그램을 선택하세요.

| 사용 중인 컴퓨터                   | 선택할 파일                           |
| ---------------------------------- | ------------------------------------- |
| macOS 12+ — Apple Silicon(M1 이상) | Apple Silicon / ARM64용 macOS DMG     |
| macOS 12+ — Intel                  | Intel / x64용 macOS DMG               |
| Windows x64                        | Windows x64 설치 프로그램             |
| Linux x64                          | Linux x64 AppImage 또는 Debian 패키지 |

공식 릴리스 페이지에서 다운로드하세요. 필요하면 [다운로드 검증](../../SECURITY.md#verifying-your-download)을 참고하세요.

macOS에서는 [Homebrew](https://brew.sh)로도 설치할 수 있습니다:

```bash
brew install --cask open-science
```

Windows 재설치 시 연구 데이터는 유지됩니다. 완전히 초기화하려면 확인 후 로컬 데이터를 영구 삭제하는 [데이터 초기화 도구](../../scripts/windows-reset/README.md)를 참고하세요.

### 2. 최초 설정 완료

설정 안내에 따라 **환경 → 데이터 위치 → 에이전트 런타임 → 모델 제공업체 → Notebook 런타임** 순서로 진행하세요.

필수 환경 및 에이전트 런타임 검사를 완료하고 모델 연결을 테스트하세요. Python/R Notebook 설정은 선택 사항이며, Notebook과 데이터 위치는 나중에 설정에서 변경할 수 있습니다.

<table>
  <tr>
    <td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="AIPOCH Open-Science의 자동 최초 실행 환경 검사"></td>
    <td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="AIPOCH Open-Science 최초 실행 모델 제공업체 구성"></td>
  </tr>
  <tr>
    <td align="center"><sub>호스트 호환성, 저장소 및 네트워크 검사</sub></td>
    <td align="center"><sub>제공업체, API Key, 엔드포인트 및 모델 검증</sub></td>
  </tr>
</table>

### 3. 연구 프로젝트 시작

1. **New project**를 클릭하고 세션을 열어 연구 목표, 입력 및 원하는 출력을 설명하세요.
2. 파일을 첨부하고 모델과 승인 모드를 선택한 후 작업을 보내세요. `@`로 프로젝트 파일을 참조하거나 `/`로 스킬을 선택할 수 있습니다.
3. 도구 활동과 승인 요청을 확인하고, 결과를 미리 보며 **Provenance**에서 이용 가능한 근거를 확인하세요.

> 이 README의 스크린샷은 워크플로를 설명하기 위한 예시입니다. 레이블, 카탈로그 및 기타 인터페이스 세부 사항은 설치한 버전과 다를 수 있습니다.

## 제품 둘러보기

### 연구 요청에서 추적 가능한 결과까지

대표적인 생물정보학 작업을 예로 들어 보겠습니다. 출판된 차등 발현 분석을 재현하고, 다시 생성한 결과를 논문과 비교한 뒤 검토에 필요한 보고서, 표, 그림을 제공합니다. 아래 스크린샷은 기록된 AIPOCH Open-Science 워크플로의 대표 화면으로, 각 단계를 보여 주지만 하나의 연속된 세션을 의미하지는 않습니다.

#### 1. 연구 작업과 근거 정의

연구 질문, 원문 논문과 데이터 세트, 필요한 방법 또는 임계값, 예상 출력, 승인 기준을 설명합니다. 관련 파일을 업로드하거나 `@`로 기존 프로젝트 아티팩트를 참조하여 에이전트가 숨겨진 컨텍스트가 아닌 명시적인 입력에서 시작하도록 합니다.

<p align="center">
  <img src="../images/readme/product-tour-task.jpg" alt="연구 결론, 생성 아티팩트, 출처 비교를 한 작업 공간에 표시한 AIPOCH Open-Science 논문 재현 작업" width="900">
</p>

#### 2. 검사 가능한 과학 도구로 실행

에이전트는 공유 Notebook에서 과학 스킬, 권한이 적용된 연구 커넥터, 검색, 파일 작업, Python 또는 R 코드를 함께 사용할 수 있습니다. 생성된 그림을 연구 요약 옆에서 검토할 수 있으며, 아티팩트 기록에서는 캡처된 생성 코드와 실행 근거를 확인할 수 있습니다.

<p align="center">
  <img src="../images/readme/product-tour-execute.png" alt="연구 요약, 생성된 그림, 캡처된 생성 코드를 나란히 표시한 AIPOCH Open-Science 생물정보학 분석" width="900">
</p>

#### 3. 보고서, 표, 그림을 한곳에서 검토

최종 응답은 재현된 내용, 달라진 내용, 중요한 한계를 요약합니다. 생성된 Markdown 보고서, CSV 표, 이미지 및 기타 연구 아티팩트는 세션에 연결된 상태로 프로젝트 파일 라이브러리에도 모이며, 대화 옆에서 미리 보고 후속 작업에 다시 사용할 수 있습니다.

<p align="center">
  <img src="../images/readme/product-tour-output.jpg" alt="에이전트 설명 옆에서 차등 발현 그림과 생성 파일을 미리 보는 AIPOCH Open-Science 재현 결과" width="900">
</p>

#### 4. 모든 아티팩트를 근거까지 추적

생성된 각 아티팩트는 체크섬이 있는 변경 불가능한 버전으로 저장됩니다. **Provenance** 보기에서는 생성 코드와 실행 기록, 참조된 입력, 관찰된 환경 목록, 생성한 대화 브랜치, 버전별 Reviewer 결과를 표시할 수 있습니다. 검증할 수 없는 근거는 추론하지 않고 사용할 수 없음으로 표시합니다.

<p align="center">
  <img src="../images/readme/product-tour-provenance.jpg" alt="생성 결과를 추적하는 Provenance 진입점이 있는 AIPOCH Open-Science 연구 아티팩트 미리 보기" width="900">
</p>

## 벤치마크 성능

### 🏆 BiomniBench-DA Public 50 1위

AIPOCH Open-Science는 집계된 BiomniBench-DA Public 50 비교에서 **gpt-5.6-sol (xhigh)**로 **79.05**를 기록해 가장 높은 순위 점수를 달성했습니다. 이 결과는 Gemini 3.1 Pro 평가 점수 **81.04**와 DeepSeek v4-pro 평가 점수 **77.06**을 동일 가중치로 평균한 값이며, 수집된 Public 50 결과에서 AIPOCH Open-Science를 **1위**에 올렸습니다. [BiomniBench-DA 데이터세트](https://huggingface.co/datasets/phylobio/BiomniBench-DA)를 살펴보세요.

<p align="center">
  <img src="../images/readme/biomnibench-public50-leaderboard.png" alt="AIPOCH Open-Science가 79.05점으로 1위를 기록한 BiomniBench-DA Public 50 비교" width="1200" />
</p>

## 핵심 기능

AIPOCH Open-Science는 프로젝트 관리, 다중 모델 에이전트 실행, Python 및 R Notebook, 과학 데이터 커넥터, 출처가 포함된 불변 아티팩트 버전, 권한이 적용된 사람 참여 제어를 하나의 로컬 워크스페이스에 통합합니다. 변경되는 카탈로그, 패키징 세부 정보, 새 옵션은 설치된 앱과 [최신 릴리스 노트](https://github.com/aipoch/open-science/releases/latest)를 기준으로 확인하세요.

| 영역                              | 핵심 기능                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **과학 스킬**                     | **23개의 기본 제공 스킬**과 [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace)에서 원클릭 설치 및 업데이트할 수 있는 **525개의 스킬**로 연구를 확장하세요. 대화나 완료된 작업에서 스킬을 만들고 패키지 또는 GitHub 소스를 가져올 수 있습니다. 기여는 검토 후 게시되며 로컬 가져오기로 자동 게시되지 않습니다.                                          |
| **커넥터**                        | **24개의 기본 제공 커넥터**로 과학 리소스에 접근하거나 사용자 지정 로컬 및 원격 MCP 커넥터를 추가하세요. 도구별 권한 관리와 커넥터 구성 가져오기/내보내기를 지원합니다.                                                                                                                                                                                                           |
| **스페셜리스트 및 위임**          | [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace)에서 **10개의 스페셜리스트**를 설치하거나 개인 전문가를 만들고 조정해 메인 에이전트의 작업을 위임하세요. 전문가 패키지는 가져오기/내보내기를 지원하며 기여는 검토 후 게시되고 로컬 가져오기는 자동 게시되지 않습니다.                                                                       |
| **모델 및 에이전트 백엔드**       | 클라우드 모델, 호환 사용자 지정 게이트웨이 또는 Claude·Codex 구독 로그인을 사용하세요. Claude Code, OpenCode, Codex, CodeBuddy 백엔드와 모델 연결 확인, 이미지 입력, 추론 강도 설정을 지원합니다.                                                                                                                                                                                 |
| **프로젝트, 세션 및 연구 패키지** | 프로젝트를 관리하고 세션 고정, 메시지 분기, 사이드 채팅과 기록 복구를 사용하세요. 대화 분기, 선택한 파일 버전, Notebook 기록과 검증 증거를 담은 **이동 가능한 `.science` 연구 패키지**를 다른 프로젝트나 컴퓨터로 옮길 수 있습니다. 가져온 기록은 읽기 전용으로 코드 실행이나 자격 증명 복원을 하지 않으며, 사이드 채팅과 북마크는 제외되고 파일 범위는 내보내기 선택에 따릅니다. |
| **검토 에이전트**                 | 필요에 따라 자동 검토를 켜고, 완료된 에이전트 턴의 응답, 실행 기록 및 관련 파일 근거를 별도 컨텍스트에서 확인합니다. 근거가 있는 통과·경고·실패 검사 결과를 제시하며, 문제가 발견되면 정해진 횟수 내에서 주 에이전트의 수정과 재검토를 진행할 수 있습니다. 검토 로그와 문제 처리 상태를 보관하며, 검토 범위는 해당 턴에서 이용할 수 있는 기록으로 제한됩니다.                     |
| **Python, R, Notebook 및 HPC**    | 관리 환경이나 자체 인터프리터로 Python, R, Notebook, Shell 작업을 로컬에서 실행하며 백그라운드 처리와 실행 기록을 지원합니다. SSH 연결이나 Slurm 작업 제출에는 아래 원격 컴퓨팅 FAQ의 호스트, 소프트웨어, 리소스 및 권한이 필요합니다.                                                                                                                                            |
| **문헌 라이브러리**               | 문헌과 PDF를 가져와 컬렉션, 태그, 프로젝트 연결, 메모 및 중복 항목 병합으로 관리합니다. 오픈 액세스 원문을 찾고, PDF를 읽으며 그림과 표를 추출하고, 대화에서 라이브러리 문헌을 활용해 AI의 도움으로 분석할 수 있습니다. 선택한 인용 스타일로 참고문헌 목록을 생성하고 BibTeX 또는 RIS로 내보낼 수 있습니다.                                                                       |
| **과학 파일 및 미리보기**         | 파일당 최대 **10 GiB**를 업로드하고 프로젝트 파일과 과학 데이터, PDF, Office 문서, 이미지, 코드, 분자 구조 미리보기를 관리하세요. 업로드 한도는 모델이 전체 내용을 읽을 수 있다는 뜻이 아니며 컨텍스트, 첨부 분석, 미리보기에는 별도 제한이 있습니다. 큰 파일은 보통 코드로 나누어 읽거나 분석해야 합니다.                                                                        |
| **아티팩트 및 출처**              | 변경 불가능한 산출물 버전과 사용 가능한 생성 코드, 입력, 실행 기록, 환경 정보 및 검토 증거를 보관합니다. 데스크톱에서 완전한 실행 레시피, 필수 입력, 사용 가능한 런타임을 갖춘 버전을 재실행하고 출력을 비교해 검증 기록을 내보낼 수 있습니다. 증거 부족으로 검증이 불가능할 수 있으며 재실행 검사는 과학적 타당성을 증명하지 않습니다.                                           |

## 모델 제공업체

AIPOCH Open-Science는 제품 수준에서 특정 모델에 종속되지 않습니다. 주요 클라우드 LLM 제공업체 또는 사용자 지정 게이트웨이에 연결하거나 기존 Claude 또는 Codex 구독을 재사용할 수 있습니다. 현재 제공업체 사용 가능 여부는 선택한 에이전트 백엔드와 지원 API 프로토콜에 따라 달라집니다. 모델에 연결하는 방법은 네 가지입니다.

| 제공업체 모드              | 작동 방식                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **기본 클라우드 제공업체** | 설치된 앱에 표시된 제공업체 목록에서 선택하고 요청된 키로 인증합니다.                                                                                                                                                                                                                                                                                                                                                                     |
| **사용자 지정 게이트웨이** | Base URL과 정확한 모델 ID를 입력하고 선택한 에이전트 백엔드가 지원하는 API 프로토콜(Messages, Chat Completions 또는 Responses)을 지정한 뒤 연결을 테스트하세요. 원격 게이트웨이는 HTTPS와 API Key가 필요합니다. `localhost`, `127.0.0.1`, `[::1]` 같은 루프백 엔드포인트는 HTTP를 사용하고 키를 생략할 수 있습니다. Ollama, LM Studio, llama.cpp, vLLM 프리셋을 제공합니다. 기본 API 형식만으로 서버나 모델 호환성이 보장되지는 않습니다. |
| **Codex 구독**             | Codex 에이전트 프레임워크를 선택한 다음 제공업체 유형에서 Codex 구독을 선택합니다.                                                                                                                                                                                                                                                                                                                                                        |
| **Claude 구독**            | 두 가지 모드로 로그인합니다. **공유** 모드는 브라우저 로그인 자격 증명을 기본 `~/.claude` 프로필에 저장합니다. **격리** 모드는 앱 소유 `CLAUDE_CONFIG_DIR`에서 `claude setup-token`을 실행하여 `~/.claude/`와 완전히 분리하고 브라우저 흐름과 토큰 붙여넣기 폴백을 제공합니다.                                                                                                                                                            |

기본 제공업체에는 OpenAI, Anthropic, DeepSeek, NVIDIA Build 등이 있습니다. 모델과 지역별 엔드포인트는 설치 버전 및 선택한 백엔드에 따라 달라지므로 앱의 제공업체 선택기와 연결 테스트로 확인하세요.

## 데이터, 권한 및 신뢰

AIPOCH Open-Science는 프로젝트 데이터, 설정, 아티팩트 버전, 출처 증거를 로컬 컴퓨터에 저장합니다. API Key는 로컬에 보관되며 운영 체제에서 지원할 경우 보안 자격 증명 저장소로 보호됩니다. 로그는 로컬에 있고 자동으로 업로드되지 않습니다.

외부 데이터 흐름은 발생할 수 있으므로 검토해야 합니다.

- 모델 요청은 프롬프트와 필요한 컨텍스트를 선택한 모델 제공업체로 보냅니다.
- 웹 검색과 원격 커넥터는 표시된 매개변수를 외부 서비스로 보냅니다.
- 로컬 커넥터는 컴퓨터에서 신뢰할 수 있는 명령을 실행할 수 있습니다.
- 앱은 업데이트 서버, 마켓플레이스 카탈로그, 런타임 또는 모델 다운로드 서비스에도 접속할 수 있습니다.
- 첨부 파일, `@` 참조, 로그, 생성 보고서에는 민감한 연구 데이터가 포함될 수 있습니다.

작업에 맞는 가장 제한적인 권한 프로필을 선택하세요.

| 모드                 | 동작                                                                                                              | 권장 용도                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Ask for approval`   | 기존 범위 지정 권한이나 신뢰된 앱 도구 정책에 포함되지 않은 작업에 승인을 요청합니다                              | 새 워크플로, 민감한 데이터, 익숙하지 않은 스크립트 |
| `Auto-approve edits` | 가능한 경우 백엔드의 기본 자동 검토를 사용하며, 그렇지 않으면 명백히 위험이 낮은 작업 공간 작업만 자동 승인합니다 | 외부 액세스를 제어하는 신뢰할 수 있는 파일 편집    |
| `Full access`        | 편집, 명령, 네트워크, 커넥터를 자동 허용                                                                          | 범위가 명확하고 완전히 신뢰하는 무인 작업          |

실제 권한 모드는 선택한 백엔드와 기존 승인에 따라 달라집니다. 커넥터, 도구, 컴퓨팅 네트워크 정책도 적용되므로 앱에 표시된 실제 적용 모드를 확인하세요.

승인 전에 커넥터 매개변수와 도구 활동을 검토하세요. API Key, 액세스 토큰, 환자 식별자, 미공개 데이터, 민감한 로컬 경로를 스크린샷이나 공개 이슈 로그에 포함하지 마세요.

## 개발 및 패키징

AIPOCH Open-Science는 React, TypeScript, Prisma/SQLite, ACP 기반 에이전트 런타임으로 구축된 Electron 앱입니다.

소스 개발 요구 사항:

- Node.js 22([`.nvmrc`](../../.nvmrc) 참고)와 npm
- Git
- Notebook 실행은 선택 사항이며 앱 관리 Python/R 환경이나 직접 설정한 호환 인터프리터를 사용할 수 있습니다.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

빌드 명령 및 개발 절차는 [개발 명령과 패키징 참고](development-quick-reference.md) 및 [기여 가이드](../../CONTRIBUTING.md)를 확인하세요.

### Localhost 웹 및 헤드리스 모드

데스크톱 백엔드는 로컬 컴퓨터의 브라우저에 동일한 렌더러를 선택적으로 제공할 수 있습니다. 이 기능은 기본적으로 꺼져 있고 `127.0.0.1`에만 바인딩됩니다.

```bash
npm run build:web
npm run dev:web
```

앱에 출력된 인증 URL을 여세요. `npm run dev:headless`를 사용하면 Electron 창을 열지 않고 백엔드, 트레이, 에이전트 런타임, localhost 웹 서비스를 시작합니다. `OPEN_SCIENCE_WEB_PORT`로 포트를 선택할 수 있습니다(기본값 `44100`). 앱을 명시적으로 종료하면 에이전트와 Notebook 프로세스도 정상적으로 종료됩니다.

### 모바일 원격 액세스

Remote.It 페어링을 통해 휴대전화나 태블릿에서 동일한 localhost 웹 UI에 연결할 수 있습니다. 6자리 AIPOCH Open-Science 코드로 브라우저를 페어링하고 데스크톱에서 한 번 승인하면 루프백 서버를 직접 공개하지 않고 워크스페이스에 연결할 수 있습니다. 브라우저 신뢰는 취소할 수 있으며 모드 변경이나 서비스 종료는 활성 원격 세션을 즉시 무효화합니다.

### 헤드리스 CLI 및 SDK

헤드리스 CLI와 종속성이 없는 Node.js SDK는 데스크톱 및 웹 인터페이스와 같은 로컬 데몬, 프로젝트, 세션, 자격 증명, 권한을 사용합니다. 자세한 사용법은 게시 가능 패키지와 함께 관리하므로 하나의 명령 참조만 유지합니다.

- [CLI 가이드](../../packages/open-science/CLI.md) — 설치, 서비스 수명 주기, 작업 자동화, 아티팩트, 출력 형식, 종료 코드
- [SDK 패키지 개요](../../packages/open-science/README.md) — Node.js 빠른 시작 및 패키지 진입점

## 자주 묻는 질문

### 모델 연결 테스트가 실패하는 이유는 무엇인가요?

답변: API Key에 빠진 문자나 공백이 없는지, Base URL과 지역이 올바른지, 제공업체의 정확한 모델 ID를 사용했는지 확인하고 네트워크 연결과 계정 잔액도 확인하세요. Claude 구독은 선택한 모드에 따라 공유 브라우저 로그인을 다시 시도하거나 격리된 `claude setup-token` 자격 증명을 갱신하세요.

### 설정 중 `Continue`가 비활성화되는 이유는 무엇인가요?

답변: 현재 단계의 필수 조건이 충족되지 않았습니다. 해당 단계에 따라 `Action needed` 환경 항목을 해결하거나, 선택한 에이전트 런타임을 설치 또는 복구하거나, 모델 제공업체를 검증하세요. Notebook 설정은 선택 사항이며 Notebook 실행에만 영향을 줍니다.

### 원격 HPC 클러스터에서 작업을 실행하려면 어떻게 하나요?

답변: **Remote Compute (SSH)**는 항상 활성화되어 있으며 Settings에서 따로 활성화할 필요가 없습니다. **Settings → Compute**에서 SSH 컴퓨팅 호스트를 등록하고 현재 세션에서 사용할 수 있게 한 다음 자연어 또는 `/remote-compute-ssh`로 원격 컴퓨팅을 사용하세요. 연결 가능한 SSH 호스트, 유효한 인증, 필요한 디렉터리 권한과 작업에 필요한 소프트웨어, 종속성, 컴퓨팅 리소스가 필요합니다. Direct SSH에는 스케줄러가 필요하지 않지만 Slurm 모드에는 사용 가능한 Slurm 환경과 작업 제출 권한이 필요합니다. “항상 활성화”는 Skill 자체를 뜻하며 등록된 모든 호스트가 항상 사용 가능하다는 뜻은 아닙니다.

### 명령줄 인터페이스가 있나요?

답변: 있습니다. **Settings → General → Command line tool → Install command**에서 한 번에 설치할 수 있습니다(`open-science`를 PATH에 추가하며 별도 Node.js가 필요하지 않습니다). CLI는 브라우저를 열지 않고 로컬 서비스를 제어하고 연구 작업을 제출합니다.

```bash
# 백그라운드에서 서비스 시작
open-science init
open-science start --no-open

# 프로젝트를 만들고 정확한 이름으로 작업 실행
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# 생성된 아티팩트 다운로드
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

전체 명령 참조, JSON/JSONL 출력 형식, 종료 코드, 헤드리스 서비스 옵션은 [CLI 가이드](../../packages/open-science/CLI.md)를 참고하세요.

### 생성된 결과의 출처를 확인하려면 어떻게 하나요?

답변: 생성된 아티팩트를 열고 **Provenance**를 선택하세요. 버전을 선택하여 콘텐츠 ID와 사용 가능한 생성 코드, 실행 기록, 입력, 환경 인벤토리, 생성 대화 컨텍스트, 리뷰 증거를 확인합니다. AIPOCH Open-Science가 검증할 수 없는 증거는 사용할 수 없음으로 표시됩니다.

### 이후 대화를 잃지 않고 이전 요청을 수정할 수 있나요?

답변: 가능합니다. 완료된 사용자 메시지를 편집해 다시 보내면 해당 지점에서 새 브랜치가 생성됩니다. 원래 후속 턴은 계속 사용할 수 있고, 메시지 옆의 수정 화살표로 대체 경로를 전환합니다.

## 참여하기

AIPOCH Open-Science는 GitHub, Discord, X 및 AIPOCH 웹사이트를 통해 버그 신고, 기능 제안, 설계 토론, 커뮤니티 질문 및 기여를 받습니다. 목적에 가장 잘 맞는 채널을 선택하고 프로젝트 세부 정보를 공개하기 전에 관련 기여 가이드와 공개 게시 안전 안내를 확인하세요.

| 채널                                                                     | 용도                                       |
| ------------------------------------------------------------------------ | ------------------------------------------ |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | 버그, 재현 가능한 오류, 구체적인 기능 제안 |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 설계 질문, 로드맵 제안, 긴 기술 토론       |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | 커뮤니티 지원, 기여자 조율, 비공식 토론    |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | 릴리스 발표 및 공개 개발 업데이트          |
| [AIPOCH Open-Science 공식 웹사이트](https://aipoch.com/open-science)     | 공식 제품 개요 및 다운로드                 |

공개 이슈를 만들기 전에 로그와 스크린샷에서 API Key, 토큰, 비공개 파일 경로, 미공개 데이터, 환자 식별자 및 기타 민감한 정보를 제거하세요. 개발 워크플로는 [기여 가이드](../../CONTRIBUTING.md)를 참고하세요.

> ⭐ **저장소에 Star:** 이 프로젝트가 도움이 되었다면 GitHub에서 Star를 남겨 주세요. Star는 지속적인 개발에 힘이 됩니다. 몇 초면 충분하지만 프로젝트에는 큰 의미가 있습니다.

제공 중인 기능, 부분 구현 및 계획은 [기능 지도](../../ROADMAP.md#capability-map)를 확인하세요.

## 라이선스

Apache License 2.0 — [LICENSE](../../LICENSE)를 참고하세요.
