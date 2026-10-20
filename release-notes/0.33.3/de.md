## ✨ Highlights

- **Seitenweise Dokumentprüfung.** Die Vorschau erhält seitenweises Office-Lesen mit Suchfunktion (#3024) und seitenweise PowerPoint-Prüfung, sodass lange Dokumente und Präsentationen komfortabel in der App gelesen werden. (#2991)
- **Enrichr-Genmengen-Anreicherung.** Der Gen-Konnektor fügt Enrichr-Werkzeuge hinzu: Durchsuchen Sie Anreicherungsbibliotheken und bewerten Sie Ihre Genmenge dagegen. (#2996)
- **Kompakte Library-Vorschau.** Die Workspace-Seitenleiste erhält eine kompakte Library-Vorschau für schnelle Überblicke, ohne den Arbeitsfluss zu verlassen. (#3030)
- **Windows-Signierung, abgeschlossen.** Die Codesignierung umfasst jetzt jede gebündelte ausführbare Datei, einschließlich der Notebook-Laufzeit-Runner. (#3001, #3011)

## 🚀 Neue Funktionen

- Seitenweises Lesen von Office-Dokumenten mit Suchfunktion im Vorschau-Panel. (#3024)
- Seitenweise PowerPoint-Prüfung: Blättern Sie mit Lesesteuerung Folie für Folie. (#2991)
- Kompakte Library-Vorschau im Workspace zum Überblick auf einen Blick. (#3030)
- Enrichr-Genmengen-Anreicherung im Gen-Konnektor: Verfügbare Bibliotheken auflisten und eine übermittelte Genmenge anreichern. (#2996)
- Intelligente Literature-Sammlungen erhalten eine Aktion zum Verwerfen von Bewertungen für Referenzen, die keine Prüfung mehr benötigen. (#2973)
- Sitzungspakete erhalten adaptive Geschwindigkeitsoptionen für Exporte und Importe. (#2997)
- Der Fortschritt von Hintergrund-Exporten wird minimiert, sodass lange Übertragungen nicht stören. (#3005)
- Tastenkürzel für die Anzeigeskalierung sind in einem einheitlichen Schema vereint. (#3018)
- Hover-Hinweise und Bubble-Bewegungen sind über die gesamte Oberfläche vereinheitlicht. (#3010)
- Neue Nachrichten werden im Nachrichtenzentrum animiert eingeblendet. (#3025)
- Die Nachrichtennavigation erhält eine dichte, durchgehende Hover-Welle für flüssigeres Scannen. (#3004)
- ClinPGx-Pharmakogenomik-Abfragen im klinischen Genomik-Konnektor: klinische Annotationen zu Arzneimittel-Gen-Varianten, Dosierungsrichtlinien, behördliche Kennzeichnungen, Variantenhäufigkeiten und Evidenzniveaus. (#3007)

## 🔧 Verbesserungen

- Die Windows-Codesignierung umfasst jetzt alle gebündelten ausführbaren Dateien, einschließlich signierter Notebook-Laufzeit-Runner, die beim Start überprüft werden. (#3001, #3011)

## 🐛 Fehlerbehebungen

- **Vorschau und Oberfläche** — Die Schriftgröße der PDF-Leseansicht stimmt mit der Datei-Kopfzeile überein (#3036); Tooltips erscheinen auf eingeklappten Seitenleisten-Symbolen (#3017); Zeilen-Klickflächen stimmen mit ihren Hover-Flächen überein (#3013); die Bubble-Einblendbewegung wird bei warmen Hover-Wechseln übersprungen (#3032); die Einblendbewegung wird beim Wechsel der Zitier-Vorschau übersprungen (#3038).
- **Notebook** — Kernel-Wiederherstellungen werden nach Lane isoliert, sodass die Wiederherstellung eines Kernels niemals einen anderen blockiert (#3031).
- **Sitzungen und Wiederherstellung** — Gesprächsspeicherungen werden während aktiver Läufe verschoben (#3012); fehlgeschlagene Wiederholungen bleiben wiederherstellbar und schließbar (#3019); Fehlermeldungen zu Läufen können geschlossen werden (#3002); die Archiv-Wiederherstellungssperre gilt nur für betroffene Projekte (#3023); umbenannte Diagnose-Exporte erhalten ein Archiv-Suffix (#3022).
- **Konnektoren und Literature** — Der native Dateizugriff respektiert gewährte Ordner (#3021); Crossref-Abstracts werden beim Vervollständigen der Metadaten importiert (#3020); die Klassifikation wählt für beide Funktionen das erste Modell (#3006).
- **Skills und Sitzungspakete** — Metadaten von Skills-Paketen und verwaltete Python-Laufzeiten werden korrekt verarbeitet (#3033); Sitzungspaket-Exporte erlauben numerische Cache-Nutzung (#3043); numerische Token-Metriken bleiben beim Export erhalten (#3040).
