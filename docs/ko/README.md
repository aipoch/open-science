<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  재현 가능한 과학을 위한 AI 연구 워크벤치 — 오픈 소스, 로컬 우선, 모델 독립형.
</p>

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

[AIPOCH Open-Science](https://aipoch.com/open-science)는 오픈 소스 AI 연구 워크벤치입니다. 질문 하나, 논문 한 편, 데이터 파일 하나로 시작할 수 있습니다. 알고 싶은 내용을 자신의 말로 설명하고 AI 에이전트와 함께 근거를 살펴보거나 데이터를 분석하거나 차트를 만들어 보세요.

결과가 어떻게 나왔는지 궁금하다면 기록된 입력, 코드, 실행 이력을 확인하세요. 작업 내용을 공유하려면 대화 분기, 파일 버전, Notebook 기록, 검증 근거 중 포함할 항목을 선택해 `.science` 패키지로 내보내세요.

### 💡 AIPOCH Open-Science v1.2.0 업데이트

_2026년 11월 9일_

- **원격 컴퓨팅**: SSH, Slurm 외에 직접 연결한 Kubernetes, Hugging Face Jobs, Modal, Ray에서 작업을 실행합니다. 작업별 승인과 재시작 후 결과 수집 재개를 지원합니다.
- **내장 에이전트**: 독립 실행형 Open-Science Agent가 새 설정의 기본값입니다. Claude Code, OpenCode, Codex, CodeBuddy, Pi도 계속 선택할 수 있습니다.
- **빠른 macOS 업데이트**: 앱 이미지의 변경된 블록만 다운로드하고 필요하면 자동으로 전체 다운로드로 전환합니다.
- **단계별 토론**: 가져온 `.science` 연구나 재생 단계에서 질문하면 해당 단계에 연결된 하위 대화가 열립니다. 가져온 기록은 읽기 전용으로 유지됩니다.
- **출처 미리보기**: 출처 링크에 마우스를 올리면 대상 도메인이 표시되며, 승인된 HTTPS 출처는 제목과 설명도 보여줍니다.
- **작업 공간 개선**: 간소화된 사이드바와 강조된 ‘Fork to continue’ 동작을 제공합니다. 이전 턴에서 전송해도 읽던 위치가 유지됩니다.
- **안정성 개선**: macOS 업데이트는 실행 중인 앱을 확인하고, Windows는 파일 점유 주체를 표시하며 작업 표시줄이 입력 영역을 가리지 않도록 합니다. 고정 레이아웃 PDF 번역은 한 페이지가 실패해도 성공한 페이지를 유지합니다.

[v1.2.0 전체 릴리스 노트 보기](https://github.com/aipoch/open-science/releases/tag/v1.2.0)

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science 히어로 배너: Science, Open to All — 오픈 소스, 모델 독립적, 자체 호스팅 가능한 과학 AI 연구 워크벤치" src="../images/readme/open-science-banner.png" />
</p>

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

설정 안내에 따라 **환경 → 데이터 위치 → 에이전트 런타임 → 모델 제공업체 → Notebook 런타임** 순서로 진행하세요.

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

## AIPOCH Open-Science `.science` 연구 패키지

완료된 연구 세션을 검토, 인계 및 보관에 사용할 수 있는 이동 가능한 `.science` 패키지로 내보낼 수 있습니다. 연구 기록과 함께 포함할 대화 분기, 파일 버전, Notebook 기록 및 검증 증거를 선택한 다음 다른 프로젝트나 컴퓨터로 가져오세요.

내보내기와 가져오기는 데스크톱 앱, 로컬 Web 세션 및 헤드리스 CLI에서 사용할 수 있습니다. 원격 Web 세션은 임의의 로컬 패키지 경로를 읽거나 쓸 수 없습니다.

**내보내기 → 전송 → 검토**

1. 완료된 세션을 내보내고 포함할 내용을 선택합니다.
2. `.science` 파일을 협업자나 다른 컴퓨터로 전송합니다.
3. 프로젝트로 가져옵니다. 오른쪽 **Research replay**에서 기록된 과정을 확인하고 왼쪽 대화에서 질문하며 고정 단계를 참조할 수 있습니다.

가져온 기록은 읽기 전용입니다. 재생은 코드 실행, 모델 호출 또는 자격 증명 복원을 수행하지 않습니다. 첫 질문은 연결된 쓰기 가능한 대화를 만듭니다. **Fork to continue**로 작업 사본을 만들어 연구를 계속할 수 있습니다. 재실행에는 완전한 레시피, 필요한 입력과 사용 가능한 실행 환경이 필요합니다.

가져온 연구나 재생 단계의 질문은 가져온 기록을 변경하지 않고 해당 단계에 연결된 하위 토론을 엽니다. 보관 후에도 유지되며 부모 세션을 삭제하면 일반 대화가 됩니다.

Side Chat 대화, 비공개 읽기 북마크와 자격 증명은 제외되며, 포함 파일은 내보내기 선택에 따라 달라집니다. 받은 검증 기록은 발신자의 검사 결과이며 이 컴퓨터에서 다시 실행했음을 증명하지 않습니다. [`.science` 패키지 가이드](https://aipoch.com/docs/guides/research-packages/)를 참고하세요.

<a id="벤치마크-성능"></a>

## 벤치마크 결과

AIPOCH는 논문 찾기부터 논문 내용에 대한 답변, 연구 계획 실행까지 다양한 작업에서 AIPOCH Open-Science를 평가했습니다. 아래 결과는 AIPOCH가 직접 실행한 평가에서 얻었으며, 각 점수는 특정 작업과 평가 설정에 해당합니다. 계산 결과 재현과 데이터 기반 가설 발견도 평가했습니다.

| 작업                        | AIPOCH Open-Science의 결과                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 목표 논문 찾기              | LitQA2-FullText-Search의 **테스트 75문항 중 68문항**에서 목표 논문이 상위 30개 결과에 포함되었습니다(**Recall@30 90.67%**, gpt-6-astra).               |
| 문헌을 바탕으로 답변하기    | 별도의 LitQA2-FullText 평가에서 Open-Science는 **75문항 중 70문항에 정답**을 제시했습니다(**정확도 93.33%**, deepseek-flash, Max 추론).                |
| 인용을 포함한 답변 종합하기 | ScholarQA-CS2 검증 100문항에서 deepseek-v4-flash로 **종합 품질 점수 0.9289/1**을 기록했습니다. 공식 테스트 참고 결과는 다른 문항을 사용합니다.         |
| 연구 워크플로 실행하기      | 동일 모델을 사용한 로컬 ASI-Bench 평가에서 B4 점수는 Open-Science **59.46**, Codex **55.45**였습니다. B2 점수는 거의 같았습니다(**56.11**, **56.09**). |
| 생의학 데이터 분석하기      | BiomniBench-DA Public 50에서 두 평가 모델의 점수는 **81.04**, **77.06**이었으며 동일 가중치 평균은 **79.05**였습니다.                                  |
| 발표된 결과 재현            | CORE-Bench-Hard — 로컬 평가에서 테스트 과제 37개 중 36개 정답(97.30%). 최종 집계에는 재시험이 포함됩니다.                                              |
| 데이터에서 가설 발견        | DiscoveryBench — 검증 세트에서 선택한 25개 과제의 로컬 모델 평가 평균은 0.7467/1입니다.                                                                |

### AstaBench — 문헌 작업

<details>
<summary><strong>논문 검색 — 75문항 중 68문항에서 목표 논문 발견</strong></summary>

AIPOCH는 공식 LitQA2-FullText-Search Test 분할의 75문항을 로컬에서 실행했습니다. Recall@30은 2026년 10월 26일 비교 스냅샷의 최고값과 같았습니다. 이 로컬 실행은 공식 순위표 제출이나 등재 순위를 의미하지 않습니다.

![AIPOCH Open-Science LitQA2 검색 비교: 공식 Test 분할의 로컬 Recall@30 90.67%](../images/readme/astabench-litqa2-test.jpg)

Recall@30은 목표 논문이 상위 30개 결과에 포함되면 적중으로 집계하며, 답변 정확도를 측정하지 않습니다. 실행 간 비용 산정 방식은 통일되지 않았습니다.

</details>

<details>
<summary><strong>전문 기반 질의응답 — 75문항 중 70문항 정답</strong></summary>

AIPOCH는 AstaBench v0.5.4의 LitQA2-FullText Test 분할 75문항을 실행했습니다. 차트는 로컬 결과와 과거 참고 기록을 점수순으로 배치하며, “#1”은 이 비교 안에서의 순서를 뜻합니다.

![AIPOCH Open-Science LitQA2 전문 질의응답 비교: 로컬 정확도 93.33%](../images/readme/astabench-litqa2-fulltext-local-comparison.png)

정확도는 올바른 답변의 비율입니다. 여기서 93.33%는 로컬 답변 정확도, 90.67%는 과거 참고 답변 정확도로, 위 검색 차트와는 지표가 다릅니다. 참고 기록은 2026년 10월 28일에 수집했고, 최고 참고 점수는 11월 2일에 다시 확인했습니다.

</details>

<details>
<summary><strong>인용 답변 품질 — 로컬 검증 결과와 공식 테스트 참고값</strong></summary>

로컬 ScholarQA-CS2 결과는 Validation 100문항의 인용 답변 품질을 측정합니다. 참고 결과는 Test 분할에서 나왔으므로 이 점수들로 직접 대결 순위를 정할 수 없습니다.

![AIPOCH Open-Science ScholarQA-CS2 비교: 로컬 Validation 종합 점수 0.9289와 공식 Test 참고 결과를 구분해 표시](../images/readme/astabench-scholarqa-cs2.jpg)

종합 점수는 0–1 척도이며, 완전히 맞힌 문항의 백분율이 아닙니다.

</details>

### AstaBench — 계산 결과 재현 및 가설 발견

<details>
<summary><strong>CORE-Bench-Hard — 36/37</strong></summary>

11월 6일 평가에서 DeepSeek Flash(Max 추론)는 논문의 코드, 데이터와 README로 결과를 재현했습니다. 공식 자동 채점기를 로컬에서 실행해 필수 답이 모두 맞을 때만 1점을 부여했습니다. 37개 모두 채점했으며 최종 집계에는 재시험이 포함됩니다. [AIPOCH](https://aipoch.com/blog/aipoch-open-science-core-bench-hard).

</details>

<details>
<summary><strong>DiscoveryBench — 0.7467/1</strong></summary>

11월 9일 평가에서는 deepseek-v4-flash로 가설을 생성하고 같은 모델로 로컬에서 구현한 평가 절차에 따라 채점했습니다. 25개 중 18개가 만점, 2개가 부분 점수, 5개가 0점이었습니다. 공식 전체 테스트와 문제 및 채점 모델이 달라 점수로 순위를 비교할 수 없습니다.

</details>

### ASI-Bench — 계획 실행과 방법 선택

네 조건은 지정된 계획 실행(B1), 워크플로 구성(B2), 연구 방법 선택(B3), 방해 정보가 있는 상황에서의 연구(B4)를 요구합니다. 차트의 처음 두 행은 동일한 GPT-6 Astra 모델을 사용한 로컬 실행을 비교합니다.

![AIPOCH Open-Science ASI-Bench B1–B4 결과와 로컬 Codex 실행 및 공개 참고 결과](../images/readme/asi-bench-b1-b4.jpg)

Open-Science의 B1–B4 점수는 **79.35, 56.11, 59.67, 59.46**이며, 로컬 Codex 참고 점수는 **74.78, 56.09, 58.12, 55.45**입니다. B2 점수는 거의 같았습니다. 다른 공개 실행은 작업 사례, 설정 또는 평가 방식이 다릅니다.

로컬 B1은 채점기 문제로 작업 하나를 제외한 뒤 59개 작업을 포함합니다. B1/B2는 로컬에서 세 번 반복한 것으로 보고되었습니다. B3/B4는 Open-Science v0.32.0과 대체 평가 모델을 사용했으며, 각 점수는 60개 작업을 세 번 실행한 평균입니다.

### BiomniBench-DA — 생의학 데이터 분석

Public 50 작업 세트에서 Gemini 3.1 Pro 평가 모델은 출력에 **81.04**, DeepSeek v4-pro 평가 모델은 **77.06**을 부여했습니다. AIPOCH는 gpt-5.6-sol(xhigh) 설정의 동일 가중치 평균 **79.05**를 보고합니다.

<details>
<summary><strong>평가 점수와 과거 참고값 — 평가 모델 적용 범위가 다름</strong></summary>

차트에는 평가 모델의 적용 범위가 다른 기록이 함께 들어 있습니다. “#1”은 이 기록 모음의 정렬 순서입니다. 공통 평가 절차에 따른 순위를 정하려면 모든 기록에 비교 가능한 채점 방식이 필요합니다.

![AIPOCH Open-Science BiomniBench-DA Public 50 비교: 두 평가 모델의 점수와 평균](../images/readme/biomnibench-public50-leaderboard.png)

79.05는 이 내부 평가의 평균 평가 점수입니다.

</details>

**평가 범위:** 보고서는 명시된 모델과 데이터 분할을 사용한 2026년 8월부터 11월까지의 로컬·내부 실행을 다루며, 현재 릴리스를 위해 다시 실행한 결과가 아닙니다. 참고 점수는 과거 스냅샷으로 실시간 순위가 아닙니다. 서로 다른 벤치마크 계열의 점수는 직접 비교할 수 없으며 수치 차이가 통계적 유의성을 입증하지 않습니다.

자세한 평가 내용은 [AstaBench 및 ASI-Bench 보고서](https://aipoch.com/benchmark/open-science)와 [BiomniBench-DA 보고서](https://aipoch.com/blog/open-science-biomnibench-da)를 참고하세요.

<a id="핵심-기능"></a>

## AIPOCH Open-Science를 사용하는 이유

1. **한 프로젝트에서 논문을 읽고 데이터를 분석하세요.**
   - Zotero에서 문헌을 가져오거나 식별자 또는 논문 링크를 한 번에 최대 100개까지 붙여 넣을 수 있습니다. 선별 모델을 설정하면 포함·제외 기준에 따라 문헌을 선별하고, 모델과 자신의 판단을 비교한 다음 PDF에서 원문을 확인할 수 있습니다.
   - 논문과 함께 과학 데이터, 문서, 이미지, 분자 구조를 미리 볼 수 있습니다. 노트북에서 Python이나 R을 실행해 프로젝트 데이터로 표나 그림을 만들고 원본 파일과 대조하세요.

2. **결과가 나온 과정과 답변의 근거를 확인하세요.**
   - **Provenance**에서 그림, 표 또는 보고서의 특정 버전을 열어 이용 가능한 입력, 코드, 실행 기록을 확인하세요. 입력, 실행 절차, 실행 환경이 갖춰져 있으면 데스크톱 앱에서 해당 버전을 다시 실행해 출력을 비교할 수 있습니다.
   - **Reviewer**를 켜면 해당 차례의 실행 로그와 파일을 바탕으로 에이전트의 답변을 별도로 점검합니다. 지적한 문제와 에이전트가 수정한 뒤의 재검토 결과를 확인할 수 있습니다.

3. **결과와 그 배경을 동료에게 전달하세요.**
   - 대화 분기, 파일 버전, Notebook 기록, 검증 근거를 선택해 `.science` 패키지에 담으세요. 동료는 다른 컴퓨터에서 패키지를 열고 그림이나 표를 만든 과정을 살펴볼 수 있습니다.
   - 가져온 기록은 읽기 전용이며 가져오기 과정에서 코드가 실행되거나 자격 증명이 복원되지 않습니다. 검증 기록은 보낸 사람의 컴퓨터에서 점검한 내용을 보여 줍니다. 동료는 **Fork to continue**를 선택해 편집 가능한 사본에서 후속 질문을 탐구할 수 있습니다.

4. **분석에 맞는 도구와 컴퓨팅 자원을 선택하세요.**
   - 모델 제공업체를 선택하고 **내장 커넥터 48개**를 통해 과학 데이터 소스에 접근할 수 있습니다. 일부 커넥터는 먼저 활성화해야 합니다.
   - 반복 작업에는 **내장 스킬 24개**를 사용할 수 있으며 [스킬 마켓플레이스](https://github.com/aipoch/openscience-skill-marketplace)에서 **스킬 525개**를 골라 설치할 수 있습니다. 작업 일부를 위임하려면 [전문가 마켓플레이스](https://github.com/aipoch/openscience-specialist-marketplace)의 **전문가 10개** 가운데 선택하세요.
   - 로컬에서 분석을 실행하거나 SSH, Slurm, Kubernetes, Hugging Face Jobs, Modal 또는 Ray를 통해 직접 관리하는 환경에 작업을 제출하세요. 원격 작업을 승인하기 전에 대상, 명령, 자원, 출력을 확인하세요. 클라우드 작업에는 연결된 계정으로 요금이 청구될 수 있습니다.

## 모델 제공업체

AIPOCH Open-Science는 제품 수준에서 특정 모델에 종속되지 않습니다. 주요 클라우드 LLM 제공업체 또는 사용자 지정 게이트웨이에 연결하거나 기존 Claude 또는 Codex 구독을 재사용할 수 있습니다. 현재 제공업체 사용 가능 여부는 선택한 에이전트 백엔드와 지원 API 프로토콜에 따라 달라집니다. 다음 연결 옵션을 사용할 수 있습니다.

| 제공업체 모드              | 작동 방식                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **기본 클라우드 제공업체** | 설치된 앱에 표시된 제공업체 목록에서 선택하고 요청된 키로 인증합니다.                                                                                                                                                                                                                                                                                                                                                                     |
| **사용자 지정 게이트웨이** | Base URL과 정확한 모델 ID를 입력하고 선택한 에이전트 백엔드가 지원하는 API 프로토콜(Messages, Chat Completions 또는 Responses)을 지정한 뒤 연결을 테스트하세요. 원격 게이트웨이는 HTTPS와 API Key가 필요합니다. `localhost`, `127.0.0.1`, `[::1]` 같은 루프백 엔드포인트는 HTTP를 사용하고 키를 생략할 수 있습니다. Ollama, LM Studio, llama.cpp, vLLM 프리셋을 제공합니다. 기본 API 형식만으로 서버나 모델 호환성이 보장되지는 않습니다. |
| **Codex 구독**             | Open-Science Agent 또는 Codex를 선택한 다음 제공업체 유형에서 Codex 구독을 선택합니다. 기존 Codex 로그인을 가져오거나 Open-Science로 로그인합니다.                                                                                                                                                                                                                                                                                        |
| **Claude 구독**            | 두 가지 모드로 로그인합니다. **공유** 모드는 브라우저 로그인 자격 증명을 기본 `~/.claude` 프로필에 저장합니다. **격리** 모드는 앱 소유 `CLAUDE_CONFIG_DIR`에서 `claude setup-token`을 실행하여 `~/.claude/`와 완전히 분리하고 브라우저 흐름과 토큰 붙여넣기 폴백을 제공합니다.                                                                                                                                                            |
| **xAI (Grok) OAuth**       | 내장 xAI (Grok) OAuth 기기 로그인을 사용합니다. 이용 가능 여부는 xAI 계정과 선택한 백엔드의 프로토콜 지원에 따라 달라지므로 앱에서 연결을 검증하세요.                                                                                                                                                                                                                                                                                     |

사전 설정된 25개의 프로바이더 옵션이 있으며, OpenAI, Anthropic, DeepSeek, NVIDIA Build 등이 있습니다. 모델과 지역별 엔드포인트는 설치 버전 및 선택한 백엔드에 따라 달라지므로 앱의 제공업체 선택기와 연결 테스트로 확인하세요.

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

AIPOCH Open-Science는 일반 Node 백엔드와 Electron 데스크톱 클라이언트로 구성되며 React, TypeScript, Prisma/SQLite 및 내장 Open-Science Agent와 선택적 에이전트 백엔드를 사용합니다.

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

빌드 명령 및 개발 절차는 [개발 명령과 패키징 참고](development-quick-reference.md) 및 [기여 가이드](../../CONTRIBUTING.md)를 확인하세요.

### Localhost 웹 및 헤드리스 모드

웹 UI는 일반 Node 백엔드에서 실행되며 Electron이나 그래픽 화면이 필요하지 않습니다.

```bash
npm run dev:web
npm run pack:backend
```

웹 UI는 일반 Node 백엔드에서 실행되며 Electron이나 그래픽 화면이 필요하지 않습니다. `npm run dev:web`와 `npm run dev:headless`는 백엔드와 웹 UI를 빌드하고 실행하며 데스크톱이나 트레이를 시작하지 않습니다. `OPEN_SCIENCE_WEB_PORT`로 포트를 선택합니다(기본값 `44100`). Ctrl+C는 전경 서비스를 정상 종료합니다.

소스 개발에는 Node.js 24가 필요합니다. 배포된 npm 패키지와 로컬에서 빌드한 독립 tarball에는 Node.js >=22.13.0이 필요합니다. Release 압축 파일, Homebrew Formula, 데스크톱 명령 실행기는 런타임을 포함합니다.

데스크톱 앱과 브라우저는 같은 서비스를 공유합니다. 앱 연결과 `open-science start`의 명시적 실행 유지 요청이 서비스를 계속 실행하게 합니다. 마지막 앱을 종료하면 명시적 유지 요청이 남아 있지 않은 경우에만 서비스가 중지됩니다.

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### 모바일 원격 액세스

QR 코드를 스캔하면 로컬 WiFi 또는 Pinggy 터널을 통해 현재 작업 공간을 휴대폰이나 태블릿에서 열 수 있습니다. WiFi 페어링은 로컬 네트워크 안에서 연결되며, 인터넷 터널의 트래픽은 Pinggy 서버를 거칩니다. 연결 대화 상자에 이 중계 경로가 안내됩니다.

### 헤드리스 CLI 및 SDK

헤드리스 CLI와 종속성이 없는 Node.js SDK는 데스크톱 및 웹 인터페이스와 같은 로컬 데몬, 프로젝트, 세션, 자격 증명, 권한을 사용합니다. 자세한 사용법은 게시 가능 패키지와 함께 관리하므로 하나의 명령 참조만 유지합니다.

- [CLI 가이드](../../packages/open-science/CLI.md) — 설치, 서비스 수명 주기, 작업 자동화, 아티팩트, 출력 형식, 종료 코드
- [SDK 패키지 개요](../../packages/open-science/README.md) — Node.js 빠른 시작 및 패키지 진입점

독립 실행형 CLI는 `open-science mcp`를 통해 연구 도구를 외부 MCP 클라이언트에 제공할 수 있습니다. 먼저 선택한 프로필의 서비스를 시작하고 인증하세요. 어댑터는 해당 프로필의 기존 권한을 사용하며 별도의 샌드박스나 읽기 전용 보기가 아닙니다. 따라서 연결된 클라이언트가 변경 사항을 저장하고 모델 비용을 발생시킬 수 있습니다. 임의의 Shell 또는 RPC 접근, 자격 증명 관리, 파일 가져오기·내보내기, 경로 지정 다운로드, 원격 HTTP MCP 엔드포인트는 제공하지 않습니다.

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
