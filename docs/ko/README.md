<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  AIPOCH Open-Science는 재현 가능한 과학 연구를 위한 로컬 우선 오픈 소스 AI 연구 워크벤치로, 모델을 유연하게 선택할 수 있습니다. 휴대 가능한 <code>.science</code> 패키지를 공유해 다른 사람이 결과의 근거를 살펴보게 하거나, 연구 영상을 내보내 결과에 이른 과정을 보여 줄 수 있습니다.
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">
    <img width="720" alt="AIPOCH Open-Science .science 패키지 생성 데모" src="../images/readme/demo-full.webp" />
  </a>
</p>

<p align="center">YouTube에서 보기: <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">AIPOCH Open-Science: Generating .science Research Packages (Demo)</a></p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="AIPOCH Open-Science 다운로드" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="AIPOCH Open-Science 최신 버전" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="AIPOCH Open-Science Zenodo DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="AIPOCH Open-Science arXiv 프리프린트: 2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#벤치마크-성능">
    <img alt="AIPOCH Open-Science — 벤치마크 결과" src="../images/readme/benchmark-comparisons.svg">
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

### 💡 AIPOCH Open-Science v1.2.2 업데이트

_2026년 11월 12일_

- **Strict 네트워크 모드**: Notebook 네트워킹에 Strict 화이트리스트를 선택할 수 있습니다. 요청은 프로토콜, 호스트, 포트가 규칙과 일치해야 하며, 일치하지 않는 요청은 인가를 묻지 않고 차단됩니다.
- **영상 이어서 만들기**: 중단된 연구 영상 생성이 검증된 체크포인트부터 이어지며 5단계 진행 화면을 표시합니다. 완료된 장면과 내레이신은 재사용됩니다.
- **PDF 충실도**: 외부 PDF는 기본 그림, 표, 캡신, 읽기 셜서를 유지하고, 번역된 문서는 원본 구조와 레이아웃을 보존합니다.
- **더 안전한 Windows 권한 부여**: 보호 모드의 폴더 권한 부여는 저장 전에 확인되고, 업데이트·제거·핸드오프 흐름은 진단 정보를 보존한 채 더 안정적으로 복구됩니다.
- **제공업체 업데이트**: Qwen4 Max Preview가 베이징과 싱가포르의 Bailian Token Plans에 합류하고, 공식 연결의 기본 모델이 갱신됩니다.
- **안정성 수정**: 세신 가져오기가 결과를 보고하고, 서비스 복구는 연결이 돌아올 때까지 작업 공간을 막으며, 어두운 모드 대비가 모든 표면에서 유지됩니다.

