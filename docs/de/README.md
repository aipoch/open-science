<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  KI-Forschungsumgebung für reproduzierbare Wissenschaft — quelloffen, lokal betrieben und modellunabhängig.
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="AIPOCH Open-Science herunterladen" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Neueste Version von AIPOCH Open-Science" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="Zenodo-DOI von AIPOCH Open-Science" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="AIPOCH Open-Science Preprint auf arXiv: 2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#benchmark-ergebnisse">
    <img alt="AIPOCH Open-Science — Benchmark-Ergebnisse" src="../images/readme/benchmark-comparisons.svg">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Plattformen macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="../../LICENSE">
    <img alt="Lizenz Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="Website aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
</p>

<p align="center">
  <a href="../../README.md"><img alt="README auf Englisch" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="README auf vereinfachtem Chinesisch" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="README auf traditionellem Chinesisch" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="README auf Japanisch" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="README auf Koreanisch" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="README auf Französisch" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="README auf Russisch" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../de/README.md"><img alt="README auf Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../es/README.md"><img alt="README auf Spanisch" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> Dieses Dokument ist eine Übersetzung der englischen `README.md`. Bei Abweichungen ist die [englische Version](../../README.md) maßgeblich.

[AIPOCH Open-Science](https://aipoch.com/open-science) ist eine quelloffene Arbeitsumgebung für die Forschung mit KI. Beginnen Sie mit einer Frage, einer wissenschaftlichen Veröffentlichung oder einer Datendatei. Beschreiben Sie in eigenen Worten, was Sie herausfinden möchten, und arbeiten Sie mit einem KI-Agenten, um Belege zu sichten, Daten zu analysieren oder ein Diagramm zu erstellen.

Um nachzuvollziehen, wie ein Ergebnis zustande kam, können Sie die verfügbaren Eingabedaten, den Code und den Ausführungsverlauf einsehen. Wenn Sie Ihre Arbeit teilen möchten, wählen Sie die Gesprächszweige, Dateiversionen, Notebook-Aufzeichnungen und Prüfnachweise aus und exportieren Sie sie als `.science`-Paket.

### 💡 AIPOCH Open-Science v1.2.0 — Neuerungen

_9. November 2026_

- **Remote-Berechnungen**: Genehmigte Aufträge auf selbst angebundenen Kubernetes-, Hugging-Face-Jobs-, Modal- oder Ray-Zielen neben SSH und Slurm ausführen, mit Einzelfreigabe und fortsetzbarer Ergebnissammlung nach Neustarts.
- **Integrierter Agent**: Der eigenständige Open-Science Agent ist bei neuen Einrichtungen voreingestellt; Claude Code, OpenCode, Codex, CodeBuddy und Pi bleiben verfügbar.
- **Schnellere macOS-Updates**: Nur geänderte Blöcke des App-Abbilds herunterladen, bei Bedarf automatisch den vollständigen Download nutzen.
- **Diskussionen zu Schritten**: Fragen zu importierter `.science`-Forschung oder einem Wiedergabeschritt öffnen eine verknüpfte untergeordnete Unterhaltung; der Import bleibt schreibgeschützt.
- **Quellenvorschau**: Beim Überfahren eines Quellenlinks erscheint die Zieldomain, bei freigegebenen HTTPS-Quellen auch Titel und Beschreibung.
- **Verbesserter Arbeitsbereich**: Einfachere Seitenleiste, hervorgehobenes „Fork to continue“ und eine stabile Leseposition beim Senden aus einem früheren Gesprächsschritt.
- **Zuverlässigkeit**: macOS prüft vor Updates die laufende App; Windows nennt blockierende Dateien und hält die Eingabe oberhalb der Taskleiste. PDF-Übersetzungen mit festem Layout behalten erfolgreiche Seiten, wenn eine Seite fehlschlägt.

[Vollständige Versionshinweise v1.2.0](https://github.com/aipoch/open-science/releases/tag/v1.2.0)

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science Hero-Banner: Science, Open to All — eine quelloffene, modellunabhängige und selbst gehostete Forschungsumgebung für wissenschaftliche KI" src="../images/readme/open-science-banner.png" />
</p>

## 🚀 Schnellstart

### 1. Laden Sie die App herunter

Öffnen Sie die [offizielle Download-Seite](https://aipoch.com/open-science/download) und wählen Sie das passende Installationspaket aus:

| Ihr Computer                              | Wählen Sie                                            |
| ----------------------------------------- | ----------------------------------------------------- |
| macOS 12+ – Apple Silicon (M1 oder neuer) | Das macOS DMG für Apple Silicon / ARM64               |
| macOS 12+ – Intel                         | Das macOS DMG für Intel / x64                         |
| Windows 10/11 x64                         | Das Windows x64-Installationsprogramm (code-signiert) |
| Linux x64                                 | Das Linux x64 AppImage- oder Debian-Paket             |
| Linux ARM64                               | Linux ARM64 AppImage- oder Debian-Paket               |

Hinweise zu Prüfungen vor der Installation finden Sie unter [Download überprüfen](../../SECURITY.md#verifying-your-download).

Die eigenständigen CLI-Archive für macOS, Linux und Windows enthalten Node.js und lassen sich ohne Homebrew oder npm verwenden.

Unter macOS können Sie die App auch mit [Homebrew](https://brew.sh) installieren:

```bash
brew install --cask open-science
```

Für die eigenständige CLI unter macOS oder Linux verwenden Sie den separaten [AIPOCH-Tap](https://github.com/aipoch/homebrew-tap):

```bash
brew install aipoch/tap/open-science
```

Die Formula enthält Node und benötigt keine laufende Desktop-App; ihre Version kann vom Desktop-Cask abweichen. Voraussetzungen und Upgrades stehen im [Leitfaden zur eigenständigen Laufzeit](../standalone-runtime.md).

Für die eigenständige CLI und Web-Oberfläche installieren Sie das veröffentlichte [npm-Paket](https://www.npmjs.com/package/@aipoch/open-science) mit **Node.js 22.13.0 oder neuer**:

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

Öffnen Sie die ausgegebene URL, um die Einrichtung abzuschließen, oder folgen Sie der [Terminal-Einrichtungsanleitung](../../packages/open-science/CLI.md#first-run-setup-codex). npm unterstützt macOS ARM64/x64, glibc-Linux ARM64/x64 und Windows x64; die Desktop-App ist nicht erforderlich. Lassen Sie optionale npm-Abhängigkeiten aktiviert und beachten Sie die [Linux-Voraussetzungen und Aktualisierungshinweise](../standalone-runtime.md#install-from-npm). Die URL enthält ein Authentifizierungstoken; halten Sie sie geheim.

Unter Windows bleiben Forschungsdaten bei einer Neuinstallation erhalten. Für eine vollständige Bereinigung nutzen Sie das [Werkzeug zum Zurücksetzen](../../scripts/windows-reset/README.md), das lokale Daten nach Bestätigung dauerhaft löscht.

### 2. Schließen Sie die Ersteinrichtung ab

Folgen Sie dem Einrichtungsassistenten: **Umgebung → Datenspeicherort → Agent-Runtime → Modellanbieter → Notebook-Runtime**.

Schließen Sie die erforderlichen Prüfungen für Umgebung und Agent-Runtime ab und testen Sie die Modellverbindung. Python/R Notebook ist optional; Notebook und Datenspeicherort lassen sich später in den Einstellungen ändern.

Darstellung und Benachrichtigungen finden Sie in den Systemeinstellungen. Unter **Allgemein** finden Sie die Anleitung zur manuellen Installation und Aktualisierung.

Der bisherige Einstellungsreiter „Modell“ heißt jetzt **Lokale Funktionen** und umfasst PDF-Extraktion, OCR-Sprachpakete und Forschungsnarration. Die Sprachausgabe benötigt ein lokal installiertes Sprachmodell.

<table>
<tr>
<td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="Automatische Umgebungsprüfungen beim ersten Start in AIPOCH Open-Science"></td>
<td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="Erstausführung der Modellanbieterkonfiguration in AIPOCH Open-Science"></td>
</tr>
<tr>
<td align="center"><sub>Hostkompatibilitäts-, Speicher- und Netzwerkprüfungen</sub></td>
<td align="center"><sub>Anbieter, API-Schlüssel, Endpunkt und Modellvalidierung</sub></td>
</tr>
</table>

### 3. Starten Sie ein Forschungsprojekt

1. Klicken Sie auf **Neues Projekt**, öffnen Sie eine Sitzung und beschreiben Sie Forschungsziel, Eingaben und gewünschte Ergebnisse.
2. Hängen Sie Dateien an, wählen Sie Modell und Freigabeprofil und senden Sie die Aufgabe. Mit `@` verweisen Sie auf Projektdateien, mit `/` wählen Sie eine Fähigkeit.
3. Prüfen Sie Werkzeugaktivitäten und Freigabeanfragen, betrachten Sie die Ergebnisse und die verfügbaren Belege in der **Provenienzansicht**.

> Screenshots in dieser README-Datei veranschaulichen den Arbeitsablauf. Beschriftungen, Kataloge und andere Schnittstellendetails können von der von Ihnen installierten Version abweichen.

## AIPOCH Open-Science `.science`-Forschungspakete

Exportieren Sie eine abgeschlossene Forschungssitzung als portables `.science`-Paket zur Prüfung, Übergabe und Archivierung. Wählen Sie die Gesprächsverzweigungen, Dateiversionen, Notebook-Aufzeichnungen und Verifikationsevidenz aus, die enthalten sein sollen, und importieren Sie das Paket anschließend in ein anderes Projekt oder auf einen anderen Rechner.

Export und Import sind in der Desktop-App, in lokalen Web-Sitzungen und über die headless CLI verfügbar. Entfernte Web-Sitzungen können keine beliebigen lokalen Paketpfade lesen oder schreiben.

**Exportieren → übertragen → prüfen**

1. Exportieren Sie eine abgeschlossene Sitzung und wählen Sie die einzuschließenden Inhalte aus.
2. Übertragen Sie die `.science`-Datei an eine mitwirkende Person oder auf einen anderen Rechner.
3. Importieren Sie die Datei in ein Projekt. Rechts zeigt **Research replay** den aufgezeichneten Ablauf; links können Sie Fragen stellen und auf feste Schritte verweisen.

Importierte Aufzeichnungen bleiben schreibgeschützt; die Wiedergabe führt weder Code noch Modellaufrufe aus und stellt keine Anmeldeinformationen wieder her. Die erste Frage erstellt eine zugehörige beschreibbare Diskussion. Mit **Fork to continue** erstellen Sie eine Arbeitskopie. Eine erneute Ausführung benötigt weiterhin ein vollständiges Rezept, notwendige Eingaben und eine verfügbare Laufzeit.

Fragen aus importierter Forschung oder einem Wiedergabeschritt öffnen schrittgebundene untergeordnete Diskussionen, ohne den Import zu ändern. Sie bleiben beim Archivieren erhalten; beim Löschen der übergeordneten Sitzung werden sie zu gewöhnlichen Unterhaltungen.

Side Chats, private Lesezeichen und Anmeldeinformationen sind ausgeschlossen; enthaltene Dateien hängen von der Exportauswahl ab. Empfangene Prüfprotokolle beschreiben die Prüfungen des Absenders, keinen erneuten Lauf auf diesem Computer. Siehe die [Anleitung für `.science`-Pakete](https://aipoch.com/docs/guides/research-packages/).

## Benchmark-Ergebnisse

AIPOCH hat AIPOCH Open-Science bei Aufgaben vom Auffinden einer Publikation über Fragen zu ihrem Inhalt bis zur Ausführung eines Forschungsplans bewertet. Die folgenden Ergebnisse stammen aus eigenen Testläufen von AIPOCH. Jeder Wert bezieht sich auf eine bestimmte Aufgabe und Bewertungskonfiguration. Die Evaluation umfasst auch die Reproduktion von Rechenergebnissen und die Ableitung von Hypothesen aus Daten.

| Aufgabe                                  | Ergebnis von AIPOCH Open-Science                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zielpublikation finden                   | Bei **68 von 75 Testfragen** erschien die Zielpublikation unter den ersten 30 Ergebnissen von LitQA2-FullText-Search (**90.67% Recall@30**, gpt-6-astra).                                                 |
| Fragen anhand der Literatur beantworten  | In einem separaten LitQA2-FullText-Lauf beantwortete Open-Science **70 von 75 Testfragen richtig** (**93.33% Genauigkeit**, deepseek-flash mit Max-Reasoning).                                            |
| Eine Antwort mit Quellen zusammenführen  | Auf 100 Validierungsfragen von ScholarQA-CS2 erreichte Open-Science mit deepseek-v4-flash einen **zusammengesetzten Qualitätswert von 0.9289/1**. Die offiziellen Testreferenzen verwenden andere Fragen. |
| Forschungsabläufe ausführen              | In lokalen ASI-Bench-Läufen mit demselben Modell erzielte Open-Science auf B4 **59.46**, Codex **55.45**. Auf B2 waren die Werte nahezu gleich (**56.11** und **56.09**).                                 |
| Biomedizinische Daten analysieren        | Auf BiomniBench-DA Public 50 bewerteten zwei Bewertungsmodelle die Ergebnisse mit **81.04** und **77.06**. Ihr gleich gewichteter Mittelwert betrug **79.05**.                                            |
| Veröffentlichte Ergebnisse reproduzieren | CORE-Bench-Hard — Im lokalen Test waren 36 von 37 Aufgaben korrekt (97,30 %). Die Auswertung enthält Wiederholungen.                                                                                      |
| Hypothesen aus Daten ableiten            | DiscoveryBench — Bei 25 Aufgaben aus dem Validierungssatz vergab ein lokales Bewertungsmodell im Mittel 0,7467/1.                                                                                         |

### AstaBench — Literaturaufgaben

<details>
<summary><strong>Literatursuche — Zielpublikation bei 68 von 75 Fragen gefunden</strong></summary>

AIPOCH führte den offiziellen LitQA2-FullText-Search-Testsplit mit 75 Fragen lokal aus. Der Recall@30 entsprach dem höchsten Wert im Vergleichsstand vom 26. Oktober 2026. Dieser lokale Lauf war weder eine Einreichung für die offizielle Rangliste noch eine dortige Platzierung.

![LitQA2-Suchvergleich von AIPOCH Open-Science: lokaler Recall@30 von 90.67% auf dem offiziellen Testsplit](../images/readme/astabench-litqa2-test.jpg)

Recall@30 zählt einen Treffer, wenn die Zielpublikation unter den ersten 30 Ergebnissen erscheint; die Antwortgenauigkeit wird damit nicht gemessen. Die Kostenberechnung wurde zwischen den Läufen nicht vereinheitlicht.

</details>

<details>
<summary><strong>Volltext-Fragenbeantwortung — 70 von 75 Antworten richtig</strong></summary>

AIPOCH führte den LitQA2-FullText-Testsplit mit 75 Fragen in AstaBench v0.5.4 aus. Die Grafik ordnet das lokale Ergebnis und historische Referenzwerte nach Punktzahl. „#1“ bezieht sich auf diesen Vergleich.

![LitQA2-Volltextvergleich von AIPOCH Open-Science: lokale Antwortgenauigkeit von 93.33%](../images/readme/astabench-litqa2-fulltext-local-comparison.png)

Die Genauigkeit misst den Anteil richtiger Antworten. Hier sind 93.33% die lokale Antwortgenauigkeit und 90.67% eine historische Referenzgenauigkeit. Die Suchgrafik oben verwendet eine andere Kennzahl. Die Referenzen wurden am 28. Oktober 2026 erfasst; der höchste Referenzwert wurde am 2. November erneut geprüft.

</details>

<details>
<summary><strong>Qualität belegter Antworten — lokale Validierung und offizielle Testreferenzen</strong></summary>

Das lokale ScholarQA-CS2-Ergebnis misst die Qualität zitierter Antworten auf 100 Validation-Fragen. Die Referenzen stammen aus dem Testsplit; die Werte begründen daher keine Rangfolge aus einem direkten Vergleich.

![ScholarQA-CS2-Vergleich von AIPOCH Open-Science: lokaler Validation-Gesamtwert 0.9289, getrennt von offiziellen Testreferenzen](../images/readme/astabench-scholarqa-cs2.jpg)

Der zusammengesetzte Wert liegt auf einer Skala von 0 bis 1; er ist nicht der Prozentsatz vollständig richtig beantworteter Fragen.

</details>

### AstaBench — Reproduzierbarkeit und Hypothesenbildung

<details>
<summary><strong>CORE-Bench-Hard — 36/37</strong></summary>

Am 6. November verwendete AIPOCH DeepSeek Flash mit Max-Reasoning, um Ergebnisse anhand von Code, Daten und README einer Studie zu reproduzieren. Das offizielle Bewertungsprogramm lief lokal und vergab einen Punkt nur bei vollständig richtigen Antworten. Alle 37 Aufgaben wurden bewertet, einschließlich Wiederholungen in der Endauswertung. [AIPOCH](https://aipoch.com/blog/aipoch-open-science-core-bench-hard).

</details>

<details>
<summary><strong>DiscoveryBench — 0,7467/1</strong></summary>

Am 9. November verwendete AIPOCH deepseek-v4-flash zur Hypothesenbildung und als Bewertungsmodell in einer lokalen Implementierung des Bewertungsverfahrens. Von 25 Aufgaben erhielten 18 die volle Punktzahl, zwei Teilpunkte und fünf null Punkte. Aufgabensatz und Bewertungsmodell unterscheiden sich vom offiziellen Gesamttest, sodass keine gemeinsame Rangfolge möglich ist.

</details>

### ASI-Bench — Pläne ausführen und Methoden auswählen

Die vier Bedingungen verlangen die Ausführung eines vorgegebenen Plans (B1), die Organisation eines Arbeitsablaufs (B2), die Auswahl von Forschungsmethoden (B3) oder Forschung mit ablenkenden Informationen (B4). Die ersten beiden Zeilen der Grafik vergleichen lokale Läufe mit demselben GPT-6-Astra-Modell.

![ASI-Bench-B1–B4-Ergebnisse von AIPOCH Open-Science neben lokalen Codex-Läufen und veröffentlichten Referenzen](../images/readme/asi-bench-b1-b4.jpg)

Open-Science erzielte auf B1–B4 **79.35, 56.11, 59.67 und 59.46**; die lokale Codex-Referenz erzielte **74.78, 56.09, 58.12 und 55.45**. Die B2-Werte waren nahezu gleich. Andere veröffentlichte Läufe unterscheiden sich bei Aufgabeninstanzen, Konfigurationen oder Bewertung.

Der lokale B1-Wert umfasst 59 Aufgaben nach einem Ausschluss wegen eines Problems im Bewertungssystem. Für B1/B2 wurden drei lokale Wiederholungen berichtet. B3/B4 verwendeten Open-Science v0.32.0 und ein Ersatz-Bewertungsmodell; jeder Wert ist der Mittelwert aus drei Läufen mit je 60 Aufgaben.

### BiomniBench-DA — Biomedizinische Datenanalyse

Auf dem Aufgabensatz Public 50 bewertete Gemini 3.1 Pro die Ergebnisse mit **81.04** und DeepSeek v4-pro mit **77.06**. AIPOCH berichtet ihren gleich gewichteten Mittelwert **79.05** für die Konfiguration gpt-5.6-sol (xhigh).

<details>
<summary><strong>Bewertungen und historische Referenzen — unterschiedliche Abdeckung durch Bewertungsmodelle</strong></summary>

Die Grafik kombiniert Einträge mit unterschiedlicher Abdeckung durch Bewertungsmodelle. „#1“ bezeichnet die Reihenfolge dieser Sammlung. Eine Rangliste nach einem gemeinsamen Bewertungsverfahren würde vergleichbare Bewertungen aller Einträge erfordern.

![BiomniBench-DA-Public-50-Vergleich von AIPOCH Open-Science mit zwei Bewertungswerten und ihrem Mittelwert](../images/readme/biomnibench-public50-leaderboard.png)

79.05 ist ein mittlerer Bewertungswert dieser internen Evaluation.

</details>

**Bewertungsumfang:** Die Berichte umfassen lokale oder interne Läufe von August bis November 2026 mit den angegebenen Modellen und Datensplits; für die aktuelle Version wurden sie nicht wiederholt. Referenzwerte sind historische Momentaufnahmen, keine Live-Ranglisten. Werte verschiedener Benchmark-Familien sind nicht direkt vergleichbar, und numerische Unterschiede belegen keine statistische Signifikanz.

Details stehen im [AstaBench- und ASI-Bench-Bericht](https://aipoch.com/benchmark/open-science) sowie im [BiomniBench-DA-Bericht](https://aipoch.com/blog/open-science-biomnibench-da).

<a id="kernkompetenzen"></a>

## Warum AIPOCH Open-Science verwenden?

1. **Fachartikel lesen und Daten im selben Projekt auswerten.**
   - Importieren Sie Literatur aus Zotero oder fügen Sie bis zu 100 Kennungen oder Artikellinks auf einmal ein. Mit einem eingerichteten Screening-Modell prüfen Sie Artikel anhand Ihrer Ein- und Ausschlusskriterien. Vergleichen Sie die Entscheidungen des Modells mit Ihren eigenen und prüfen Sie Befunde im Kontext der jeweiligen PDF-Datei.
   - Sehen Sie sich wissenschaftliche Daten, Dokumente, Bilder und Molekülstrukturen neben Ihren Artikeln an. Erstellen Sie mit Python oder R in einem Notebook eine Tabelle oder Abbildung aus Ihren Projektdaten und vergleichen Sie das Ergebnis mit den Quelldateien.

2. **Nachvollziehen, wie ein Ergebnis entstand und worauf eine Antwort beruht.**
   - Öffnen Sie in **Provenance** eine bestimmte Version einer Abbildung, Tabelle oder eines Berichts, um die verfügbaren Eingaben, den Code und den Ausführungsverlauf einzusehen. Sind Eingaben, Ablauf und Laufzeitumgebung verfügbar, können Sie die Version in der Desktop-App erneut ausführen und die Ausgaben vergleichen.
   - Aktivieren Sie **Reviewer**, um die Antwort des Agenten gesondert anhand der Protokolle und Dateien des jeweiligen Durchlaufs prüfen zu lassen. Lesen Sie die gemeldeten Probleme und die erneute Prüfung nach einer Korrektur durch den Agenten.

3. **Ergebnisse mitsamt ihrem Kontext weitergeben.**
   - Wählen Sie Gesprächszweige, Dateiversionen, Notebook-Aufzeichnungen und Prüfnachweise für ein `.science`-Paket aus. Andere können es auf einem anderen Rechner öffnen und die Entstehung einer Abbildung oder Tabelle nachvollziehen.
   - Importierte Aufzeichnungen sind schreibgeschützt. Der Import führt keinen Code aus und stellt keine Zugangsdaten wieder her. Die Prüfnachweise dokumentieren die Prüfungen auf dem Ausgangsrechner. Über **Fork to continue** lässt sich eine Folgefrage in einer beschreibbaren Kopie untersuchen.

4. **Werkzeuge und Rechenressourcen für die Analyse auswählen.**
   - Wählen Sie einen Modellanbieter und greifen Sie über **48 integrierte Konnektoren** auf wissenschaftliche Datenquellen zu. Einige Konnektoren müssen zuerst aktiviert werden.
   - Für wiederkehrende Aufgaben stehen **24 integrierte Fähigkeiten** bereit. Der [Fähigkeiten-Marktplatz](https://github.com/aipoch/openscience-skill-marketplace) bietet **525 Fähigkeiten** zur Installation. Um Teilaufgaben zu delegieren, wählen Sie aus **10 Spezialisten** auf dem [Spezialisten-Marktplatz](https://github.com/aipoch/openscience-specialist-marketplace).
   - Führen Sie Analysen lokal aus oder übermitteln Sie sie über SSH, Slurm, Kubernetes, Hugging Face Jobs, Modal oder Ray an eine von Ihnen verwaltete Umgebung. Prüfen Sie Ziel, Befehl, Ressourcen und Ausgaben, bevor Sie einen entfernten Auftrag freigeben. Cloud-Aufträge können Kosten für das verbundene Konto verursachen.

## Modellanbieter

AIPOCH Open-Science ist modellunabhängig: Sie können große Cloud-LLM-Anbieter oder ein benutzerdefiniertes Gateway anbinden und ein bestehendes Claude- oder Codex-Abonnement verwenden. Welche Anbieter verfügbar sind, hängt derzeit vom ausgewählten Agenten-Backend und dessen unterstützten API-Protokollen ab. Folgende Verbindungsoptionen stehen zur Verfügung:

| Anbietermodus                   | Wie es funktioniert                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integrierte Cloud-Anbieter**  | Wählen Sie aus der von der installierten App angezeigten Anbieterliste aus und authentifizieren Sie sich mit dem angeforderten Schlüssel.                                                                                                                                                                                                                                                                                                                                                   |
| **Benutzerdefiniertes Gateway** | Geben Sie Basis-URL, genaue Modell-ID und ein vom gewählten Backend unterstütztes API-Protokoll an (Messages, Chat Completions oder Responses), und testen Sie die Verbindung. Entfernte Gateways erfordern HTTPS und einen API-Schlüssel. Loopback-Adressen wie `localhost`, `127.0.0.1` oder `[::1]` erlauben HTTP ohne Schlüssel; Voreinstellungen gibt es für Ollama, LM Studio, llama.cpp und vLLM. Das voreingestellte API-Format garantiert keine Server- oder Modellkompatibilität. |
| **Codex-Abonnement**            | Wählen Sie Open-Science Agent oder Codex und dann Codex-Abonnement als Anbietertyp aus. Importieren Sie eine bestehende Codex-Anmeldung oder melden Sie sich mit Open-Science an.                                                                                                                                                                                                                                                                                                           |
| **Claude-Abonnement**           | Melden Sie sich in einem von zwei Modi an: **gemeinsam** über den Browser, wobei Anmeldedaten im standardmäßigen `~/.claude`-Profil gespeichert werden, oder **isoliert** über ein von der App verwaltetes `claude setup-token` in einem App-eigenen `CLAUDE_CONFIG_DIR`. Dieser Modus ist vollständig von `~/.claude/` getrennt und bietet neben dem Browser-Ablauf eine manuelle Token-Eingabe.                                                                                           |
| **xAI (Grok) OAuth**            | Verwenden Sie die integrierte Geräteanmeldung über xAI (Grok) OAuth. Der Zugriff hängt vom xAI-Konto und der Protokollunterstützung des gewählten Backends ab; prüfen Sie die Verbindung in der App.                                                                                                                                                                                                                                                                                        |

Es gibt 25 voreingestellte Anbieteroptionen, darunter OpenAI, Anthropic, DeepSeek und NVIDIA Build. Modelle und regionale Endpunkte hängen von installierter Version und Backend ab; maßgeblich sind Anbieterauswahl und Verbindungstest in der App.

## Daten, Berechtigungen und Vertrauen

AIPOCH Open-Science speichert Projektdaten, Einstellungen, Artefaktversionen und Provenienznachweise auf dem lokalen Computer. API-Schlüssel werden lokal abgelegt und nach Möglichkeit durch den sicheren Anmeldedatenspeicher des Betriebssystems geschützt. Protokolle bleiben lokal und werden nicht automatisch hochgeladen.

Dennoch können Daten an externe Dienste übertragen werden. Prüfen Sie insbesondere folgende Fälle:

- Modellanfragen senden den Prompt und den erforderlichen Kontext an den ausgewählten Modellanbieter.
- Websuchen und Remote-Konnektoren senden ihre angezeigten Parameter an externe Dienste.
- Lokale Konnektoren können vertrauenswürdige Befehle auf dem Computer ausführen.
- Die App kann auch Update-Server, Marktplatzkataloge und Download-Dienste für Laufzeiten oder Modelle kontaktieren.
- Anhänge, `@`-Referenzen, Protokolle und generierte Berichte können vertrauliche Forschungsdaten enthalten.

Wählen Sie das engste Berechtigungsprofil, das zur Aufgabe passt:

| Modus                | Verhalten                                                                                                                                                        | Empfohlene Verwendung                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Ask for approval`   | Fragt bei Aktionen nach, die nicht durch bestehende begrenzte Freigaben oder Richtlinien vertrauenswürdiger App-Werkzeuge abgedeckt sind                         | Neue Arbeitsabläufe, sensible Daten, unbekannte Skripte                  |
| `Auto-approve edits` | Nutzt die native automatische Prüfung des Backends, sofern verfügbar; andernfalls werden nur eindeutig risikoarme Vorgänge im Arbeitsbereich automatisch erlaubt | Vertrauenswürdige Dateibearbeitung mit kontrolliertem externen Zugriff   |
| `Full access`        | Ermöglicht automatisch Bearbeitungen, Befehle, Netzwerk und Konnektoren                                                                                          | Klar abgegrenzte, vollständig vertrauenswürdige, unbeaufsichtigte Arbeit |

Das wirksame Profil hängt vom Backend und bestehenden Freigaben ab. Konnektor-, Werkzeug- und Compute-Netzwerkrichtlinien gelten ebenfalls; prüfen Sie den von der App angezeigten wirksamen Modus.

Prüfen Sie Konnektorparameter und Tool-Aktivität vor der Freigabe. API-Schlüssel, Zugriffstoken, Patientenkennungen, unveröffentlichte Daten oder vertrauliche lokale Pfade gehören niemals in Screenshots oder öffentliche Issue-Protokolle.

## Entwicklung & Verpackung

AIPOCH Open-Science besteht aus einem gewöhnlichen Node-Backend und einem Electron-Desktop-Client mit React, TypeScript, Prisma/SQLite und dem integrierten Open-Science Agent sowie optionalen Agenten-Backends.

Voraussetzungen für die Quellentwicklung:

- Node.js 24 (siehe [`.nvmrc`](../../.nvmrc)) mit npm
- Git
- Notebook-Ausführung ist optional und verwendet App-verwaltete Python/R-Umgebungen oder einen von Ihnen eingerichteten kompatiblen Interpreter.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

Build-Befehle und Entwicklungsablauf stehen in der [Referenz für Entwicklung und Paketierung](development-quick-reference.md) und im [Beitragsleitfaden](../../CONTRIBUTING.md).

### Localhost-Web- und Headless-Modi

Die Web-Oberfläche läuft mit einem gewöhnlichen Node-Backend, ohne Electron oder grafische Anzeige.

```bash
npm run dev:web
npm run pack:backend
```

Die Web-Oberfläche läuft mit einem gewöhnlichen Node-Backend, ohne Electron oder grafische Anzeige. `npm run dev:web` und `npm run dev:headless` bauen und starten Backend und Web-Oberfläche; sie starten weder Desktop noch Infobereich. `OPEN_SCIENCE_WEB_PORT` wählt den Port (Standard `44100`); Strg+C beendet den Vordergrunddienst geordnet.

Quellentwicklung benötigt Node.js 24. Das veröffentlichte npm-Paket und das lokal gebaute eigenständige npm-Tarball benötigen Node.js >=22.13.0. Release-Archive, Homebrew-Formula und Desktop-Befehlsstarter enthalten ihre eigene Laufzeit.

Desktop-App und Browser teilen denselben Dienst. App-Verbindungen und eine ausdrückliche Halteanforderung durch `open-science start` halten ihn am Laufen. Das Beenden der letzten App stoppt den Dienst nur, wenn keine ausdrückliche Halteanforderung mehr besteht.

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### Mobiler Fernzugriff

Scannen Sie einen QR-Code, um den aktuellen Arbeitsbereich auf einem Smartphone oder Tablet über lokales WLAN oder einen Pinggy-Tunnel zu öffnen. Die WLAN-Kopplung bleibt im lokalen Netzwerk; Internettunnel leiten den Verkehr über Pinggys Server, worauf der Verbindungsdialog hinweist.

### Headless CLI und SDK

Die Headless-CLI und das Node.js-SDK ohne zusätzliche Abhängigkeiten verwenden denselben lokalen Daemon sowie dieselben Projekte, Sitzungen, Anmeldeinformationen und Berechtigungen wie die Desktop- und Weboberflächen. Die ausführliche Anleitung liegt beim veröffentlichbaren Paket, sodass nur eine Befehlsreferenz gepflegt werden muss:

- [CLI-Anleitung](../../packages/open-science/CLI.md) – Installation, Dienstlebenszyklus, Aufgabenautomatisierung, Artefakte, Ausgabeformate und Exit-Codes
- [SDK-Paketübersicht](../../packages/open-science/README.md) – Node.js-Schnellstart und Einstiegspunkt des Pakets

Die eigenständige CLI kann ihre Recherchewerkzeuge über `open-science mcp` für externe MCP-Clients bereitstellen. Starten und authentifizieren Sie zuerst den Dienst des ausgewählten Profils. Der Adapter verwendet dessen bestehende Berechtigungen; er ist weder eine separate Sandbox noch schreibgeschützt, sodass verbundene Clients Änderungen speichern und Modellkosten verursachen können. Beliebiger Befehlszeilen- oder RPC-Zugriff, Anmeldedatenverwaltung, Dateiimport und -export, Downloads auf einen Pfad und ein entfernter HTTP-MCP-Endpunkt werden nicht bereitgestellt.

## Häufig gestellte Fragen

<a id="warum-schlägt-der-modellverbindungstest-fehl"></a>

<details>
<summary>Warum schlägt der Modellverbindungstest fehl?</summary>

A: Prüfen Sie den API-Schlüssel auf fehlende Zeichen oder Leerzeichen, kontrollieren Sie Basis-URL und Region, verwenden Sie die exakte Modell-ID des Anbieters und stellen Sie Netzwerkzugriff sowie ausreichendes Guthaben sicher. Bei einem Claude-Abonnement können Sie je nach ausgewähltem Modus die gemeinsame Browseranmeldung wiederholen oder die isolierten Anmeldedaten aus `claude setup-token` erneuern.

</details>

<a id="warum-ist-continue-während-des-setups-deaktiviert"></a>

<details>
<summary>Warum ist <code>Continue</code> während des Setups deaktiviert?</summary>

A: Mindestens eine Pflichtbedingung des aktuellen Schritts ist noch nicht erfüllt. Bearbeiten Sie alle mit `Action needed` gekennzeichneten Umgebungsprüfungen, installieren oder reparieren Sie die ausgewählte Agent-Runtime beziehungsweise validieren Sie den Modellanbieter. Die Notebook-Einrichtung ist optional und betrifft ausschließlich die Notebook-Ausführung.

</details>

<a id="wie-führe-ich-jobs-auf-einem-remote-hpc-cluster-aus"></a>

<details>
<summary>Wie führe ich Jobs auf einem Remote-HPC-Cluster aus?</summary>

A: **Remote Compute (SSH)** ist dauerhaft aktiviert und muss nicht in den Einstellungen eingeschaltet werden. Registrieren Sie unter **Einstellungen → Verbindungen → Rechenressourcen** einen SSH-Rechenhost, stellen Sie ihn für die aktuelle Sitzung bereit und verwenden Sie anschließend natürliche Sprache oder `/remote-compute-ssh`. Erforderlich sind ein erreichbarer SSH-Host, gültige Anmeldedaten, Rechte für die benötigten Verzeichnisse sowie die für den Auftrag nötige Software, Abhängigkeiten und Rechenleistung. Direct SSH benötigt keinen Scheduler; der Slurm-Modus setzt eine funktionsfähige Slurm-Umgebung und das Recht zur Jobübermittlung voraus. „Dauerhaft aktiviert“ bezieht sich auf die Fähigkeit, nicht auf die ständige Verfügbarkeit jedes registrierten Hosts.

Auch Kubernetes, Hugging Face Jobs, Modal und Ray stehen für selbst angebundene Ziele bereit. Vor jeder externen Übermittlung genehmigen Sie Ziel, Befehl, Ressourcen und Ausgaben. Wiederherstellungsdaten setzen die Ergebnissammlung nach einem Neustart fort; veröffentlichte Ergebnisse öffnen sich in Compute Preview. Konten, Software, Ressourcen und Rechte müssen selbst bereitgestellt werden; Cloud-Aufträge können Kosten verursachen.

</details>

<a id="gibt-es-eine-befehlszeilenschnittstelle"></a>

<details>
<summary>Gibt es eine Befehlszeilenschnittstelle?</summary>

A: Ja. Installieren Sie die eigenständige CLI oder verwenden Sie **Einstellungen → Allgemein → Befehlszeile → Befehl installieren**, um eine bereits laufende Desktop-Instanz zu steuern. Die Installation über npm benötigt Node.js; Homebrew und eigenständige Pakete mit gebündelter Laufzeit enthalten es bereits. Initialisieren Sie das lokale Profil, steuern Sie anschließend den Dienst und übermitteln Sie Forschungsaufgaben, ohne einen Browser zu öffnen:

```bash
# Start the service in the background
open-science init
open-science start --no-open

# Create a project and run a task by its exact name
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# Download a generated artifact
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

Die vollständige Befehlsreferenz, JSON/JSONL-Ausgabeformate, Exit-Codes und Headless-Dienstoptionen finden Sie im [CLI-Handbuch](../../packages/open-science/CLI.md).

</details>

<a id="wie-überprüfe-ich-woher-ein-generiertes-ergebnis-stammt"></a>

<details>
<summary>Wie überprüfe ich, woher ein generiertes Ergebnis stammt?</summary>

A: Öffnen Sie das generierte Artefakt und wählen Sie **Provenienz**. Wählen Sie eine Version aus, um Inhaltsidentität, verfügbaren Erzeugercode, Ausführungsverlauf, Eingaben, Umgebungsbestand, den erzeugenden Konversationskontext und Reviewer-Belege zu prüfen. Belege, die AIPOCH Open-Science nicht verifizieren konnte, sind als nicht verfügbar gekennzeichnet.

</details>

<a id="kann-ich-eine-frühere-anfrage-überarbeiten-ohne-die-anschließende-konversation-zu-verlieren"></a>

<details>
<summary>Kann ich eine frühere Anfrage überarbeiten, ohne die anschließende Konversation zu verlieren?</summary>

A: Ja. Bearbeiten Sie eine abgeschlossene Benutzernachricht und senden Sie sie erneut, um ab diesem Punkt einen neuen Branch zu erstellen. Die ursprünglichen nachfolgenden Interaktionen bleiben verfügbar. Mit den Versionspfeilen neben der Nachricht wechseln Sie zwischen den alternativen Pfaden.

</details>

## Mitwirkende

Vielen Dank an alle, die mit Code, Dokumentation, Übersetzungen, Fehlerberichten und Unterstützung der Community zu AIPOCH Open-Science beitragen.

[Mitwirkende auf GitHub ansehen](https://github.com/aipoch/open-science/graphs/contributors)

[![Mitwirkende an AIPOCH Open-Science](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## Machen Sie mit

Helfen Sie, AIPOCH Open-Science zu verbessern: Melden Sie einen Fehler, schlagen Sie eine Funktion vor, stellen Sie eine Frage oder leisten Sie einen Beitrag. Wählen Sie unten einen passenden Kanal.

| Kanal                                                                    | Geeignet für                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Fehlerberichte, reproduzierbare Probleme und konkrete Funktionsvorschläge |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Designfragen, Roadmap-Vorschläge und längere technische Diskussionen      |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Community-Hilfe, Koordinierung der Mitwirkenden und informelle Diskussion |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Veröffentlichungsankündigungen und integrierte öffentliche Updates        |
| [Open-Science-Website](https://aipoch.com/open-science)                  | Offizielle Produktübersicht und Downloads                                 |

Entfernen Sie vor dem Erstellen eines öffentlichen Issues API-Schlüssel, Token, private Dateipfade, unveröffentlichte Daten, Patientenkennungen und anderes vertrauliches Material aus Protokollen und Screenshots. Informationen zum Entwicklungsworkflow finden Sie in [CONTRIBUTING.md](../../CONTRIBUTING.md).

> Wenn AIPOCH Open-Science für Sie nützlich ist, geben Sie dem Repository auf GitHub einen Stern.

Gelieferte, teilweise umgesetzte und geplante Funktionen finden Sie in der [Capability Map](../ROADMAP.md#capability-map).

<a id="aipoch-open-science-paper-und-zitierung"></a>

## Zitieren

Wenn Sie AIPOCH Open-Science in Ihrer Forschung verwenden, zitieren Sie bitte den [Preprint zu AIPOCH Open-Science](https://arxiv.org/abs/2610.17110).

<details>
<summary>BibTeX-Zitat</summary>

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

## Lizenz

Apache-Lizenz 2.0 – siehe [LICENSE](../../LICENSE).

## Sterngeschichte

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
<source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="GitHub-Sternverlauf von AIPOCH Open-Science" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
</picture>
</a>
