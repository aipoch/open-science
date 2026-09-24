## ✨ Highlights

- **Live-Sichtung intelligenter Literatursammlungen.** Intelligente Sammlungen sichten Referenzen jetzt live, mit Steuerung zum Unterbrechen und Fortsetzen, sodass große Sichtungsläufe von Anfang bis Ende unter Ihrer Kontrolle bleiben. (#2968)
- **Neue Konnektoren und Alignment-Werkzeuge.** HMMER kommt als Konnektor für Sequenz-Homologiesuchen gegen Profildatenbanken hinzu (#2957); InterProScan kommt als Konnektor hinzu, der den Status vorhandener Annotationsjobs prüft und deren Ergebnisse abruft (#2935); und der Genomes-Konnektor erhält Clustal-Omega-Multiple-Sequence-Alignment (#2944).
- **Aktualisierung der Anbieterkataloge.** GPT-6 und Claude Opus 5.5 kommen in die Anbieterkataloge und lassen sich in neuen und bestehenden Konfigurationen direkt auswählen. (#2967)
- **PDF-Evidenz reist mit der Unterhaltung mit.** Unterhaltungen im Arbeitsbereich können jetzt zusammen mit der ersten Nachricht PDF-Evidenz mitführen, sodass der Kontext ankommt, bevor der Agent mit der Arbeit beginnt. (#2941)

## 🚀 Neue Funktionen

- Live-Sichtung intelligenter Literatursammlungen: Sichtungsläufe bewerten Referenzen bei Eintreffen und können jederzeit unterbrochen und fortgesetzt werden. (#2968)
- HMMER-Konnektor: Durchsuchen Sie Protein- oder Nukleotidsequenzen gegen HMM-Profildatenbanken, um homologe Familien zu identifizieren. (#2957)
- InterProScan-Konnektor: Prüfen Sie den Status vorhandener InterProScan-Annotationsjobs anhand der Job-ID und rufen Sie deren Ergebnisse ab. (#2935)
- Clustal-Omega-Multiple-Sequence-Alignment kommt in den Genomes-Konnektor: Richten Sie drei oder mehr FASTA-Protein-, DNA- oder RNA-Einträge mit EMBL-EBI Clustal Omega aus und rufen Sie eine herunterladbare Alignmentsdatei ab. (#2944)
- Die Modelle GPT-6 und Claude Opus 5.5 kommen in die Anbieterkataloge. (#2967)
- Unterhaltungen im Arbeitsbereich können mit der ersten Nachricht PDF-Evidenz enthalten, sodass der Agent das Quellmaterial sieht, bevor er beginnt. (#2941)
- Sitzungsdiagnosen können bei explizitem Opt-in sensible Paket-Evidenz enthalten und liefern so tieferen Kontext für die Fehlersuche. (#2947)
- Literatursammlungen unterscheiden und verknüpfen jetzt ihre Geltungsbereiche, sodass persönliche und geteilte Sammlungen klar getrennt und miteinander verbunden sind. (#2938)

## 🔧 Verbesserungen

- Der Abschnittskopf der Anbieter in den Einstellungen erhält eine direkte Anbieteraktion, sodass das Hinzufügen oder Anpassen von Anbietern weniger Schritte erfordert. (#2970)
- Dateien im Arbeitsbereich erhalten einheitliche Dateityp-Symbole, sodass sich gemischte Ordner auf einen Blick erfassen lassen. (#2965)

## 🐛 Fehlerbehebungen

- **Notebook** – Windows-verwaltete Python-Laufzeiten werden wiederhergestellt und der verwaltete Python-Pfad während der Erkennung aktiviert, sodass app-verwaltete Umgebungen unter Windows wieder funktionieren (#2953, #2951); wenn der Zugriff auf die R-Laufzeit verweigert wird, fordert die App jetzt zur Eingabe auf, statt still zu scheitern (#2930).
- **Sitzung** – Speicher-Races bei Laufzeit und Rechenleistung erholen sich sauber, statt Arbeit zu verlieren (#2955); Fortsetzung und Offenlegung der Überprüfung sind stabilisiert (#2950); eine nicht verfügbare Zulassung wird einmal erneut versucht, bevor aufgegeben wird (#2943).
- **Agentenbrücke** – Die ACP-Brücke stellt die Verbindung wieder her, wenn sich die Vision-Fähigkeit ändert, sodass Sitzungen nach einem Fähigkeits-Update nicht mehr hängen bleiben (#2963).
- **Arbeitsbereich** – Der Composer bleibt beschäftigt, während eine Agentenanfrage aktiv ist, und verhindert so versehentliche Doppelversände (#2836); die Identität der PDF-Vorschau bleibt beim ersten Senden erhalten (#2948).
- **Einstellungen** – Globale und lokale Suchkürzel sind getrennt und kollidieren nicht mehr (#2934); mehrsprachige Konnektor-Texte sind vervollständigt (#2946).
- **Fähigkeiten** – Workflows zum Zuschneiden und Überarbeiten von Abbildungen funktionieren wieder korrekt (#2936).
- **Speicher** – Historische Datenspeicherorte bleiben über Aktualisierungen hinweg erhalten und geschützt (#2865).
- **Pakete und Onboarding** – Token-Flags werden nicht mehr innerhalb unzusammenhängender Wörter erkannt (#2940); die DeepSeek-Markendarstellung im Onboarding ist normalisiert (#2939).
- **Oberfläche** – Der Bearbeitungstooltip für Anmerkungen ist vereinfacht (#2966); der Windows-Installer meldet Aufräumfehler mit umsetzbaren Diagnosen (#2952).
