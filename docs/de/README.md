<h1 align="center">AIPOCH Open Science</h1>

<p align="center">
  Quelloffene, lokal betriebene und modellunabhängige KI-Forschungsumgebung für reproduzierbare Wissenschaft.
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

Open Science ist eine von [AIPOCH](https://aipoch.com/open-science) entwickelte, quelloffene, lokal betriebene und modellunabhängige KI-Forschungsumgebung für Wissenschaftler und Forschende. Sie ermöglicht reproduzierbare und nachvollziehbare Forschung mit wissenschaftlichen KI-Agenten, Python und R, wissenschaftlichen Datenkonnektoren sowie Unterstützung für macOS, Windows und Linux. Erstellen Sie ein Projekt, beschreiben Sie Ihr Forschungsziel in natürlicher Sprache und lassen Sie Agenten Dateien lesen, im Web recherchieren, Code ausführen, wissenschaftliche Datenquellen abfragen und Berichte, Tabellen oder Abbildungen mit nachvollziehbarer Provenienz erstellen – alles in einem Arbeitsbereich.

Open Science unterstützt rechen- und datenintensive Forschung in zahlreichen Disziplinen, darunter maschinelles Lernen, Statistik, Biowissenschaften, Chemie, Materialwissenschaften, Physik und Umweltwissenschaften. Die Umgebung begleitet den Forschungsprozess von der Literaturrecherche und Hypothesenbildung über Codeausführung, Datenanalyse, Simulation und Visualisierung bis zur Erstellung nachvollziehbarer Forschungsergebnisse.

> 💡 **[Open Science v0.26.0 veröffentlicht](https://github.com/aipoch/open-science/releases/latest)** _(zuletzt aktualisiert im September 2026)_. Open Science v0.26.0 bringt HPC-fähiges Rechnen und einen Literatur-Arbeitsbereich: Remote-Compute-Hosts erhalten einen Slurm-Ausführungsmodus pro Host neben direktem SSH, und eine neue Referenzbibliothek organisiert Literaturstellen, PDFs und Zitationen mit identifikatorbasiertem Import, Dublettenzusammenführung, Open-Access-Volltext-Anhängen und Zitationsformatierung. Apodex stößt zu den integrierten Anbietern, gemeinsam mit den neuesten OpenAI- und Anthropic-Modellen; Notebook-Tool-Aufrufe werden zu lesbaren Zusammenfassungskarten, und flüssigeres Streaming, ruhigere Standardberechtigungen sowie eine breite Palette von Korrekturen halten Einzug. Weitere Details finden Sie in den [neuesten Versionshinweisen](https://github.com/aipoch/open-science/releases/latest).

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open Science Hero-Banner: Science, Open to All — eine quelloffene, modellunabhängige und selbst gehostete Forschungsumgebung für wissenschaftliche KI" src="../images/readme/open-science-banner.png" />
</p>

## Inhaltsverzeichnis

- [Schnellstart](#-schnellstart)
- [Produkttour](#produkttour)
- [Benchmark-Ergebnisse](#benchmark-ergebnisse)
- [Warum Open Science](#warum-open-science)
- [Kernkompetenzen](#kernkompetenzen)
- [Modellanbieter](#modellanbieter)
- [Daten, Berechtigungen und Vertrauen](#daten-berechtigungen-und-vertrauen)
- [Projektstatus](#projektstatus)
- [Entwicklung & Verpackung](#entwicklung--verpackung)
- [Häufig gestellte Fragen](#häufig-gestellte-fragen)
- [Machen Sie mit](#machen-sie-mit)
- [Lizenz](#lizenz)
- [Sterngeschichte](#sterngeschichte)

## 🚀 Schnellstart

Open Science ist in drei Schritten einsatzbereit: Installationspaket herunterladen, geführte Ersteinrichtung abschließen und ein Forschungsprojekt erstellen.

### 1. Laden Sie die App herunter

Öffnen Sie die [neueste Version](https://github.com/aipoch/open-science/releases/latest), klappen Sie **Assets** auf und wählen Sie das passende Installationspaket aus:

| Ihr Computer                          | Wählen Sie                                |
| ------------------------------------- | ----------------------------------------- |
| macOS – Apple Silicon (M1 oder neuer) | Das macOS DMG für Apple Silicon / ARM64   |
| macOS – Intel                         | Das macOS DMG für Intel / x64             |
| Windows x64                           | Das Windows x64-Installationsprogramm     |
| Linux x64                             | Das Linux x64 AppImage- oder Debian-Paket |

Überprüfen Sie die auf der Release-Seite veröffentlichten Assets und Verifizierungsinformationen. Lesen Sie vor der Installation den Abschnitt [Überprüfen Ihres Downloads](../../SECURITY.md#verifying-your-download), wenn Sie ein Paket validieren müssen.

> Wenn macOS oder Windows vor einem nicht identifizierten Entwickler oder einem unbekannten Herausgeber warnt, vergewissern Sie sich vor dem Fortfahren, dass das Paket von der offiziellen Releases-Seite stammt.

### 2. Schließen Sie die Ersteinrichtung ab

Der erste Start besteht aus fünf geführten Schritten:

1. **Umgebung** prüft Kompatibilität, App-Speicher, sichere Speicherung von Anmeldeinformationen und Netzwerkzugriff.
2. **Datenspeicherort** wählt aus, wo große Artefakte, Notebooks, Uploads und Umgebungen gespeichert werden.
3. **Agent-Runtime** wählt Claude Code, OpenCode, Codex oder CodeBuddy aus und bereitet das Framework vor. Von der App verwaltete Runtimes lassen sich ohne Node.js, npm oder Administratorkennwort installieren.
4. **Modellanbieter** verbindet und testet das Modell, das Sie verwenden möchten. Wählen Sie einen integrierten Anbieter, ein benutzerdefiniertes Gateway oder ein vorhandenes Claude- oder Codex-Abonnement-Login.
5. **Notebook-Runtime** bereitet optional von der App verwaltete Python- und R-Umgebungen vor oder aktiviert erkannte und manuell registrierte Interpreter für beide Sprachen.

<table>
<tr>
<td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="Automatische Umgebungsprüfungen beim ersten Start in Open Science"></td>
<td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="Erstausführung der Modellanbieterkonfiguration in Open Science"></td>
</tr>
<tr>
<td align="center"><sub>Hostkompatibilitäts-, Speicher- und Netzwerkprüfungen</sub></td>
<td align="center"><sub>Anbieter, API-Schlüssel, Endpunkt und Modellvalidierung</sub></td>
</tr>
</table>

Die Notebook-Ausführung ist optional. `Continue` wird erst verfügbar, wenn alle erforderlichen Prüfungen für Umgebung und Agent-Runtime erfolgreich waren. Vor Abschluss der Einrichtung muss außerdem die Modellverbindung funktionieren. Die Standardeinstellungen für Notebook und Datenspeicherort können Sie zunächst übernehmen und später in den Einstellungen ändern. Während ein Kernel läuft, zeigt die Ansicht „Variablen“ den Python- oder R-Namensraum mit Namen, Typen, Formen und Vorschauen schreibgeschützt an und aktualisiert ihn nach jeder Ausführung.

### 3. Starten Sie ein Forschungsprojekt

1. Klicken Sie auf **Neues Projekt** und geben Sie dem Projekt einen stabilen Forschungsnamen und optional eine Beschreibung.
2. Öffnen Sie eine Sitzung und beschreiben Sie das Ziel, die Eingabedaten, die Einschränkungen, die gewünschten Ergebnisse und wie das Ergebnis überprüft werden soll.
3. Hängen Sie Quelldateien an, wählen Sie ein verifiziertes Modell und ein Freigabeprofil aus.
4. Senden Sie die Aufgabe. Prüfen Sie die Tool-Aktivität des Agenten, geben Sie vertrauliche Aktionen frei und öffnen Sie generierte Artefakte im Vorschaufenster.
5. Um eine andere Richtung zu verfolgen, bearbeiten Sie eine frühere Benutzernachricht und senden Sie sie in einem neuen Branch erneut. Mit der Versionssteuerung der Nachricht können Sie zwischen beiden Pfaden wechseln.
6. Öffnen Sie die **Provenienzansicht** eines Artefakts, um seine Versionen und die verfügbaren Beweise hinter dem ausgewählten Ergebnis zu überprüfen.
7. Setzen Sie die Arbeit in späteren Sitzungen fort. Verwenden Sie `@`, um auf eine vorhandene Projektdatei zu verweisen, und `/`, um explizit eine aktivierte Fähigkeit auszuwählen.

> Screenshots in dieser README-Datei veranschaulichen den Arbeitsablauf. Beschriftungen, Kataloge und andere Schnittstellendetails können von der von Ihnen installierten Version abweichen.

## Produkttour

Open Science organisiert Forschung in Projekten und Sitzungen, sodass jedes Ergebnis mit den Belegen verknüpft bleibt, aus denen es entstanden ist. Die folgenden Abschnitte stellen Arbeitsbereich, Artefaktprovenienz, Vorschauen, wissenschaftliche Fähigkeiten und Datenkonnektoren vor.

### Ein Arbeitsbereich von der Aufgabe bis zu nachverfolgbaren Artefakten

Projekte bündeln zusammengehörige Sitzungen, Uploads, generierte Dateien und den jeweiligen Vorschaustatus. Die Konversation protokolliert die Antwort des Agenten sowie die Befehle, Dateizugriffe, Bearbeitungen, Suchvorgänge und Konnektoraufrufe, aus denen sie hervorgegangen ist. Jedes generierte Artefakt wird als unveränderliche Version mit Prüfsumme gespeichert. Die Ansicht **Provenienz** zeigt die bei der Erstellung überprüfbaren Belege: erzeugenden Code und Ausführungsverlauf, referenzierte Eingaben, den erfassten Umgebungsbestand, den erzeugenden Konversations-Branch und versionsbezogene Reviewer-Befunde. Fehlende Belege werden als nicht verfügbar gekennzeichnet, statt ergänzt oder vermutet zu werden.

<table>
<tr>
<td width="50%"><img src="../images/readme/project-files.jpg" alt="Projektdateibibliothek mit Uploads und generierten Forschungsartefakten"></td>
<td width="50%"><img src="../images/readme/csv-preview.jpg" alt="CSV-Artefaktvorschau neben einer abgeschlossenen Agentensitzung"></td>
</tr>
<tr>
<td align="center"><sub>Uploads und generierte Dateien, organisiert nach Projekt und Sitzung</sub></td>
<td align="center"><sub>Native Vorschauen halten Daten und den Forschungsverlauf nebeneinander</sub></td>
</tr>
</table>

Erstellte Berichte, Abbildungen und Tabellen bleiben mit der Sitzung verknüpft und werden zusätzlich in der Projektdateibibliothek gesammelt. Vorschau-Tabs halten das aktive Ergebnis auch bei Größenänderungen des Bereichs sichtbar; lange Dateinamen behalten ihr unterscheidbares Suffix und ihre Erweiterung. Open Science unterstützt Vorschauen für gängige wissenschaftliche Daten, PDFs, Office-Dokumente (DOCX, XLSX, PPTX), Bilder mit Zoom und Verschieben, Quellcode mit Syntaxhervorhebung, molekulare Strukturen und Reaktionen sowie den Notebook-Verlauf. Größenbeschränkungen der Vorschau verändern die zugrunde liegende Datei nicht; das vollständige Artefakt bleibt für den Agenten und externe Tools verfügbar. Mit `Cmd/Ctrl+F` durchsuchen Sie Transkripte, Notebook-Ausgaben und gerenderte Seiten im gesamten Arbeitsbereich. `Cmd/Ctrl+K` öffnet die projektbezogene Befehlspalette. Das Design lässt sich unter **Einstellungen → Allgemein** ohne sichtbares Flackern zwischen hell und dunkel umschalten. Dort können Sie auch zur Laufzeit zwischen Chinesisch (vereinfacht und traditionell), Japanisch, Koreanisch, Französisch, Russisch, Deutsch und Spanisch wechseln.

### Konversation verzweigen, ohne das Original zu verlieren

Bearbeiten Sie eine abgeschlossene Benutzernachricht, um ab diesem Punkt einen überarbeiteten Prompt zu senden. Open Science erstellt einen neuen Nachrichten-Branch, ohne die nachfolgenden Interaktionen zu löschen. Mit der Versionssteuerung wechseln Sie zwischen ursprünglichem und alternativem Pfad. Branch-Auswahl, Tool-Aktivität, Anhänge und generierte Artefakte bleiben bei Projektwechseln und Neustarts erhalten. Die Provenienz jeder Artefaktversion bleibt an den erzeugenden Branch gebunden. So können Sie eine andere Hypothese verfolgen, ohne die Dokumentation des früheren Ergebnisses zu vermischen.

### Wissenschaftliche Fähigkeiten und Datenkonnektoren

Open Science umfasst einen wachsenden Katalog mit **22 ausgewählten**, dateibasierten Forschungsfähigkeiten: AlphaFold2, Boltz, Borzoi, Chai-1, Customize, DiffDock, Environment & Packages, ESM-2, ESMFold2, Evo 2, Figure Composer, Figure Style, Indication Dossier, LigandMPNN, Literature Review, OpenFold3, Paper Narrative, ProteinMPNN, scGPT, scvi-tools, SolubleMPNN und **Remote Compute (SSH)** zum Übermitteln und Abrufen lang laufender Jobs auf Remote-HPC-Clustern. Sie können persönliche Fähigkeiten erstellen, `SKILL.md`-, ZIP- oder `.skill`-Pakete hochladen, kompatible Fähigkeiten von GitHub vorab prüfen und optional mit authentifiziertem Zugriff importieren. Auch bereits in globalen Agentenverzeichnissen installierte Fähigkeiten lassen sich übernehmen. Ein Agent kann zudem den Import eines Pakets aus einem Sitzungsanhang oder einer öffentlichen GitHub-URL anfordern. Bevor Dateien geschrieben werden, zeigt die App eine Vorschau und fordert eine Bestätigung an. Aktivierte Fähigkeiten wählen Sie im Composer direkt mit `/` aus.

Hinzu kommen **24 integrierte** Forschungskonnektoren: Literature Graph, PubMed, bioRxiv, Genes & Ontologies, Genomes, BioMart, Variants, Human Genetics, Clinical Genomics, Structures & Interactions, Protein Annotation, Expression, Omics Archives, CellGuide, Regulation, RNA, Chemistry, ChEMBL, ZINC, Molecule Viewer, Clinical Trials, Drug Regulatory, Cancer Models und Research Resources. Für integrierte wie benutzerdefinierte Konnektoren gilt das Berechtigungssystem mit den Tool-spezifischen Optionen `Always allow`, `Ask each time` und `Block`. Die installierte App zeigt jeweils die aktuellen Kataloge für Fähigkeiten, Konnektoren und Tools.

<table>
<tr>
<td width="50%"><img src="../images/readme/skills.jpg" alt="Open Science Einstellungen, die ausgewählte wissenschaftliche Fähigkeiten anzeigen"></td>
<td width="50%"><img src="../images/readme/connectors.jpg" alt="Open Science-Einstellungen zeigen integrierte wissenschaftliche Datenkonnektoren"></td>
</tr>
<tr>
<td align="center"><sub>Lesbare, wiederverwendbare Recherchefähigkeiten</sub></td>
<td align="center"><sub>Wissenschaftliche Datenbanken, die als autorisierte Agent-Tools bereitgestellt werden</sub></td>
</tr>
</table>

## Benchmark-Ergebnisse

### 🏆 Platz 1 bei BiomniBench-DA Public 50

Open Science erzielte im zusammengestellten Vergleich BiomniBench-DA Public 50 den höchsten Ranking-Wert: **79.05** mit **gpt-5.6-sol (xhigh)**. Das Ergebnis kombiniert einen Bewertungswert von Gemini 3.1 Pro (**81.04**) und einen Bewertungswert von DeepSeek v4-pro (**77.06**) als gleich gewichteten Mittelwert und platziert Open Science damit auf **Platz 1** der gesammelten Public-50-Ergebnisse. Erkunden Sie den [BiomniBench-DA-Datensatz](https://huggingface.co/datasets/phylobio/BiomniBench-DA).

<p align="center">
  <img src="../images/readme/biomnibench-public50-leaderboard.png" alt="BiomniBench-DA-Public-50-Vergleich mit AIPOCH Open Science auf Platz 1 und einem Wert von 79.05" width="1200" />
</p>

## Warum Open Science

Open Science führt Chats, Notebooks, lokale Skripte, wissenschaftliche Datenbanken, Dateien und Berichtstools in einer dauerhaften, lokal ausgerichteten KI-Forschungsumgebung zusammen, in der Ausführung und Nachweise verbunden bleiben.

- **Dauerhafte Ausführung.** Projekte, Sitzungen, Dateien, Vorschauen und Ausführungsverläufe bleiben nach Neustarts erhalten; freigegebene Agenten können Befehle sowie Python und R ausführen und Artefakte erzeugen.
- **Nachvollziehbare Ergebnisse.** Unveränderliche Artefaktversionen bewahren überprüfbare Entstehungsnachweise und kennzeichnen nicht verfügbare Belege eindeutig.
- **Modellunabhängige Auswahl.** Verbinden Sie integrierte Cloud-Anbieter, kompatible benutzerdefinierte Gateways oder Claude- und Codex-Abonnements und wählen Sie Modell sowie Reasoning-Aufwand pro Sitzung.
- **Lokale Kontrolle.** App und Projektstatus bleiben auf Ihrem Computer; externe Aufrufe verwenden nur ausdrücklich konfigurierte oder freigegebene Dienste.
- **Offen und erweiterbar.** Die unabhängige Apache-2.0-Codebasis, Fähigkeiten, Konnektoren, Tool-Aktivität und generierten Dateien sind einsehbar; Fähigkeiten und MCP-Konnektoren lassen sich ergänzen.

[AIPOCH](https://aipoch.com/) entwickelt [Open Science](https://aipoch.com/open-science), eine quelloffene, lokal ausgerichtete Desktop-Forschungsumgebung für wissenschaftliche KI-Workflows.

## Kernkompetenzen

Open Science verbindet Projektverwaltung, modellübergreifende Agentenausführung, Python- und R-Notebooks, wissenschaftliche Datenkonnektoren, unveränderliche Artefaktversionen mit Provenienz und berechtigungsbasierte Human-in-the-Loop-Kontrolle in einem lokalen Arbeitsbereich. Maßgeblich für veränderliche Kataloge, Paketdetails und neue Optionen sind die installierte App und die [neuesten Versionshinweise](https://github.com/aipoch/open-science/releases/latest).

| Bereich                                                   | Kernfunktionen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projekte und Sitzungen**                                | Erstellen und organisieren Sie Projekte mit angehefteten Sitzungen, dauerhaften Nachrichtenverzweigungen und Nebengesprächen, bearbeitbaren Sitzungsdetails sowie der Wiederherstellung von letzter Arbeit, Entwürfen, Gesprächsverlauf und Vorschauzustand.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Agenten-Workflow**                                      | Sitzungen in natürlicher Sprache bieten gestreamte Antworten, zweckbezogen gruppierte Werkzeugaktivität, Genehmigungs- und Stoppkontrollen, eingereihte Folgeanfragen, Kontextkomprimierung und Wiederherstellung nach einem Neustart. Verzweigen Sie abgeschlossene Arbeit in neue Sitzungen und nutzen Sie strukturierte Rückfragen, Text-, Bild- und PDF-Anmerkungen, Lesekontext für verknüpfte PDFs, Projektspeicher, Sitzungsreferenzen und prüfungspflichtige Pläne. Benachrichtigungen, Live-Status, Zeit- und Token-Details, Befehlspalette, Quellenvorschau und Projektwechsel halten lang laufende Forschung sichtbar und steuerbar.                                         |
| **Modelle und Agenten-Backends**                          | Nutzen Sie integrierte Cloud-Anbieter wie Apodex, NVIDIA Build mit einem kuratierten agentenfähigen Katalog sowie die neuesten Modellkataloge von OpenAI und Anthropic (GPT-6 Astra und Claude Fable 5.1), kompatible benutzerdefinierte Gateways oder Claude- und Codex-Abonnementanmeldungen. Wählen Sie Claude Code, OpenCode, Codex oder die anmeldungsfreie CodeBuddy-Laufzeit als Agenten-Backend, mit geprüfter Modell- und API-Kompatibilität, multimodaler Bildeingabe, Steuerung der Schlussfolgerungsintensität und eigenen Richtlinien für Unteragent, Prüfer und Vision.                                                                                                   |
| **Spezialisten und Delegation**                           | Erstellen Sie persönliche Spezialisten-Agenten mit begrenzten Fähigkeiten, dialogbasierter Anpassung, Paketimport/-export und sofortiger Übergabe vom Hauptagenten. Der Marktplatz für signierte Pakete unterstützt offizielle und vom Benutzer genehmigte GitHub-Quellen, konfliktbewusste Importe und 64 integrierte Fähigkeitssymbole; produktive Delegation ergänzt dauerhafte Nachrichten, Wiederherstellung und einen Delegationsschalter pro Sitzung.                                                                                                                                                                                                                            |
| **Python, R, Notebooks und HPC**                          | Führen Sie persistente Python-, R- und REPL-Kernel zusammen mit protokollierten Befehlszeilenbefehlen in verwalteten Offline-Umgebungen oder mit eigenen Interpretern aus. Arbeiten Sie lokal oder verbinden Sie Remote-Hosts per SSH und übermitteln Sie Notebook-Läufe per Slurm an HPC-Cluster; geschützter Netzwerkzugriff, verschlüsselte Anmeldedaten, Paket- und Variablenprüfung, ein gemeinsames Terminal und progressiver Verlauf machen Berechnungen steuerbar und nachvollziehbar. Die Paketverwaltung externer R-Laufzeiten bleibt manuell.                                                                                                                                |
| **Literaturrecherche und Referenzverwaltung**             | Importieren Sie Referenzen per DOI, PubMed ID, arXiv ID oder Datei, organisieren Sie Sammlungen, verknüpfen Sie Referenzen mit Projekten und stellen Sie heruntergeladene PDFs aus dem Papierkorb wieder her. Durchsuchen Sie Europe PMC, PMC, OpenAlex, arXiv und Unpaywall parallel nach frei zugänglichen Volltexten, führen Sie Duplikate ohne Verlust von Anhängen oder Links zusammen und formatieren Sie Zitate aus gespeicherten Metadaten mit Artefaktprovenienz.                                                                                                                                                                                                              |
| **Wissenschaftliche Dateien und Vorschauen**              | Hängen Sie Dateien bis zu 10 GB per Streaming-Upload an, organisieren und durchsuchen Sie eine Projektbibliothek, referenzieren Sie Uploads, Ausgaben und lokale Ordner mit `@` und `@path`, und exportieren Sie Dateien, Gespräche oder `.ipynb`-Sitzungen. Zeigen Sie wissenschaftliche Daten, durchsuchbare PDFs, Office-Dateien, TIFF- und andere Bilder, Quellcode, Molekülstrukturen und Reaktionen sowie Notebook-Verläufe inline oder im Vollbild an, mit Provenienz und Navigation zurück zur Quelle.                                                                                                                                                                          |
| **Artefakte und Provenienz**                              | Bewahren Sie unveränderliche, sitzungsbezogene Artefaktversionen mit Prüfsummeninhalt, erzeugendem Code, Ausführungsverlauf, exakten Eingaben, Umgebungsinventar, Nachrichtenverzweigungskontext, Abstammung und Prüfnachweisen auf. Bearbeitbare Markdown-, Text-, Skript- und Quellcodedateien veröffentlichen bei jedem Speichern eine neue provenienzerhaltende Version mit Vergleich zum Vorgänger.                                                                                                                                                                                                                                                                                |
| **Wissenschaftliche Fähigkeiten und Datenkonnektoren**    | Erweitern Sie Forschungsworkflows mit **22 hervorgehobenen** integrierten Fähigkeiten und **24 integrierten** Forschungskonnektoren. Erstellen Sie Fähigkeiten dialogbasiert oder aus abgeschlossener Arbeit, importieren Sie Pakete und GitHub-Quellen und fügen Sie benutzerdefinierte lokale oder entfernte MCP-Konnektoren mit Werkzeugberechtigungen sowie Konfigurationsimport/-export hinzu. Ressourcenübergreifende Tags, ein geschützter Favoriten-Tag und durchsuchbare Filter organisieren Fähigkeiten, Konnektoren und Spezialisten.                                                                                                                                        |
| **Lokale Daten, Datenschutz, Berechtigungen und Prüfung** | Speichern Sie Projektdaten, Anwendungsstatus und Notebook-Caches lokal in konfigurierbarem, migrierbarem Speicher; nutzen Sie System-, manuelle oder direkte Proxy-Modi und ein Token-Dashboard mit einer 30-Tage-Aktivitäts-Heatmap und Zuordnung pro Lauf. Steuern Sie Aktionen mit `Ask for approval`, `Auto-approve edits` oder `Full access`, begrenzten Freigaben, zentralen Anmeldedaten, benutzergenehmigten Compute-Domains sowie Richtlinien pro Konnektor und Werkzeug. Ein optionaler Prüfer untersucht Gesprächsprotokolle, Ausführungslogs und Artefakte, meldet Bestanden/Warnung/Fehler und kann eine begrenzte Korrekturschleife mit dauerhaften Nachweisen ausführen. |

## Modellanbieter

Open Science ist modellunabhängig: Sie können große Cloud-LLM-Anbieter oder ein benutzerdefiniertes Gateway anbinden und ein bestehendes Claude- oder Codex-Abonnement verwenden. Welche Anbieter verfügbar sind, hängt derzeit vom ausgewählten Agenten-Backend und dessen unterstützten API-Protokollen ab. Ein Modell lässt sich auf vier Arten verbinden:

| Anbietermodus                   | Wie es funktioniert                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integrierte Cloud-Anbieter**  | Wählen Sie aus der von der installierten App angezeigten Anbieterliste aus und authentifizieren Sie sich mit dem angeforderten Schlüssel.                                                                                                                                                                                                                                                         |
| **Benutzerdefiniertes Gateway** | Geben Sie eine kompatible Basis-URL, einen API-Schlüssel und die genaue Modell-ID an. Das aktive Agenten-Framework bestimmt das standardmäßige API-Format (Messages, Chat Completions oder Responses), sodass ein neues benutzerdefiniertes Gateway direkt verwendet werden kann.                                                                                                                 |
| **Codex-Abonnement**            | Wählen Sie das Codex-Agenten-Framework und dann Codex-Abonnement als Anbietertyp aus.                                                                                                                                                                                                                                                                                                             |
| **Claude-Abonnement**           | Melden Sie sich in einem von zwei Modi an: **gemeinsam** über den Browser, wobei Anmeldedaten im standardmäßigen `~/.claude`-Profil gespeichert werden, oder **isoliert** über ein von der App verwaltetes `claude setup-token` in einem App-eigenen `CLAUDE_CONFIG_DIR`. Dieser Modus ist vollständig von `~/.claude/` getrennt und bietet neben dem Browser-Ablauf eine manuelle Token-Eingabe. |

Der alte Anbieter **Local Claude** wurde entfernt. Zuvor gespeicherte Local-Claude-Einträge werden
beim Upgrade gelöscht. Fügen Sie stattdessen **Claude-Abonnement** hinzu und authentifizieren Sie
sich entweder über die gemeinsame Browseranmeldung oder den isolierten Ablauf mit `claude setup-token`.

Zu den integrierten Cloud-Anbietern zählen derzeit OpenAI, Anthropic, Grok (xAI), DeepSeek, Zhipu AI (GLM) mit einem dedizierten GLM-Coding-Plan-Endpunkt, Kimi (Moonshot), MiniMax, StepFun mit einem dedizierten Step-Plan-Abonnement-Endpunkt, Xiaomi MIMO, SenseNova, Volcengine Ark, Bailian (Alibaba Cloud) mit einem dedizierten Bailian-for-Plan-Abonnement-Endpunkt, OpenCode Go und OpenCode Zen sowie das OpenRouter-Aggregations-Gateway; einige davon sind regionalspezifisch.

Anbieter, verfügbare Modelle und regionale Endpunkte können sich unabhängig von dieser README-Datei ändern. Maßgeblich sind die Anbieterauswahl und der Verbindungstest in der installierten App.

## Daten, Berechtigungen und Vertrauen

Open Science speichert Projektdaten, Einstellungen, Artefaktversionen und Provenienznachweise auf dem lokalen Computer. API-Schlüssel werden lokal abgelegt und nach Möglichkeit durch den sicheren Anmeldedatenspeicher des Betriebssystems geschützt. Protokolle bleiben lokal und werden nicht automatisch hochgeladen.

Dennoch können Daten an externe Dienste übertragen werden. Prüfen Sie insbesondere folgende Fälle:

- Modellanfragen senden den Prompt und den erforderlichen Kontext an den ausgewählten Modellanbieter.
- Websuchen und Remote-Konnektoren senden ihre angezeigten Parameter an externe Dienste.
- Lokale Konnektoren können vertrauenswürdige Befehle auf dem Computer ausführen.
- Anhänge, `@`-Referenzen, Protokolle und generierte Berichte können vertrauliche Forschungsdaten enthalten.

Wählen Sie das engste Berechtigungsprofil, das zur Aufgabe passt:

| Modus                | Verhalten                                                                                             | Empfohlene Verwendung                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Ask for approval`   | Fragt vor Bearbeitungen, Befehlen, Netzwerk- und Konnektoraufrufen                                    | Neue Arbeitsabläufe, sensible Daten, unbekannte Skripte                  |
| `Auto-approve edits` | Ermöglicht automatisch Bearbeitungen im Arbeitsbereich; fragt nach Befehlen, Netzwerk und Konnektoren | Vertrauenswürdige Dateibearbeitung mit kontrolliertem externen Zugriff   |
| `Full access`        | Ermöglicht automatisch Bearbeitungen, Befehle, Netzwerk und Konnektoren                               | Klar abgegrenzte, vollständig vertrauenswürdige, unbeaufsichtigte Arbeit |

Prüfen Sie Konnektorparameter und Tool-Aktivität vor der Freigabe. API-Schlüssel, Zugriffstoken, Patientenkennungen, unveröffentlichte Daten oder vertrauliche lokale Pfade gehören niemals in Screenshots oder öffentliche Issue-Protokolle.

## Projektstatus

Open Science ist eine aktiv entwickelte Desktop-Anwendung, die für macOS, Windows und Linux verfügbar ist. Die Entwicklung konzentriert sich auf zuverlässige lokale Forschungsabläufe, erweiterbare wissenschaftliche Funktionen, nachverfolgbare Forschungsartefakte und eine benutzergesteuerte Ausführung.

Aktuelle Downloads und versionspezifische Änderungen finden Sie in der [neuesten Version](https://github.com/aipoch/open-science/releases/latest). Informationen zu gelieferten, teilweisen und geplanten Funktionen finden Sie in der [Capability Map](../../ROADMAP.md#capability-map).

Open Science unterstützt die Durchführung von Forschungsarbeiten und die Führung von Aufzeichnungen. Forscher bleiben für Methoden, Interpretation, Privatsphäre und wissenschaftliche Gültigkeit verantwortlich.

## Entwicklung & Verpackung

Open Science ist eine Electron-Anwendung auf Basis von React, TypeScript, Prisma/SQLite und einer ACP-basierten Agent-Runtime.

Voraussetzungen für die Quellentwicklung:

- Node.js 22 (siehe [`.nvmrc`](../../.nvmrc)) mit npm
- Git
- Python 3 nur für die Notebook-Ausführung

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` generiert automatisch den Prisma-Client und installiert die nativen Electron-Abhängigkeiten. `npm run dev` erstellt die Main- und Preload-Bundles, startet den Renderer und öffnet die Desktop-App. Entwicklungsdaten werden unter `~/.open-science-project` isoliert.

Nützliche Befehle:

| Befehl                 | Zweck                                                  |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev`          | Entwicklungs-App starten                               |
| `npm run dev:web`      | Dev-App + Localhost-Web-Benutzeroberfläche (127.0.0.1) |
| `npm run dev:headless` | Dev-Backend + Web-UI, kein Electron-Fenster            |
| `npm run lint`         | ESLint ausführen                                       |
| `npm run typecheck`    | Typüberprüfung des Haupt- und Renderercodes            |
| `npm test`             | Vitest-Suite ausführen                                 |
| `npm run build`        | Typüberprüfung und Erstellung der Anwendung            |
| `npm run build:web`    | Optionale Localhost-Web-Benutzeroberfläche erstellen   |
| `npm run build:mac`    | macOS-Paket erstellen                                  |
| `npm run build:win`    | Windows-Paket erstellen                                |
| `npm run build:linux`  | Linux-Paket erstellen                                  |

Die gepackte Ausgabe wird unter `dist/` geschrieben.

### Localhost-Web- und Headless-Modi

Das Desktop-Backend kann optional denselben Renderer in einem Browser auf dem lokalen Computer bereitstellen. Diese Funktion ist standardmäßig deaktiviert und ausschließlich an `127.0.0.1` gebunden.

```bash
npm run build:web
npm run dev:web
```

Öffnen Sie die von der App ausgegebene authentifizierte URL. Mit `npm run dev:headless` starten Sie Backend, Infobereich, Agent-Runtime und Localhost-Webdienst ohne Electron-Fenster. Über `OPEN_SCIENCE_WEB_PORT` legen Sie den Port fest; der Standardwert ist `44100`. Beim ausdrücklichen Beenden der App werden Agenten- und Notebook-Prozesse weiterhin ordnungsgemäß heruntergefahren.

### Mobiler Fernzugriff

Über die Remote.It-Kopplung ist dieselbe Localhost-Web-UI auch auf einem Smartphone oder Tablet erreichbar. Koppeln Sie einen Browser mit einem sechsstelligen Open Science-Code und geben Sie ihn einmal auf dem Desktop frei. Der Arbeitsbereich bleibt erreichbar, ohne den Loopback-Server direkt freizugeben. Das Vertrauen für einen Browser kann widerrufen werden; Änderungen des Modus oder das Beenden des Dienstes machen aktive Remote-Sitzungen sofort ungültig.

### Headless CLI und SDK

Die Headless-CLI und das Node.js-SDK ohne zusätzliche Abhängigkeiten verwenden denselben lokalen Daemon sowie dieselben Projekte, Sitzungen, Anmeldeinformationen und Berechtigungen wie die Desktop- und Weboberflächen. Die ausführliche Anleitung liegt beim veröffentlichbaren Paket, sodass nur eine Befehlsreferenz gepflegt werden muss:

- [CLI-Anleitung](../../packages/open-science/CLI.md) – Installation, Dienstlebenszyklus, Aufgabenautomatisierung, Artefakte, Ausgabeformate und Exit-Codes
- [SDK-Paketübersicht](../../packages/open-science/README.md) – Node.js-Schnellstart und Einstiegspunkt des Pakets

## Häufig gestellte Fragen

### Was soll ich tun, wenn ich Open Science zum ersten Mal öffne?

A: Führen Sie die fünf Einrichtungsschritte aus: **Umgebung**, **Agent-Runtime**, **Modellanbieter**, **Notebook-Runtime** und **Datenspeicherort**. Bearbeiten Sie die mit `Action needed` gekennzeichneten Pflichtprüfungen, installieren oder reparieren Sie bei Bedarf das ausgewählte Agenten-Framework und testen Sie die Modellverbindung. Notebook-Einrichtung und benutzerdefinierter Datenspeicherort sind optional.

### Was ist ein API-Schlüssel und wo bekomme ich einen?

A: Ein API-Schlüssel ist ein geheimer Zugangsnachweis Ihres Modellanbieters. Erstellen oder kopieren Sie ihn in der Entwickler- oder API-Konsole des Anbieters. Über diesen Schlüssel können kostenpflichtige Anfragen abgerechnet werden. Behandeln Sie ihn wie ein Passwort: Geben Sie ihn nicht weiter und speichern Sie ihn niemals in einem Repository.

### Benötige ich einen API-Schlüssel?

A: Nicht, wenn Sie ein vorhandenes Abonnement-Login wiederverwenden – ein Claude-Abonnement über eine gemeinsame Browser-Anmeldung oder einen isolierten, von der App verwalteten `claude setup-token`-Flow oder ein ChatGPT/Codex-Abonnement-Login im Codex-Backend. Integrierte Cloud-Anbieter und benutzerdefinierte Gateways erfordern ihre eigenen Schlüssel.

### Welche Modellanbieter kann ich nutzen?

A: Öffnen Sie die Anbieterauswahl während der Einrichtung oder unter `Settings → Model`, um die Auswahlmöglichkeiten anzuzeigen, die von Ihrer installierten App und dem ausgewählten Agenten-Backend unterstützt werden. Sie können einen integrierten Cloud-Anbieter, ein kompatibles benutzerdefiniertes Gateway, ein Claude-Abonnement über gemeinsame oder isolierte Anmeldung oder ein Codex-Abonnement im Codex-Backend verwenden.

### Warum schlägt der Modellverbindungstest fehl?

A: Prüfen Sie den API-Schlüssel auf fehlende Zeichen oder Leerzeichen, kontrollieren Sie Basis-URL und Region, verwenden Sie die exakte Modell-ID des Anbieters und stellen Sie Netzwerkzugriff sowie ausreichendes Guthaben sicher. Bei einem Claude-Abonnement können Sie je nach ausgewähltem Modus die gemeinsame Browseranmeldung wiederholen oder die isolierten Anmeldedaten aus `claude setup-token` erneuern.

### Warum ist `Continue` während des Setups deaktiviert?

A: Mindestens eine Pflichtbedingung des aktuellen Schritts ist noch nicht erfüllt. Bearbeiten Sie alle mit `Action needed` gekennzeichneten Umgebungsprüfungen, installieren oder reparieren Sie die ausgewählte Agent-Runtime beziehungsweise validieren Sie den Modellanbieter. Die Notebook-Einrichtung ist optional und betrifft ausschließlich die Notebook-Ausführung.

### Die Einrichtung ist abgeschlossen. Wie starte ich eine Forschungsaufgabe?

A: Erstellen oder öffnen Sie ein Projekt, starten Sie eine Sitzung, hängen Sie alle Quelldateien an und beschreiben Sie das Ziel, die Einschränkungen, die erwartete Ausgabe und die Validierungskriterien. Verwenden Sie `@`, um auf eine Projektdatei zu verweisen, und `/`, um eine aktivierte Fähigkeit auszuwählen.

### Wie führe ich Jobs auf einem Remote-HPC-Cluster aus?

A: Aktivieren Sie die Fähigkeit **Remote Compute (SSH)** unter **Einstellungen → Fähigkeiten**, registrieren Sie den Cluster unter **Einstellungen → Rechenressourcen**, starten Sie eine Sitzung und wählen Sie `/remote-compute-ssh`. Die Fähigkeit übernimmt Hostregistrierung, kurze SSH-Befehle und vollständig asynchrone Jobs. Nach Abschluss eines Jobs startet die App automatisch eine Analyseinteraktion; eine eigene Polling-Schleife ist nicht erforderlich.

### Gibt es eine Befehlszeilenschnittstelle?

A: Ja. Installieren Sie das Befehlszeilentool unter **Einstellungen → Allgemein → Befehlszeile → Befehl installieren**. Dadurch wird `open-science` zu Ihrem PATH hinzugefügt; eine separate Node.js-Installation ist nicht erforderlich. Die CLI steuert den lokalen Dienst und übermittelt Forschungsaufgaben, ohne einen Browser zu öffnen:

```bash
# Start the service in the background
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

A: Öffnen Sie das generierte Artefakt und wählen Sie **Provenienz**. Wählen Sie eine Version aus, um Inhaltsidentität, verfügbaren Erzeugercode, Ausführungsverlauf, Eingaben, Umgebungsbestand, den erzeugenden Konversationskontext und Reviewer-Belege zu prüfen. Belege, die Open Science nicht verifizieren konnte, sind als nicht verfügbar gekennzeichnet.

### Kann ich eine frühere Anfrage überarbeiten, ohne die anschließende Konversation zu verlieren?

A: Ja. Bearbeiten Sie eine abgeschlossene Benutzernachricht und senden Sie sie erneut, um ab diesem Punkt einen neuen Branch zu erstellen. Die ursprünglichen nachfolgenden Interaktionen bleiben verfügbar. Mit den Versionspfeilen neben der Nachricht wechseln Sie zwischen den alternativen Pfaden.

### Bleiben meine Forschungsdaten auf meinem Computer?

A: Projekte, Sitzungen, Dateien, Einstellungen und konfigurierte Anmeldeinformationen werden standardmäßig lokal gespeichert. Inhalte, die für Modellanfragen, Websuchen oder Konnektoraufrufe benötigt werden, werden möglicherweise weiterhin an den von Ihnen ausgewählten externen Dienst gesendet. Überprüfen Sie daher vertrauliche Eingaben und Anbieterrichtlinien, bevor Sie eine Aufgabe ausführen.

## Machen Sie mit

Open Science freut sich über Fehlerberichte, Funktionsvorschläge, Designdiskussionen, Fragen aus der Community und Codebeiträge über GitHub, Discord, X oder die AIPOCH-Website. Wählen Sie den passenden Kanal und beachten Sie vor dem Teilen von Projektdetails die verlinkten Beitrags- und Sicherheitshinweise.

| Kanal                                                                    | Geeignet für                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Fehlerberichte, reproduzierbare Probleme und konkrete Funktionsvorschläge |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Designfragen, Roadmap-Vorschläge und längere technische Diskussionen      |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Community-Hilfe, Koordinierung der Mitwirkenden und informelle Diskussion |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Veröffentlichungsankündigungen und integrierte öffentliche Updates        |
| [Open-Science-Website](https://aipoch.com/open-science)                  | Offizielle Produktübersicht und Downloads                                 |

Entfernen Sie vor dem Erstellen eines öffentlichen Issues API-Schlüssel, Token, private Dateipfade, unveröffentlichte Daten, Patientenkennungen und anderes vertrauliches Material aus Protokollen und Screenshots. Informationen zum Entwicklungsworkflow finden Sie in [CONTRIBUTING.md](CONTRIBUTING.md).

> ⭐ **Repository mit einem Stern markieren:** Wenn Ihnen das Projekt hilft, freuen wir uns über einen Stern auf GitHub. Damit unterstützen Sie die weitere Entwicklung.

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
