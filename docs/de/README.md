<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  AIPOCH Open-Science ist eine quelloffene, lokal ausgerichtete KI-Forschungsumgebung für reproduzierbare Wissenschaft mit flexibler Modellauswahl. Geben Sie ein portables <code>.science</code>-Paket weiter, damit andere die Belege für ein Ergebnis prüfen können, oder zeigen Sie den Weg zum Ergebnis in einem Forschungsfilm.
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">
    <img width="720" alt="AIPOCH Open-Science Demo zur Erstellung eines .science-Pakets" src="../images/readme/demo-full.webp" />
  </a>
</p>

<p align="center">Auf YouTube ansehen: <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">AIPOCH Open-Science: Generating .science Research Packages (Demo)</a></p>

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

### 💡 AIPOCH Open-Science v1.2.2 — Neuerungen

_12. November 2026_

- **Strenger Netzwerkmodus**: Opt-in für eine strikte Whitelist beim Notebook-Netzwerkzugriff — Anfragen müssen Ihren Regeln nach Protokoll, Host und Port entsprechen; nicht übereinstimmende Anfragen werden ohne Autorisierungsabfrage blockiert.
- **Filme setzen sich fort**: Eine unterbrochene Forschungsfilm-Erzeugung läuft an validierten Prüfpunkten mit einer Fortschrittsanzeige in fünf Schritten weiter; fertige Szenen und Kommentar werden wiederverwendet.
- **PDF-Qualität**: Externe PDFs behalten native Abbildungen, Tabellen, Bildunterschriften und Lesereihenfolge, und übersetzte Dokumente bewahren die ursprüngliche Struktur und das Layout.
- **Sicherere Windows-Berechtigungen**: Ordnerberechtigungen im geschützten Modus werden vor dem Speichern geprüft; Update-, Deinstallations- und Übergabe-Abläufe erholen sich zuverlässiger und bewahren ihre Diagnosen.
- **Anbieter-Aktualisierungen**: Qwen4 Max Preview ergänzt Bailian Token Plans in Peking und Singapur, und die Standardmodelle offizieller Verbindungen werden erneuert.
- **Zuverlässigkeitskorrekturen**: Sitzungsimporte melden ihr Ergebnis, die Dienstwiederherstellung blockiert den Workspace, bis die Verbindung zurückkehrt, und der Kontrast im Dunkelmodus bleibt über alle Flächen erhalten.

