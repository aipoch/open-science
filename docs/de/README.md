<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  KI-Forschungsumgebung für reproduzierbare Wissenschaft — quelloffen, lokal betrieben und modellunabhängig.
</p>

<p align="center">
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Herunterladen" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Version" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://huggingface.co/datasets/phylobio/BiomniBench-DA">
    <img alt="Platz 1 bei BiomniBench-DA Public 50" src="https://img.shields.io/badge/%F0%9F%8F%86%20%231-BiomniBench--DA%20Public%2050-f59f00?style=flat">
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
  <a href="https://discord.gg/zxQAYjReRv">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=flat&logo=discord&logoColor=white">
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

AIPOCH Open-Science ist eine KI-Forschungsumgebung für Wissenschaftler und Forschende, entwickelt von [AIPOCH](https://aipoch.com/open-science) mit einem quelloffenen, lokal betriebenen und modellunabhängigen Ansatz. Sie ermöglicht reproduzierbare und nachvollziehbare Forschung mit wissenschaftlichen KI-Agenten, Python und R, wissenschaftlichen Datenkonnektoren sowie Unterstützung für macOS, Windows und Linux. Erstellen Sie ein Projekt, beschreiben Sie Ihr Forschungsziel in natürlicher Sprache und lassen Sie Agenten Dateien lesen, im Web recherchieren, Code ausführen, wissenschaftliche Datenquellen abfragen und Berichte, Tabellen oder Abbildungen mit nachvollziehbarer Provenienz erstellen – alles in einem Arbeitsbereich.

AIPOCH Open-Science unterstützt rechen- und datenintensive Forschung in zahlreichen Disziplinen, darunter maschinelles Lernen, Statistik, Biowissenschaften, Chemie, Materialwissenschaften, Physik und Umweltwissenschaften. Die Umgebung begleitet den Forschungsprozess von der Literaturrecherche und Hypothesenbildung über Codeausführung, Datenanalyse, Simulation und Visualisierung bis zur Erstellung nachvollziehbarer Forschungsergebnisse.

> 💡 **[AIPOCH Open-Science v0.33.0 veröffentlicht](https://github.com/aipoch/open-science/releases/latest)** _(zuletzt aktualisiert im September 2026)_. AIPOCH Open-Science v0.33.0 bringt Sichtung von Literatur auf Screening-Niveau: Intelligente Literatursammlungen bewerten Referenzen anhand Ihrer Einschluss- und Ausschlusskriterien, mit den Zuständen Aufgenommen / Überprüfung nötig / Ausgeschlossen, PDF-Evidenz und automatischen Aktualisierungen auf Wunsch. Forschungspakete betten jetzt RO-Crate-Metadaten ein (neu exportierte Pakete benötigen einen Reader mit ro-crate-Unterstützung; bestehende Pakete bleiben lesbar), und die Konnektor-Familie wächst um die Zenodo-Suche in öffentlichen Datensätzen, GDC-Projekt- und Datei-Metadaten sowie das UniProt-Batch-Identifier-Mapping. Ressourcenzugriffe pro Agent vereinen die Fähigkeiten- und Konnektor-Berechtigungen für Hauptagent und Spezialisten an einem Ort, Sitzungen erhalten einen lokalen Diagnose-Export, und die Anbieterkataloge werden mit Xiaomi MiMo v2.6, Grok 4.7 sowie Modellen der aktuellen Generation für Zen und Go aufgefrischt. Notebook-Hinweise zu Umgebung und Wiederherstellung lassen sich jetzt schließen, das Windows-Paket-Reset entfernt schreibgeschützte Attribute, Linux-Pakete liefern die Fedora-Abfrage-Engine, und das Streaming bleibt dank begrenzter Token-Schätzung reaktionsfähig. Weitere Details finden Sie in den [neuesten Versionshinweisen](https://github.com/aipoch/open-science/releases/latest).

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science Hero-Banner: Science, Open to All — eine quelloffene, modellunabhängige und selbst gehostete Forschungsumgebung für wissenschaftliche KI" src="../images/readme/open-science-banner.png" />
</p>

## Inhaltsverzeichnis

- [Schnellstart](#-schnellstart)
- [Produkttour](#produkttour)
- [Benchmark-Ergebnisse](#benchmark-ergebnisse)
- [Kernkompetenzen](#kernkompetenzen)
- [Modellanbieter](#modellanbieter)
- [Daten, Berechtigungen und Vertrauen](#daten-berechtigungen-und-vertrauen)
- [Entwicklung & Verpackung](#entwicklung--verpackung)
- [Häufig gestellte Fragen](#häufig-gestellte-fragen)
- [Machen Sie mit](#machen-sie-mit)
- [Lizenz](#lizenz)
- [Sterngeschichte](#sterngeschichte)

## 🚀 Schnellstart

### 1. Laden Sie die App herunter

Öffnen Sie die [neueste Version](https://github.com/aipoch/open-science/releases/latest), klappen Sie **Assets** auf und wählen Sie das passende Installationspaket aus:

| Ihr Computer                              | Wählen Sie                                |
| ----------------------------------------- | ----------------------------------------- |
| macOS 12+ – Apple Silicon (M1 oder neuer) | Das macOS DMG für Apple Silicon / ARM64   |
| macOS 12+ – Intel                         | Das macOS DMG für Intel / x64             |
| Windows x64                               | Das Windows x64-Installationsprogramm     |
| Linux x64                                 | Das Linux x64 AppImage- oder Debian-Paket |

Laden Sie das Paket von der offiziellen Release-Seite herunter; bei Bedarf finden Sie Hinweise unter [Download überprüfen](../../SECURITY.md#verifying-your-download).

Unter macOS können Sie die App auch mit [Homebrew](https://brew.sh) installieren:

```bash
brew install --cask open-science
```

Unter Windows bleiben Forschungsdaten bei einer Neuinstallation erhalten. Für eine vollständige Bereinigung nutzen Sie das [Werkzeug zum Zurücksetzen](../../scripts/windows-reset/README.md), das lokale Daten nach Bestätigung dauerhaft löscht.

### 2. Schließen Sie die Ersteinrichtung ab

Folgen Sie dem Einrichtungsassistenten: **Umgebung → Datenspeicherort → Agent-Runtime → Modellanbieter → Notebook-Runtime**.

Schließen Sie die erforderlichen Prüfungen für Umgebung und Agent-Runtime ab und testen Sie die Modellverbindung. Python/R Notebook ist optional; Notebook und Datenspeicherort lassen sich später in den Einstellungen ändern.

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

## Produkttour

### Von der Forschungsanfrage zum nachvollziehbaren Ergebnis

Nehmen wir eine typische Bioinformatikaufgabe: Eine veröffentlichte Analyse der differentiellen Genexpression wird reproduziert, die neu erzeugten Ergebnisse werden mit der Publikation verglichen und Bericht, Tabellen sowie Abbildungen für die Prüfung bereitgestellt. Die folgenden Screenshots zeigen repräsentative Ansichten aus dokumentierten Open-Science-Workflows; sie veranschaulichen die einzelnen Schritte, stammen aber nicht aus einer einzigen durchgängigen Sitzung.

#### 1. Forschungsaufgabe und Evidenz festlegen

Beschreiben Sie die Forschungsfrage, die Quellpublikation und Datensätze, erforderliche Methoden oder Schwellenwerte, erwartete Ergebnisse und Abnahmekriterien. Laden Sie unterstützende Dateien hoch oder referenzieren Sie mit `@` ein vorhandenes Projektartefakt, damit der Agent mit expliziten Eingaben statt mit verborgenem Kontext beginnt.

<p align="center">
  <img src="../images/readme/product-tour-task.jpg" alt="Open-Science-Aufgabe zur Reproduktion einer Publikation mit Forschungsergebnis, erzeugten Artefakten und Quellenvergleich in einem Arbeitsbereich" width="900">
</p>

#### 2. Mit überprüfbaren wissenschaftlichen Werkzeugen ausführen

Der Agent kann im gemeinsamen Notebook wissenschaftliche Fähigkeiten, berechtigungsgesteuerte Forschungskonnektoren, Suchen, Dateioperationen sowie Python- oder R-Code kombinieren. Erzeugte Abbildungen lassen sich neben der Forschungszusammenfassung prüfen; der Artefaktdatensatz stellt dazu den erfassten Erzeugungscode und Ausführungsevidenz bereit.

<p align="center">
  <img src="../images/readme/product-tour-execute.png" alt="Open-Science-Bioinformatikanalyse mit Forschungszusammenfassung, erzeugter Abbildung und erfasstem Erzeugungscode nebeneinander" width="900">
</p>

#### 3. Berichte, Tabellen und Abbildungen direkt prüfen

Die abschließende Antwort fasst zusammen, was reproduziert wurde, was abwich und welche Einschränkungen relevant sind. Erzeugte Markdown-Berichte, CSV-Tabellen, Bilder und weitere Forschungsartefakte bleiben mit der Sitzung verknüpft und werden zugleich in der Projektdateibibliothek gesammelt. Dort können sie neben dem Dialog angezeigt und in späteren Arbeiten wiederverwendet werden.

<p align="center">
  <img src="../images/readme/product-tour-output.jpg" alt="Open-Science-Reproduktionsergebnis mit Abbildungen zur differentiellen Genexpression und erzeugten Dateien neben der Erläuterung des Agenten" width="900">
</p>

#### 4. Jedes Artefakt bis zu seiner Evidenz zurückverfolgen

Jedes erzeugte Artefakt wird als unveränderliche Version mit Prüfsumme gespeichert. Die Ansicht **Provenance** kann Erzeugungscode und Ausführungshistorie, referenzierte Eingaben, das beobachtete Umgebungsinventar, den erzeugenden Gesprächszweig sowie versionsbezogene Reviewer-Ergebnisse anzeigen. Nicht überprüfbare Evidenz wird als nicht verfügbar gekennzeichnet und nicht hergeleitet.

<p align="center">
  <img src="../images/readme/product-tour-provenance.jpg" alt="Vorschau eines Open-Science-Forschungsartefakts mit Provenance-Zugang zur Rückverfolgung eines erzeugten Ergebnisses" width="900">
</p>

## Benchmark-Ergebnisse

### 🏆 Platz 1 bei BiomniBench-DA Public 50

AIPOCH Open-Science erzielte im zusammengestellten Vergleich BiomniBench-DA Public 50 den höchsten Ranking-Wert: **79.05** mit **gpt-5.6-sol (xhigh)**. Das Ergebnis kombiniert einen Bewertungswert von Gemini 3.1 Pro (**81.04**) und einen Bewertungswert von DeepSeek v4-pro (**77.06**) als gleich gewichteten Mittelwert und platziert AIPOCH Open-Science damit auf **Platz 1** der gesammelten Public-50-Ergebnisse. Erkunden Sie den [BiomniBench-DA-Datensatz](https://huggingface.co/datasets/phylobio/BiomniBench-DA).

<p align="center">
  <img src="../images/readme/biomnibench-public50-leaderboard.png" alt="BiomniBench-DA-Public-50-Vergleich mit AIPOCH Open-Science auf Platz 1 und einem Wert von 79.05" width="1200" />
</p>

## Kernkompetenzen

AIPOCH Open-Science verbindet Projektverwaltung, modellübergreifende Agentenausführung, Python- und R-Notebooks, wissenschaftliche Datenkonnektoren, unveränderliche Artefaktversionen mit Provenienz und berechtigungsbasierte Human-in-the-Loop-Kontrolle in einem lokalen Arbeitsbereich. Maßgeblich für veränderliche Kataloge, Paketdetails und neue Optionen sind die installierte App und die [neuesten Versionshinweise](https://github.com/aipoch/open-science/releases/latest).

| Bereich                                      | Kernfunktionen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wissenschaftliche Fähigkeiten**            | Erweitern Sie Forschung mit **23 integrierten Fähigkeiten** und **525 Fähigkeiten** aus dem [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace), mit Ein-Klick-Installation und Updates. Erstellen Sie Fähigkeiten im Dialog oder aus abgeschlossener Arbeit und importieren Sie Pakete oder GitHub-Quellen. Beiträge werden nach Prüfung veröffentlicht; ein lokaler Import veröffentlicht sie nicht.                                                                                                                     |
| **Konnektoren**                              | Greifen Sie über **24 integrierte Konnektoren** auf wissenschaftliche Ressourcen zu oder ergänzen Sie eigene lokale und entfernte MCP-Konnektoren. Verwalten Sie Werkzeugberechtigungen und importieren oder exportieren Sie Konfigurationen.                                                                                                                                                                                                                                                                                                        |
| **Spezialisten und Delegation**              | Installieren Sie **10 Spezialisten** aus dem [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace) oder erstellen Sie persönliche Spezialisten für Aufgaben des Hauptagenten. Pakete lassen sich importieren und exportieren; Beiträge werden nach Prüfung veröffentlicht, lokale Importe veröffentlichen nichts.                                                                                                                                                                                                   |
| **Modelle und Agenten-Backends**             | Nutzen Sie Cloud-Modelle, kompatible Gateways oder Claude- und Codex-Abonnements. Wählen Sie Claude Code, OpenCode, Codex oder CodeBuddy als Backend, mit Verbindungsprüfung, Bildeingaben und einstellbarer Denkintensität.                                                                                                                                                                                                                                                                                                                         |
| **Projekte, Sitzungen und Forschungspakete** | Organisieren Sie Projekte mit angehefteten Sitzungen, Nachrichtenverzweigungen, Nebengesprächen und wiederherstellbarem Verlauf. Übertragen Sie ein **portables `.science`-Forschungspaket** mit Gesprächsverzweigungen, ausgewählten Dateiversionen, Notebook-Aufzeichnungen und Verifikationsevidenz in ein anderes Projekt oder auf einen anderen Rechner. Importe sind schreibgeschützt, führen keinen Code aus und stellen keine Anmeldedaten wieder her; Nebengespräche und Lesezeichen sind ausgeschlossen, Dateien folgen der Exportauswahl. |
| **Prüfagent**                                | Aktivieren Sie bei Bedarf die automatische Prüfung, um Antworten, Ausführungsprotokolle und zugehörige Dateibelege eines abgeschlossenen Agentendurchlaufs in einem eigenen Kontext zu prüfen. Sie erhalten belegte Ergebnisse mit den Status Bestanden, Warnung oder Fehler; bei Problemen sind Korrekturen durch den Hauptagenten und erneute Prüfungen mit begrenzter Rundenzahl möglich. Prüfprotokolle und Bearbeitungsstände bleiben erhalten; die Prüfung beschränkt sich auf die für diesen Durchlauf verfügbaren Aufzeichnungen.            |
| **Python, R, Notebooks und HPC**             | Führen Sie Python, R, Notebook und Befehlszeile lokal in verwalteten Umgebungen oder eigenen Interpretern aus, mit Hintergrundausführung und Verlauf. SSH und Slurm setzen Host, Software, Ressourcen und Rechte gemäß der nachfolgenden FAQ zu entfernten Berechnungen voraus.                                                                                                                                                                                                                                                                      |
| **Literaturbibliothek**                      | Importieren und verwalten Sie Literatur und PDFs mit Sammlungen, Tags, Projektverknüpfungen, Notizen und dem Zusammenführen von Duplikaten. Finden Sie frei zugängliche Volltexte, lesen Sie PDFs, extrahieren Sie Abbildungen und Tabellen und nutzen Sie Bibliotheksquellen in Gesprächen für KI-gestützte Analysen. Erstellen Sie Literaturverzeichnisse im gewählten Zitierstil und exportieren Sie Referenzen als BibTeX oder RIS.                                                                                                              |
| **Wissenschaftliche Dateien und Vorschauen** | Laden Sie Dateien bis **10 GiB pro Datei** hoch, organisieren Sie Projektdateien und betrachten Sie wissenschaftliche Daten, PDFs, Office-Dokumente, Bilder, Code und Molekülstrukturen. Diese Upload-Grenze garantiert nicht, dass ein Modell alles lesen kann: Kontext, Anhangsanalyse und Vorschauen haben eigene Grenzen. Große Dateien erfordern meist abschnittsweises Lesen oder Analysieren per Code.                                                                                                                                        |
| **Artefakte und Provenienz**                 | Speichern Sie unveränderliche Ergebnisversionen mit verfügbarem Erzeugungscode, Eingaben, Ausführungsverlauf, Umgebungsinformationen und Prüfnachweisen. Auf dem Desktop können geeignete Versionen mit vollständigem Rezept, benötigten Eingaben und nutzbarer Laufzeit wiederholt, Ausgaben verglichen und Prüfprotokolle exportiert werden. Fehlende Nachweise können die Prüfung verhindern; Wiederholung belegt keine wissenschaftliche Gültigkeit.                                                                                             |

## Modellanbieter

AIPOCH Open-Science ist modellunabhängig: Sie können große Cloud-LLM-Anbieter oder ein benutzerdefiniertes Gateway anbinden und ein bestehendes Claude- oder Codex-Abonnement verwenden. Welche Anbieter verfügbar sind, hängt derzeit vom ausgewählten Agenten-Backend und dessen unterstützten API-Protokollen ab. Ein Modell lässt sich auf vier Arten verbinden:

| Anbietermodus                   | Wie es funktioniert                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integrierte Cloud-Anbieter**  | Wählen Sie aus der von der installierten App angezeigten Anbieterliste aus und authentifizieren Sie sich mit dem angeforderten Schlüssel.                                                                                                                                                                                                                                                                                                                                                   |
| **Benutzerdefiniertes Gateway** | Geben Sie Basis-URL, genaue Modell-ID und ein vom gewählten Backend unterstütztes API-Protokoll an (Messages, Chat Completions oder Responses), und testen Sie die Verbindung. Entfernte Gateways erfordern HTTPS und einen API-Schlüssel. Loopback-Adressen wie `localhost`, `127.0.0.1` oder `[::1]` erlauben HTTP ohne Schlüssel; Voreinstellungen gibt es für Ollama, LM Studio, llama.cpp und vLLM. Das voreingestellte API-Format garantiert keine Server- oder Modellkompatibilität. |
| **Codex-Abonnement**            | Wählen Sie das Codex-Agenten-Framework und dann Codex-Abonnement als Anbietertyp aus.                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Claude-Abonnement**           | Melden Sie sich in einem von zwei Modi an: **gemeinsam** über den Browser, wobei Anmeldedaten im standardmäßigen `~/.claude`-Profil gespeichert werden, oder **isoliert** über ein von der App verwaltetes `claude setup-token` in einem App-eigenen `CLAUDE_CONFIG_DIR`. Dieser Modus ist vollständig von `~/.claude/` getrennt und bietet neben dem Browser-Ablauf eine manuelle Token-Eingabe.                                                                                           |

Integrierte Anbieter sind unter anderem OpenAI, Anthropic, DeepSeek und NVIDIA Build. Modelle und regionale Endpunkte hängen von installierter Version und Backend ab; maßgeblich sind Anbieterauswahl und Verbindungstest in der App.

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

AIPOCH Open-Science ist eine Electron-Anwendung auf Basis von React, TypeScript, Prisma/SQLite und einer ACP-basierten Agent-Runtime.

Voraussetzungen für die Quellentwicklung:

- Node.js 22 (siehe [`.nvmrc`](../../.nvmrc)) mit npm
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

Das Desktop-Backend kann optional denselben Renderer in einem Browser auf dem lokalen Computer bereitstellen. Diese Funktion ist standardmäßig deaktiviert und ausschließlich an `127.0.0.1` gebunden.

```bash
npm run build:web
npm run dev:web
```

Öffnen Sie die von der App ausgegebene authentifizierte URL. Mit `npm run dev:headless` starten Sie Backend, Infobereich, Agent-Runtime und Localhost-Webdienst ohne Electron-Fenster. Über `OPEN_SCIENCE_WEB_PORT` legen Sie den Port fest; der Standardwert ist `44100`. Beim ausdrücklichen Beenden der App werden Agenten- und Notebook-Prozesse weiterhin ordnungsgemäß heruntergefahren.

### Mobiler Fernzugriff

Über die Remote.It-Kopplung ist dieselbe Localhost-Web-UI auch auf einem Smartphone oder Tablet erreichbar. Koppeln Sie einen Browser mit einem sechsstelligen AIPOCH Open-Science-Code und geben Sie ihn einmal auf dem Desktop frei. Der Arbeitsbereich bleibt erreichbar, ohne den Loopback-Server direkt freizugeben. Das Vertrauen für einen Browser kann widerrufen werden; Änderungen des Modus oder das Beenden des Dienstes machen aktive Remote-Sitzungen sofort ungültig.

### Headless CLI und SDK

Die Headless-CLI und das Node.js-SDK ohne zusätzliche Abhängigkeiten verwenden denselben lokalen Daemon sowie dieselben Projekte, Sitzungen, Anmeldeinformationen und Berechtigungen wie die Desktop- und Weboberflächen. Die ausführliche Anleitung liegt beim veröffentlichbaren Paket, sodass nur eine Befehlsreferenz gepflegt werden muss:

- [CLI-Anleitung](../../packages/open-science/CLI.md) – Installation, Dienstlebenszyklus, Aufgabenautomatisierung, Artefakte, Ausgabeformate und Exit-Codes
- [SDK-Paketübersicht](../../packages/open-science/README.md) – Node.js-Schnellstart und Einstiegspunkt des Pakets

## Häufig gestellte Fragen

### Warum schlägt der Modellverbindungstest fehl?

A: Prüfen Sie den API-Schlüssel auf fehlende Zeichen oder Leerzeichen, kontrollieren Sie Basis-URL und Region, verwenden Sie die exakte Modell-ID des Anbieters und stellen Sie Netzwerkzugriff sowie ausreichendes Guthaben sicher. Bei einem Claude-Abonnement können Sie je nach ausgewähltem Modus die gemeinsame Browseranmeldung wiederholen oder die isolierten Anmeldedaten aus `claude setup-token` erneuern.

### Warum ist `Continue` während des Setups deaktiviert?

A: Mindestens eine Pflichtbedingung des aktuellen Schritts ist noch nicht erfüllt. Bearbeiten Sie alle mit `Action needed` gekennzeichneten Umgebungsprüfungen, installieren oder reparieren Sie die ausgewählte Agent-Runtime beziehungsweise validieren Sie den Modellanbieter. Die Notebook-Einrichtung ist optional und betrifft ausschließlich die Notebook-Ausführung.

### Wie führe ich Jobs auf einem Remote-HPC-Cluster aus?

A: **Remote Compute (SSH)** ist dauerhaft aktiviert und muss nicht in den Einstellungen eingeschaltet werden. Registrieren Sie unter **Einstellungen → Rechenressourcen** einen SSH-Rechenhost, stellen Sie ihn für die aktuelle Sitzung bereit und verwenden Sie anschließend natürliche Sprache oder `/remote-compute-ssh`. Erforderlich sind ein erreichbarer SSH-Host, gültige Anmeldedaten, Rechte für die benötigten Verzeichnisse sowie die für den Auftrag nötige Software, Abhängigkeiten und Rechenleistung. Direct SSH benötigt keinen Scheduler; der Slurm-Modus setzt eine funktionsfähige Slurm-Umgebung und das Recht zur Jobübermittlung voraus. „Dauerhaft aktiviert“ bezieht sich auf die Fähigkeit, nicht auf die ständige Verfügbarkeit jedes registrierten Hosts.

### Gibt es eine Befehlszeilenschnittstelle?

A: Ja. Installieren Sie das Befehlszeilentool unter **Einstellungen → Allgemein → Befehlszeile → Befehl installieren**. Dadurch wird `open-science` zu Ihrem PATH hinzugefügt; eine separate Node.js-Installation ist nicht erforderlich. Die CLI steuert den lokalen Dienst und übermittelt Forschungsaufgaben, ohne einen Browser zu öffnen:

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

### Wie überprüfe ich, woher ein generiertes Ergebnis stammt?

A: Öffnen Sie das generierte Artefakt und wählen Sie **Provenienz**. Wählen Sie eine Version aus, um Inhaltsidentität, verfügbaren Erzeugercode, Ausführungsverlauf, Eingaben, Umgebungsbestand, den erzeugenden Konversationskontext und Reviewer-Belege zu prüfen. Belege, die AIPOCH Open-Science nicht verifizieren konnte, sind als nicht verfügbar gekennzeichnet.

### Kann ich eine frühere Anfrage überarbeiten, ohne die anschließende Konversation zu verlieren?

A: Ja. Bearbeiten Sie eine abgeschlossene Benutzernachricht und senden Sie sie erneut, um ab diesem Punkt einen neuen Branch zu erstellen. Die ursprünglichen nachfolgenden Interaktionen bleiben verfügbar. Mit den Versionspfeilen neben der Nachricht wechseln Sie zwischen den alternativen Pfaden.

## Machen Sie mit

AIPOCH Open-Science freut sich über Fehlerberichte, Funktionsvorschläge, Designdiskussionen, Fragen aus der Community und Codebeiträge über GitHub, Discord, X oder die AIPOCH-Website. Wählen Sie den passenden Kanal und beachten Sie vor dem Teilen von Projektdetails die verlinkten Beitrags- und Sicherheitshinweise.

| Kanal                                                                    | Geeignet für                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Fehlerberichte, reproduzierbare Probleme und konkrete Funktionsvorschläge |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Designfragen, Roadmap-Vorschläge und längere technische Diskussionen      |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Community-Hilfe, Koordinierung der Mitwirkenden und informelle Diskussion |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Veröffentlichungsankündigungen und integrierte öffentliche Updates        |
| [Open-Science-Website](https://aipoch.com/open-science)                  | Offizielle Produktübersicht und Downloads                                 |

Entfernen Sie vor dem Erstellen eines öffentlichen Issues API-Schlüssel, Token, private Dateipfade, unveröffentlichte Daten, Patientenkennungen und anderes vertrauliches Material aus Protokollen und Screenshots. Informationen zum Entwicklungsworkflow finden Sie in [CONTRIBUTING.md](../../CONTRIBUTING.md).

> ⭐ **Repository mit einem Stern markieren:** Wenn Ihnen das Projekt hilft, freuen wir uns über einen Stern auf GitHub. Damit unterstützen Sie die weitere Entwicklung.

Gelieferte, teilweise umgesetzte und geplante Funktionen finden Sie in der [Capability Map](../../ROADMAP.md#capability-map).

## Lizenz

Apache-Lizenz 2.0 – siehe [LICENSE](../../LICENSE).

## Sterngeschichte

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
<source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
</picture>
</a>
