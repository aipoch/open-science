# Contribuir a Open Science

Gracias por su interés en contribuir. Este documento explica cómo configurar el proyecto, el flujo de trabajo que seguimos y las comprobaciones que debe superar un cambio antes de poder fusionarse.

> Este documento es una traducción del `CONTRIBUTING.md` en inglés. En caso de discrepancia, prevalece la [versión en inglés](../../CONTRIBUTING.md).

## Código de conducta

Sea respetuoso y constructivo en todas las interacciones. Asuma buenas intenciones, mantenga las discusiones centradas en los méritos técnicos y ayude a que este sea un proyecto acogedor para todos.

## Primeros pasos

### Requisitos previos

- [Node.js](https://nodejs.org/) 22 (consulte [`.nvmrc`](../../.nvmrc)) y npm
- Git

### Instalación

```bash
# Cree un fork en https://github.com/aipoch/open-science/fork y, después:
git clone https://github.com/<your-username>/open-science.git
cd open-science

# Añada el repositorio original como upstream para mantener el fork actualizado
git remote add upstream https://github.com/aipoch/open-science.git

npm install
```

`npm install` ejecuta un paso `postinstall` que genera el cliente Prisma e instala las dependencias nativas de la aplicación Electron.

### Ejecutar en desarrollo

```bash
npm run dev
```

## Navegación para agentes de codificación

Ejecute comandos de instalación, desarrollo y validación desde la raíz del repositorio:

| Intención                         | Comando raíz                                                |
| --------------------------------- | ----------------------------------------------------------- |
| Instalar                          | `npm install`                                               |
| Ejecutar                          | `npm run dev`                                               |
| Prueba específica                 | `npm test -- <affected-test-path> [-t '<test pattern>']`    |
| Pruebas del módulo                | `npm run test:module -- <module-id>`                        |
| Pruebas afectadas                 | `npm run test:affected -- --base <base> --head <head>`      |
| Comprobación de tipos de Node.js  | `npm run typecheck:node`                                    |
| Comprobación de tipos web         | `npm run typecheck:web`                                     |
| Lint                              | `npm run lint`                                              |
| Comprobación completa de respaldo | `npm run typecheck`, `npm run lint`, luego `npm test`       |
| Interfaz de usuario E2E           | `npm run build:e2e`, luego `npm run test:e2e`               |
| Flujos de interfaz de usuario     | `npm run build:e2e`, luego `npm run test:e2e:journey`       |
| Espacio de trabajo                | `npm run build:e2e`, luego `npm run test:e2e:workspace`     |
| A11y                              | `npm run build:e2e`, luego `npm run test:e2e:accessibility` |
| Visual                            | `npm run build:e2e`, luego `npm run test:e2e:visual`        |

Cree árboles de trabajo de Git solo en el directorio `.worktree/<name>` del repositorio, y cada rama de cambio se basa en la rama predeterminada. No retire ni mueva otro árbol de trabajo.

Obtenga aprobación explícita antes de operaciones destructivas de Git o del sistema de archivos, instalación de dependencias que descarga o ejecuta código nuevo, publicación de paquetes o lanzamientos, manejo de credenciales fuera de los flujos existentes del proyecto o escrituras externas (como envíos, solicitudes de extracción, problemas y mensajes) que la tarea aún no solicitó.

Lea el documento del propietario existente antes de cambiar una de estas áreas y luego ejecute sus comprobaciones específicas:

| Área          | Documento de propietario                                                             | Controles enfocados                                                                                   |
| ------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Renderizador  | [Especificación de diseño](../design.md)                                             | `npm run typecheck:web`; pruebas dirigidas bajo `src/renderer/`                                       |
| Notebook      | [Arquitectura actual](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`; pruebas dirigidas bajo `src/main/notebook/`                                 |
| Configuración | [Diseño de configuración](../design.md#settings)                                     | `npm run typecheck`; pruebas dirigidas bajo `src/main/settings/` y `src/renderer/src/pages/settings/` |
| ACP           | [Arquitectura actual](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`; pruebas dirigidas bajo `src/main/acp/`                                      |

## Estructura del proyecto

Esta es una aplicación Electron creada con electron-vite, React y TypeScript. Tres capas de proceso de tiempo de ejecución y un módulo compartido se encuentran en `src/`:

- `src/main/` — proceso principal de Electron (entorno de ejecución de ACP, persistencia de sesiones, artefactos, Notebook, proyectos y controladores de IPC).
- `src/preload/`: puente de precarga que expone al renderizador una API `window.api` tipada.
- `src/renderer/` — React UI (páginas, tiendas, componentes).
- `src/shared/`: tipos y ayudantes compartidos entre procesos.

## Flujo de trabajo de desarrollo

1. Cree una rama a partir de la rama predeterminada para su cambio.
2. Haga su cambio y manténgalo acotado y autosuficiente.
3. Agregue o actualice pruebas que cubran el comportamiento que cambió.
4. Cree el conjunto final de impacto de las pruebas y ejecútelo después de la última edición material. Utilice la comprobación completa de respaldo cuando no se puedan determinar el módulo responsable, los consumidores o los riesgos.
5. Abra un pull request (PR) con una descripción clara del cambio y su motivación.

### Componentes externos duraderos

Antes de añadir un recurso que sobreviva al proceso que lo creó fuera del almacenamiento gestionado por la aplicación o en un plano de control de terceros, siga el [contrato de propiedad de componentes externos duraderos](../PRD.md#durable-external-component-ownership). El mismo contrato se aplica al añadir una nueva ruta para crear, adoptar o eliminar un componente existente. El PR debe identificar:

- el módulo propietario del componente y la identidad exacta o el recibo registrado en el momento de la creación;
- el comportamiento al crear o iniciar, detener, eliminar, recuperarse de fallos y desinstalar la aplicación;
- cómo la limpieza adopta un modo de fallo seguro sin escanear directorios del sistema ni tocar recursos compartidos, gestionados por el usuario o cuya propiedad no esté demostrada;
- las pruebas específicas de la plataforma para detener antes de eliminar, reintentar, idempotencia y preservación de recursos sin propietario; y
- cualquier impacto de formato persistente, compatibilidad histórica o nuevo estado.

Un hook de limpieza futuro no es suficiente: no publique la ruta de creación hasta que el módulo responsable pueda detener y retirar el componente de forma segura. Si el PR cambia una excepción heredada conocida que figure en el contrato, debe migrar esa ruta a una propiedad comprobada o documentar la excepción limitada y su plan de compatibilidad histórica; no use una excepción como precedente para un comportamiento nuevo.

### Cambios en el esquema de la base de datos

`prisma/schema.prisma` define las tablas, columnas, valores predeterminados, índices y claves foráneas. Las restricciones `CHECK` de SQLite que Prisma no puede expresar se mantienen en `prisma/sqlite-check-constraints.json`. El módulo del esquema en tiempo de ejecución se genera automáticamente; no lo edite ni añada DDL al código de inicio.

1. Cambie el esquema Prisma y, solo cuando sea necesario, el contrato SQLite CHECK.
2. Ejecute `npm run db:schema:generate` y revise el esquema de destino generado.
3. Agregue una nueva entrada inmutable en `src/main/database/migrations/`; nunca cambie una migración publicada ni amplíe la lista de reparación heredada `0001` congelada.
4. Ejecute `npm run db:schema:check` y las pruebas de migración antes de confirmar.

Prisma CLI es solo una herramienta de desarrollo y CI. Las aplicaciones empaquetadas ejecutan el manifiesto de migraciones incluido en el repositorio y no incluyen el motor de migración de Prisma.

El historial de migraciones pertenece a `src/main/database/`. Las pruebas del módulo pueden ejecutar `migrateApplicationDatabase` para crear un fixture con el esquema actual, pero los esquemas históricos creados manualmente, las aserciones de actualización y las expectativas del registro de migraciones pertenecen a las pruebas de migración de la base de datos, no a las suites de los módulos funcionales.

### Nombres de ramas

Utilice el formato `<type>/<short-description>`, con una descripción en minúsculas y separada por guiones:

```text
feat/project-sidebar-filter
fix/notebook-kernel-timeout
ci/ai-pr-review
```

Utilice uno de estos prefijos de tipo estándar:

- `feat` — una nueva característica
- `fix` — una corrección de errores
- `docs` — cambios solo en documentación
- `style`: formato u otros cambios que no afectan el comportamiento
- `refactor`: cambios de código que no corrigen un error ni agregan una característica
- `perf` — mejoras de rendimiento
- `test` — agregar o corregir pruebas
- `build` — sistema de compilación o cambios de dependencia
- `ci`: configuración de CI o cambios en el script
- `chore` — trabajos de mantenimiento no cubiertos por otro tipo
- `revert` — revertir un cambio anterior

### Estilo de codificación

- Coincidir con el estilo del código circundante: nombres, estructura y modismos.
- El formato está a cargo de Prettier. `npm run format` es opcional; revise sus cambios antes de confirmar porque reescribe archivos en todo el repositorio.
- ESLint aplica las reglas de lint; ejecute `npm run lint`.
- Envuelva las cadenas visibles para el usuario con la función de traducción `t()` de `react-i18next`. Agregue las traducciones correspondientes al espacio de nombres `renderer` en `src/shared/i18n/locales/es.json` (español), `src/shared/i18n/locales/fr.json` (francés), `src/shared/i18n/locales/ja.json` (japonés), `src/shared/i18n/locales/ko.json` (coreano), `src/shared/i18n/locales/pt-PT.json` (portugués europeo), `src/shared/i18n/locales/ru.json` (ruso), `src/shared/i18n/locales/zh-Hans.json` (chino simplificado) y `src/shared/i18n/locales/zh-Hant.json` (chino tradicional). Utilice el texto en inglés como clave de traducción. Mantenga los comentarios del código y la documentación en inglés.

## Política de verificación

### Semántica estable de los comandos de prueba

- `npm test` siempre ejecuta la suite Vitest completa y multiplataforma. Su significado no depende de la rama actual ni de los archivos modificados.
- `npm test -- <paths> [-t '<pattern>']` ejecuta únicamente el destino indicado de forma explícita. No detecta las pruebas afectadas y no debe describirse como una verificación completa.
- La selección de impacto es una decisión separada basada en la diferencia final. No sobrecargue `npm test` con un comportamiento Git-diff implícito.

### Bucle interior

Durante la implementación, ejecute la prueba más pequeña que pertenezca al módulo responsable y ejercite el comportamiento que está cambiando. Vuelva a ejecutarla cada vez que cambie ese comportamiento. Los resultados del bucle interno obtenidos con un estado de implementación anterior no son evidencia definitiva.

### Conjunto final de impacto de prueba local

Antes de la entrega, obtenga el conjunto mínimo correspondiente al diff material final:

1. pruebas del comportamiento del módulo modificado;
2. pruebas por contrato para interfaces y adaptadores modificados;
3. pruebas de consumo o de características cuando una interfaz puede haber cambiado;
4. verificaciones de tipos para cada proceso de ejecución afectado;
5. `npm run lint` cuando haya cambiado el código fuente o la configuración sujeta a lint;
6. comprobaciones de plataforma, persistencia, migración, compilación o E2E para los riesgos que puedan verificarse localmente.

La proximidad entre directorios no constituye por sí sola evidencia de impacto. Si un archivo combina responsabilidades, trátelo como un cambio de interfaz o utilice la comprobación completa de respaldo.

`test:module` solo admite los ID de módulo declarados en `scripts/ci/module-impact.json`. Ejecuta las pruebas seleccionadas del módulo responsable, del contrato y de un consumidor representativo; no constituye una verificación completa posterior a un cambio de interfaz. Use `test:affected` o el plan de PR Gate del `HEAD` exacto cuando una interfaz o sus consumidores puedan haber cambiado.

### Comprobación completa de respaldo

Ejecute `npm run typecheck`, `npm run lint` y `npm test` cuando se aplique cualquiera de estos:

- no se pueden determinar el módulo propietario, la interfaz modificada o los consumidores;
- cambian entradas de validación global, como los metadatos del paquete, la configuración de TypeScript, Vitest o la compilación, el flujo de trabajo o el clasificador de PR Gate, o la propiedad, los consumidores, las capacidades o las rutas alternativas del manifiesto de impacto del módulo;
- el cambio atraviesa varias áreas de ejecución sin un mapa de impacto demostrado;
- un flujo de publicación candidato o un responsable de mantenimiento solicita explícitamente la suite local completa.

La comprobación completa de respaldo es un mecanismo de seguridad, no un requisito previo incondicional para cada PR. No se espera que los colaboradores reproduzcan localmente todos los jobs de CI de cada sistema operativo.

Cambiar únicamente `testFiles` dentro de un módulo que ya tenga un responsable no activa la comprobación completa de respaldo. Ejecute en su lugar las pruebas de validación del manifiesto, `npm run test:module -- <module-id>`, las comprobaciones de tipos del proceso afectado y lint; la CI del commit exacto sigue siendo la autoridad para las suites multiplataforma completas.

### Autoridad y evidencia de CI

PR Gate clasifica el diff final entre la base y el `HEAD` a partir de entradas de confianza, añade comprobaciones de riesgo para consumidores y plataformas, y adopta un modo de fallo seguro ante una responsabilidad desconocida o ambigua. Las comprobaciones seleccionadas son obligatorias; las no seleccionadas se muestran como omitidas y no cuentan como evidencia.

La entrega final debe enumerar los cambios materiales, vincular cada comportamiento afectado con la comprobación del módulo responsable y su resultado (`comportamiento -> comando -> resultado`), explicar por qué se incluyeron o excluyeron consumidores o comprobaciones de plataforma e identificar los riesgos detectados. Indique que las comprobaciones se ejecutaron después de la última edición material. Marque el cambio como verificado solo después de que una revisión independiente confirme que este mapeo cubre el estado final.

## Mensajes de commit

El asunto de cada commit debe seguir Conventional Commits e incluir un alcance:

```text
<type>(<scope>): <description>
```

Este formato se verifica en cada commit de un PR.

Utilice los mismos prefijos de tipo estándar que figuran en [Nombres de ramas](#nombres-de-ramas). El alcance debe ser un nombre corto, separado por guiones, para el área afectada y comenzar con una letra minúscula; se permiten mayúsculas en el interior para nombres propios y términos técnicos (por ejemplo, `macOS`).

```text
feat(projects): add sidebar filter
fix(notebook): prevent kernel startup timeout
ci(review): unify automated AI reviews
```

- Escriba una descripción clara, en modo imperativo, que comience con una letra minúscula; se permiten mayúsculas en el interior para nombres propios y términos técnicos (por ejemplo, `detect user-installed CRAN R on Windows`).
- Mantenga el asunto conciso; use el cuerpo para explicar el _porqué_ cuando no resulte evidente en el diff.
- Agregue `!` antes de los dos puntos y un pie de página `BREAKING CHANGE:` para cambios incompatibles, por ejemplo `feat(api)!: remove legacy session endpoint`.

## Pull requests

- Utilice el mismo formato `<type>(<scope>): <description>` para el título del PR, por ejemplo `feat(projects): add sidebar filter`.
- Haga referencia a cualquier problema relacionado en la descripción.
- Para trabajos que cambien el comportamiento, utilice una descripción concisa para que los revisores puedan evaluar la intención, el alcance y la validación antes de leer la diferencia. Utilice la siguiente estructura cuando sea aplicable:

  ```md
  ## Problem

  ## Proposed change

  ## Scope and non-goals

  ## Acceptance criteria and validation

  ## Review focus
  ```

- Para cambios arquitectónicos, flujos de datos, transiciones de estado o interacciones entre múltiples componentes, considere agregar un diagrama Mermaid cuando facilite la comprensión y revisión del diseño.
- La documentación pequeña, el mantenimiento y las correcciones de alcance limitado pueden utilizar un resumen conciso, pero aun así deben indicar el comportamiento esperado y la validación.
- Incluya el mapeo de evidencia final de [Política de verificación](#política-de-verificación), indique que las comprobaciones enumeradas se ejecutaron después de la última edición material y mencione los riesgos detectados.
- Mantenga los PR razonablemente pequeños y bien delimitados para que sean fáciles de revisar.
- Asegúrese de que se apruebe el conjunto final de impacto de las pruebas o, cuando corresponda, la comprobación completa de respaldo.
- Después de que pasen las comprobaciones del PR, fusiónelo directamente usando solo **squash merge**. No actualice la rama únicamente porque `main` haya avanzado; hágalo cuando existan conflictos de fusión o lo solicite un responsable de mantenimiento. El asunto del commit de squash debe conservar el formato Conventional Commits del título del PR.
- Los cambios que no se limiten a la documentación y se fusionen en `main` activan el [workflow nocturno](../../.github/workflows/nightly.yml), que ejecuta la verificación posterior a la fusión y certifica el paquete multiplataforma en el commit resultante.

## Informar de problemas

Al presentar un informe de error, incluya:

- Lo que esperaba que sucediera y lo que ocurrió realmente.
- Pasos para reproducir.
- Su sistema operativo y versión de la aplicación.
- Registros o capturas de pantalla relevantes, si están disponibles.

## Publicación del paquete npm

Los responsables del mantenimiento deben seguir la [guía de publicación del paquete npm](../npm-release.md). Las versiones del paquete npm usan etiquetas `npm-v*` y se publican mediante el flujo de trabajo protegido `Publish npm package`.

## Licencia

Al contribuir, acepta que sus contribuciones tendrán la [Licencia Apache 2.0](../../LICENSE), la misma licencia que cubre este proyecto.
