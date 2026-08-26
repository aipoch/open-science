# Contribuyendo a Open Science

¡Gracias por su interés en contribuir! Este documento explica cómo configurar el proyecto, el flujo de trabajo que seguimos y las comprobaciones que debe pasar su cambio antes de poder fusionarlo.

> Este documento es una traducción del `CONTRIBUTING.md` en inglés. En caso de discrepancia, prevalece la [versión en inglés](../../CONTRIBUTING.md).

## Código de conducta

Sea respetuoso y constructivo en todas las interacciones. Asuma buenas intenciones, mantenga las discusiones centradas en los méritos técnicos y ayude a que este sea un proyecto acogedor para todos.

## Primeros pasos

### Requisitos previos

- [Node.js](https://nodejs.org/) 22 (ver [`.nvmrc`](../../.nvmrc) ) y npm
- Git

### Instalación

```bash
# Fork the repo at https://github.com/aipoch/open-science/fork, then:
git clone https://github.com/<your-username>/open-science.git
cd open-science

# Add the original repo as upstream (to stay in sync)
git remote add upstream https://github.com/aipoch/open-science.git

npm install
```

`npm install` ejecuta un paso `postinstall` que genera el cliente Prisma e instala las dependencias de la aplicación Electron nativa.

### Ejecutar en desarrollo

```bash
npm run dev
```

## Navegación para agentes de codificación

Ejecute comandos de instalación, desarrollo y validación desde la raíz del repositorio:

| Intención                        | Comando raíz                                                |
| -------------------------------- | ----------------------------------------------------------- |
| Instalar                         | `npm install`                                               |
| Ejecutar                         | `npm run dev`                                               |
| Prueba objetivo                  | `npm test -- <affected-test-path> [-t '<test pattern>']`    |
| Pruebas del módulo               | `npm run test:module -- <module-id>`                        |
| Pruebas afectadas                | `npm run test:affected -- --base <base> --head <head>`      |
| Comprobación de tipos de Node.js | `npm run typecheck:node`                                    |
| Verificación de tipo web         | `npm run typecheck:web`                                     |
| Lint                             | `npm run lint`                                              |
| Reserva completa                 | `npm run typecheck`, `npm run lint`, luego `npm test`       |
| Interfaz de usuario E2E          | `npm run build:e2e`, luego `npm run test:e2e`               |
| Viajes de interfaz de usuario    | `npm run build:e2e`, luego `npm run test:e2e:journey`       |
| Espacio de trabajo               | `npm run build:e2e`, luego `npm run test:e2e:workspace`     |
| A11y                             | `npm run build:e2e`, luego `npm run test:e2e:accessibility` |
| Visual                           | `npm run build:e2e`, luego `npm run test:e2e:visual`        |

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
2. Haga su cambio, manteniéndolo enfocado y autónomo.
3. Agregue o actualice pruebas que cubran el comportamiento que cambió.
4. Cree el conjunto de impacto de prueba final y ejecútelo después de la última edición del material. Utilice el respaldo completo cuando no se pueda establecer la propiedad, los consumidores o los riesgos.
5. Abra una solicitud de extracción con una descripción clara del cambio y su motivación.

### Componentes externos duraderos

Antes de agregar un recurso que sobreviva a su proceso de creación fuera del almacenamiento administrado por la aplicación o en un plano de control de terceros, siga el [contrato de propiedad de componente externo duradero](../PRD.md#durable-external-component-ownership). El mismo contrato se aplica al agregar una nueva ruta de creación, adopción o eliminación a un componente existente. La solicitud de extracción debe identificar:

- el módulo propietario del componente y la identidad exacta o el recibo registrado en el momento de la creación;
- crear/iniciar, detener, eliminar, recuperar fallos y desinstalar aplicaciones;
- cómo la limpieza falla sin escanear los directorios del sistema o tocar recursos compartidos, administrados por el usuario o no probados;
- las pruebas específicas de la plataforma para detener antes de eliminar, reintentar, idempotencia y preservación de recursos sin propietario; y
- cualquier impacto de formato persistente, compatibilidad histórica o nuevo estado.

Un gancho de limpieza futuro no es suficiente: no envíe la creación hasta que el propietario pueda detener y retirar el componente de forma segura. Si el PR cambia una excepción heredada conocida enumerada en el contrato, debe migrar esa ruta a una propiedad comprobada o documentar la excepción limitada y su plan de compatibilidad histórica; no utilice una excepción como precedente para un comportamiento nuevo.

### Cambios en el esquema de la base de datos

`prisma/schema.prisma` define las tablas, columnas, valores predeterminados, índices y claves externas. Las restricciones `CHECK` de SQLite que Prisma no puede expresar se mantienen en `prisma/sqlite-check-constraints.json`. El módulo del esquema en tiempo de ejecución se genera automáticamente; no lo edite ni agregue DDL al código de inicio.

1. Cambie el esquema Prisma y, solo cuando sea necesario, el contrato SQLite CHECK.
2. Ejecute `npm run db:schema:generate` y revise el esquema de destino generado.
3. Agregue una nueva entrada inmutable en `src/main/database/migrations/`; nunca cambie una migración publicada ni amplíe la lista de reparación heredada `0001` congelada.
4. Ejecute `npm run db:schema:check` y las pruebas de migración antes de confirmar.

Prisma CLI es solo una herramienta de desarrollo y CI. Las aplicaciones empaquetadas ejecutan el manifiesto de migración registrado y no incluyen el motor de migración Prisma.

El historial de migración es propiedad de `src/main/database/`. Las pruebas del módulo pueden ejecutar `migrateApplicationDatabase` para crear un dispositivo de esquema actual, pero los esquemas históricos elaborados a mano, las afirmaciones de actualización y las expectativas del libro mayor de migración pertenecen a las pruebas de migración de la base de datos y no a los conjuntos de módulos de funciones.

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
- ESLint aplica el Linting; ejecute `npm run lint`.
- Ajustar cadenas orientadas al usuario con la función de traducción `t()` de `react-i18next`. Agregue las traducciones correspondientes al espacio de nombres `renderer` en `src/shared/i18n/locales/es.json` (español), `src/shared/i18n/locales/fr.json` (francés), `src/shared/i18n/locales/ja.json` (japonés), `src/shared/i18n/locales/ko.json` (coreano), `src/shared/i18n/locales/ru.json` (ruso), `src/shared/i18n/locales/zh-Hans.json` (chino simplificado) y `src/shared/i18n/locales/zh-Hant.json` (chino tradicional). Utilice el texto en inglés como clave de traducción. Mantenga los comentarios del código y la documentación en inglés.

## Política de verificación

### Semántica de comando de prueba estable

- `npm test` siempre ejecuta la suite Vitest completa y multiplataforma. Su significado no depende de la rama actual ni de los archivos modificados.
- `npm test -- <paths> [-t '<pattern>']` ejecuta solo el destino explícito proporcionado por la persona que llama. No descubre pruebas afectadas y no debe describirse como verificación completa.
- La selección de impacto es una decisión separada basada en la diferencia final. No sobrecargue `npm test` con un comportamiento Git-diff implícito.

### Bucle interior

Durante la implementación, ejecute la prueba más pequeña propiedad del proyecto que practique el comportamiento que se está cambiando. Vuelva a ejecutarlo cada vez que ese comportamiento cambie. Los resultados del bucle interno de un estado de implementación anterior no son evidencia definitiva.

### Conjunto final de impacto de prueba local

Antes de la transferencia, obtenga el conjunto mínimo de la diferencia de material final:

1. pruebas del comportamiento del módulo modificado;
2. pruebas por contrato para interfaces y adaptadores modificados;
3. pruebas de consumo o de características cuando una interfaz puede haber cambiado;
4. verificaciones de tipos para cada proceso de ejecución afectado;
5. `npm run lint` cuando se cambió la configuración fuente o linted;
6. comprobaciones de plataforma, persistencia, migración, compilación o E2E para detectar riesgos que se puedan ejercer localmente.

La proximidad del directorio por sí sola no es evidencia de impacto. Si un archivo combina responsabilidades, trátelo como si afectara la interfaz o utilice el respaldo completo.

`test:module` admite solo los ID de módulo declarados en `scripts/ci/module-impact.json`. Ejecuta las pruebas seleccionadas de propietario, contrato y consumidor representativo de ese módulo; no es una verificación posterior completa para un cambio de interfaz. Utilice `test:affected` o el plan PR Gate de cabeza exacta cuando una interfaz o sus consumidores puedan haber cambiado.

### Reserva completa

Ejecute `npm run typecheck`, `npm run lint` y `npm test` cuando se aplique cualquiera de estos:

- no se puede establecer el Módulo Propietario, la Interfaz modificada o los consumidores;
- cambios en las entradas de validación global, incluidos los metadatos del paquete, TypeScript / Vitest /configuración de compilación, el flujo de trabajo o clasificador de PR Gate, o propiedad, consumidor, capacidad o enrutamiento alternativo en el manifiesto de impacto del módulo;
- el cambio atraviesa varias áreas de ejecución sin un mapa de impacto demostrado;
- un flujo de trabajo candidato a lanzamiento o un mantenedor solicita explícitamente el paquete local completo.

El respaldo total es un mecanismo de seguridad, no un requisito previo incondicional para cada solicitud de extracción. No se espera que los contribuyentes reproduzcan localmente todos los carriles de CI del sistema operativo.

Cambiar solo `testFiles` dentro de un módulo que ya se posee no activa el respaldo completo. Ejecute las pruebas de validación del manifiesto, `npm run test:module -- <module-id>`, las comprobaciones de tipo del proceso afectado y lint en su lugar; la CI del commit exacto sigue siendo la autoridad para las suites completas multiplataforma.

### Autoridad y evidencia de CI

PR Gate clasifica la diferencia final de base a cabeza a partir de entradas confiables, agrega carriles de riesgo para el consumidor y la plataforma, y ​​no cierra el plan completo por propiedad desconocida o ambigua. Los cheques seleccionados están bloqueando; los cheques no seleccionados se informan como omitidos en lugar de tratarse como prueba.

La transferencia final debe enumerar los cambios materiales, asignar cada comportamiento afectado a su verificación propiedad del proyecto y al resultado final ( `behavior -> command -> result` ), explicar por qué se incluyeron o excluyeron consumidores o carriles de plataforma e identificar riesgos descubiertos. Indique que las comprobaciones se ejecutaron después de la última edición del material. Marque únicamente el cambio verificado después de que una revisión independiente confirme que este mapeo cubre el estado final.

## Mensajes de commit

El asunto de cada commit debe seguir Conventional Commits e incluir un alcance:

```text
<type>(<scope>): <description>
```

Este formato se verifica para cada confirmación en una solicitud de extracción.

Utilice los mismos prefijos de tipo estándar que figuran en [Nombres de ramas](#nombres-de-ramas). El alcance debe ser un nombre corto, separado por guiones, para el área afectada y comenzar con una letra minúscula; se permiten mayúsculas en el interior para nombres propios y términos técnicos (por ejemplo, `macOS`).

```text
feat(projects): add sidebar filter
fix(notebook): prevent kernel startup timeout
ci(review): unify automated AI reviews
```

- Escribir una descripción clara, en modo imperativo, que comience con una letra minúscula; Se permiten mayúsculas en el interior para nombres propios y términos técnicos (por ejemplo, `detect user-installed CRAN R on Windows`).
- Mantener el tema conciso; use el cuerpo para explicar el _por qué_ cuando no sea obvio a partir de la diferencia.
- Agregue `!` antes de los dos puntos y un pie de página `BREAKING CHANGE:` para cambios importantes, por ejemplo `feat(api)!: remove legacy session endpoint`.

## Solicitudes de extracción

- Utilice el mismo formato `<type>(<scope>): <description>` para el título de la solicitud de extracción, por ejemplo `feat(projects): add sidebar filter`.
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
- Incluir el mapeo de evidencia final de [Política de verificación](#verification-policy), indicar que las verificaciones enumeradas se ejecutaron después de la última edición del material y mencionar los riesgos descubiertos.
- Mantenga los PR razonablemente pequeños y bien delimitados para que sean fáciles de revisar.
- Asegúrese de que se apruebe el conjunto de impacto de prueba final, o el respaldo completo cuando sea necesario.
- Después de que pasen las comprobaciones de la solicitud de extracción, combínela directamente usando **squash merge only**. No actualice la rama solo porque `main` avanzó; actualícelo cuando tenga conflictos de fusión o un mantenedor lo solicite. El asunto de la confirmación de squash debe mantener el formato de confirmación convencional del título de la solicitud de extracción.
- Los cambios no relacionados con la documentación combinados en `main` activan el [flujo de trabajo nocturno](../../.github/workflows/nightly.yml), que ejecuta la verificación posterior a la combinación y la certificación del paquete multiplataforma en la confirmación resultante.

## Informar de problemas

Al presentar un informe de error, incluya:

- Lo que esperabas que sucediera y lo que realmente sucedió.
- Pasos para reproducir.
- Su sistema operativo y versión de la aplicación.
- Registros o capturas de pantalla relevantes, si están disponibles.

## Publicación del paquete npm

Los responsables del mantenimiento deben seguir la [guía de publicación del paquete npm](../npm-release.md). Las versiones del paquete npm usan etiquetas `npm-v*` y se publican mediante el flujo de trabajo protegido `Publish npm package`.

## Licencia

Al contribuir, acepta que sus contribuciones tendrán la [Licencia Apache 2.0](../../LICENSE), la misma licencia que cubre este proyecto.
