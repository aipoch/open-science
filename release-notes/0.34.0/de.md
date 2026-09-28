## ✨ Highlights

- **Native Linux ARM64.** Open Science liefert jetzt neben x64 auch ARM64-Installer für Linux und deckt damit Apple-Silicon-Linux-VMs und ARM-Workstations ab. (#3106)
- **Konnektor-Erweiterung.** Ein neuer Pathway-Commons-Konnektor ergänzt die erweiterten cBioPortal-, openFDA-, MGnify- und Bgee-Expressionsquellen für Querschnittsarten. (#3113, #3101, #3097)
- **Sitzungsnavigation im Tray.** Das Desktop-Tray-Menü listet jetzt Sitzungen auf, sodass Sie schnell wechseln können, ohne das Hauptfenster zu öffnen. (#3047)
- **Electron 43.** Die App aktualisiert auf Electron 43 und erhält damit eine neuere, besser unterstützte Laufzeit. (#3060)

## 🚀 Neue Funktionen

- Native Linux ARM64-Installer ergänzen die bestehenden x64-Pakete. (#3106)
- Pathway-Commons-Konnektor: Pathways durchsuchen, Top-Pathways auflisten, Interaktionsgraphen prüfen und Ergebnisse exportieren. (#3113)
- Bgee-Expressionswerkzeuge für Querschnittsarten: Expression-Calls, Download-Links und SPARQL-Abfragen über Arten hinweg. (#3097)
- Erweiterte cBioPortal-, openFDA- und MGnify-Konnektoren mit breiterer Abfrageabdeckung. (#3101)
- MiniMax M3.1 Flash Preview als integrierte Provider-Option. (#3110)
- Journal-Datensätze mit Referenzattributen zur Organisation von Literatursammlungen. (#3095)
- Sitzungsnavigation im Tray auf dem Desktop für schnellen Sitzungswechsel. (#3047)
- Workspace-Referenzaktionen für die Arbeit mit Literaturreferenzen im Kontext. (#3058)
- Verfeinerte Library-Referenzvorschau und Nachrichtenbereiche. (#3042)
- Upgrade auf die Electron-43-Laufzeit. (#3060)

## 🔧 Verbesserungen

- Workspace-Wechsel behalten Sitzungszeilen, wodurch die Seitenleistennavigation spürbar schneller wird. (#2992)
- Die Interpreter-Erkennung startet weniger Unterprozesse und beschleunigt damit den Laufzeitstart. (#3055)

## 🐛 Fehlerbehebungen

- **Sitzungen und Wiederherstellung** — Sitzungspakete erkennen serialisierte geschwärzte Bearer-Werte (#3112); die Wiederherstellung setzt nach Agent-Verbindungsfehlern fort (#3104); neue Unterhaltungen können während der Sendevorbereitung beginnen (#3109); Delegation wird nach Stopp und Neustart der App wiederhergestellt (#3092); die native Kontext-Kompaktierung setzt sich zuverlässig (#3053); Prisma-Konfiguration und Fortsetzungszulassung sind gehärtet (#3028); der Subagent-Verlauf bleibt über Vorschau-Lebenszyklen erhalten (#3091); Notebooks behalten die erste Ausführungsvorschau im Hintergrund (#3054).
- **Literatur und PDF** — Die Extraktion von Abbildungen und Tabellen ist gehärtet (#3096); fehlende Metadaten und PDF-Importdetails werden wiederhergestellt (#3049); alle Referenzen öffnen aus der Library-Vorschau (#3068); der Abstand der Vorschau-Referenzen ist verdichtet (#3103).
- **Reviewer und Laufzeiten** — unterbrochene Korrekturbewertungen setzen fort (#3093); die Codex-Laufzeit erfordert eine unterstützte CLI und repariert veraltete Laufzeiten (#3052).
- **Remote Computing** — macOS-Remote-Verzeichnisauflistungen werden unterstützt (#3085); WSL-Laufzeitbereitschaft und Lebenszyklus-Benachrichtigungen sind gehärtet (#3090).
- **Workspace-UX** — Bearbeitungen sind geschützt und Workspace-Aktionen sind klarer (#3063); die Mehrfachauswahl in der Library ist optional mit abgeflachten Chat-Schaltflächen (#3062); Tastaturfokus und Escape-Navigation sind verfeinert (#3059); Layout-, Barrierefreiheits- und Workflow-Regressionen sind behoben (#3077); veraltete Annotation-Neuladen-Rückrufe werden ignoriert (#3061).
- **Einstellungen und Erklärungen** — Der Claude-Installer behandelt Weiterleitungen und HTML-Antworten (#3098); Erklärungen zu lokalem Server, Laufzeitberechtigungen und deaktivierten Steuerelementen sind klarer (#3070, #3087, #3080).
