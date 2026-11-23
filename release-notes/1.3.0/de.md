## ✨ Highlights

- **Geplante Forschungsaufgaben.** Richten Sie wiederkehrende oder einmalige Zeitpläne ein, die Sitzungen und Notebook-Aufgaben eigenständig starten — jeder Lauf öffnet sich im Workspace mit eigenem Datensatz, und Sie behalten dank übersichtlicher Ausführungsverlauf die Kontrolle. (#4380)
- **Bilderzeugung und -bearbeitung.** Erzeugen Sie Bilder aus einem Prompt mit Ihrem konfigurierten Anbieter und arbeiten Sie iterativ weiter: Jede Bearbeitung hält eine neue Version bereit, sodass Sie frühere Varianten im gesamten Projekt vergleichen, erneut aufrufen und wiederverwenden können. (#4424)
- **Bearbeitbare Präsentationen.** PowerPoint-Dateien lassen sich zur Bearbeitung öffnen: Überarbeiten Sie Text mit Formatierung — Schriftarten, Größen, Farben, Ausrichtung — und bewahren Sie dabei die Struktur der Datei, alles innerhalb der App. (#4392)
- **Forschungsfilme, erneut abgespielt.** Filmoperationen lassen sich auf neue Zweige mit unabhängigen Ergebnissen übertragen, Filme öffnen sich direkt aus dem Sitzungsmenü, und der Film-Dialog erklärt den Tokenverbrauch, bevor Sie erzeugen. (#4389, #4414)
- **Klügere Agentenfragen.** Wenn der Agent Ihre Eingabe benötigt, legt er jetzt die Abwägungen zwischen den angebotenen Optionen dar, sodass Sie mit Blick auf die Folgen entscheiden können. (#4357)

## ⚠️ Scope & Safety

- **Geplante Aufgaben laufen mit den Berechtigungen Ihres Projekts.** Ein Zeitplan startet seine Sitzung oder Notebook-Aufgabe ohne weitere Bestätigung, solange die App läuft. Der Lauf handelt mit den Ordnern, Anmeldedaten und dem Netzwerkzugang, die diesem Projekt bereits gewährt wurden, und verbraucht Ihr konfiguriertes Anbieterkontingent. Prüfen Sie Ziel, Rhythmus und die Berechtigungen des Projekts, bevor Sie einen Zeitplan aktivieren, und pausieren oder löschen Sie Zeitpläne, die Sie nicht mehr benötigen. Siehe die [Grenze geplanter Aufgaben im Register bekannter Einschränkungen](https://github.com/aipoch/open-science/blob/v1.3.0/docs/known-limitations.md). (#4380)
- **Bilderzeugung und -bearbeitung geben Prompts und Quellbilder an Ihren konfigurierten Anbieter weiter.** Erzeugungsanfragen und die als Quelle dienenden Bilder werden über die von Ihnen konfigurierte Anbieterverbindung übertragen; ein lokales Abbrechen oder Löschen kann bereits beim Anbieter eingegangene Daten nicht zurückholen. Prüfen Sie die Datenbestimmungen des Anbieters, bevor Sie mit sensiblen Inhalten erzeugen. Siehe [Empfänger von Daten](https://github.com/aipoch/open-science/blob/v1.3.0/docs/security.md#data-recipients). (#4424)

## 🚀 New Features

- Geplante Aufgaben erstellen, die eine Sitzung starten oder ein Notebook nach wiederkehrendem oder einmaligem Rhythmus ausführen: Jeder geplante Lauf öffnet sich im Workspace als eigener Datensatz, wobei der Ausführungsverlauf pro Zeitplan geführt wird. (#4380)
- Bilder aus Prompts über Ihren konfigurierten Anbieter erzeugen und mit Folgeanweisungen bearbeiten: Jede Erzeugung und Bearbeitung speichert eine neue Artefaktversion, und frühere Varianten bleiben für Vergleich und Wiederverwendung verfügbar. (#4424)
- PowerPoint-Präsentationen direkt bearbeiten: Text mit Schriftarten, Größen, Farben und Ausrichtung auswählen und überarbeiten, während die Folienstruktur erhalten bleibt. (#4392)
- Filmoperationen eines Forschungsfilms auf einen anderen Zweig übertragen und ein unabhängiges Ergebnis erhalten, ohne den ursprünglichen Film anzufassen. (#4389)
- Erzeugte Forschungsfilme direkt aus dem Sitzungsmenü öffnen und vorab sehen, wie viele Token die Filmerzeugung verbrauchen wird. (#4414)
- Laufende Notebook-Prozesse aus der App überwachen und diejenigen stoppen, deren Eigentümer die App ist, wenn sie nicht mehr benötigt werden. (#4399)
- Dokument- und Abbildungsfähigkeiten sind sofort einsatzbereit: Ihre unterstützenden Bibliotheken werden beim ersten Gebrauch in die verwaltete Umgebung vorinstalliert, statt mitten in einer Aufgabe zu scheitern. (#4411)

## 🔧 Improvements

- Lange Gesprächsverläufe werden schrittweise persistiert, sodass große Sitzungen fortlaufend speichern, schneller neu laden und bei wachsendem Umfang reaktionsfähig bleiben. (#4378)
- Die App erreicht die Projektübersicht beim Start früher, indem Arbeiten beschnitten werden, die den ersten Bildschirm blockierten. (#4398)
- Steckengebliebene Filmerzeugung, Forschungspaket-Übertragungen und Hintergrundzustellungen erholen sich eigenständig, statt auf einen Neustart zu warten. (#4372)
- Windows-Installationen und -Updates nutzen eine schlankere, zuverlässigere Paketierungs-Pipeline, und Bereitschaftsprüfungen für Updates sind begrenzt, sodass sie den Ablauf nicht zum Stehen bringen können. (#4420, #4417)
- Die Wiederherstellungsplanung für Rechenziele läuft auf Anforderung statt nach festem Zeitgeber und reduziert so Leerlauf-Overhead. (#4375)
- Fähigkeitsverweise stimmen mit den öffentlichen OpenCode-2.x-Fähigkeitsnamen überein, sodass importierte Fähigkeiten wie erwartet aufgelöst werden. (#4355)
- Externe PDFs stellen ihre native Struktur bei Analyse und Übersetzung zuverlässiger wieder her, die Leseransicht fasst ihre Werkzeugleiste zusammen, und Grenzen der Bildunterstützung erklären sich selbst, statt still zu scheitern. (#4361, #4360, #4435, #4407, #4394, #4400)
- Der Composer hält Sendesteuerungen in schmalen Layouts erreichbar, zeigt die Kontextnutzung genau an und blendet den Pfeil zum Neuesten beim Darüberfahren über das Gespräch ein. (#4367, #4403)
- Die erste Darstellung langer Gespräche ist begrenzt, sodass sich das Fenster auch bei vielen geladenen Nachrichten schnell öffnet. (#4376)

## 🐛 Bug Fixes

- Sitzungen behalten ihre korrekte Nummerierung, wenn Datensätze repariert werden, und das erneute Abspielen des Journals wiederholt keine Arbeit mehr und scannt den Verlauf nicht unnötig erneut. (#4368, #4432, #4428)
- Agenten-Laufzeiten geben ihre Ressourcen über Agenten-Lebenszyklen hinweg frei, sodass wiederholte Läufe keinen Overhead ansammeln. (#4396)
- Das erneute Laden von Fähigkeiten unterbricht die laufende Sitzungserstellung nicht mehr. (#4427)
- Agenten-Übergaben bewahren ihre Metadaten, auch wenn Werkzeugerergebnisse abgeschnitten werden. (#4413)
- Artefakt-Downloads über die lokale CLI laufen nicht mehr in eine Zeitüberschreitung, während Daten noch eintreffen. (#4430)
- Entfernte Aufgabenanfragen und -Downloads respektieren die Lebensdauer des Aufrufers, sodass aufgegebene Vorgänge zügig stoppen. (#4390)
- Terminale Ray-Jobs werden nach der Ernte entfernt, statt auf dem Ziel zurückzubleiben. (#4386)
- ACP-Ressourcenlinks werden wieder akzeptiert. (#4381)
- Science-Pakete öffnen den verfügbaren importierten Filmmodus, statt zu scheitern. (#4419)
- Vorschauen behalten ihre Dateinamen-Identität in schmalen Oberflächen, Ausführungsmarken landen an den richtigen Positionen, und die Projektumschaltung hält ihr Scrollen innerhalb der Liste. (#4401, #4350, #4405)
- Abschriften des Notebook-Rahmens werden gleichmäßig seitenweise geladen, und Markdown-Fußnoten halten ihr Scrollen im Griff. (#4370, #4391)

## 🙏 Danksagungen

- Danke an [@cyj1116](https://github.com/cyj1116) für die bearbeitbaren Präsentationen ([#4392](https://github.com/aipoch/open-science/pull/4392)), die Verbesserungen der PDF-Leseransicht ([#4394](https://github.com/aipoch/open-science/pull/4394)), die Bewahrung der Übergabemetadaten ([#4413](https://github.com/aipoch/open-science/pull/4413)) und die Korrekturen an Zeitüberschreitungen bei CLI-Downloads ([#4430](https://github.com/aipoch/open-science/pull/4430)).
- Danke an [@wen2zhou](https://github.com/wen2zhou) für die Abwägungen bei Agentenfragen ([#4357](https://github.com/aipoch/open-science/pull/4357)), die Überwachung von Notebook-Prozessen ([#4399](https://github.com/aipoch/open-science/pull/4399)) und die Dateinamen-Identität von Vorschauen ([#4401](https://github.com/aipoch/open-science/pull/4401)).
- Danke an [@fengdwx](https://github.com/fengdwx) für die schrittweise Persistenz des Sitzungsverlaufs ([#4378](https://github.com/aipoch/open-science/pull/4378)).
- Danke an [@roxi3906](https://github.com/roxi3906) für die Stabilität der Ausführungsmarken-Navigation ([#4350](https://github.com/aipoch/open-science/pull/4350)), an [@BobbyLin7](https://github.com/BobbyLin7) für die Angleichung der OpenCode-Fähigkeitsnamen ([#4355](https://github.com/aipoch/open-science/pull/4355)), und an [@daanveer-tech](https://github.com/daanveer-tech) für die README-Aktualisierungen ([#4433](https://github.com/aipoch/open-science/pull/4433)).
