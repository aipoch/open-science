## ✨ Highlights

- **Persistente PDF-Annotationen und Dokument-Notebooks.** Notizen und Annotationen bleiben jetzt bei der Dateiversion, zu der sie gehören: Textstile, Bereichsmarkierungen, Seiten- und Dokumentnotizen, Kommentare, Farben, globale Tags, Rückgängig/Wiederholen sowie der Import nativer PDF-Annotationen — mit Export in eine separate annotierte PDF oder Markdown/CSV-Notizen, während die Quellbytes unverändert bleiben. Anhänge der Literaturbibliothek teilen ihr Notebook über Referenzen, Projekte und Sitzungen hinweg; Projekt-Uploads und Artefakte teilen es über die Sitzungen des zugehörigen Projekts hinweg. (#2853)
- **Vollständiger RO-Crate-Artefaktexport.** Eine verifizierte Artefaktversion lässt sich jetzt als vollständiges RO-Crate-1.1-Archiv zusammen mit ihren exakten Eingaben verpacken — deklarierte Größen und Prüfsummen werden verifiziert, bevor die Daten übernommen werden, identische Inhalte werden dedupliziert, und widersprüchliche Inhalte werden abgelehnt. (#2685)
- **NCBI-BLAST-Sequenzsuche.** Neue asynchrone Tools reichen eine Nukleotid- oder Proteinabfrage an NCBI BLAST weiter, verfolgen den Auftrag bis zum Abschluss und rufen den Bericht im gewünschten Format ab — damit hält die Ähnlichkeitssuche für unbekannte Sequenzen Einzug in den Genomes-Konnektor. (#2829)
- **Umfangreichere Omics-Recherche.** ENA-Runs lassen sich anhand von Organismus, Bibliotheksstrategie oder Stichwort finden — mit den ursprünglich eingereichten Dateien (BAM, CRAM) neben den Archiv-FASTQ; PRIDE-Projekte bieten seitenweise Dateilisten; UniProt-Einträge lassen sich über Genname, Proteinbegriff und Organismus finden, bevor Sequenzen abgerufen werden. (#2852, #2844, #2857)

## 🚀 Neue Funktionen

- Die Installation lokaler PDF-Parsing-Modelle erprobt verifizierte Spiegelserver, wenn der primäre Download nicht erreichbar ist, und ordnet sie nach Antwortzeit — Installationen scheitern nicht mehr an einer einzigen Quelle. (#2837)
- Die Auswahl von Fähigkeiten kann einen benutzerdefinierten, TypeSafe-kompatiblen Klassifikationsdienst ansteuern — Endpunkt-URL, Modell-ID und ein optionaler API-Schlüssel. Loopback-Endpunkte ohne Schlüssel sind erlaubt; entfernte Endpunkte erfordern HTTPS und Anmeldedaten. (#2832)
- Step-5 Preview von StepFun kommt mit multimodaler Unterstützung, einem Kontextfenster von einer Million Token sowie den Regionen China und Global in den Anbieterkatalog; bestehende Anbieter behalten ihren bisherigen Endpunkt. (#2825)
- Unbeaufsichtigte CLI-Aufgabenausführungen können jetzt das Warten auf Menschen ganz ablehnen — Automatisierung bleibt so nie an einer Freigabe oder einer Frage hängen, die nie kommen wird. (#2848)

## 🔧 Verbesserungen

- Start und lange Konversationen laufen leichter: Die Evidenz-Wiederherstellung wird gebündelt und die Sitzungshydratation wiederverwendet, die Markdown-Darstellung wird aufgeschoben, bis sie gebraucht wird, Markdown-Beobachter sparen redundante Durchläufe ein, Annotations-Beobachter pausieren, während Streams aktiv sind, Vorschauen von Unteragenten laden erst, wenn sie angezeigt werden, und inaktive Bildlaufleisten verbergen sich von selbst. (#2826, #2629, #2831, #2841, #2822, #2823, #2843)
- Der Agent klassifiziert mehrdeutige Leseanfragen zu verknüpften PDFs, statt stets auf die fokussierte Abfrage zurückzufallen, sodass indirekte Anfragen zum Gesamtdokument vollständig gelesen werden. (#2828)

## 🐛 Fehlerbehebungen

- **Sitzungen und Agent-Laufzeit** – OpenCode-Tool-Verbindungen werden pro Sitzung isoliert, sodass Geschwister-Sitzungen nicht mehr die Notebook-, Artefakt- oder Plan-Tools der jeweils anderen aufrufen können (#2856); die Eigentümerschaft an der Wiederherstellung übersteht die Artefakt-Veröffentlichung (#2839); Side-Chats beschränken ihre Konversationen und in der Warteschlange wartenden Hinweise auf den aktuellen Anwendungslauf (#2827).
- **Berechnung und Speicher** – die Bereitstellung von Berechnungen im Hintergrund ist wiederhergestellt und der Abbruch von Aufträgen wird bestätigt (#2854); Dateisystem-Freigaben werden nach einer unvollständigen Notebook-Bereinigung abgelehnt (#2851).
- **Konnektoren** – gnomAD liefert keine ungeeigneten mitochondrialen Datensätze mehr (#2840).
- **Oberfläche** – die Textauswahl bleibt über PDF-Annotations-Overlays hinweg erhalten (#2860); die Schnellsuche in den Einstellungen springt Fokus und Anker präzise an (#2570); Fokusrahmen von Datei-Kacheln bleiben nach dem Schließen des Vorschau-Dialogs vollständig sichtbar (#2017); Inline-Wiederherstellungswarnungen füllen die verfügbare Breite und platzieren Aktionen unter dem erläuternden Inhalt (#2850, #2855).
