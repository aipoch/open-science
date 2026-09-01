## ✨ Highlights

- **Spanische Benutzeroberfläche.** Die gesamte Oberfläche - Ersteinrichtung, Einstellungen, Konversationsansichten, native Dialoge und Versionshinweise - ist jetzt auf Spanisch verfügbar. Damit ergänzt Spanisch die sieben vorhandenen Sprachen; die Sprache lässt sich in den Einstellungen zur Laufzeit wechseln. (#1771)
- **Quellenvorschau in der App.** Links in Agentenantworten werden in einer abgeschirmten Vorschau innerhalb der App geöffnet. Beim Darüberfahren erscheinen Quellentitel und vollständige URL; ein Klick lädt die Seite mit einer deterministischen Fortschrittsanzeige im Seitenbereich, ohne den Arbeitsbereich zu verlassen. (#1524)
- **Live-Variablen in Notebooks.** Die neue Ansicht „Variablen“ zeigt den laufenden Python- oder R-Namensraum mit Namen, Typen, Formen und Vorschauen schreibgeschützt an. Sie wird nach jeder Ausführung aktualisiert, ohne zum bloßen Anzeigen einen Kernel zu starten. (#1748)
- **Sitzungsvorschau beim Darüberfahren.** Wenn Sie den Mauszeiger über eine Sitzung in der Seitenleiste bewegen oder sie fokussieren, werden Titel und Beschreibung angezeigt. Überlange Titel laufen durch, damit sie unterscheidbar bleiben. (#1775)

## 🚀 Neue Funktionen

- **Spanische Lokalisierung** - vollständige Kataloge für gemeinsame, native und Renderer-Texte in neutralem internationalem Spanisch, einschließlich nativer Electron-Meldungen, Datumsformatierung und lokalisierter Dokumentation. (#1771, #1780)
- **Quellenvorschau in der App** - HTTPS-Links in Agentenantworten werden zu nativen Quellenlinks mit interaktivem Popover, abgeschirmtem Laden im Seitenbereich, Fortschrittsanzeige in der Symbolleiste, Verknüpfung zum externen Browser, Tastaturnavigation und dauerhaft sichtbarer URL. (#1524)
- **Live-Namensraumbrowser** - eine untergeordnete Variablenansicht für Notebook-Kernel mit Filter, Umschalter für private Namen, manueller Aktualisierung sowie Anzeigen für veraltete Daten, laufende Aktualisierung und Nichtverfügbarkeit. Momentaufnahmen sind größenbegrenzt und werden nie dauerhaft gespeichert. (#1748)
- **Sitzungsvorschau beim Darüberfahren** - sofortige Vorschau von Titel und Beschreibung beim Bewegen des Mauszeigers darüber oder bei Tastaturfokus, mit Unterstützung für reduzierte Bewegung und Beschränkung auf Desktop-Systeme. (#1775, #1796, #1797)
- **Kontextmenü für Vorschau-Tabs** - Schließen, Andere schließen sowie je nach Kontext Herunterladen, Pfad kopieren und Als Artefakt speichern. Das Menü erscheint am Mauszeiger, ohne den Tab zu aktivieren. (#1764)
- **Rückfragekarten mit Prüfung je Frage** - beantwortete und übersprungene Fragekarten werden zu kompakten Einträgen, die sich wieder zu den ursprünglichen Fragen samt Antworten aufklappen lassen; Auswahlzähler bleiben korrekt und die Steuerelemente kompakt. (#1772)
- **Neue Anbieter und Modelle** - OpenCode Go und OpenCode Zen als integrierte API-Schlüssel-Anbieter sowie GLM-5.3-Flash neben GLM-4.5-Air und GLM-5.3 für Zhipu AI (GLM). (#1763, #1790, #1762, #1766)

## 🔧 Verbesserungen

- Beim Rendern von Konversationen werden Mermaid und die Laufzeit für Syntaxhervorhebung nur noch geladen, wenn eine Nachricht sie tatsächlich benötigt. Dadurch startet der Renderer schneller. (#1789)
- Lang laufende Sitzungen werden nun in kontrollierten Abständen gespeichert statt einmal pro Darstellungsframe. Das senkt die anhaltende CPU-, Arbeitsspeicher- und Datenträgerbelastung bei großen Sitzungen. (#1779)
- Die Zusammenfassung der Modellanfragen in der Antwortfußzeile verwendet jetzt die Bezeichnung „Aufrufe“ und stimmt damit mit der Kontextfensteransicht überein. (#1781)
- Beim Archivieren eines Projekts wird nun auf laufende Reviewer-Aufgaben und nicht abgeschlossene Remote-Rechenaufträge gewartet. Außerdem pausiert die Warteschlange für Nachrichten, bis das Projekt wiederhergestellt ist. (#1785)
- Lange Planzusammenfassungen werden auf drei Zeilen begrenzt und beim Darüberfahren vollständig angezeigt. Die Planvorschau behält ihre Bildlaufposition bei gestreamten Fortschrittsaktualisierungen bei. (#1783)

## 🐛 Fehlerbehebungen

- **Sitzungen** - Berechtigungsfreigaben kollidieren nicht mehr mit der Erzeugung von Titel und Beschreibung. Beides bleibt erhalten, statt eine Warnung beim Speichern auszulösen. (#1768)
- **Sitzungen** - unterbrochene Sitzungen werden bei strukturierten Anbieterfehlern fortgesetzt, wobei der maßgebliche Fehler erhalten bleibt, statt den Kontext unbemerkt zurückzusetzen. (#1774)
- **Projekte** - ein konfigurierter Agentenkontext für Projekte wird einheitlich durchgesetzt: Fehler beim Nachschlagen führen zu einem sicheren Abbruch, und Kontextänderungen gelten vor der nächsten Eingabe auch für inaktive Sitzungen. (#1786)
- **Projektdateien** - schlagen Änderungen an freigegebenen Ordnerberechtigungen fehl, wird nun eine Fehlermeldung mit Option zum erneuten Versuch angezeigt, statt die bisherige Freigabe unbemerkt beizubehalten. (#1793)
- **Notebook** - lokale RPC-Anfragen werden für jede Methode strikt geprüft; fehlerhafte Parameter werden vor der Ausführung abgewiesen. (#1794)
- **Sitzungsvorschau** - Vorschauen beim Darüberfahren schließen sofort und funktionieren auch nach Änderungen an der Pointer-Bridge weiter. (#1796, #1797)