[Vollständige Versionshinweise v1.2.2](https://github.com/aipoch/open-science/releases/tag/v1.2.2)

<a id="share-your-research"></a>

## Ein Forschungsprotokoll zum Teilen, ein Film zum Anschauen

Geben Sie mit einem [`.science`-Paket](https://aipoch.com/docs/guides/research-packages/) ausgewählte Gesprächszweige, Dateiversionen, Notebook-Protokolle und Prüfnachweise weiter. Andere können das Paket in ihr Projekt importieren und im schreibgeschützten Protokoll eine Abbildung oder Tabelle bis zu den Eingabedaten zurückverfolgen. Die Nachweise dokumentieren die Prüfungen des Absenders. Ein Fork in der Desktop-App erstellt eine bearbeitbare Kopie.

Erstellen Sie aus einem abgeschlossenen Gesprächszweig in der Desktop-App einen [Forschungsfilm](https://aipoch.com/docs/guides/research-films/). Das konfigurierte Modell erstellt die Präsentation anhand des Sitzungsprotokolls. Die lokale Sprachausgabe erzeugt den englischen Kommentar. Prüfen Sie den Film und laden Sie den HTML-Player herunter oder exportieren Sie eine MP4-Datei. Ein `.science`-Paket kann auch den Player eines bereits erstellten Films aus einem enthaltenen Zweig mitführen.

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

<a id="kernkompetenzen"></a>

## Was können Sie mit AIPOCH Open-Science tun?

| Aufgabe                   | Vorgehen                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Literatur prüfen          | Quellen aus Zotero importieren, Arbeiten nach eigenen Kriterien auswählen und Aussagen im Original-PDF prüfen.                                                              |
| Daten analysieren         | Python oder R im Notebook ausführen und Tabellen und Abbildungen neben den Ausgangsdateien prüfen.                                                                          |
| Ergebnisse nachvollziehen | In der Provenienzansicht Eingaben, Code und Verlauf einer Dateiversion prüfen. Sind Rezept, Eingaben und Laufzeitumgebung vorhanden, lässt sich die Berechnung wiederholen. |
| Ergebnisse weitergeben    | Mit einem [`.science`-Paket](#share-your-research) die Schritte und Dateiversionen hinter einem Ergebnis zugänglich machen.                                                 |
| Abläufe erweitern         | Wissenschaftliche Datenkonnektoren aktivieren, integrierte Fähigkeiten auswählen oder weitere Fähigkeiten und Spezialisten aus den Marktplätzen installieren.               |
| Modell wählen             | Einen unterstützten Anbieter, ein eigenes Gateway oder ein unterstütztes Claude- oder Codex-Abonnement nutzen. Die verfügbaren Protokolle hängen vom Agenten-Backend ab.    |

## Benchmark-Ergebnisse

AIPOCH hat AIPOCH Open-Science bei Aufgaben vom Auffinden einer Publikation über Fragen zu ihrem Inhalt bis zur Ausführung eines Forschungsplans bewertet. Die folgenden Ergebnisse stammen aus eigenen Testläufen von AIPOCH. Jeder Wert bezieht sich auf eine bestimmte Aufgabe und Bewertungskonfiguration. Die Evaluation umfasst auch die Reproduktion von Rechenergebnissen und die Ableitung von Hypothesen aus Daten.

| Aufgabe                                  | Benchmark              | Ergebnis von AIPOCH Open-Science                                                                                                                                                                          |
| ---------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zielpublikation finden                   | LitQA2-FullText-Search | Bei **68 von 75 Testfragen** erschien die Zielpublikation unter den ersten 30 Ergebnissen von LitQA2-FullText-Search (**90.67% Recall@30**, gpt-6-astra).                                                 |
| Fragen anhand der Literatur beantworten  | LitQA2-FullText        | In einem separaten LitQA2-FullText-Lauf beantwortete Open-Science **70 von 75 Testfragen richtig** (**93.33% Genauigkeit**, deepseek-flash mit Max-Reasoning).                                            |
| Eine Antwort mit Quellen zusammenführen  | ScholarQA-CS2          | Auf 100 Validierungsfragen von ScholarQA-CS2 erreichte Open-Science mit deepseek-v4-flash einen **zusammengesetzten Qualitätswert von 0.9289/1**. Die offiziellen Testreferenzen verwenden andere Fragen. |
| Forschungsabläufe ausführen              | ASI-Bench              | In lokalen ASI-Bench-Läufen mit demselben Modell erzielte Open-Science auf B4 **59.46**, Codex **55.45**. Auf B2 waren die Werte nahezu gleich (**56.11** und **56.09**).                                 |
| Wissenschaftliche Aufgaben ausführen     | TB-Science 0.1         | Bei 70 Aufgaben: **145/210** lokale Versuche bestanden (**69.05%**) mit GPT-6 Astra/max. Kein offizieller Ranglistenplatz; Einzelprotokolle sind nicht veröffentlicht.                                    |
| Biomedizinische Daten analysieren        | BiomniBench-DA         | Auf BiomniBench-DA Public 50 bewerteten zwei Bewertungsmodelle die Ergebnisse mit **81.04** und **77.06**. Ihr gleich gewichteter Mittelwert betrug **79.05**.                                            |
| Veröffentlichte Ergebnisse reproduzieren | CORE-Bench-Hard        | CORE-Bench-Hard — Im lokalen Test waren 36 von 37 Aufgaben korrekt (97,30 %). Die Auswertung enthält Wiederholungen.                                                                                      |
| Hypothesen aus Daten ableiten            | DiscoveryBench         | DiscoveryBench — Bei 25 Aufgaben aus dem Validierungssatz vergab ein lokales Bewertungsmodell im Mittel 0,7467/1.                                                                                         |

<details>
<summary>Evaluationsumfang und Berichte</summary>

**Bewertungsumfang:** Die Berichte umfassen lokale oder interne Läufe von August bis November 2026 mit den angegebenen Modellen und Datensplits; für die aktuelle Version wurden sie nicht wiederholt. Referenzwerte sind historische Momentaufnahmen, keine Live-Ranglisten. Werte verschiedener Benchmark-Familien sind nicht direkt vergleichbar, und numerische Unterschiede belegen keine statistische Signifikanz.

Details stehen im [AstaBench- und ASI-Bench-Bericht](https://aipoch.com/benchmark/open-science) sowie im [BiomniBench-DA-Bericht](https://aipoch.com/blog/open-science-biomnibench-da). Siehe auch das [lokale Ergebnis zu TB-Science 0.1](https://aipoch.com/blog/aipoch-open-science-terminal-bench-science-local-result).

[CORE-Bench-Hard · Bericht zur Reproduzierbarkeit](https://aipoch.com/blog/aipoch-open-science-core-bench-hard)

</details>

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

## Entwicklerleitfäden

- **Entwicklung** · [Aus Quellcode bauen und paketieren](../development-quick-reference.md) · [Mitwirken](../../CONTRIBUTING.md)
- **Open-Science betreiben** · [Eigenständige Laufzeitumgebung](../standalone-runtime.md) · [Dienstlebenszyklus](../../packages/open-science/CLI.md#service-lifecycle) · [Mobilgerät koppeln](https://aipoch.com/docs/guides/remote-access/#mobile-pairing)
- **Automatisierung** · [CLI](../../packages/open-science/CLI.md) · [Node.js SDK](../../packages/open-science/README.md) · [MCP-Client verbinden](../../packages/open-science/CLI.md#external-agents-through-mcp)

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
