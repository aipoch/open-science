<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  Entorno de investigación con IA de código abierto, centrado en la ejecución local e independiente del modelo, para una ciencia reproducible.
</p>

<p align="center">
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Descargar" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Versión" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://huggingface.co/datasets/phylobio/BiomniBench-DA">
    <img alt="N.º 1 en BiomniBench-DA Public 50" src="https://img.shields.io/badge/%F0%9F%8F%86%20%231-BiomniBench--DA%20Public%2050-f59f00?style=flat">
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
  <a href="https://discord.gg/zxQAYjReRv">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=flat&logo=discord&logoColor=white">
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

AIPOCH Open-Science es un entorno local y de código abierto, desarrollado por [AIPOCH](https://aipoch.com/open-science) para científicos e investigadores, compatible con distintos modelos de IA. Permite realizar investigaciones reproducibles e inspeccionables con agentes científicos de IA, ejecutar Python y R, conectarse a fuentes de datos científicos y trabajar en macOS, Windows y Linux. Cree un proyecto, describa su objetivo de investigación en lenguaje natural y permita que los agentes lean archivos, busquen en la web, ejecuten código, consulten fuentes de datos científicos y produzcan informes, tablas y figuras con procedencia rastreable, todo en un mismo espacio de trabajo.

AIPOCH Open-Science respalda la investigación computacional y con uso intensivo de datos en todas las disciplinas, incluidos el aprendizaje automático, la estadística, las ciencias biológicas, la química, la ciencia de los materiales, la física y las ciencias ambientales. Acompaña todo el proceso de investigación, desde la revisión bibliográfica y el desarrollo de hipótesis hasta la ejecución de código, el análisis de datos, la simulación, la visualización y la producción de resultados rastreables.

> 💡 **[AIPOCH Open-Science v0.26.0 publicado](https://github.com/aipoch/open-science/releases/latest)** _(última actualización en septiembre de 2026)_. AIPOCH Open-Science v0.26.0 incorpora cálculo de clase HPC y un espacio de trabajo de literatura: los hosts de cálculo remotos estrenan un modo de ejecución por host con Slurm junto al SSH directo, y una nueva biblioteca de referencias organiza las referencias, los PDF y las citas con importaciones que reconocen identificadores, combinación de duplicados, adjunción de texto completo de acceso abierto y formateo de citas. Apodex se suma a los proveedores integrados junto con los últimos modelos de OpenAI y Anthropic, las llamadas a herramientas del Notebook se convierten en tarjetas de resumen legibles, y llegan un streaming más fluido, permisos predeterminados menos intrusivos y un amplio conjunto de correcciones en toda la aplicación. Consulte las [notas de la versión más recientes](https://github.com/aipoch/open-science/releases/latest) para obtener todos los detalles.

<p align="center">
 <img width="1920" height="1140" alt="Banner principal de AIPOCH Open-Science: Science, Open to All — un entorno de investigación de IA científica de código abierto, independiente del modelo y autohospedado" src="../images/readme/open-science-banner.png" />
</p>

## Tabla de contenido

- [Inicio rápido](#-inicio-rápido)
- [Recorrido por el producto](#recorrido-por-el-producto)
- [Rendimiento en benchmarks](#rendimiento-en-benchmarks)
- [Por qué AIPOCH Open-Science](#por-qué-aipoch-open-science)
- [Capacidades principales](#capacidades-principales)
- [Proveedores de modelos](#proveedores-de-modelos)
- [Datos, permisos y confianza](#datos-permisos-y-confianza)
- [Estado del proyecto](#estado-del-proyecto)
- [Desarrollo y empaquetado](#desarrollo-y-empaquetado)
- [Preguntas frecuentes](#preguntas-frecuentes)
- [Participe](#participe)
- [Licencia](#licencia)
- [Historial de estrellas](#historial-de-estrellas)

## 🚀 Inicio rápido

Ejecute AIPOCH Open-Science en tres pasos: descargue el instalador para su plataforma, complete la configuración guiada de primera ejecución y cree un proyecto de investigación.

### 1. Descargue la aplicación

Abra la [última versión](https://github.com/aipoch/open-science/releases/latest), expanda **Assets** y elija el instalador para su equipo:

| Su equipo                             | Elija                                      |
| ------------------------------------- | ------------------------------------------ |
| macOS: Apple Silicon (M1 o posterior) | El DMG de macOS para Apple Silicon / ARM64 |
| macOS: Intel                          | El DMG de macOS para Intel/x64             |
| Windows x64                           | El instalador de Windows x64               |
| Linux x64                             | El paquete AppImage o Debian de Linux x64  |

Revise los activos y la información de verificación publicada en la página de lanzamiento. Consulte [Verificación de su descarga](../../SECURITY.md#verifying-your-download) antes de la instalación si necesita validar un paquete.

> Si macOS o Windows muestra una advertencia de desarrollador no identificado o de editor desconocido, verifique que el paquete provenga de la página oficial de lanzamientos antes de continuar.

En macOS, también puede instalar la aplicación con [Homebrew](https://brew.sh):

```bash
brew install --cask open-science
```

Homebrew selecciona automáticamente el paquete para Apple Silicon o Intel.

### 2. Complete la configuración inicial

El primer lanzamiento tiene cinco pasos guiados:

1. **Entorno** comprueba la compatibilidad, el almacenamiento de aplicaciones, el almacenamiento seguro de credenciales y el acceso a la red.
2. **Ubicación de datos** permite elegir dónde se almacenan los artefactos, Notebooks, cargas y entornos de gran tamaño.
3. **Entorno de ejecución del agente** selecciona y prepara Claude Code, OpenCode o Codex. Los entornos de ejecución gestionados por la aplicación se pueden instalar sin necesidad de Node.js, npm o una contraseña de administrador.
4. **Proveedor de modelo** conecta y prueba el modelo que desea utilizar. Elija un proveedor integrado, una puerta de enlace personalizada o un inicio de sesión de suscripción Claude o Codex existente.
5. **Entorno de ejecución de Notebook** prepara opcionalmente entornos Python y R administrados por la aplicación o habilita intérpretes detectados y registrados manualmente.

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

La ejecución de Notebook es opcional. Todas las comprobaciones obligatorias del entorno y del entorno de ejecución del agente deben superarse antes de que **Continuar** esté disponible, y la conexión con el modelo debe validarse antes de finalizar la configuración. Puede conservar los valores predeterminados de Notebook y de la ubicación de datos, y cambiarlos más adelante en Configuración.

### 3. Iniciar un proyecto de investigación

1. Haga clic en **Nuevo proyecto** y asigne al proyecto un nombre de investigación estable y una descripción opcional.
2. Abra una sesión y describa el objetivo, los datos de entrada, las restricciones, los resultados deseados y cómo se debe verificar el resultado.
3. Adjunte archivos fuente, seleccione un modelo verificado y elija un modo de aprobación.
4. Envíe la tarea. Inspeccione la actividad de las herramientas del agente, apruebe las acciones confidenciales y abra los artefactos generados en el panel de vista previa.
5. Para explorar una dirección diferente, edite un mensaje de usuario anterior y vuelva a enviarlo en una rama nueva; utilice los controles de revisión del mensaje para regresar a cualquiera de las rutas.
6. Abra la vista **Procedencia** de un artefacto para inspeccionar sus versiones y la evidencia disponible detrás del resultado seleccionado.
7. Continúe el trabajo en sesiones posteriores. Utilice `@` para hacer referencia a un archivo de proyecto existente y `/` para seleccionar explícitamente una habilidad habilitada.

> Las capturas de pantalla de este archivo README ilustran el flujo de trabajo. Las etiquetas, catálogos y otros detalles de la interfaz pueden diferir de la versión que instale.

## Recorrido por el producto

### De la solicitud de investigación al resultado rastreable

Considere una tarea bioinformática representativa: reproducir un análisis publicado de expresión diferencial, comparar los resultados regenerados con el artículo y entregar el informe, las tablas y las figuras necesarias para la revisión. Las capturas siguientes son vistas representativas de flujos de trabajo documentados de AIPOCH Open-Science; ilustran cada etapa, pero no pertenecen a una única sesión continua.

#### 1. Definir la tarea de investigación y sus evidencias

Describa la pregunta de investigación, el artículo y los conjuntos de datos de origen, los métodos o umbrales necesarios, los resultados esperados y los criterios de aceptación. Cargue los archivos de apoyo o haga referencia a un artefacto existente del proyecto con `@`, para que el agente parta de entradas explícitas y no de un contexto oculto.

<p align="center">
  <img src="../images/readme/product-tour-task.jpg" alt="Tarea de reproducción de un artículo en AIPOCH Open-Science con la conclusión, los artefactos generados y la comparación de fuentes en un mismo espacio de trabajo" width="900">
</p>

#### 2. Ejecutar con herramientas científicas inspeccionables

El agente puede combinar en el Notebook compartido habilidades científicas, conectores de investigación sujetos a permisos, búsquedas, operaciones con archivos y código Python o R. Las figuras generadas se pueden revisar junto al resumen de la investigación, mientras que el registro del artefacto permite inspeccionar el código productor capturado y las evidencias de ejecución.

<p align="center">
  <img src="../images/readme/product-tour-execute.png" alt="Análisis bioinformático en AIPOCH Open-Science que muestra juntos el resumen de la investigación, la figura generada y el código productor capturado" width="900">
</p>

#### 3. Revisar informes, tablas y figuras en contexto

La respuesta final resume qué se reprodujo, qué presentó diferencias y qué limitaciones son importantes. Los informes Markdown, las tablas CSV, las imágenes y otros artefactos de investigación generados permanecen asociados a la sesión y también se reúnen en la biblioteca de archivos del proyecto, donde se pueden previsualizar junto a la conversación y reutilizar en trabajos posteriores.

<p align="center">
  <img src="../images/readme/product-tour-output.jpg" alt="Resultado de reproducción en AIPOCH Open-Science con figuras de expresión diferencial y archivos generados junto a la explicación del agente" width="900">
</p>

#### 4. Rastrear cada artefacto hasta sus evidencias

Cada artefacto generado se almacena como una versión inmutable con suma de comprobación. La vista **Provenance** puede mostrar el código productor y el historial de ejecución, las entradas referenciadas, el inventario observado del entorno, la rama de conversación productora y los hallazgos del Reviewer específicos de la versión. Las evidencias que no se pudieron verificar se marcan como no disponibles en lugar de inferirse.

<p align="center">
  <img src="../images/readme/product-tour-provenance.jpg" alt="Vista previa de un artefacto de investigación de AIPOCH Open-Science con acceso a Provenance para rastrear un resultado generado" width="900">
</p>

## Rendimiento en benchmarks

### 🏆 N.º 1 en BiomniBench-DA Public 50

AIPOCH Open-Science obtuvo la puntuación de clasificación más alta en la comparación recopilada de BiomniBench-DA Public 50: **79.05** con **gpt-5.6-sol (xhigh)**. El resultado combina una puntuación del evaluador Gemini 3.1 Pro de **81.04** y una puntuación del evaluador DeepSeek v4-pro de **77.06** mediante una media con ponderación equivalente, lo que sitúa a AIPOCH Open-Science en el **n.º 1** entre los resultados recopilados de Public 50. Consulte el [conjunto de datos BiomniBench-DA](https://huggingface.co/datasets/phylobio/BiomniBench-DA).

<p align="center">
  <img src="../images/readme/biomnibench-public50-leaderboard.png" alt="Comparación BiomniBench-DA Public 50 que muestra a AIPOCH Open-Science en primer lugar con una puntuación de 79.05" width="1200" />
</p>

## Por qué AIPOCH Open-Science

AIPOCH Open-Science reúne chats, Notebooks, scripts locales, bases de datos científicas, archivos y herramientas de informes en un entorno de investigación de IA persistente y local-first donde la ejecución permanece vinculada a las pruebas.

- **Ejecución persistente.** Los proyectos, sesiones, archivos, vistas previas e historial sobreviven a los reinicios, mientras que los agentes aprobados pueden ejecutar comandos, Python y R y generar artefactos.
- **Resultados rastreables.** Las versiones de artefactos inmutables conservan pruebas de producción verificables y señalan claramente la información no disponible.
- **Elección independiente del modelo.** Conecte proveedores de nube integrados, puertas de enlace personalizadas compatibles o suscripciones de Claude y Codex, y elija el modelo y el esfuerzo de razonamiento de cada sesión.
- **Control local-first.** La aplicación y el estado del proyecto permanecen en su equipo; las llamadas externas utilizan únicamente los servicios que configure o apruebe.
- **Abierto y extensible.** El código independiente bajo Apache-2.0, las habilidades, los conectores, la actividad de las herramientas y los archivos generados son inspeccionables, y puede añadir habilidades y conectores MCP.

## Capacidades principales

AIPOCH Open-Science combina gestión de proyectos, ejecución de agentes multimodelo, Notebooks de Python y R, conectores de datos científicos, versiones inmutables de artefactos con procedencia y control humano autorizado en un espacio de trabajo local. La aplicación instalada y las [notas de la versión más recientes](https://github.com/aipoch/open-science/releases/latest) son la fuente de referencia para los catálogos actuales, los detalles de empaquetado y las opciones recién incorporadas.

| Área                                                   | Capacidad central                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proyectos y sesiones**                               | Cree y organice proyectos con sesiones fijadas, ramas de mensajes y conversaciones laterales persistentes, y detalles de sesión editables. Edite prompts completados para convertirlos en ramas de mensajes persistentes y seleccionables sin eliminar la ruta posterior original, y recupere el trabajo reciente, los borradores, el historial de conversación y el estado de vista previa.                                                                                                                                                                                                                                                                                                                                          |
| **Flujo de trabajo del agente**                        | Las sesiones en lenguaje natural ofrecen respuestas transmitidas y actividad de herramientas agrupada por finalidad, con controles de aprobación y detención, seguimientos en cola, compactación de contexto y recuperación tras reinicios. Ramifique el trabajo terminado en sesiones nuevas y use aclaraciones estructuradas, anotaciones de texto, imagen y PDF, contexto de lectura de PDF vinculados, memoria del proyecto, referencias de sesión y planes sujetos a revisión. Las notificaciones, el estado en directo, los detalles de tiempo y tokens, la paleta de comandos, las vistas previas de fuentes y el cambio de proyecto mantienen visibles y manejables las investigaciones largas.                               |
| **Modelos y backends de agentes**                      | Use proveedores cloud integrados, como Apodex, NVIDIA Build con un catálogo seleccionado compatible con agentes, y los catálogos de modelos más recientes de OpenAI y Anthropic (GPT-6 Astra y Claude Fable 5.1), gateways personalizados compatibles o inicios de sesión de suscripción de Claude y Codex. Seleccione Claude Code, OpenCode, Codex o el entorno CodeBuddy sin inicio de sesión como backend de agente, con validación de compatibilidad de modelos y API, entrada multimodal de imágenes, controles de razonamiento y políticas específicas de subagente, revisor y Vision.                                                                                                                                          |
| **Especialistas y delegación**                         | Cree agentes especialistas personales con capacidades acotadas, personalización conversacional, importación/exportación de paquetes y transferencia inmediata desde el agente principal. El mercado de paquetes firmados admite fuentes de GitHub oficiales y aprobadas por el usuario, importaciones que detectan conflictos y 64 iconos de capacidades integrados; la delegación para producción añade mensajería duradera, recuperación y un interruptor de delegación por sesión.                                                                                                                                                                                                                                                 |
| **Python, R, Notebooks y HPC**                         | Ejecute kernels persistentes de Python, R y REPL junto con comandos de línea de comandos registrados, en entornos sin conexión administrados o con sus propios intérpretes. Trabaje localmente o conéctese mediante SSH a hosts remotos y envíe ejecuciones de Notebook a clústeres HPC mediante Slurm; el acceso de red protegido, las credenciales cifradas, la inspección de paquetes y variables, el terminal compartido y el historial progresivo permiten controlar y observar el cómputo. La gestión de paquetes para entornos de R externos sigue siendo manual.                                                                                                                                                              |
| **Revisión bibliográfica y gestión de referencias**    | Importe referencias mediante DOI, PubMed ID, arXiv ID o archivos, organice colecciones, vincule referencias a proyectos y restaure PDF descargados desde la papelera. Busque en paralelo texto completo de acceso abierto en Europe PMC, PMC, OpenAlex, arXiv y Unpaywall, combine registros duplicados sin perder adjuntos ni enlaces y dé formato a las citas a partir de metadatos guardados con procedencia de artefactos.                                                                                                                                                                                                                                                                                                        |
| **Archivos científicos y vistas previas**              | Adjunte archivos de hasta 10 GB mediante carga en streaming, organice y busque en una biblioteca de proyecto, referencie cargas, salidas y carpetas locales con `@` y `@path`, y exporte archivos, conversaciones o sesiones `.ipynb`. Previsualice en línea o a pantalla completa datos científicos, PDF con búsqueda, archivos de Office, imágenes TIFF y otras, código fuente, estructuras y reacciones moleculares e historial de Notebook, con procedencia y navegación a la fuente.                                                                                                                                                                                                                                             |
| **Artefactos y procedencia**                           | Conserve versiones inmutables de artefactos por sesión con contenido verificado por suma, código productor, historial de ejecución, entradas exactas, inventario del entorno, contexto de ramas de mensajes, linaje y evidencia de revisión. Los archivos editables Markdown, texto, scripts y código fuente publican una versión nueva que conserva la procedencia con cada guardado y permiten compararla con la anterior.                                                                                                                                                                                                                                                                                                          |
| **Habilidades científicas y conectores de datos**      | Amplíe los flujos de investigación con **22 habilidades integradas destacadas** y **24 conectores de investigación integrados**. Cree habilidades de forma conversacional o a partir de trabajo terminado, importe paquetes y fuentes de GitHub y añada conectores MCP locales o remotos personalizados con permisos por herramienta e importación/exportación de configuración. Las etiquetas entre recursos, una etiqueta protegida de Favoritos y los filtros con búsqueda organizan habilidades, conectores y especialistas.                                                                                                                                                                                                      |
| **Datos locales, privacidad, permisos y verificación** | Mantenga locales los datos del proyecto, el estado de la aplicación y las cachés de Notebook en un almacenamiento configurable y migrable; use los modos de proxy del sistema, manual o directo y un panel de tokens con un mapa de calor de actividad de 30 días y atribución por ejecución. Controle las acciones con `Ask for approval`, `Auto-approve edits` o `Full access`, concesiones acotadas, credenciales centralizadas, dominios de cálculo aprobados por el usuario y políticas por conector y herramienta. Un revisor opcional audita transcripciones, registros de ejecución y artefactos, informa de resultados de aprobado/advertencia/error y puede ejecutar un bucle de corrección acotado con evidencia duradera. |

## Proveedores de modelos

AIPOCH Open-Science es independiente del modelo a nivel de producto: conéctelo a los principales proveedores de LLM en la nube, una puerta de enlace personalizada o reutilice una suscripción Claude o Codex existente. Actualmente, la disponibilidad del proveedor depende del backend del agente seleccionado y de los protocolos API que admite. Hay cuatro formas de conectar un modelo:

| Modo proveedor                     | Cómo funciona                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedores de nube integrados** | Elija de la lista de proveedores que muestra la aplicación instalada y autentíquese con la clave solicitada.                                                                                                                                                                                                                                                                             |
| **Puerta de enlace personalizada** | Proporcione una URL base compatible, una clave API y un ID de modelo exacto. El formato API predeterminado (Messages, Chat Completions o Responses) se deriva del framework de agentes activo, por lo que una nueva puerta de enlace personalizada es compatible desde el primer momento.                                                                                                |
| **Suscripción de Codex**           | Seleccione el framework de agentes Codex y luego elija Suscripción de Codex como tipo de proveedor.                                                                                                                                                                                                                                                                                      |
| **Suscripción de Claude**          | Inicie sesión con una suscripción de Claude en dos modos: **compartido** (un inicio de sesión en el navegador que almacena las credenciales en el perfil predeterminado `~/.claude`) o **aislado** (un flujo `claude setup-token` gestionado por la aplicación bajo un `CLAUDE_CONFIG_DIR` propio y completamente aislado de `~/.claude/`, con la opción alternativa de pegar un token). |

Se eliminó el proveedor heredado **Local Claude**. Las entradas locales de Claude guardadas anteriormente se eliminan durante la actualización; añada **Suscripción de Claude** y autentíquese mediante el inicio de sesión compartido en el navegador o el flujo aislado `claude setup-token`.

Los proveedores de nube integrados actualmente incluyen OpenAI, Anthropic, Grok (xAI), DeepSeek, Zhipu AI (GLM) con un endpoint específico para GLM Coding Plan, Kimi (Moonshot), MiniMax, StepFun con un endpoint de suscripción específico para Step Plan, Xiaomi MIMO, SenseNova, Volcengine Ark, Bailian (Alibaba Cloud) con un endpoint de suscripción específico para Bailian for Plan, Tencent TokenHub, además de endpoints de suscripción específicos para Tencent Coding Plan y Token Plan, y la puerta de enlace de agregación OpenRouter, entre otros; algunos son específicos de la región.

Los proveedores, los modelos disponibles y los endpoints regionales pueden evolucionar independientemente de este README. Considere el selector de proveedores y la prueba de conexión de la aplicación instalada como la fuente de verdad.

## Datos, permisos y confianza

AIPOCH Open-Science almacena en el equipo local los datos del proyecto, la configuración, las versiones de los artefactos y la evidencia de procedencia. Las claves API se guardan localmente y utilizan el almacén seguro de credenciales del sistema operativo cuando está disponible. Los registros también son locales y no se cargan automáticamente.

El flujo de datos externos aún es posible y debe revisarse:

- Las solicitudes al modelo envían el prompt y el contexto necesarios al proveedor del modelo seleccionado.
- Las búsquedas web y los conectores remotos envían sus parámetros mostrados a servicios externos.
- Los conectores locales pueden ejecutar comandos de confianza en el equipo.
- Los archivos adjuntos, las referencias `@`, los registros y los informes generados pueden contener datos de investigación confidenciales.

Elija el perfil de permiso más limitado que se ajuste a la tarea:

| Modo                                  | Comportamiento                                                                                          | Uso recomendado                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Solicitar aprobación**              | Solicita aprobación antes de editar archivos, ejecutar comandos, acceder a la red o llamar a conectores | Flujos de trabajo nuevos, datos confidenciales y scripts desconocidos        |
| **Aprobar ediciones automáticamente** | Permite editar el espacio de trabajo; sigue solicitando aprobación para comandos, red y conectores      | Edición de archivos de confianza con acceso externo controlado               |
| **Acceso completo**                   | Permite automáticamente las ediciones, los comandos, el acceso a la red y los conectores                | Trabajo desatendido, de plena confianza y con un alcance claramente definido |

Revise los parámetros del conector y la actividad de la herramienta antes de aprobarlos. Nunca incluya claves API, tokens de acceso, identificadores de pacientes, datos no publicados o rutas locales confidenciales en capturas de pantalla o registros de problemas públicos.

## Estado del proyecto

AIPOCH Open-Science es una aplicación de escritorio desarrollada activamente disponible para macOS, Windows y Linux. El desarrollo se centra en flujos de trabajo de investigación locales confiables, capacidades científicas extensibles, artefactos de investigación rastreables y ejecución controlada por el usuario.

Consulte la [última versión](https://github.com/aipoch/open-science/releases/latest) para conocer las descargas actuales y los cambios específicos de la versión. Para conocer las capacidades publicadas, parciales y planificadas, consulte el [Mapa de capacidades](../../ROADMAP.md#capability-map).

AIPOCH Open-Science facilita la ejecución de investigaciones y el mantenimiento de registros; los investigadores siguen siendo responsables de los métodos, la interpretación, la privacidad y la validez científica.

## Desarrollo y empaquetado

AIPOCH Open-Science es una aplicación Electron creada con React, TypeScript, Prisma/SQLite y un entorno de ejecución de agentes basado en ACP.

Requisitos previos para desarrollar desde el código fuente:

- Node.js 22 (consulte [`.nvmrc`](../../.nvmrc)) con npm
- Git
- Python 3 solo si desea la ejecución de Notebook

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` genera automáticamente el cliente Prisma e instala las dependencias nativas Electron. `npm run dev` crea los paquetes principales/precargados Electron, inicia el renderizador y abre la aplicación de escritorio. Los datos de desarrollo están aislados en `~/.open-science-project`.

Comandos útiles:

| Comando                | Propósito                                                                    |
| ---------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`          | Iniciar la aplicación de desarrollo                                          |
| `npm run dev:web`      | Aplicación de desarrollo + interfaz de usuario web de host local (127.0.0.1) |
| `npm run dev:headless` | Backend de desarrollo + interfaz de usuario web, sin ventana Electron        |
| `npm run lint`         | Ejecute ESLint                                                               |
| `npm run typecheck`    | Comprobar los tipos del código principal y del renderizador                  |
| `npm test`             | Ejecute la suite Vitest                                                      |
| `npm run build`        | Verifique el tipo y cree la aplicación                                       |
| `npm run build:web`    | Cree la interfaz de usuario web localhost opcional                           |
| `npm run build:mac`    | Empaquetar las compilaciones de macOS                                        |
| `npm run build:win`    | Empaquetar las compilaciones de Windows                                      |
| `npm run build:linux`  | Empaquetar las compilaciones de Linux                                        |

La salida empaquetada está escrita en `dist/`.

### Modos web y sin interfaz gráfica en localhost

Opcionalmente, el backend de escritorio puede servir el mismo renderizador a un navegador en el equipo local. Esta función está desactivada de forma predeterminada y solo escucha en `127.0.0.1`.

```bash
npm run build:web
npm run dev:web
```

Abra la URL autenticada que muestra la aplicación. Utilice `npm run dev:headless` para iniciar el backend, la bandeja, el entorno de ejecución del agente y el servicio web localhost sin abrir una ventana de Electron. Configure `OPEN_SCIENCE_WEB_PORT` para elegir un puerto (predeterminado: `44100`). Al salir explícitamente de la aplicación también se cierran con normalidad los procesos del agente y de Notebook.

### Acceso remoto móvil

Se puede acceder a la misma interfaz web de localhost desde un teléfono o una tableta mediante el emparejamiento de Remote.It. Empareje un navegador con un código de AIPOCH Open-Science de seis dígitos, apruébelo una vez en el escritorio y el espacio de trabajo permanecerá accesible sin exponer directamente el servidor de loopback. Puede revocar la confianza del navegador; además, los cambios de modo o el cierre del servicio invalidan de inmediato las sesiones remotas activas.

### CLI y SDK sin interfaz gráfica

La CLI sin interfaz gráfica y el SDK de Node.js sin dependencias utilizan el mismo daemon local, así como los mismos proyectos, sesiones, credenciales y permisos que las interfaces web y de escritorio. La documentación detallada se incluye en el paquete publicado y sirve como referencia única de los comandos:

- [Guía CLI](../../packages/open-science/CLI.md): instalación, ciclo de vida del servicio, automatización de tareas, artefactos, formatos de salida y códigos de salida
- [Descripción general del paquete SDK](../../packages/open-science/README.md) - Inicio rápido de Node.js y punto de entrada del paquete

## Preguntas frecuentes

### ¿Qué es AIPOCH Open-Science y quién lo desarrolla?

R: AIPOCH Open-Science es un entorno de trabajo de investigación independiente y de código abierto (Apache-2.0), desarrollado por el equipo de AIPOCH. **AIPOCH Open-Science** es el nombre completo del producto y **Open-Science** es su nombre abreviado. Ambos nombres se refieren al mismo producto de AIPOCH.

### ¿Qué debo hacer la primera vez que abro AIPOCH Open-Science?

R: Complete los cinco pasos de configuración: **Entorno**, **Ubicación de datos**, **Entorno de ejecución del agente**, **Proveedor de modelo** y **Entorno de ejecución de Notebook**. Corrija las filas obligatorias marcadas como **Acción necesaria**, instale o repare el agente seleccionado si se ofrece esa opción y pruebe la conexión con el modelo. La configuración de Notebook y una ubicación de datos personalizada son opcionales.

### ¿Qué es una clave API y dónde consigo una?

R: Una clave API es una credencial secreta emitida por un proveedor de modelos. Cree o copie una desde la consola de API o para desarrolladores de ese proveedor. El proveedor podrá facturar las solicitudes realizadas con la clave. Trátela como una contraseña: nunca la comparta ni la envíe a un repositorio.

### ¿Necesito una clave API?

R: No, si reutiliza el inicio de sesión de una suscripción existente: una suscripción de Claude mediante un inicio de sesión compartido en el navegador o un flujo aislado `claude setup-token` gestionado por la aplicación, o una suscripción de ChatGPT/Codex en el backend de Codex. Los proveedores de nube integrados y las puertas de enlace personalizadas requieren sus propias claves.

### ¿Qué proveedores de modelos puedo utilizar?

R: Abra el selector de proveedores durante la configuración o en **Configuración → Modelo** para ver las opciones admitidas por la aplicación instalada y el backend del agente seleccionado. Puede utilizar un proveedor de nube integrado, una puerta de enlace personalizada compatible, una suscripción de Claude mediante un inicio de sesión compartido o aislado, o una suscripción de Codex en el backend de Codex.

### ¿Por qué falla la prueba de conexión del modelo?

R: Compruebe que la clave API no tenga caracteres omitidos ni espacios, verifique la URL base y la región, use el ID exacto del modelo indicado por el proveedor y confirme el acceso a la red y el saldo de la cuenta. Para una suscripción de Claude, vuelva a iniciar sesión en el navegador compartido o actualice la credencial aislada `claude setup-token`, según el modo seleccionado.

### ¿Por qué **Continuar** está deshabilitado durante la instalación?

R: El paso actual no cumple la condición requerida. Corrija cualquier fila del entorno marcada como **Acción necesaria**, instale o repare el entorno de ejecución del agente seleccionado o valide el proveedor del modelo, según el paso activo. La configuración de Notebook es opcional y solo afecta a la ejecución de Notebook.

### La configuración está completa. ¿Cómo inicio una tarea de investigación?

R: Cree o abra un proyecto, inicie una sesión, adjunte los archivos fuente y describa el objetivo, las restricciones, el resultado esperado y los criterios de validación. Utilice `@` para hacer referencia a un archivo de proyecto y `/` para seleccionar una habilidad habilitada.

### ¿Cómo ejecuto trabajos en un clúster HPC remoto?

R: Habilite la habilidad **Computación remota (SSH)** en **Configuración → Habilidades**, registre su clúster en **Configuración → Cálculo**, inicie una sesión y seleccione la habilidad con `/remote-compute-ssh`. La habilidad se encarga de registrar el host, ejecutar comandos breves mediante SSH y enviar trabajos de forma totalmente asíncrona. Cuando termina un trabajo, la aplicación inicia automáticamente un turno de análisis, por lo que no es necesario escribir un bucle de sondeo.

### ¿Existe una interfaz de línea de comandos?

R: Sí. Instálela con un solo clic desde **Configuración → General → Herramienta de línea de comandos → Instalar comando** (añade `open-science` a su `PATH`; no requiere una instalación independiente de Node.js). La CLI controla el servicio local y envía tareas de investigación sin abrir un navegador:

```bash
# Inicie el servicio en segundo plano
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

### ¿Cómo inspecciono de dónde provino un resultado generado?

R: Abra el artefacto generado y elija **Procedencia**. Seleccione una versión para inspeccionar la identidad del contenido, el código que produjo el artefacto, el historial de ejecución, las entradas, el inventario del entorno, el contexto de la conversación de origen y la evidencia del revisor. La evidencia que AIPOCH Open-Science no pudo verificar se marca como no disponible.

### ¿Puedo revisar una solicitud anterior sin perder la conversación que siguió?

R: Sí. Edite un mensaje de usuario completo y reenvíelo para crear una nueva rama desde ese punto. Los turnos posteriores originales permanecen disponibles y las flechas de revisión junto al mensaje permiten cambiar entre las rutas alternativas.

### ¿Los datos de mi investigación permanecen en mi equipo?

R: Los proyectos, sesiones, archivos, configuraciones y credenciales configuradas se almacenan localmente de forma predeterminada. Es posible que el contenido necesario para solicitudes de modelo, búsquedas web o llamadas de conector aún se envíe al servicio externo que seleccionó, así que revise las entradas confidenciales y las políticas del proveedor antes de ejecutar una tarea.

## Participe

AIPOCH Open-Science agradece informes de errores, propuestas de funciones, debates sobre diseño, preguntas de la comunidad y contribuciones a través de GitHub, Discord, X y el sitio web de AIPOCH. Elija el canal que mejor se adapte a su objetivo, luego siga la guía de contribución vinculada y el recordatorio de seguridad de publicación pública antes de compartir los detalles del proyecto.

| Canal                                                                    | Úselo para                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [GitHub Problemas](https://github.com/aipoch/open-science/issues)        | Errores, fallos reproducibles y propuestas de funciones concretas                    |
| [GitHub Discusiones](https://github.com/aipoch/open-science/discussions) | Preguntas de diseño, propuestas de hoja de ruta y conversaciones técnicas más largas |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Ayuda comunitaria, coordinación de contribuyentes y discusión informal               |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Anuncios de versiones y novedades sobre el desarrollo público                        |
| [Sitio web de AIPOCH Open-Science](https://aipoch.com/open-science)      | Descripción general oficial del producto y descargas                                 |

Antes de abrir una incidencia pública, elimine de los registros y las capturas de pantalla las claves API, los tokens, las rutas de archivos privados, los datos no publicados, los identificadores de pacientes y cualquier otro material confidencial. Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para conocer el flujo de trabajo de desarrollo.

> **Dar Star al repositorio:** Si este proyecto le ha resultado útil, agradeceríamos que le diera Star en GitHub. Ayuda a sostener el desarrollo y solo lleva un segundo.

## Licencia

Licencia Apache 2.0: consulte [LICENSE](../../LICENSE).

## Historial de estrellas

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Gráfico del historial de estrellas" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>
