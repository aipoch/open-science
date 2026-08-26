# Zu Open Science beitragen

Vielen Dank für Ihr Interesse an einer Mitarbeit! Dieses Dokument erläutert, wie Sie das Projekt einrichten, welchen Arbeitsablauf wir verwenden und welche Prüfungen Ihre Änderung bestehen muss, bevor sie zusammengeführt werden kann.

> Dieses Dokument ist eine Übersetzung der englischen `CONTRIBUTING.md`. Bei Abweichungen ist die [englische Fassung](../../CONTRIBUTING.md) maßgeblich.

## Verhaltenskodex

Verhalten Sie sich in allen Interaktionen respektvoll und konstruktiv. Gehen Sie von guten Absichten aus, konzentrieren Sie Diskussionen auf die technischen Aspekte und tragen Sie dazu bei, dass sich alle im Projekt willkommen fühlen.

## Erste Schritte

### Voraussetzungen

- [Node.js](https://nodejs.org/) 22 (siehe [`.nvmrc`](../../.nvmrc)) und npm
- Git

### Einrichtung

```bash
# Erstellen Sie unter https://github.com/aipoch/open-science/fork einen Fork und führen Sie dann Folgendes aus:
git clone https://github.com/<your-username>/open-science.git
cd open-science

# Fügen Sie das ursprüngliche Repository als upstream hinzu, damit Ihr Fork aktuell bleibt.
git remote add upstream https://github.com/aipoch/open-science.git

npm install
```

`npm install` führt einen `postinstall`-Schritt aus, der den Prisma-Client generiert und die nativen Abhängigkeiten der Electron-App installiert.

### Entwicklungsmodus starten

```bash
npm run dev
```

## Navigation für Coding-Agenten

Führen Sie Installations-, Entwicklungs- und Validierungsbefehle im Stammverzeichnis des Repositorys aus:

| Zweck                  | Befehl im Stammverzeichnis                                 |
| ---------------------- | ---------------------------------------------------------- |
| Installation           | `npm install`                                              |
| Start                  | `npm run dev`                                              |
| Gezielter Test         | `npm test -- <affected-test-path> [-t '<test pattern>']`   |
| Modultests             | `npm run test:module -- <module-id>`                       |
| Betroffene Tests       | `npm run test:affected -- --base <base> --head <head>`     |
| Node-Typprüfung        | `npm run typecheck:node`                                   |
| Web-Typprüfung         | `npm run typecheck:web`                                    |
| Lint                   | `npm run lint`                                             |
| Vollständiger Fallback | `npm run typecheck`, `npm run lint`, dann `npm test`       |
| UI-E2E                 | `npm run build:e2e`, dann `npm run test:e2e`               |
| UI-Abläufe             | `npm run build:e2e`, dann `npm run test:e2e:journey`       |
| Arbeitsbereich         | `npm run build:e2e`, dann `npm run test:e2e:workspace`     |
| Barrierefreiheit       | `npm run build:e2e`, dann `npm run test:e2e:accessibility` |
| Visuelle Prüfungen     | `npm run build:e2e`, dann `npm run test:e2e:visual`        |

Erstellen Sie Git-Worktrees ausschließlich im Verzeichnis `.worktree/<name>` des Repositorys und legen Sie jeden Änderungsbranch auf Grundlage des Standardbranches an. Entfernen oder verschieben Sie keine fremden Worktrees.

Holen Sie vor destruktiven Git- oder Dateisystemoperationen, der Installation von Abhängigkeiten, durch die neuer Code heruntergeladen oder ausgeführt wird, der Veröffentlichung von Paketen oder Releases, dem Umgang mit Anmeldeinformationen außerhalb der bestehenden Projektabläufe sowie externen Schreibvorgängen, die nicht bereits durch die Aufgabe autorisiert wurden (etwa Pushes, Pull Requests, Issues und Nachrichten), eine ausdrückliche Genehmigung ein.

Lesen Sie vor Änderungen an einem der folgenden Bereiche die jeweils zuständige Dokumentation und führen Sie anschließend die zugehörigen gezielten Prüfungen aus:

| Bereich       | Zuständige Dokumentation                                                              | Gezielte Prüfungen                                                                                    |
| ------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Renderer      | [Designspezifikation](../design.md)                                                   | `npm run typecheck:web`; gezielte Tests unter `src/renderer/`                                         |
| Notebook      | [Aktuelle Architektur](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`; gezielte Tests unter `src/main/notebook/`                                   |
| Einstellungen | [Einstellungsdesign](../design.md#settings)                                           | `npm run typecheck`; gezielte Tests unter `src/main/settings/` und `src/renderer/src/pages/settings/` |
| ACP           | [Aktuelle Architektur](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`; gezielte Tests unter `src/main/acp/`                                        |

## Projektstruktur

Dies ist eine Electron-Anwendung, die mit electron-vite, React und TypeScript entwickelt wird. Unter `src/` gliedert sich die Laufzeit in drei Prozessschichten und ein gemeinsam genutztes Modul:

- `src/main/` – Electron-Hauptprozess (ACP-Runtime, Sitzungspersistenz, Artefakte, Notebook, Projekte und IPC-Handler).
- `src/preload/` – Preload-Bridge, die dem Renderer eine typisierte `window.api` bereitstellt.
- `src/renderer/` – React-Benutzeroberfläche (Seiten, Stores und Komponenten).
- `src/shared/` – prozessübergreifend genutzte Typen und Hilfsfunktionen.

## Entwicklungsablauf

1. Erstellen Sie für Ihre Änderung einen Branch vom Standardbranch.
2. Nehmen Sie Ihre Änderung vor und beschränken Sie sie auf einen klar abgegrenzten Zweck.
3. Fügen Sie Tests für das geänderte Verhalten hinzu oder aktualisieren Sie bestehende Tests.
4. Stellen Sie das abschließende Test Impact Set zusammen und führen Sie es nach der letzten wesentlichen Änderung aus. Verwenden Sie den vollständigen Fallback, wenn Zuständigkeit, Consumer oder Risiken nicht eindeutig bestimmt werden können.
5. Öffnen Sie einen Pull Request mit einer klaren Beschreibung der Änderung und ihrer Motivation.

### Dauerhafte externe Komponenten

Bevor Sie eine Ressource hinzufügen, die den Prozess überdauert, der sie erzeugt hat, und außerhalb des von der App verwalteten Speichers oder in der Control Plane eines Drittanbieters verbleibt, beachten Sie den [Vertrag zur Zuständigkeit für dauerhafte externe Komponenten](../PRD.md#durable-external-component-ownership). Derselbe Vertrag gilt, wenn Sie für eine bestehende Komponente einen neuen Pfad zum Erstellen, Übernehmen oder Entfernen hinzufügen. Der Pull Request muss Folgendes benennen:

- das für die Komponente zuständige Modul sowie die genaue Identität oder den bei der Erstellung gespeicherten Beleg;
- das Verhalten beim Erstellen und Starten, Stoppen, Entfernen, Wiederherstellen nach einem Absturz und Deinstallieren der Anwendung;
- wie die Bereinigung nach dem Fail-Closed-Prinzip erfolgt, ohne Systemverzeichnisse zu durchsuchen oder gemeinsam genutzte, benutzerverwaltete beziehungsweise anderweitig nicht zweifelsfrei zugeordnete Ressourcen anzutasten;
- die plattformspezifischen Tests für die Reihenfolge „Stoppen vor Entfernen“, Wiederholungsversuche, Idempotenz und den Erhalt nicht zugeordneter Ressourcen; sowie
- Auswirkungen auf persistierte Formate, historische Kompatibilität oder neu eingeführte Zustände.

Ein künftiger Bereinigungs-Hook reicht nicht aus: Liefern Sie die Erstellungsfunktion erst aus, wenn das zuständige Modul die Ressource sicher stoppen und entfernen kann. Wenn der PR eine im Vertrag aufgeführte bekannte Legacy-Ausnahme ändert, muss er diesen Pfad entweder auf eine nachgewiesene Zuständigkeit migrieren oder die begrenzte Ausnahme und ihren Plan zur historischen Kompatibilität dokumentieren. Verwenden Sie eine Ausnahme nicht als Präzedenzfall für neues Verhalten.

### Änderungen am Datenbankschema

`prisma/schema.prisma` ist für Tabellen, Spalten, Standardwerte, Indizes und Fremdschlüssel maßgeblich. SQLite-CHECK-Constraints, die Prisma nicht ausdrücken kann, befinden sich in `prisma/sqlite-check-constraints.json`. Das Laufzeitschema-Modul wird generiert; bearbeiten Sie es nicht und fügen Sie dem Startcode kein funktionsspezifisches DDL hinzu.

1. Ändern Sie das Prisma-Schema und, nur wenn erforderlich, den SQLite-CHECK-Vertrag.
2. Führen Sie `npm run db:schema:generate` aus und prüfen Sie das generierte Zielschema.
3. Fügen Sie unter `src/main/database/migrations/` einen neuen unveränderlichen Eintrag hinzu. Ändern Sie niemals eine veröffentlichte Migration und erweitern Sie nicht die eingefrorene Legacy-Reparaturliste `0001`.
4. Führen Sie vor dem Commit `npm run db:schema:check` und die Migrationstests aus.

Die Prisma-CLI ist ausschließlich ein Entwicklungs- und CI-Werkzeug. Paketierte Anwendungen führen das eingecheckte Migrationsmanifest aus und enthalten nicht die Prisma Migrate Engine.

Für die Migrationshistorie ist `src/main/database/` zuständig. Modultests dürfen `migrateApplicationDatabase` ausführen, um eine Fixture mit aktuellem Schema zu erzeugen. Manuell erstellte historische Schemata, Upgrade-Assertions und Erwartungen an den Migrations-Ledger gehören jedoch in die Datenbankmigrationstests und nicht in Testsuiten einzelner Funktionsmodule.

### Branch-Namen

Verwenden Sie das Format `<type>/<short-description>` mit einer kleingeschriebenen und durch Bindestriche getrennten Beschreibung:

```text
feat/project-sidebar-filter
fix/notebook-kernel-timeout
ci/ai-pr-review
```

Verwenden Sie eines der folgenden Standardpräfixe:

- `feat` – eine neue Funktion
- `fix` – eine Fehlerbehebung
- `docs` – ausschließlich Dokumentationsänderungen
- `style` – Formatierung oder andere Änderungen ohne Verhaltensauswirkung
- `refactor` – Codeänderungen, die weder einen Fehler beheben noch eine Funktion hinzufügen
- `perf` – Leistungsverbesserungen
- `test` – Hinzufügen oder Korrigieren von Tests
- `build` – Änderungen am Build-System oder an Abhängigkeiten
- `ci` – Änderungen an CI-Konfiguration oder -Skripten
- `chore` – Wartungsarbeiten, die keinem anderen Typ entsprechen
- `revert` – Rücknahme einer früheren Änderung

### Code-Stil

- Halten Sie sich bei Benennung, Struktur und Idiomen an den umgebenden Code.
- Die Formatierung übernimmt Prettier. `npm run format` ist optional; prüfen Sie die Änderungen vor dem Commit, da der Befehl Dateien im gesamten Repository neu schreibt.
- ESLint erzwingt die Lint-Regeln; führen Sie `npm run lint` aus.
- Umschließen Sie benutzersichtbare Zeichenfolgen mit der Übersetzungsfunktion `t()` aus `react-i18next`. Fügen Sie dem Namespace `renderer` in `src/shared/i18n/locales/de.json` (Deutsch), `src/shared/i18n/locales/es.json` (Spanisch), `src/shared/i18n/locales/fr.json` (Französisch), `src/shared/i18n/locales/ja.json` (Japanisch), `src/shared/i18n/locales/ko.json` (Koreanisch), `src/shared/i18n/locales/ru.json` (Russisch), `src/shared/i18n/locales/zh-Hans.json` (Chinesisch, vereinfacht) und `src/shared/i18n/locales/zh-Hant.json` (Chinesisch, traditionell) die entsprechenden Übersetzungen hinzu. Verwenden Sie den englischen Text als Übersetzungsschlüssel. Halten Sie Codekommentare und Dokumentation auf Englisch.

## Verifizierungsrichtlinie

### Stabile Semantik der Testbefehle

- `npm test` führt immer die vollständige portable Vitest-Suite aus. Die Bedeutung des Befehls hängt weder vom aktuellen Branch noch von geänderten Dateien ab.
- `npm test -- <paths> [-t '<pattern>']` führt nur das vom Aufrufer ausdrücklich angegebene Ziel aus. Der Befehl ermittelt keine betroffenen Tests und darf nicht als vollständige Verifizierung bezeichnet werden.
- Die Auswahl nach Auswirkung ist eine separate Entscheidung auf Grundlage des endgültigen Diffs. Überladen Sie `npm test` nicht mit implizitem Verhalten auf Basis eines Git-Diffs.

### Kurze Feedbackschleife

Führen Sie während der Implementierung den kleinsten projekteigenen Test aus, der das geänderte Verhalten abdeckt. Wiederholen Sie ihn nach jeder Änderung dieses Verhaltens. Ergebnisse aus einer früheren Implementierungsfassung gelten nicht als abschließender Nachweis.

### Abschließendes lokales Test Impact Set

Leiten Sie vor der Übergabe den erforderlichen Mindestsatz aus dem endgültigen wesentlichen Diff ab:

1. Tests für das Verhalten, für das das geänderte Modul zuständig ist;
2. Vertragstests für geänderte Schnittstellen und Adapter;
3. Tests der Consumer oder des betroffenen Feature-Slice, wenn sich eine Schnittstelle geändert haben könnte;
4. Typprüfungen für jeden betroffenen Laufzeitprozess;
5. `npm run lint`, wenn Quellcode oder eine von Lint erfasste Konfiguration geändert wurde;
6. Plattform-, Persistenz-, Migrations-, Build- oder E2E-Prüfungen für Risiken, die lokal überprüft werden können.

Die Nähe im Verzeichnisbaum allein ist kein Nachweis für Auswirkungen. Wenn eine Datei mehrere Zuständigkeiten vermischt, behandeln Sie die Änderung als schnittstellenrelevant oder verwenden Sie den vollständigen Fallback.

`test:module` unterstützt nur die in `scripts/ci/module-impact.json` deklarierten Modul-IDs. Der Befehl führt die kuratierten Owner-, Vertrags- und repräsentativen Consumer-Tests dieses Moduls aus; für eine Schnittstellenänderung ist dies keine vollständige nachgelagerte Verifizierung. Verwenden Sie `test:affected` oder den Plan von PR Gate für den exakten Head, wenn sich eine Schnittstelle oder ihre Consumer geändert haben könnten.

### Vollständiger Fallback

Führen Sie `npm run typecheck`, `npm run lint` und `npm test` aus, wenn eine der folgenden Bedingungen erfüllt ist:

- Das zuständige Modul, die geänderte Schnittstelle oder ihre Consumer können nicht eindeutig bestimmt werden.
- Globale Validierungseingaben ändern sich. Dazu zählen Paketmetadaten, TypeScript-, Vitest- oder Build-Konfigurationen, der Workflow oder Classifier von PR Gate sowie Ownership-, Consumer-, Capability- oder Fallback-Routing im Modul-Impact-Manifest.
- Die Änderung betrifft mehrere Laufzeitbereiche ohne nachgewiesene Impact-Map.
- Ein Release-Candidate-Workflow oder ein Maintainer fordert ausdrücklich die vollständige lokale Suite an.

Der vollständige Fallback ist ein Sicherheitsmechanismus und keine pauschale Voraussetzung für jeden Pull Request. Von Mitwirkenden wird nicht erwartet, dass sie jede betriebssystemspezifische CI-Lane lokal reproduzieren.

Wenn sich ausschließlich `testFiles` innerhalb eines bereits zugeordneten Moduls ändert, löst dies nicht den vollständigen Fallback aus. Führen Sie stattdessen die Manifest-Validierungstests, `npm run test:module -- <module-id>`, die Typprüfungen der betroffenen Prozesse und Lint aus; die CI für den exakten Head bleibt für die vollständigen portablen und plattformspezifischen Testsuiten maßgeblich.

### CI als maßgebliche Instanz und Nachweise

PR Gate klassifiziert den endgültigen Diff zwischen Base und Head anhand vertrauenswürdiger Eingaben, ergänzt Test-Lanes für Consumer- und Plattformrisiken und verwendet bei unbekannter oder uneindeutiger Zuständigkeit den vollständigen Plan als Fallback. Ausgewählte Prüfungen sind blockierend; nicht ausgewählte Prüfungen werden als übersprungen gemeldet und gelten nicht als Nachweis.

Die abschließende Übergabe muss die wesentlichen Änderungen aufführen, jedes betroffene Verhalten einer projekteigenen Prüfung und deren Endergebnis zuordnen (`behavior -> command -> result`), begründen, warum Consumer- oder Plattform-Lanes ein- beziehungsweise ausgeschlossen wurden, und nicht abgedeckte Risiken benennen. Geben Sie an, dass die Prüfungen nach der letzten wesentlichen Änderung ausgeführt wurden. Kennzeichnen Sie die Änderung erst dann als verifiziert, wenn eine unabhängige Prüfung bestätigt hat, dass diese Zuordnung den endgültigen Zustand abdeckt.

## Commit-Nachrichten

Jeder Commit-Betreff muss Conventional Commits mit einem Scope entsprechen:

```text
<type>(<scope>): <description>
```

Dieses Format wird für jeden Commit in einem Pull Request geprüft.

Verwenden Sie dieselben Standardpräfixe wie unter [Branch-Namen](#branch-namen). Der Scope sollte eine kurze, durch Bindestriche getrennte Bezeichnung für den betroffenen Bereich sein, mit einem Kleinbuchstaben beginnen und nur bei Eigennamen oder technischen Begriffen Großbuchstaben enthalten, beispielsweise `macOS`.

```text
feat(projects): add sidebar filter
fix(notebook): prevent kernel startup timeout
ci(review): unify automated AI reviews
```

- Formulieren Sie eine klare Beschreibung im Imperativ, die mit einem Kleinbuchstaben beginnt. Großbuchstaben innerhalb der Beschreibung sind bei Eigennamen und technischen Begriffen zulässig, beispielsweise `detect user-installed CRAN R on Windows`.
- Halten Sie den Betreff kurz. Erläutern Sie im Text das _Warum_, wenn es aus dem Diff nicht unmittelbar hervorgeht.
- Setzen Sie bei Breaking Changes ein `!` vor den Doppelpunkt und fügen Sie den Footer `BREAKING CHANGE:` hinzu, beispielsweise `feat(api)!: remove legacy session endpoint`.

## Pull Requests

- Verwenden Sie für den Titel des Pull Requests dasselbe Format `<type>(<scope>): <description>`, beispielsweise `feat(projects): add sidebar filter`.
- Verweisen Sie in der Beschreibung auf alle zugehörigen Issues.
- Verwenden Sie bei Änderungen am Verhalten eine prägnante Beschreibung, damit Reviewer Absicht, Umfang und Validierung vor dem Lesen des Diffs beurteilen können. Nutzen Sie gegebenenfalls folgende Struktur:

  ```md
  ## Problem

  ## Vorgeschlagene Änderung

  ## Umfang und Nicht-Ziele

  ## Akzeptanzkriterien und Validierung

  ## Prüfschwerpunkte
  ```

- Erwägen Sie bei Architekturänderungen, Datenflüssen, Zustandsübergängen oder Interaktionen über mehrere Komponenten hinweg ein Mermaid-Diagramm, wenn es den Entwurf verständlicher und leichter prüfbar macht.
- Kleine Dokumentations-, Wartungs- und eng begrenzte Korrekturen dürfen eine kurze Zusammenfassung verwenden, sollten aber weiterhin das erwartete Verhalten und die Validierung benennen.
- Nehmen Sie die abschließende Nachweiszuordnung aus der [Verifizierungsrichtlinie](#verifizierungsrichtlinie) auf, geben Sie an, dass die aufgeführten Prüfungen nach der letzten wesentlichen Änderung ausgeführt wurden, und weisen Sie auf nicht abgedeckte Risiken hin.
- Halten Sie Pull Requests angemessen klein und klar abgegrenzt, damit sie leicht geprüft werden können.
- Stellen Sie sicher, dass das abschließende Test Impact Set oder, falls erforderlich, der vollständige Fallback erfolgreich ist.
- Führen Sie den Pull Request nach erfolgreichen Prüfungen direkt und ausschließlich per **Squash Merge** zusammen. Aktualisieren Sie den Branch nicht allein deshalb, weil `main` weiter fortgeschritten ist, sondern nur bei Merge-Konflikten oder auf Anforderung eines Maintainers. Der Betreff des Squash-Commits muss das Conventional-Commit-Format des Pull-Request-Titels beibehalten.
- Änderungen außerhalb der Dokumentation, die in `main` zusammengeführt werden, lösen den [Nightly-Workflow](../../.github/workflows/nightly.yml) aus. Dieser führt nach dem Merge die Verifizierung und plattformübergreifende Paketzertifizierung für den resultierenden Commit aus.

## Issues melden

Geben Sie beim Melden eines Fehlers bitte Folgendes an:

- Was Sie erwartet haben und was tatsächlich passiert ist.
- Schritte zur Reproduktion.
- Ihr Betriebssystem und die App-Version.
- Relevante Protokolle oder Screenshots, sofern verfügbar.

## npm-Paket veröffentlichen

Maintainer sollten die [Anleitung zur Veröffentlichung des npm-Pakets](../npm-release.md) befolgen. npm-Paketversionen verwenden Tags im Format `npm-v*` und werden über den geschützten Workflow `Publish npm package` veröffentlicht.

## Lizenz

Mit Ihrer Mitwirkung erklären Sie sich damit einverstanden, dass Ihre Beiträge unter der [Apache License 2.0](../../LICENSE) lizenziert werden, die auch für dieses Projekt gilt.
