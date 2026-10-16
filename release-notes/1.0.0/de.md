## ✨ Open-Science 1.0

AIPOCH Open-Science ist eine quelloffene KI-Forschungsumgebung mit lokaler Datenhaltung. Version 1.0 vereint Literatur, wissenschaftliche Daten, agentengestützte Analysen, überprüfbare Ergebnisse und übertragbare Forschungsaufzeichnungen unter macOS, Windows und Linux.

## 🚀 Forschungsfunktionen

- **Projekte und Gespräche:** Forschung in Projekten und Sitzungen organisieren, Nachrichtenverzweigungen und Nebengespräche nutzen, Sitzungen für andere Forschungswege kopieren und Pläne, Rückfragen, Werkzeugaktivitäten sowie Benachrichtigungen verfolgen.
- **Modelle und Agenten:** Claude Code, OpenCode, Codex oder CodeBuddy mit kompatiblen Cloud-Anbietern, eigenen Endpunkten oder unterstützten Claude-/Codex-Abonnementanmeldungen nutzen. Modelle und Denkoptionen konfigurieren, Nutzung einsehen und bei Bedarf das Projektgedächtnis aktivieren.
- **Fähigkeiten, Spezialisten und Konnektoren:** Forschungsfähigkeiten und Spezialisten über ihre Marktplätze installieren und aktualisieren oder selbst erstellen und importieren. Aufgaben delegieren und wissenschaftliche Ressourcen über integrierte Konnektoren oder eigene MCP-Server mit begrenzten Berechtigungen nutzen.
- **Python, R und Berechnungen:** Code in dauerhaften Notebook-Umgebungen ausführen, Variablen und Ausführungsverläufe prüfen, Pakete verwalten und `.ipynb` exportieren. Hintergrundaufgaben lokal oder auf eingerichteten SSH-Hosts und Slurm-Clustern ausführen, abbrechen, wiederherstellen und Ergebnisse einsammeln.
- **Literatur und PDFs:** Referenzen, Sammlungen, Tags, Notizen und Dubletten verwalten, frei zugängliche Volltexte finden und Publikationen nach Forschungskriterien sichten. PDFs lesen und annotieren, Abbildungen und Tabellen extrahieren, Quellen im Gespräch verwenden und Bibliografien sowie BibTeX/RIS exportieren.
- **Dateien und Artefakte:** Wissenschaftliche Tabellen, Sequenzen, Molekülstrukturen, PDFs, Office-Dokumente, Bilder und Code anzeigen. Unterstützte Textformate bearbeiten und unveränderliche Artefaktversionen mit erfasstem Code, Eingaben, Ausführungsverlauf und Umgebungsnachweisen behalten.
- **Prüfung und Verifikation:** Eine optionale Prüfung eines Agentendurchlaufs und seiner verfügbaren Nachweise aktivieren. Geeignete Artefaktversionen in der Desktop-App mit vollständigem Ausführungsrezept und nutzbarer Laufzeit erneut ausführen, Ausgaben vergleichen sowie Prüfprotokolle und kompatible erfasste Umgebungsbündel exportieren.
- **Forschungsaustausch:** Ausgewählte Gesprächszweige, Dateien, Notebook-Aufzeichnungen und Prüfnachweise als `.science`-Paket exportieren. Importierte Aufzeichnungen schreibgeschützt ansehen, aufgezeichnete Schritte abspielen, Inhalte besprechen oder in einer beschreibbaren Kopie weiterforschen. Artefaktherkunft als RO-Crate exportieren.
- **Desktop, Browser und Automatisierung:** Desktop, lokale Weboberfläche, gekoppelten mobilen Browser oder eigenständige CLI und Task SDK verwenden. Die Oberfläche bietet Englisch und acht Übersetzungen; der dokumentierte Funktionsumfang unterscheidet sich je nach Zugang.
- **Lokale Daten und Kontrolle:** Forschungsaufzeichnungen lokal speichern, Werkzeug- und Ordnerberechtigungen prüfen, unterstützte Netzwerkkontrollen konfigurieren und Diagnosen bei Bedarf exportieren. Modellanbieter, entfernte Konnektoren und Rechenhosts tauschen weiterhin Daten mit ihren konfigurierten Diensten aus.

## 🧭 Umfang und Grenzen

- Modellprotokolle und Funktionen hängen vom Agentenframework ab. Desktop, Browser und CLI bieten nicht dieselben Funktionen; Sandbox-Schutz hängt von Ausführungspfad und Plattform ab. WSL2 Bash bleibt eine ausdrücklich aktivierbare Vorschau unter Windows x64.
- Sitzungswiedergabe führt keinen Code aus. Artefaktverifikation benötigt erfasste Eingaben und eine verfügbare Umgebung; sie garantiert weder deterministische Wiederholung ganzer Sitzungen noch wissenschaftliche Gültigkeit. Literatursichtung und optionale Prüfung unterstützen das fachliche Urteil.
- Importierte `.science`-Aufzeichnungen sind schreibgeschützt und stellen keine Zugangsdaten wieder her. Nebengespräche und private Lesezeichen werden nicht mitexportiert. Umgebungsbündel müssen vollständig und mit der Zielplattform kompatibel sein.
- Entfernte Berechnungen unterstützen SSH und Slurm. Verwaltete Cloud-GPU-Aufträge, ein lokales GPU-Backend und gemeinsame Bearbeitung in Echtzeit sind nicht Teil von 1.0.

## 📦 Installation und Upgrades

- Desktop-Installationsprogramme und eigenständige CLI-Pakete sind auf der [Downloadseite](https://aipoch.com/open-science/download) und unter [GitHub Releases](https://github.com/aipoch/open-science/releases) verfügbar. CLI-Archive enthalten Node und heißen `open-science-cli-<version>-<target>`; Skripte mit dem alten Präfix müssen angepasst werden.
- Die CLI über das zuständige Installationsprogramm oder den Paketmanager aktualisieren; `open-science update` ist nicht mehr verfügbar. Desktop-Updates bleiben verfügbar. Vor dem Ersetzen einer eigenständigen Installation alle darüber laufenden Profile stoppen und übereinstimmende Desktop-/Backend-Versionen verwenden.
- 1.0 behält bestehende Upgrade- und Importpfade für historische Daten bei; der Versionswechsel führt kein neues Datenformat und keine Migration ein. Vor dem Upgrade das Profil sichern. Ein Binär-Downgrade setzt Daten nicht zurück; ältere Programme können neuere Daten möglicherweise nicht lesen.
- Die [1.x-Kompatibilitätsrichtlinie](https://github.com/aipoch/open-science/blob/main/docs/compatibility.md) gilt für dokumentierte CLI-/SDK-Schnittstellen, Task-Automatisierung, `.science`-Importe und unterstützte Profil-Upgrades. Sicherheitskorrekturen gelten für die neueste stabile Version und `main`.