[v1.2.2 전체 릴리스 노트 보기](https://github.com/aipoch/open-science/releases/tag/v1.2.2)

<a id="share-your-research"></a>

## 함께 살펴볼 연구 기록과 영상으로 보는 연구 과정

[`.science` 패키지](https://aipoch.com/docs/guides/research-packages/)에 공유할 대화 분기, 파일 버전, Notebook 기록과 검증 자료를 담습니다. 받는 사람은 자신의 프로젝트에 패키지를 가져와 읽기 전용 기록을 열고 그림이나 표에 사용된 입력 자료를 확인할 수 있습니다. 검증 기록은 보낸 쪽에서 수행한 확인을 보여 줍니다. 데스크톱 앱에서 포크하면 편집 가능한 사본이 만들어집니다.

같은 작업을 [연구 영상](https://aipoch.com/docs/guides/research-films/)으로 소개할 수 있습니다. 데스크톱 앱에서 완료된 대화 분기를 선택해 영상을 생성합니다. 설정한 모델이 세션 기록을 바탕으로 발표 내용을 구성하고 로컬 음성 엔진이 영어 내레이션을 만듭니다. 영상을 검토한 뒤 HTML 플레이어를 내려받거나 MP4로 내보냅니다. 포함된 분기에 이미 생성된 영상이 있다면 그 플레이어를 `.science` 패키지에 담을 수도 있습니다.

## 🚀 빠른 시작

### 1. 앱 다운로드

[공식 다운로드 페이지](https://aipoch.com/open-science/download)를 열고 컴퓨터에 맞는 설치 프로그램을 선택하세요.

| 사용 중인 컴퓨터                   | 선택할 파일                             |
| ---------------------------------- | --------------------------------------- |
| macOS 12+ — Apple Silicon(M1 이상) | Apple Silicon / ARM64용 macOS DMG       |
| macOS 12+ — Intel                  | Intel / x64용 macOS DMG                 |
| Windows 10/11 x64                  | Windows x64 설치 프로그램(코드 서명됨)  |
| Linux x64                          | Linux x64 AppImage 또는 Debian 패키지   |
| Linux ARM64                        | Linux ARM64 AppImage 또는 Debian 패키지 |

설치 전 확인 사항은 [다운로드 검증](../../SECURITY.md#verifying-your-download)을 참고하세요.

macOS에서는 [Homebrew](https://brew.sh)로도 설치할 수 있습니다:

```bash
brew install --cask open-science
```

macOS 또는 Linux용 독립 CLI는 별도의 [AIPOCH tap](https://github.com/aipoch/homebrew-tap)을 사용합니다.

```bash
brew install aipoch/tap/open-science
```

이 Formula는 Node를 포함하고 데스크톱 앱 없이 실행됩니다. 버전은 데스크톱 Cask와 다를 수 있습니다. 전제 조건과 업그레이드는 [독립 실행 환경 가이드](../standalone-runtime.md)를 참고하세요.

[GitHub Release의 Assets](https://github.com/aipoch/open-science/releases/latest)에서는 Node.js가 포함된 독립 CLI 압축 파일도 받을 수 있습니다. macOS와 Linux는 ARM64와 x64를, Windows는 x64를 지원합니다.

독립 CLI와 웹 UI는 **Node.js 22.13.0 이상**에서 배포된 [npm 패키지](https://www.npmjs.com/package/@aipoch/open-science)로 설치할 수 있습니다:

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

출력된 URL을 열어 설정을 완료하거나 [터미널 설정 가이드](../../packages/open-science/CLI.md#first-run-setup-codex)를 따르세요. npm은 macOS ARM64/x64, glibc 기반 Linux ARM64/x64 및 Windows x64를 지원하며 데스크톱 앱은 필요하지 않습니다. npm 선택적 의존성을 활성화하고 [Linux 사전 요구 사항 및 업그레이드 안내](../standalone-runtime.md#install-from-npm)를 확인하세요. URL에는 인증 토큰이 포함되므로 공유하지 마세요.

Windows 재설치 시 연구 데이터는 유지됩니다. 완전히 초기화하려면 확인 후 로컬 데이터를 영구 삭제하는 [데이터 초기화 도구](../../scripts/windows-reset/README.md)를 참고하세요.

### 2. 최초 설정 완료

설정 안내에 따라 **환경 → 데이터 위치 → 에이전트 런타임 → 모델 제공업체 → Notebook 런타임** 셜서로 진행하세요.

필수 환경 및 에이전트 런타임 검사를 완료하고 모델 연결을 테스트하세요. Python/R Notebook 설정은 선택 사항이며, Notebook과 데이터 위치는 나중에 설정에서 변경할 수 있습니다.

초기 설정을 마친 뒤에는 시스템 설정에서 화면 모양과 알림을 조정할 수 있습니다. 일반 설정에서는 앱 정보, 진단 항목, 명령줄 도구를 확인하고 수동 설치 및 업데이트 안내서를 열 수 있습니다.

기존 모델 설정 탭은 **로컬 기능**으로 바뀌어 PDF 추출, OCR 언어 팩, 연구 내레이션을 관리합니다. 내레이션에는 로컬에 설치된 음성 모델이 필요합니다.

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

<a id="핵심-기능"></a>

## AIPOCH Open-Science로 무엇을 할 수 있나요?

| 작업        | 사용 방법                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 문헌 검토   | Zotero에서 참고문헌을 가져와 기준에 따라 논문을 선별하고 원문 PDF에서 결과를 확인합니다.                                                            |
| 데이터 분석 | Notebook에서 Python이나 R을 실행하고 출력된 그림과 표를 원본 파일과 함께 확인합니다.                                                                |
| 결과 추적   | 출처 보기에서 파일 버전의 입력, 코드, 실행 이력을 확인합니다. 절차와 입력, 실행 환경이 갖춰지면 다시 실행할 수 있습니다.                            |
| 결과 인계   | [`.science` 패키지](#share-your-research)를 공유해 다른 사람이 결과에 이른 단계와 파일 버전을 확인하도록 합니다.                                    |
| 작업 확장   | 과학 데이터 커넥터와 내장 스킬을 사용하거나 마켓플레이스에서 스킬과 전문가를 추가합니다.                                                            |
| 모델 선택   | 지원되는 제공업체, 사용자 지정 게이트웨이 또는 지원되는 Claude나 Codex 구독을 연결합니다. 사용 가능한 프로토콜은 에이전트 백엔드에 따라 달라집니다. |

<a id="벤치마크-성능"></a>

## 벤치마크 결과

AIPOCH는 논문 찾기부터 논문 내용에 대한 답변, 연구 계획 실행까지 다양한 작업에서 AIPOCH Open-Science를 평가했습니다. 아래 결과는 AIPOCH가 직접 실행한 평가에서 얻었으며, 각 점수는 특정 작업과 평가 설정에 해당합니다. 계산 결과 재현과 데이터 기반 가설 발견도 평가했습니다.

| 작업                        | Benchmark              | AIPOCH Open-Science의 결과                                                                                                                             |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 목표 논문 찾기              | LitQA2-FullText-Search | LitQA2-FullText-Search의 **테스트 75문항 중 68문항**에서 목표 논문이 상위 30개 결과에 포함되었습니다(**Recall@30 90.67%**, gpt-6-astra).               |
| 문헌을 바탕으로 답변하기    | LitQA2-FullText        | 별도의 LitQA2-FullText 평가에서 Open-Science는 **75문항 중 70문항에 정답**을 제시했습니다(**정확도 93.33%**, deepseek-flash, Max 추론).                |
| 인용을 포함한 답변 종합하기 | ScholarQA-CS2          | ScholarQA-CS2 검증 100문항에서 deepseek-v4-flash로 **종합 품질 점수 0.9289/1**을 기록했습니다. 공식 테스트 참고 결과는 다른 문항을 사용합니다.         |
| 연구 워크플로 실행하기      | ASI-Bench              | 동일 모델을 사용한 로컬 ASI-Bench 평가에서 B4 점수는 Open-Science **59.46**, Codex **55.45**였습니다. B2 점수는 거의 같았습니다(**56.11**, **56.09**). |
| 과학 연구 과제 수행         | TB-Science 0.1         | 70개 과제에서 GPT-6 Astra/max: 로컬 실행 210회 중 **145회 통과**(**69.05%**). 공식 순위가 아니며 개별 실행 기록은 공개되지 않았습니다.                 |
| 생의학 데이터 분석하기      | BiomniBench-DA         | BiomniBench-DA Public 50에서 두 평가 모델의 점수는 **81.04**, **77.06**이었으며 동일 가중치 평균은 **79.05**였습니다.                                  |
| 발표된 결과 재현            | CORE-Bench-Hard        | CORE-Bench-Hard — 로컬 평가에서 테스트 과제 37개 중 36개 정답(97.30%). 최종 집계에는 재시험이 포함됩니다.                                              |
| 데이터에서 가설 발견        | DiscoveryBench         | DiscoveryBench — 검증 세트에서 선택한 25개 과제의 로컬 모델 평가 평균은 0.7467/1입니다.                                                                |

<details>
<summary>평가 범위 및 보고서</summary>

**평가 범위:** 보고서는 명시된 모델과 데이터 분할을 사용한 2026년 8월부터 11월까지의 로컬·내부 실행을 다루며, 현재 릴리스를 위해 다시 실행한 결과가 아닙니다. 참고 점수는 과거 스냅샷으로 실시간 셜위가 아닙니다. 서로 다른 벤치마크 계열의 점수는 직접 비교할 수 없으며 수치 차이가 통계적 유의성을 입증하지 않습니다.

자세한 평가 내용은 [AstaBench 및 ASI-Bench 보고서](https://aipoch.com/benchmark/open-science), [BiomniBench-DA 보고서](https://aipoch.com/blog/open-science-biomnibench-da), [TB-Science 0.1 로컬 결과](https://aipoch.com/blog/aipoch-open-science-terminal-bench-science-local-result)를 참고하세요.

[CORE-Bench-Hard · 재현성 평가 보고서](https://aipoch.com/blog/aipoch-open-science-core-bench-hard)

</details>

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

## 개발자 가이드

- **개발** · [소스 빌드 및 패키징](../development-quick-reference.md) · [기여하기](../../CONTRIBUTING.md)
- **Open-Science 실행** · [독립 실행 환경](../standalone-runtime.md) · [서비스 수명 주기](../../packages/open-science/CLI.md#service-lifecycle) · [모바일 기기 페어링](https://aipoch.com/docs/guides/remote-access/#mobile-pairing)
- **자동화** · [CLI](../../packages/open-science/CLI.md) · [Node.js SDK](../../packages/open-science/README.md) · [MCP 클라이언트 연결](../../packages/open-science/CLI.md#external-agents-through-mcp)

## 자주 묻는 질문

<a id="모델-연결-테스트가-실패하는-이유는-무엇인가요"></a>

<details>
<summary>모델 연결 테스트가 실패하는 이유는 무엇인가요?</summary>

답변: API Key에 빠진 문자나 공백이 없는지, Base URL과 지역이 올바른지, 제공업체의 정확한 모델 ID를 사용했는지 확인하고 네트워크 연결과 계정 잔액도 확인하세요. Claude 구독은 선택한 모드에 따라 공유 브라우저 로그인을 다시 시도하거나 격리된 `claude setup-token` 자격 증명을 갱신하세요.

</details>

<a id="설정-중-continue가-비활성화되는-이유는-무엇인가요"></a>

<details>
<summary>설정 중 <code>Continue</code>가 비활성화되는 이유는 무엇인가요?</summary>

답변: 현재 단계의 필수 조건이 충족되지 않았습니다. 해당 단계에 따라 `Action needed` 환경 항목을 해결하거나, 선택한 에이전트 런타임을 설치 또는 복구하거나, 모델 제공업체를 검증하세요. Notebook 설정은 선택 사항이며 Notebook 실행에만 영향을 줍니다.

</details>

<a id="원격-hpc-클러스터에서-작업을-실행하려면-어떻게-하나요"></a>

<details>
<summary>원격 HPC 클러스터에서 작업을 실행하려면 어떻게 하나요?</summary>

답변: **Remote Compute (SSH)**는 항상 활성화되어 있으며 Settings에서 따로 활성화할 필요가 없습니다. **Settings → Connections → Compute**에서 SSH 컴퓨팅 호스트를 등록하고 현재 세션에서 사용할 수 있게 한 다음 자연어 또는 `/remote-compute-ssh`로 원격 컴퓨팅을 사용하세요. 연결 가능한 SSH 호스트, 유효한 인증, 필요한 디렉터리 권한과 작업에 필요한 소프트웨어, 종속성, 컴퓨팅 리소스가 필요합니다. Direct SSH에는 스케줄러가 필요하지 않지만 Slurm 모드에는 사용 가능한 Slurm 환경과 작업 제출 권한이 필요합니다. “항상 활성화”는 Skill 자체를 뜻하며 등록된 모든 호스트가 항상 사용 가능하다는 뜻은 아닙니다.

직접 연결한 Kubernetes, Hugging Face Jobs, Modal, Ray 대상도 지원합니다. 외부 제출마다 대상, 명령, 리소스 및 출력을 승인합니다. 복구 기록을 통해 재시작 후 결과 수집을 재개하며 게시된 결과는 Compute Preview에서 엽니다. 계정, 소프트웨어, 리소스 및 권한은 직접 준비해야 하며 클라우드 작업에는 요금이 발생할 수 있습니다.

</details>

<a id="명령줄-인터페이스가-있나요"></a>

<details>
<summary>명령줄 인터페이스가 있나요?</summary>

답변: 있습니다. 독립형 CLI를 설치하거나 **Settings → General → Command line tool → Install command**를 사용하여 이미 실행 중인 데스크톱 인스턴스를 제어할 수 있습니다. npm 설치에는 Node.js가 필요하며, Homebrew와 런타임이 포함된 독립형 패키지에는 Node.js가 포함되어 있습니다. 로컬 프로필을 초기화한 다음 브라우저를 열지 않고 서비스를 제어하고 연구 작업을 제출하세요:

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

</details>

<a id="생성된-결과의-출처를-확인하려면-어떻게-하나요"></a>

<details>
<summary>생성된 결과의 출처를 확인하려면 어떻게 하나요?</summary>

답변: 생성된 아티팩트를 열고 **Provenance**를 선택하세요. 버전을 선택하여 콘텐츠 ID와 사용 가능한 생성 코드, 실행 기록, 입력, 환경 인벤토리, 생성 대화 컨텍스트, 리뷰 증거를 확인합니다. AIPOCH Open-Science가 검증할 수 없는 증거는 사용할 수 없음으로 표시됩니다.

</details>

<a id="이후-대화를-잃지-않고-이전-요청을-수정할-수-있나요"></a>

<details>
<summary>이후 대화를 잃지 않고 이전 요청을 수정할 수 있나요?</summary>

답변: 가능합니다. 완료된 사용자 메시지를 편집해 다시 보내면 해당 지점에서 새 브랜치가 생성됩니다. 원래 후속 턴은 계속 사용할 수 있고, 메시지 옆의 수정 화살표로 대체 경로를 전환합니다.

</details>

## 기여자

코드, 문서, 번역, 버그 보고 및 커뮤니티 지원을 통해 AIPOCH Open-Science에 기여해 주시는 모든 분께 감사드립니다.

[GitHub 기여자 보기](https://github.com/aipoch/open-science/graphs/contributors)

[![AIPOCH Open-Science 기여자](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## 참여하기

버그 신고, 기능 제안, 질문 또는 기여로 AIPOCH Open-Science 개선에 참여하세요. 아래에서 목적에 맞는 채널을 선택해 시작할 수 있습니다.

| 채널                                                                     | 용도                                       |
| ------------------------------------------------------------------------ | ------------------------------------------ |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | 버그, 재현 가능한 오류, 구체적인 기능 제안 |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 설계 질문, 로드맵 제안, 긴 기술 토론       |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | 커뮤니티 지원, 기여자 조율, 비공식 토론    |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | 릴리스 발표 및 공개 개발 업데이트          |
| [AIPOCH Open-Science 공식 웹사이트](https://aipoch.com/open-science)     | 공식 제품 개요 및 다운로드                 |

공개 이슈를 만들기 전에 로그와 스크린샷에서 API Key, 토큰, 비공개 파일 경로, 미공개 데이터, 환자 식별자 및 기타 민감한 정보를 제거하세요. 개발 워크플로는 [기여 가이드](../../CONTRIBUTING.md)를 참고하세요.

> AIPOCH Open-Science가 유용하다면 GitHub 저장소에 Star를 남겨 주세요.

제공 중인 기능, 부분 구현 및 계획은 [기능 지도](../ROADMAP.md#capability-map)를 확인하세요.

<a id="aipoch-open-science-논문-및-인용"></a>

## 인용

연구에 AIPOCH Open-Science를 사용했다면 [AIPOCH Open-Science 프리프린트](https://arxiv.org/abs/2610.17110)를 인용해 주세요.

<details>
<summary>BibTeX 인용</summary>

```bibtex
@misc{ouyang2026aipochopenscienceopensourceai,
      title={AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages},
      author={Wen Ouyang and Bocheng Huang and Qianyu Yao and Fei Sun and Minying Deng and Haoyue Cheng and Wenwen Zhou and Lei Mou and Yusi Wei and Jiang Li and Kun Zhu and Lei Wang and Yi Feng and Jiaheng Dai and Ke Qian and Dan Wang and Yahui Wang and Chenyi Wang and Mingsheng Lyu and Yaqiang Zhang and Ping Zheng and Chunhua Tang and Xinge Ma and Xu Zhang and Youjia Fan and Can Lu and Zhijun Dai and Man Hu and Qiqi Xie and Beinan Liu and Yuanning Guo and Yunze Liu and Jinhong Jiang and Xianjun Fu and Mingwei Zhang and Yuanji Xu and Shilin Xia and Bowen Yang and Mingjun Yu and Jingdun Xie and Xuwei Chen and Xia Zou and Yuzhou Xue and Jianguo Zhou and Chunhao Cao and Donghao Tian and Lei Huang and Jinxiao Li and Shengrong Long and Zefeng Song and Honglin Li and Jiang Luo and Wenying Jiang and Shanshan Li and Lei Dai and Ning Jiang and Ying Cai and Chaohui Li and Chunyan Peng and Hetong Zhao and Angqing Li and Chunyan Yang and Chongyang Sun and Yong Li and Xinyu Shi and Wei Dai and Ming Peng and Chen Sang and Yuanyuan Han and Desong Qiu and Haixin Miao and Jian Xu and Yi Chen and Xiaoliang Shi and Tian Shen and Teng Hu and Shuhao Wang and Yingyong Hou and Huimei Wang},
      year={2026},
      eprint={2610.17110},
      archivePrefix={arXiv},
      primaryClass={cs.SE},
      url={https://arxiv.org/abs/2610.17110},
}
```

</details>

## 라이선스

Apache License 2.0 — [LICENSE](../../LICENSE)를 참고하세요.
