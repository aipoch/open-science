## ✨ Highlights

- **Private Lesezeichen für Ihr Lesen.** Speichern Sie eine beliebige Passage aus dem Gesprächstext, eine Textvorschau oder eine PDF-Text- bzw. Bereichsauswahl als sitzungsbezogenes Lesezeichen mit optionaler Notiz; springen Sie aus einer Liste im Eingabefeld zurück, bearbeiten Sie Notizen über die dauerhaften Markierungen und öffnen Sie nach einem Neustart die exakte Dateiversion – alles, ohne etwas an den Agenten zu senden. (#2578)
- **Nebengespräche werden unabhängige Registerkarten.** Mehrere Nebengespräche können jetzt unter einer Sitzung laufen, jedes als eigene benannte Vorschauregisterkarte, während das Hauptgespräch vollständig interaktiv bleibt; verschieben Sie Anmerkungen per Drag-and-Drop oder über das gemeinsame Aktionsmenü zwischen den Entwürfen von Haupt- und Nebengespräch. (#2558)
- **Ein neu gestaltetes Einstellungszentrum.** Siebzehn Bereiche wurden zu vier zweckbasierten Abschnitten neu gruppiert – Intelligenz, Verbindungen, Arbeitsbereich, System – mit einstellungsweiter Suche, die per Deep-Link zum passenden Bereich führt, übersetzten Meldungen zu Schreibfehlern und einheitlichen Stapelaktions-Docks für Fähigkeiten, Konnektoren und Spezialisten. (#2453, #2533, #2522, #2542)
- **Schärfere globale Suche.** Eine Spalte mit erweiterten Filtern klappt aus der Kategoriezeile aus, und ein Pin hält Ihre gewählte Filterkombination fixiert, während Sie die Ergebnisse durchstöbern. (#2551, #2529)
- **Agenten können extrahierte PDF-Elemente lesen.** Für verknüpfte PDFs können Agenten die in der Strukturansicht bereits extrahierten Abbildungen, Tabellen und Algorithmen auflisten und lesen – eine Beschriftung ist nicht mehr der einzige Beleg für einen gezeichneten Trend oder einen Tabellenwert. (#2528)

## 🚀 Neue Funktionen

- **Private sitzungsbezogene Lesezeichen** – Gesprächstext, native Textvorschauen sowie PDF-Text oder PDF-Bereiche, jeweils mit optionaler Notiz; Lesezeichen bleiben über Neustarts hinweg erhalten, überstehen den Neuaufbau der Projektion, öffnen die exakte verwaltete Dateiversion erneut und werden zusammen mit ihrer Sitzung entfernt. (#2578)
- **Unabhängige Vorschauregisterkarten für Nebengespräche** – stabile Identität pro Gespräch, mehrere Geschwister pro übergeordneter Sitzung, sichtbare und zugängliche Benennung als `Side chat`, bestätigtes zerstörendes Schließen mit Wiederherstellung der Registerkarte, falls die Bereinigung fehlschlägt. (#2558)
- **Neugestaltung des Einstellungszentrums** – Navigation mit vier Gruppen, ein Suchfeld in der Kopfzeile (per Tastenkürzel für die Einstellungssuche fokussiert), das repräsentative Einträge jedes Bereichs mit Tastaturnavigation und Deep-Links abdeckt, ein gemeinsames Kopfbereichslayout der Bereiche, strukturierte, übersetzbare Fehlercodes beim Schreiben sowie Leeren-Schaltflächen in den Einstellungssuchfeldern. (#2453)
- **Filterinsel der globalen Suche und fixierter Filter-Umschalter** – die Spalte mit erweiterten Filtern stapelt die bestehenden Steuerelemente für Bereich, Reihenfolge, Zeit und Verfeinerung, setzt sich beim erneuten Öffnen zurück und berücksichtigt reduzierte Bewegung; der Umschalter für fixierte Filter hält die gewählte Filterkombination aktiv. (#2551, #2529)
- **PDF-Elemente für Agenten** – `list`- und `read`-Zugriff auf die bereits aus verknüpften PDFs extrahierten Abbildungen, Tabellen und Algorithmen, sodass die Evidenz hinter einem gezeichneten Trend oder einem Tabellenwert direkt erreichbar ist. (#2528)
- **Aktualisierungen des Anbieterkatalogs** – SenseNova erweitert sich um China- und Global-Endpunkte mit aktualisierten Chat-Modellen (#2541), und kuratierte kostenlose Gateway-Modelle ergänzen den Katalog.
- **Sitzungsnummern erscheinen in den Hover-Details** (#2584), und einheitliche Stapelaktions-Docks richten die Kataloge für Fähigkeiten, Konnektoren und Spezialisten aus (#2533, #2522, #2542).

## 🔧 Verbesserungen

- Die App leistet im Leerlauf weniger Arbeit: Die Wiederherstellung der Ergebnisübermittlung durchsucht den Sitzungskatalog nicht mehr neu, wenn nichts aussteht, überlappende Arbeitsbereich-Snapshots werden dedupliziert, abgeschlossene Remote-Joblisten ticken nicht weiter, und abgebrochene Läufe stoppen ihre Timer. (#2585)
- Die Update-Behandlung stellt unterbrochene Starts der Befehlszeile wieder her, bevor der Updater neu gestartet wird (#2554), und der Download-Fortschritt bleibt sichtbar, während die Versionshinweise durchscrollen. (#2524)
- Blockierte Konfigurationen der Laufzeitwiederherstellung erklären mit klareren Meldungen und Diagnosen, was nicht stimmt. (#2571)
- PDF-Steuersymbole und Hover-Hinweise sind vereinheitlicht, und Stapelabschluss-Aktionen sind über den Arbeitsbereich hinweg einheitlich ausgerichtet. (#2539)

## 🐛 Fehlerbehebungen

- **PDF** – native Abbildungs- und Tabellenlayouts werden wiederhergestellt, wenn die Extraktion sie übersieht (#2536), und die Textauswahl ist auf gedrehten Seiten korrekt ausgerichtet. (#2564)
- **Konnektoren** – dbSNP-Platzierungen bewahren Deletionsallele (#2583) und maskieren das Trennzeichen der Quelle (#2581); VEP-Abfragen bewahren Allele und zählen eindeutige Transkripte (#2566); boolesche BioMart-Filter kodieren ausgeschlossene Werte korrekt. (#2559)
- **Agenten und Anbieter** – Reasoning bleibt in der Assistenten-Historie der Anbieterbrücke erhalten (#2563); der Fehlerkontext von Agenten behält seinen umsetzbaren Wiederherstellungszustand (#2435); Benutzereingaben sind gegen Race Conditions beim Archivieren geschützt. (#2531)
- **Sitzungen** – explizite Verzweigungsauswahlen bleiben über offene Clients hinweg konsistent (#2523), und die Zugehörigkeit zu Aktivitätsgruppen bleibt über Zusammenführungen hinweg gültig. (#2574)
- **Notebook und Berechnung** – Einbindungen mit Schreibschutz sind auf freigegebene Pfade begrenzt (#2577), kurzlebige Windows-Befehlszeilenprozesse werden korrekt abgeglichen (#2535), und Kernel-Fähigkeiten bleiben bei der Laufzeitübergabe erhalten.
- **Start und Lebenszyklus** – ausstehende Artefakt-Abstammung wird beim Datenbankstart akzeptiert (#2545); das Rollback der Befehlszeile läuft nach Bereinigungsfehlern weiter und bewahrt den ursprünglichen Fehler (#2556, #2555); die IPC-Bereinigung läuft nach Disposer-Fehlern weiter (#2560); zerstörte Fenster werden beim Beenden nicht mehr angerührt (#2582); eine freigegebene Bestätigung blockiert ein erneut angefordertes Beenden nicht mehr (#2565); die Bereinigung veralteter Installationen behindert Ersetzungs-Handler nicht mehr (#2562).
- **Ergebnisübermittlung und Fernzugriff** – verspätete Fortsetzungen werden nach der Zerstörung gestoppt (#2552); abgebrochene doppelte Transferstarts werden abgewiesen (#2553); das Herunterfahren des Fernzugriffs beachtet Bereinigungsfehler sofort. (#2572)
- **Arbeitsbereich** – Office-Vorschau-Listener werden bei der Deinstallation bereinigt (#2532), und Sonden zur Sichtbarkeit ungelesener Elemente werden mit der Laufzeit abgebaut. (#2534)
