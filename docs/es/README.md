<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  AIPOCH Open-Science es un entorno de investigación con IA de código abierto, centrado en el trabajo local y con modelos flexibles para una ciencia reproducible. Exporte el trabajo seleccionado como un paquete <code>.science</code> portátil para que otras personas puedan examinar el registro de investigación.
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">
    <img width="720" alt="Demostración de AIPOCH Open-Science para crear un paquete .science" src="../images/readme/demo-full.webp" />
  </a>
</p>

<p align="center">Ver en YouTube: <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">AIPOCH Open-Science: Generating .science Research Packages (Demo)</a></p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="Descargar AIPOCH Open-Science" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Última versión de AIPOCH Open-Science" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI de AIPOCH Open-Science en Zenodo" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="Preprint de AIPOCH Open-Science en arXiv: 2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#rendimiento-en-benchmarks">
    <img alt="AIPOCH Open-Science — Resultados de benchmarks" src="../images/readme/benchmark-comparisons.svg">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Plataformas macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="../../LICENSE">
    <img alt="Licencia Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="Sitio web aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
</p>

<p align="center">
  <a href="../../README.md"><img alt="README en inglés" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="README en ruso" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../de/README.md"><img alt="README en alemán" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../es/README.md"><img alt="README en español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> Este documento es una traducción del `README.md` en inglés. En caso de discrepancia, prevalece la [versión en inglés](../../README.md).

### 💡 AIPOCH Open-Science v1.2.1 — Novedades

_11 de noviembre de 2026_

- **Centro de recursos unificado**: Gestione habilidades, conectores, especialistas e instalaciones del mercado en un solo lugar; también se puede instalar desde la interfaz web.
- **Optimización manual del prompt**: Invoque al proveedor configurado desde el compositor, revise o edite el resultado y deshágalo; guarde plantillas propias en la configuración del proyecto.
- **Agente integrado mejorado**: Use suscripciones de Codex para el agente principal y los subagentes, Claude Fable 5.2 con un contexto de 1 millón de tokens y los límites de salida admitidos por cada proveedor.
- **Bibliografía en CSV**: Exporte referencias seleccionadas, un proyecto completo o una colección con 16 nombres de columna fijos en inglés.
- **Exportaciones de investigación compactas**: Notebook y Compute almacenan una sola vez cada evidencia única, reduciendo el tamaño y el tiempo de exportación de historiales `.science` largos.
- **Inicio de sesión en cómputo en la nube**: Modal y Hugging Face preparan Python compatible antes de la autorización en el navegador; la verificación de cuentas usa el proxy del sistema.
- **Fiabilidad**: Mejoras en la recuperación de actualizaciones de Windows, la continuación tras responder preguntas y los vídeos de investigación al cambiar de sesión; los intérpretes se liberan tras 15 minutos sin actividad de la sesión.

[Notas completas v1.2.1](https://github.com/aipoch/open-science/releases/tag/v1.2.1)

## 🚀 Inicio rápido

### 1. Descargue la aplicación

Abra la [página oficial de descargas](https://aipoch.com/open-science/download) y elija el instalador para su equipo:

| Su equipo                                 | Elija                                              |
| ----------------------------------------- | -------------------------------------------------- |
| macOS 12+: Apple Silicon (M1 o posterior) | El DMG de macOS para Apple Silicon / ARM64         |
| macOS 12+: Intel                          | El DMG de macOS para Intel/x64                     |
| Windows 10/11 x64                         | El instalador de Windows x64 (con firma de código) |
| Linux x64                                 | El paquete AppImage o Debian de Linux x64          |
| Linux ARM64                               | AppImage o paquete Debian de Linux ARM64           |

Consulte la [verificación de descargas](../../SECURITY.md#verifying-your-download) para realizar comprobaciones antes de instalar.

Los archivos de la CLI independiente para macOS, Linux y Windows incluyen Node.js y se pueden usar sin Homebrew ni npm.

En macOS, también puede instalar la aplicación con [Homebrew](https://brew.sh):

```bash
brew install --cask open-science
```

Para la CLI independiente en macOS o Linux, utilice el [tap de AIPOCH](https://github.com/aipoch/homebrew-tap) por separado:

```bash
brew install aipoch/tap/open-science
```

La fórmula incluye Node y no necesita la aplicación de escritorio en ejecución; su versión puede diferir del Cask de escritorio. Consulte los requisitos y las actualizaciones en la [guía del entorno independiente](../standalone-runtime.md).

Para el CLI independiente y la interfaz web, instale el [paquete npm publicado](https://www.npmjs.com/package/@aipoch/open-science) con **Node.js 22.13.0 o posterior**:

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

Abra la URL indicada para completar la configuración o siga la [guía de configuración desde el terminal](../../packages/open-science/CLI.md#first-run-setup-codex). npm admite macOS ARM64/x64, Linux ARM64/x64 con glibc y Windows x64; no requiere la aplicación de escritorio. Mantenga las dependencias opcionales de npm y consulte los [requisitos de Linux y las instrucciones de actualización](../standalone-runtime.md#install-from-npm). La URL contiene un token de autenticación; manténgala privada.

En Windows, reinstalar conserva los datos de investigación. Para una limpieza completa, consulte la [herramienta de restablecimiento](../../scripts/windows-reset/README.md), que elimina permanentemente los datos locales tras la confirmación.

### 2. Complete la configuración inicial

Siga el asistente: **Entorno → Ubicación de datos → Entorno de ejecución del agente → Proveedor de modelo → Entorno de ejecución de Notebook**.

Complete las comprobaciones obligatorias del entorno y del runtime del agente y pruebe la conexión al modelo. Python/R Notebook es opcional; Notebook y la ubicación de datos pueden ajustarse más adelante en Configuración.

En los ajustes del sistema encontrará las opciones de apariencia y notificaciones. La sección **General** incluye la guía de instalación y actualización manuales.

La antigua pestaña Modelo ahora se llama **Capacidades locales** e incluye extracción de PDF, paquetes de idioma OCR y narración de investigaciones. La narración requiere un modelo de voz instalado localmente.

<table>
<tr>
<td width="50%"> <img src="../images/readme/onboarding-environment.jpg" alt="Comprobaciones automáticas del entorno durante el primer inicio de AIPOCH Open-Science"> </td>
<td width="50%"> <img src="../images/readme/onboarding-model-provider.jpg" alt="Configuración del proveedor de modelos durante el primer inicio de AIPOCH Open-Science"> </td>
</tr>
<tr>
<td align="center"> <sub> Comprobaciones de red, almacenamiento y compatibilidad del host </sub> </td>
<td align="center"> <sub> Proveedor, clave API, endpoint y validación de modelo </sub> </td>
</tr>
</table>

### 3. Iniciar un proyecto de investigación

1. Haga clic en **Nuevo proyecto**, abra una sesión y describa el objetivo de investigación, las entradas y los resultados esperados.
2. Adjunte archivos, elija un modelo y un modo de aprobación y envíe la tarea. Use `@` para referenciar archivos del proyecto o `/` para elegir una habilidad.
3. Revise la actividad de las herramientas y las solicitudes de aprobación, previsualice los resultados y consulte la evidencia disponible en **Procedencia**.

> Las capturas de pantalla de este archivo README ilustran el flujo de trabajo. Las etiquetas, catálogos y otros detalles de la interfaz pueden diferir de la versión que instale.

## Paquetes de investigación `.science` de AIPOCH Open-Science

Exporte una sesión de investigación terminada como un paquete `.science` portátil para revisión, traspaso y archivo. Elija las ramas de conversación, versiones de archivos, registros de Notebook y evidencias de verificación que desea incluir, y luego importe el paquete en otro proyecto o equipo.

La exportación y la importación están disponibles en la aplicación de escritorio, las sesiones web locales y la CLI sin interfaz. Las sesiones web remotas no pueden leer ni escribir rutas arbitrarias de paquetes locales.

**Exportar → transferir → inspeccionar**

1. Exporte una sesión terminada y elija el contenido que desea incluir.
2. Transfiera el archivo `.science` a un colaborador o a otro equipo.
3. Importe el archivo en un proyecto. **Research replay**, a la derecha, muestra el proceso registrado; la conversación de la izquierda permite hacer preguntas y citar pasos fijos.

Los registros importados siguen siendo de solo lectura; ver la reproducción no ejecuta código, no llama a modelos ni restaura credenciales. La primera pregunta crea una conversación editable asociada; utilice **Fork to continue** para crear una copia de trabajo. Volver a ejecutar un resultado sigue requiriendo una receta completa, los datos necesarios y un entorno disponible.

Las preguntas desde una investigación importada o un paso de reproducción abren discusiones secundarias vinculadas al paso sin modificar la importación. Se conservan al archivar; al eliminar la sesión principal se convierten en conversaciones normales.

Se excluyen las conversaciones Side Chat, los marcadores privados de lectura y las credenciales; los archivos incluidos dependen de la selección de exportación. Los registros de verificación recibidos describen las comprobaciones del remitente, no una nueva ejecución en este equipo. Consulte la [guía de paquetes `.science`](https://aipoch.com/docs/guides/research-packages/).

<a id="rendimiento-en-benchmarks"></a>

## Resultados de benchmarks

AIPOCH evaluó AIPOCH Open-Science en tareas que abarcan encontrar un artículo, responder preguntas sobre su contenido y ejecutar un plan de investigación. Los resultados siguientes proceden de ejecuciones propias de AIPOCH. Cada puntuación corresponde a una tarea y una configuración de evaluación concretas. La evaluación también abarca la reproducción de resultados computacionales y la formulación de hipótesis a partir de datos.

| Tarea                                | Resultado de AIPOCH Open-Science                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encontrar el artículo objetivo       | En **68 de las 75 preguntas de prueba**, el artículo objetivo apareció entre los primeros 30 resultados de LitQA2-FullText-Search (**90.67% Recall@30**, gpt-6-astra).                                     |
| Responder a partir de la literatura  | En una ejecución independiente de LitQA2-FullText, Open-Science respondió correctamente **70 de 75 preguntas** (**93.33% de exactitud**, deepseek-flash con razonamiento Max).                             |
| Elaborar una síntesis con citas      | En 100 preguntas de validación de ScholarQA-CS2, Open-Science obtuvo una **puntuación compuesta de calidad de 0.9289/1** con deepseek-v4-flash. Las referencias de la prueba oficial usan otras preguntas. |
| Ejecutar flujos de investigación     | En ejecuciones locales de ASI-Bench con el mismo modelo, Open-Science obtuvo **59.46** en B4 y Codex **55.45**. En B2 las puntuaciones fueron casi idénticas (**56.11** y **56.09**).                      |
| Analizar datos biomédicos            | En BiomniBench-DA Public 50, dos modelos jueces puntuaron los resultados con **81.04** y **77.06**. Su media con igual ponderación fue **79.05**.                                                          |
| Reproducir resultados publicados     | CORE-Bench-Hard — 36 de 37 tareas de prueba correctas (97,30 %) en la evaluación local. El recuento incluye repeticiones.                                                                                  |
| Formular hipótesis a partir de datos | DiscoveryBench — En un subconjunto de 25 tareas de validación, la puntuación media del modelo evaluador local fue de 0,7467/1.                                                                             |

### AstaBench — Tareas de literatura

<details>
<summary><strong>Búsqueda de artículos — objetivo encontrado en 68 de 75 preguntas</strong></summary>

AIPOCH ejecutó localmente la partición Test oficial de 75 preguntas de LitQA2-FullText-Search. Su Recall@30 igualó el valor más alto de la instantánea comparativa del 26 de octubre de 2026. Esta ejecución local no fue una presentación a la clasificación oficial ni una posición en ella.

![Comparación de búsqueda LitQA2 de AIPOCH Open-Science: Recall@30 local del 90.67% en la partición Test oficial](../images/readme/astabench-litqa2-test.jpg)

Recall@30 cuenta un acierto cuando el artículo objetivo aparece entre los primeros 30 resultados; no mide la exactitud de las respuestas. Los costes no se calcularon de forma uniforme entre ejecuciones.

</details>

<details>
<summary><strong>Preguntas sobre texto completo — 70 respuestas correctas de 75</strong></summary>

AIPOCH ejecutó la partición Test de 75 preguntas de LitQA2-FullText en AstaBench v0.5.4. El gráfico ordena por puntuación el resultado local y los registros históricos de referencia. Su «#1» se refiere a esa comparación.

![Comparación de respuestas sobre texto completo LitQA2 de AIPOCH Open-Science: exactitud local del 93.33%](../images/readme/astabench-litqa2-fulltext-local-comparison.png)

La exactitud mide las respuestas correctas. Aquí, 93.33% es la exactitud local de respuesta y 90.67% es una exactitud histórica de referencia. El gráfico de búsqueda anterior usa otra métrica. Las referencias se recopilaron el 28 de octubre de 2026; la mayor puntuación de referencia se comprobó de nuevo el 2 de noviembre.

</details>

<details>
<summary><strong>Calidad de respuestas con citas — validación local y referencias oficiales de prueba</strong></summary>

El resultado local de ScholarQA-CS2 mide la calidad de respuestas con citas en 100 preguntas de Validation. Las referencias proceden de Test, por lo que estas puntuaciones no establecen una clasificación de enfrentamiento directo.

![Comparación ScholarQA-CS2 de AIPOCH Open-Science: puntuación compuesta local de Validation de 0.9289, separada de las referencias oficiales de Test](../images/readme/astabench-scholarqa-cs2.jpg)

La puntuación compuesta se expresa en una escala de 0 a 1; no es el porcentaje de preguntas respondidas de forma completamente correcta.

</details>

### AstaBench — Reproducibilidad y formulación de hipótesis

<details>
<summary><strong>CORE-Bench-Hard — 36/37</strong></summary>

El 6 de noviembre, AIPOCH utilizó DeepSeek Flash con razonamiento Max para reproducir resultados a partir del código, los datos y el README de un estudio. El evaluador programático oficial se ejecutó localmente y asignó un punto solo si todas las respuestas requeridas eran correctas. Se puntuaron las 37 tareas y el recuento incluye repeticiones. [AIPOCH](https://aipoch.com/blog/aipoch-open-science-core-bench-hard).

</details>

<details>
<summary><strong>DiscoveryBench — 0,7467/1</strong></summary>

El 9 de noviembre, AIPOCH utilizó deepseek-v4-flash tanto para generar hipótesis como para puntuarlas con una implementación local del procedimiento de evaluación. De las 25 tareas, 18 obtuvieron la puntuación máxima, dos una puntuación parcial y cinco un cero. El conjunto de tareas y el evaluador difieren de los de la prueba oficial completa, por lo que no se pueden comparar posiciones.

</details>

### ASI-Bench — Seguir un plan y elegir métodos

Las cuatro condiciones piden al agente ejecutar un plan especificado (B1), organizar un flujo de trabajo (B2), elegir métodos (B3) o investigar con información distractora (B4). Las dos primeras filas del gráfico comparan ejecuciones locales con el mismo modelo GPT-6 Astra.

![Resultados ASI-Bench B1–B4 de AIPOCH Open-Science junto a ejecuciones locales de Codex y referencias publicadas](../images/readme/asi-bench-b1-b4.jpg)

Open-Science obtuvo **79.35, 56.11, 59.67 y 59.46** en B1–B4; la referencia local de Codex obtuvo **74.78, 56.09, 58.12 y 55.45**. Las puntuaciones B2 fueron casi idénticas. Otras ejecuciones publicadas difieren en instancias de tareas, configuraciones o evaluación.

La puntuación local B1 cubre 59 tareas tras excluir una por un problema del sistema de puntuación. Se informaron tres repeticiones locales para B1/B2. B3/B4 usaron Open-Science v0.32.0 y un juez sustituto; cada puntuación es la media de tres ejecuciones de 60 tareas.

### BiomniBench-DA — Análisis de datos biomédicos

En el conjunto Public 50, el juez Gemini 3.1 Pro puntuó los resultados con **81.04** y el juez DeepSeek v4-pro con **77.06**. AIPOCH informa de su media con igual ponderación, **79.05**, para la configuración gpt-5.6-sol (xhigh).

<details>
<summary><strong>Puntuaciones de jueces y referencias históricas — cobertura de evaluación variable</strong></summary>

El gráfico combina entradas con distinta cobertura de jueces. Su «#1» describe el orden de esa colección. Una clasificación con un procedimiento común exigiría puntuaciones comparables para todas las entradas.

![Comparación BiomniBench-DA Public 50 de AIPOCH Open-Science con las puntuaciones de los dos jueces y su media](../images/readme/biomnibench-public50-leaderboard.png)

79.05 es una puntuación media de los jueces en esta evaluación interna.

</details>

**Alcance de la evaluación:** estos informes cubren ejecuciones locales o internas de agosto a noviembre de 2026 con los modelos y particiones indicados; no se repitieron para la versión actual. Las referencias son instantáneas históricas, no clasificaciones en tiempo real. Las puntuaciones de distintas familias de benchmarks no son directamente comparables y las diferencias numéricas no establecen significación estadística.

Consulte el [informe de AstaBench y ASI-Bench](https://aipoch.com/benchmark/open-science) y el [informe de BiomniBench-DA](https://aipoch.com/blog/open-science-biomnibench-da) para conocer los detalles.

<a id="capacidades-principales"></a>

## ¿Por qué usar AIPOCH Open-Science?

1. **Lee artículos y analiza datos en un mismo proyecto.**
   - Importa referencias desde Zotero o pega hasta 100 identificadores o enlaces de artículos a la vez. Tras configurar un modelo de cribado, aplica tus criterios de inclusión y exclusión. Compara las decisiones del modelo con las tuyas y consulta los PDF para verificar un hallazgo en su contexto.
   - Visualiza datos científicos, documentos, imágenes y estructuras moleculares junto a los artículos. Ejecuta Python o R en un cuaderno para generar una tabla o figura con los datos del proyecto y contrasta el resultado con los archivos de origen.

2. **Comprueba cómo se obtuvo un resultado y qué respalda la respuesta.**
   - Abre una versión concreta de una figura, tabla o informe en **Provenance** para consultar las entradas, el código y el historial disponibles. Si dispones de las entradas, el procedimiento y el entorno de ejecución, vuelve a ejecutar esa versión en la aplicación de escritorio y compara los resultados.
   - Activa **Reviewer** para contrastar la respuesta del agente con los registros de ejecución y los archivos disponibles para ese turno. Consulta los problemas que detecta y la revisión posterior a las correcciones del agente.

3. **Comparte con tus colegas el contexto de un resultado.**
   - Elige las ramas de conversación, versiones de archivos, registros del cuaderno y pruebas de verificación que incluirás en un paquete `.science`. Otra persona puede abrirlo en otro equipo y consultar los pasos que dieron lugar a una figura o tabla.
   - El registro importado se abre en modo de solo lectura. La importación no ejecuta código ni restaura credenciales. Las verificaciones corresponden al equipo de origen. Para explorar otra pregunta, tu colega puede seleccionar **Fork to continue** y trabajar en una copia editable.

4. **Elige herramientas y recursos de cómputo para tu análisis.**
   - Selecciona un proveedor de modelos y accede a fuentes de datos científicos mediante **48 conectores integrados**. Algunos deben activarse primero.
   - Usa las **24 habilidades integradas** para tareas recurrentes. El [mercado de habilidades](https://github.com/aipoch/openscience-skill-marketplace) ofrece **525 habilidades** que puedes instalar. Para delegar parte del trabajo, elige entre los **10 especialistas** del [mercado de especialistas](https://github.com/aipoch/openscience-specialist-marketplace).
   - Ejecuta el análisis localmente o envíalo a un entorno que administres mediante SSH, Slurm, Kubernetes, Hugging Face Jobs, Modal o Ray. Revisa el destino, el comando, los recursos y las salidas antes de aprobar un trabajo remoto. Los trabajos en la nube pueden generar cargos en la cuenta conectada.

## Proveedores de modelos

AIPOCH Open-Science es independiente del modelo a nivel de producto: conéctelo a los principales proveedores de LLM en la nube, una puerta de enlace personalizada o reutilice una suscripción Claude o Codex existente. Actualmente, la disponibilidad del proveedor depende del backend del agente seleccionado y de los protocolos API que admite. Están disponibles las siguientes opciones de conexión:

| Modo proveedor                     | Cómo funciona                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedores de nube integrados** | Elija de la lista de proveedores que muestra la aplicación instalada y autentíquese con la clave solicitada.                                                                                                                                                                                                                                                                                                                                                                 |
| **Puerta de enlace personalizada** | Indique la URL base, el ID exacto del modelo y un protocolo API compatible con el backend elegido (Messages, Chat Completions o Responses), y pruebe la conexión. Las pasarelas remotas requieren HTTPS y clave API. Las direcciones de loopback como `localhost`, `127.0.0.1` o `[::1]` permiten HTTP sin clave; hay ajustes predefinidos para Ollama, LM Studio, llama.cpp y vLLM. El formato API predeterminado no garantiza la compatibilidad del servidor o del modelo. |
| **Suscripción de Codex**           | Seleccione Open-Science Agent o Codex y luego elija Suscripción de Codex como tipo de proveedor. Importe un inicio de sesión de Codex existente o inicie sesión con Open-Science.                                                                                                                                                                                                                                                                                            |
| **Suscripción de Claude**          | Inicie sesión con una suscripción de Claude en dos modos: **compartido** (un inicio de sesión en el navegador que almacena las credenciales en el perfil predeterminado `~/.claude`) o **aislado** (un flujo `claude setup-token` gestionado por la aplicación bajo un `CLAUDE_CONFIG_DIR` propio y completamente aislado de `~/.claude/`, con la opción alternativa de pegar un token).                                                                                     |
| **xAI (Grok) OAuth**               | Utilice el inicio de sesión de dispositivo integrado de xAI (Grok) OAuth. El acceso depende de la cuenta de xAI y de los protocolos del backend elegido; valide la conexión en la aplicación.                                                                                                                                                                                                                                                                                |

Hay 25 opciones de proveedor preconfiguradas, incluidos OpenAI, Anthropic, DeepSeek, NVIDIA Build y otros. Los modelos y puntos de acceso regionales dependen de la versión instalada y del backend elegido; consulte el selector y la prueba de conexión de la aplicación.

## Datos, permisos y confianza

AIPOCH Open-Science almacena en el equipo local los datos del proyecto, la configuración, las versiones de los artefactos y la evidencia de procedencia. Las claves API se guardan localmente y utilizan el almacén seguro de credenciales del sistema operativo cuando está disponible. Los registros también son locales y no se cargan automáticamente.

El flujo de datos externos aún es posible y debe revisarse:

- Las solicitudes al modelo envían el prompt y el contexto necesarios al proveedor del modelo seleccionado.
- Las búsquedas web y los conectores remotos envían sus parámetros mostrados a servicios externos.
- Los conectores locales pueden ejecutar comandos de confianza en el equipo.
- La aplicación también puede contactar con servidores de actualización, catálogos del mercado y servicios de descarga de entornos o modelos.
- Los archivos adjuntos, las referencias `@`, los registros y los informes generados pueden contener datos de investigación confidenciales.

Elija el perfil de permiso más limitado que se ajuste a la tarea:

| Modo                                  | Comportamiento                                                                                                                                                               | Uso recomendado                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Solicitar aprobación**              | Solicita aprobación para las acciones no cubiertas por permisos acotados existentes o políticas de herramientas de confianza de la aplicación                                | Flujos de trabajo nuevos, datos confidenciales y scripts desconocidos        |
| **Aprobar ediciones automáticamente** | Usa la revisión automática nativa del backend cuando existe; en caso contrario, solo autoriza automáticamente operaciones claramente de bajo riesgo en el espacio de trabajo | Edición de archivos de confianza con acceso externo controlado               |
| **Acceso completo**                   | Permite automáticamente las ediciones, los comandos, el acceso a la red y los conectores                                                                                     | Trabajo desatendido, de plena confianza y con un alcance claramente definido |

El perfil efectivo depende del backend y de los permisos existentes. También se aplican las políticas de conectores, herramientas y red de cálculo; compruebe el modo efectivo que muestra la aplicación.

Revise los parámetros del conector y la actividad de la herramienta antes de aprobarlos. Nunca incluya claves API, tokens de acceso, identificadores de pacientes, datos no publicados o rutas locales confidenciales en capturas de pantalla o registros de problemas públicos.

## Desarrollo y empaquetado

AIPOCH Open-Science consta de un backend Node convencional y un cliente de escritorio Electron, con React, TypeScript, Prisma/SQLite y Open-Science Agent integrado junto con backends de agentes opcionales.

Requisitos previos para desarrollar desde el código fuente:

- Node.js 24 (consulte [`.nvmrc`](../../.nvmrc)) con npm
- Git
- La ejecución de Notebook es opcional y usa entornos Python/R gestionados por la aplicación o un intérprete compatible que usted configure.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

Consulte la [referencia de comandos de desarrollo y empaquetado](development-quick-reference.md) y la [guía de contribución](../../CONTRIBUTING.md) para los comandos de compilación y el flujo de desarrollo.

### Modos web y sin interfaz gráfica en localhost

La interfaz web funciona con un backend Node independiente, sin Electron ni entorno gráfico.

```bash
npm run dev:web
npm run pack:backend
```

La interfaz web funciona con un backend Node independiente, sin Electron ni entorno gráfico. `npm run dev:web` y `npm run dev:headless` compilan e inician el backend y la interfaz web; no inician el escritorio ni la bandeja. `OPEN_SCIENCE_WEB_PORT` selecciona el puerto (predeterminado `44100`); Ctrl+C cierra el servicio en primer plano de forma ordenada.

El desarrollo desde el código fuente requiere Node.js 24. El paquete npm publicado y el tarball independiente compilado localmente requieren Node.js >=22.13.0. Los archivos de Release, la fórmula Homebrew y el lanzador del escritorio incluyen su propio entorno de ejecución.

La aplicación de escritorio y el navegador comparten el mismo servicio. Las aplicaciones conectadas y una solicitud explícita de mantener el servicio activo mediante `open-science start` lo mantienen en ejecución. Al salir de la última aplicación, el servicio solo se detiene si no queda ninguna solicitud explícita de mantenerlo activo.

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### Acceso remoto móvil

Escanee un código QR para abrir el espacio de trabajo actual en un teléfono o una tableta por WiFi local o un túnel Pinggy. El emparejamiento por WiFi permanece en la red local; los túneles de Internet encaminan el tráfico por los servidores de Pinggy, como indica el diálogo de conexión.

### CLI y SDK sin interfaz gráfica

La CLI sin interfaz gráfica y el SDK de Node.js sin dependencias utilizan el mismo daemon local, así como los mismos proyectos, sesiones, credenciales y permisos que las interfaces web y de escritorio. La documentación detallada se incluye en el paquete publicado y sirve como referencia única de los comandos:

- [Guía CLI](../../packages/open-science/CLI.md): instalación, ciclo de vida del servicio, automatización de tareas, artefactos, formatos de salida y códigos de salida
- [Descripción general del paquete SDK](../../packages/open-science/README.md) - Inicio rápido de Node.js y punto de entrada del paquete

La CLI independiente puede exponer sus herramientas de investigación a clientes MCP externos mediante `open-science mcp`. Primero, inicie y autentique el servicio del perfil seleccionado. El adaptador usa los permisos existentes de ese perfil; no es un entorno aislado ni una vista de solo lectura, por lo que los clientes conectados pueden guardar cambios y generar costes de modelos. No expone acceso arbitrario a shell o RPC, gestión de credenciales, importación o exportación de archivos, descargas a una ruta ni un endpoint MCP HTTP remoto.

## Preguntas frecuentes

<a id="por-qué-falla-la-prueba-de-conexión-del-modelo"></a>

<details>
<summary>¿Por qué falla la prueba de conexión del modelo?</summary>

R: Compruebe que la clave API no tenga caracteres omitidos ni espacios, verifique la URL base y la región, use el ID exacto del modelo indicado por el proveedor y confirme el acceso a la red y el saldo de la cuenta. Para una suscripción de Claude, vuelva a iniciar sesión en el navegador compartido o actualice la credencial aislada `claude setup-token`, según el modo seleccionado.

</details>

<a id="por-qué-continuar-está-deshabilitado-durante-la-instalación"></a>

<details>
<summary>¿Por qué **Continuar** está deshabilitado durante la instalación?</summary>

R: El paso actual no cumple la condición requerida. Corrija cualquier fila del entorno marcada como **Acción necesaria**, instale o repare el entorno de ejecución del agente seleccionado o valide el proveedor del modelo, según el paso activo. La configuración de Notebook es opcional y solo afecta a la ejecución de Notebook.

</details>

<a id="cómo-ejecuto-trabajos-en-un-clúster-hpc-remoto"></a>

<details>
<summary>¿Cómo ejecuto trabajos en un clúster HPC remoto?</summary>

R: **Computación remota (SSH)** permanece siempre habilitada y no necesita activarse en Configuración. Registre un host de cálculo SSH en **Configuración → Conexiones → Cálculo**, hágalo disponible para la sesión actual y utilice lenguaje natural o `/remote-compute-ssh`. Se necesita un host SSH accesible, autenticación válida, permisos sobre los directorios necesarios y el software, las dependencias y los recursos de cálculo que requiera la tarea. Direct SSH no requiere planificador; el modo Slurm exige un entorno Slurm operativo y permiso para enviar trabajos. “Siempre habilitada” se refiere a la habilidad, no a la disponibilidad permanente de cada host registrado.

También puede usar Kubernetes, Hugging Face Jobs, Modal y Ray en destinos conectados por usted. Antes de cada envío externo, apruebe el destino, el comando, los recursos y las salidas. Los registros de recuperación permiten retomar la recogida de resultados tras un reinicio; los resultados publicados se abren en Compute Preview. Debe proporcionar las cuentas, el software, los recursos y los permisos; los trabajos en la nube pueden generar cargos.

</details>

<a id="existe-una-interfaz-de-línea-de-comandos"></a>

<details>
<summary>¿Existe una interfaz de línea de comandos?</summary>

R: Sí. Instale la CLI independiente o use **Configuración → General → Herramienta de línea de comandos → Instalar comando** para controlar una instancia de escritorio que ya esté en ejecución. La instalación mediante npm requiere Node.js; Homebrew y los paquetes independientes con entorno de ejecución incluido ya lo incorporan. Inicialice el perfil local y, a continuación, controle el servicio y envíe tareas de investigación sin abrir un navegador:

```bash
# Inicie el servicio en segundo plano
open-science init
open-science start --no-open

# Cree un proyecto y ejecute una tarea usando su nombre exacto
open-science project create "Revisión sistemática"
open-science run --project "Revisión sistemática" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# Descargue un artefacto generado
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

Consulte la [guía CLI](../../packages/open-science/CLI.md) para obtener la referencia completa de comandos, formatos de salida JSON/JSONL, códigos de salida y opciones de servicio sin interfaz gráfica.

</details>

<a id="cómo-inspecciono-de-dónde-provino-un-resultado-generado"></a>

<details>
<summary>¿Cómo inspecciono de dónde provino un resultado generado?</summary>

R: Abra el artefacto generado y elija **Procedencia**. Seleccione una versión para inspeccionar la identidad del contenido, el código que produjo el artefacto, el historial de ejecución, las entradas, el inventario del entorno, el contexto de la conversación de origen y la evidencia del revisor. La evidencia que AIPOCH Open-Science no pudo verificar se marca como no disponible.

</details>

<a id="puedo-revisar-una-solicitud-anterior-sin-perder-la-conversación-que-siguió"></a>

<details>
<summary>¿Puedo revisar una solicitud anterior sin perder la conversación que siguió?</summary>

R: Sí. Edite un mensaje de usuario completo y reenvíelo para crear una nueva rama desde ese punto. Los turnos posteriores originales permanecen disponibles y las flechas de revisión junto al mensaje permiten cambiar entre las rutas alternativas.

</details>

## Colaboradores

Gracias a todas las personas que contribuyen a AIPOCH Open-Science con código, documentación, traducciones, informes de errores y ayuda a la comunidad.

[Ver colaboradores en GitHub](https://github.com/aipoch/open-science/graphs/contributors)

[![Colaboradores de AIPOCH Open-Science](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## Participe

Ayude a mejorar AIPOCH Open-Science: informe de un error, sugiera una función, haga una pregunta o contribuya. Elija un canal a continuación para empezar.

| Canal                                                                    | Úselo para                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [GitHub Problemas](https://github.com/aipoch/open-science/issues)        | Errores, fallos reproducibles y propuestas de funciones concretas                    |
| [GitHub Discusiones](https://github.com/aipoch/open-science/discussions) | Preguntas de diseño, propuestas de hoja de ruta y conversaciones técnicas más largas |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Ayuda comunitaria, coordinación de contribuyentes y discusión informal               |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Anuncios de versiones y novedades sobre el desarrollo público                        |
| [Sitio web de AIPOCH Open-Science](https://aipoch.com/open-science)      | Descripción general oficial del producto y descargas                                 |

Antes de abrir una incidencia pública, elimine de los registros y las capturas de pantalla las claves API, los tokens, las rutas de archivos privados, los datos no publicados, los identificadores de pacientes y cualquier otro material confidencial. Consulte [CONTRIBUTING.md](../../CONTRIBUTING.md) para conocer el flujo de trabajo de desarrollo.

> Si AIPOCH Open-Science le resulta útil, dé una estrella al repositorio en GitHub.

Las capacidades entregadas, parciales y previstas aparecen en el [mapa de capacidades](../ROADMAP.md#capability-map).

<a id="aipoch-open-science-artículo-y-cita"></a>

## Cómo citar

Si utilizas AIPOCH Open-Science en tu investigación, cita la [prepublicación de AIPOCH Open-Science](https://arxiv.org/abs/2610.17110).

<details>
<summary>Cita BibTeX</summary>

```bibtex
@misc{ouyang2026aipochopenscienceopensourceai,
      title={AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages},
      author={Wen Ouyang and Bocheng Huang and Qianyu Yao and Fei Sun and Minying Deng and Haoyue Cheng and Wenwen Zhou and Lei Mou and Yusi Wei and Jiang Li and Kun Zhu and Lei Wang and Yi Feng and Jiaheng Dai and Ke Qian and Dan Wang and Yahui Wang and Chenyi Wang and Mingsheng Lyu and Yaqiang Zhang and Ping Zheng and Chunhua Tang and Xinge Ma and Xu Zhang and Youjia Fan and Can Lu and Zhijun Dai and Man Hu and Qiqi Xie and Beinan Liu and Yuanning Guo and Yunze Liu and Jinhong Jiang and Xianjun Fu and Mingwei Zhang and Yuanji Xu and Shilin Xia and Bowen Yang and Mingjun Yu and Jingdun Xie and Xuwei Chen and Xia Zou and Yuzhou Xue and Jianguo Zhou and Chunhao Cao and Donghao Tian and Lei Huang and Jinxiao Li and Shengrong Long and Zefeng Song and Honglin Li and Jiang Luo and Wenying Jiang and Shanshan Li and Lei Dai and Ning Jiang and Ying Cai and Chaohui Li and Chunyan Peng and Hetong Zhao and Angqing Li and Chunyan Yang and Chongyang Sun and Yong Li and Xinyu Shi and Wei Dai and Ming Peng and Chen Sang and Yuanyuan Han and Desong Qiu and Haixin Miao and Jian Xu and Yi Chen and Xiaoliang Shi and Tian Shen and Teng Hu and Shuhao Wang and Yingyong Hou and Huimei Wang},
      year={2026},
      eprint={2610.17110},
      archivePrefix={arXiv},
      primaryClass={cs.SE},
      url={https://arxiv.org/abs/2610.17110},
}
```

</details>

## Licencia

Licencia Apache 2.0: consulte [LICENSE](../../LICENSE).

## Historial de estrellas

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Gráfico del historial de estrellas de AIPOCH Open-Science en GitHub" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>
