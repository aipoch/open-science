<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  Entorno de investigación con IA para una ciencia reproducible — de código abierto, centrado en la ejecución local e independiente del modelo.
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

AIPOCH Open-Science es un entorno de investigación con IA para científicos e investigadores, desarrollado por [AIPOCH](https://aipoch.com/open-science) con un enfoque de código abierto, centrado en la ejecución local e independiente del modelo. Permite realizar investigaciones reproducibles e inspeccionables con agentes científicos de IA, ejecutar Python y R, conectarse a fuentes de datos científicos y trabajar en macOS, Windows y Linux. Cree un proyecto, describa su objetivo de investigación en lenguaje natural y permita que los agentes lean archivos, busquen en la web, ejecuten código, consulten fuentes de datos científicos y produzcan informes, tablas y figuras con procedencia rastreable, todo en un mismo espacio de trabajo.

AIPOCH Open-Science respalda la investigación computacional y con uso intensivo de datos en todas las disciplinas, incluidos el aprendizaje automático, la estadística, las ciencias biológicas, la química, la ciencia de los materiales, la física y las ciencias ambientales. Acompaña todo el proceso de investigación, desde la revisión bibliográfica y el desarrollo de hipótesis hasta la ejecución de código, el análisis de datos, la simulación, la visualización y la producción de resultados rastreables.

> 💡 **[AIPOCH Open-Science v0.31.1 publicado](https://github.com/aipoch/open-science/releases/latest)** _(última actualización en septiembre de 2026)_. AIPOCH Open-Science v0.31.1 amplía los datos científicos que puede alcanzar desde una sesión: las herramientas de ENA resuelven una accesión pública de ENA/INSDC hasta sus ejecuciones de secuenciación con los archivos FASTQ generados por el archivo, el conector Genes incorpora el enriquecimiento de GO y de rutas impulsado por g:Profiler con un fondo estadístico personalizado, y las nuevas herramientas de NCBI resuelven nombres de taxones, inspeccionan ensamblajes del genoma con versiones y consultan alias de secuencias. Configuración puede conectar de forma opcional un servicio dedicado de modelos de clasificación, y el emparejamiento de acceso remoto pasa a la parte superior del panel de seguridad con una revocación segura de los navegadores de confianza. La estabilidad es más sólida en todo el producto — los notebooks de R en Windows supervisan los kernels persistentes y guían la recuperación de red, las sesiones de OpenCode perdidas se recuperan al arrancar, y las tarjetas de aprobación, las vistas previas de mensajes pendientes y la lista de sesiones recientes se comportan de forma más fiable. Consulte las [notas de la versión más recientes](https://github.com/aipoch/open-science/releases/latest) para obtener todos los detalles.

<p align="center">
 <img width="1920" height="1140" alt="Banner principal de AIPOCH Open-Science: Science, Open to All — un entorno de investigación de IA científica de código abierto, independiente del modelo y autohospedado" src="../images/readme/open-science-banner.png" />
</p>

## Tabla de contenido

- [Inicio rápido](#-inicio-rápido)
- [Recorrido por el producto](#recorrido-por-el-producto)
- [Rendimiento en benchmarks](#rendimiento-en-benchmarks)
- [Capacidades principales](#capacidades-principales)
- [Proveedores de modelos](#proveedores-de-modelos)
- [Datos, permisos y confianza](#datos-permisos-y-confianza)
- [Desarrollo y empaquetado](#desarrollo-y-empaquetado)
- [Preguntas frecuentes](#preguntas-frecuentes)
- [Participe](#participe)
- [Licencia](#licencia)
- [Historial de estrellas](#historial-de-estrellas)

## 🚀 Inicio rápido

### 1. Descargue la aplicación

Abra la [última versión](https://github.com/aipoch/open-science/releases/latest), expanda **Assets** y elija el instalador para su equipo:

| Su equipo                                 | Elija                                      |
| ----------------------------------------- | ------------------------------------------ |
| macOS 12+: Apple Silicon (M1 o posterior) | El DMG de macOS para Apple Silicon / ARM64 |
| macOS 12+: Intel                          | El DMG de macOS para Intel/x64             |
| Windows x64                               | El instalador de Windows x64               |
| Linux x64                                 | El paquete AppImage o Debian de Linux x64  |

Descargue desde la página oficial de versiones; consulte la [verificación de descargas](../../SECURITY.md#verifying-your-download) si es necesario.

En macOS, también puede instalar la aplicación con [Homebrew](https://brew.sh):

```bash
brew install --cask open-science
```

En Windows, reinstalar conserva los datos de investigación. Para una limpieza completa, consulte la [herramienta de restablecimiento](../../scripts/windows-reset/README.md), que elimina permanentemente los datos locales tras la confirmación.

### 2. Complete la configuración inicial

Siga el asistente: **Entorno → Ubicación de datos → Entorno de ejecución del agente → Proveedor de modelo → Entorno de ejecución de Notebook**.

Complete las comprobaciones obligatorias del entorno y del runtime del agente y pruebe la conexión al modelo. Python/R Notebook es opcional; Notebook y la ubicación de datos pueden ajustarse más adelante en Configuración.

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

## Capacidades principales

AIPOCH Open-Science combina gestión de proyectos, ejecución de agentes multimodelo, Notebooks de Python y R, conectores de datos científicos, versiones inmutables de artefactos con procedencia y control humano autorizado en un espacio de trabajo local. La aplicación instalada y las [notas de la versión más recientes](https://github.com/aipoch/open-science/releases/latest) son la fuente de referencia para los catálogos actuales, los detalles de empaquetado y las opciones recién incorporadas.

| Área                                                | Capacidad central                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Habilidades científicas**                         | Amplíe la investigación con **23 habilidades integradas** y **525 habilidades** del [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace), con instalación y actualizaciones en un clic. Cree habilidades mediante conversación o trabajo completado e importe paquetes o fuentes de GitHub. Las aportaciones se publican tras revisión; una importación local no las publica.                                                                                                                                                              |
| **Conectores**                                      | Acceda a recursos científicos con **24 conectores integrados** o añada conectores MCP locales y remotos personalizados. Gestione permisos por herramienta e importe o exporte configuraciones.                                                                                                                                                                                                                                                                                                                                                                      |
| **Especialistas y delegación**                      | Instale **10 especialistas** del [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace) o cree especialistas personales para recibir tareas del agente principal. Los paquetes admiten importación y exportación; las aportaciones se revisan antes de publicarse y las importaciones locales no las publican.                                                                                                                                                                                                                      |
| **Modelos y backends de agentes**                   | Use modelos en la nube, pasarelas compatibles o inicios de sesión de suscripciones Claude y Codex. Elija Claude Code, OpenCode, Codex o CodeBuddy como backend, con pruebas de conexión, entrada de imágenes y ajustes de razonamiento.                                                                                                                                                                                                                                                                                                                             |
| **Proyectos, sesiones y paquetes de investigación** | Organice proyectos con sesiones fijadas, ramas de mensajes, conversaciones laterales e historial recuperable. Traslade un **paquete de investigación `.science` portátil** a otro proyecto o equipo con ramas de conversación, versiones de archivos seleccionadas, registros de Notebook y evidencia de verificación. Las importaciones son de solo lectura, sin ejecutar código ni restaurar credenciales; se excluyen conversaciones laterales y marcadores, y los archivos dependen de la selección de exportación.                                             |
| **Agente revisor**                                  | Active la revisión automática opcional para comprobar, en un contexto separado, las respuestas, registros de ejecución y evidencias de archivos relacionados con un turno completado del agente. Obtenga comprobaciones fundamentadas con resultados de aprobación, advertencia o fallo, con un número limitado de ciclos de corrección por el agente principal y nueva revisión cuando se detecten problemas. Se conservan los registros de revisión y el estado de resolución de los problemas; la revisión se limita a los registros disponibles para ese turno. |
| **Python, R, Notebooks y HPC**                      | Ejecute Python, R, Notebook y shell localmente con entornos gestionados o intérpretes propios, con ejecución en segundo plano e historial. SSH y Slurm requieren el host, software, recursos y permisos descritos en la FAQ de cálculo remoto.                                                                                                                                                                                                                                                                                                                      |
| **Biblioteca de referencias**                       | Importe y gestione referencias y PDF con colecciones, etiquetas, vínculos a proyectos, notas y fusión de duplicados. Busque textos completos de acceso abierto, lea PDF, extraiga figuras y tablas y utilice fuentes de la biblioteca en las conversaciones para el análisis asistido por IA. Genere bibliografías con el estilo de cita elegido y exporte referencias en BibTeX o RIS.                                                                                                                                                                             |
| **Archivos científicos y vistas previas**           | Suba archivos de hasta **10 GiB cada uno**, organice los archivos del proyecto y previsualice datos científicos, PDF, documentos Office, imágenes, código y estructuras moleculares. El límite de subida no garantiza que un modelo lea todo el archivo: contexto, análisis de adjuntos y vistas previas tienen límites propios. Los archivos grandes suelen necesitar lectura o análisis por bloques mediante código.                                                                                                                                              |
| **Artefactos y procedencia**                        | Conserve versiones inmutables de resultados con código generador, entradas, historial de ejecución, entorno y evidencia de revisión disponibles. En el escritorio, reproduzca versiones aptas con una receta completa, las entradas necesarias y un entorno utilizable, compare salidas y exporte registros de verificación. La falta de evidencia puede impedir la verificación, y reproducir resultados no demuestra validez científica.                                                                                                                          |

## Proveedores de modelos

AIPOCH Open-Science es independiente del modelo a nivel de producto: conéctelo a los principales proveedores de LLM en la nube, una puerta de enlace personalizada o reutilice una suscripción Claude o Codex existente. Actualmente, la disponibilidad del proveedor depende del backend del agente seleccionado y de los protocolos API que admite. Hay cuatro formas de conectar un modelo:

| Modo proveedor                     | Cómo funciona                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedores de nube integrados** | Elija de la lista de proveedores que muestra la aplicación instalada y autentíquese con la clave solicitada.                                                                                                                                                                                                                                                                                                                                                                 |
| **Puerta de enlace personalizada** | Indique la URL base, el ID exacto del modelo y un protocolo API compatible con el backend elegido (Messages, Chat Completions o Responses), y pruebe la conexión. Las pasarelas remotas requieren HTTPS y clave API. Las direcciones de loopback como `localhost`, `127.0.0.1` o `[::1]` permiten HTTP sin clave; hay ajustes predefinidos para Ollama, LM Studio, llama.cpp y vLLM. El formato API predeterminado no garantiza la compatibilidad del servidor o del modelo. |
| **Suscripción de Codex**           | Seleccione el framework de agentes Codex y luego elija Suscripción de Codex como tipo de proveedor.                                                                                                                                                                                                                                                                                                                                                                          |
| **Suscripción de Claude**          | Inicie sesión con una suscripción de Claude en dos modos: **compartido** (un inicio de sesión en el navegador que almacena las credenciales en el perfil predeterminado `~/.claude`) o **aislado** (un flujo `claude setup-token` gestionado por la aplicación bajo un `CLAUDE_CONFIG_DIR` propio y completamente aislado de `~/.claude/`, con la opción alternativa de pegar un token).                                                                                     |

Los proveedores integrados incluyen OpenAI, Anthropic, DeepSeek, NVIDIA Build y otros. Los modelos y puntos de acceso regionales dependen de la versión instalada y del backend elegido; consulte el selector y la prueba de conexión de la aplicación.

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

AIPOCH Open-Science es una aplicación Electron creada con React, TypeScript, Prisma/SQLite y un entorno de ejecución de agentes basado en ACP.

Requisitos previos para desarrollar desde el código fuente:

- Node.js 22 (consulte [`.nvmrc`](../../.nvmrc)) con npm
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

### ¿Por qué falla la prueba de conexión del modelo?

R: Compruebe que la clave API no tenga caracteres omitidos ni espacios, verifique la URL base y la región, use el ID exacto del modelo indicado por el proveedor y confirme el acceso a la red y el saldo de la cuenta. Para una suscripción de Claude, vuelva a iniciar sesión en el navegador compartido o actualice la credencial aislada `claude setup-token`, según el modo seleccionado.

### ¿Por qué **Continuar** está deshabilitado durante la instalación?

R: El paso actual no cumple la condición requerida. Corrija cualquier fila del entorno marcada como **Acción necesaria**, instale o repare el entorno de ejecución del agente seleccionado o valide el proveedor del modelo, según el paso activo. La configuración de Notebook es opcional y solo afecta a la ejecución de Notebook.

### ¿Cómo ejecuto trabajos en un clúster HPC remoto?

R: **Computación remota (SSH)** permanece siempre habilitada y no necesita activarse en Configuración. Registre un host de cálculo SSH en **Configuración → Cálculo**, hágalo disponible para la sesión actual y utilice lenguaje natural o `/remote-compute-ssh`. Se necesita un host SSH accesible, autenticación válida, permisos sobre los directorios necesarios y el software, las dependencias y los recursos de cálculo que requiera la tarea. Direct SSH no requiere planificador; el modo Slurm exige un entorno Slurm operativo y permiso para enviar trabajos. “Siempre habilitada” se refiere a la habilidad, no a la disponibilidad permanente de cada host registrado.

### ¿Existe una interfaz de línea de comandos?

R: Sí. Instálela con un solo clic desde **Configuración → General → Herramienta de línea de comandos → Instalar comando** (añade `open-science` a su `PATH`; no requiere una instalación independiente de Node.js). La CLI controla el servicio local y envía tareas de investigación sin abrir un navegador:

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

### ¿Cómo inspecciono de dónde provino un resultado generado?

R: Abra el artefacto generado y elija **Procedencia**. Seleccione una versión para inspeccionar la identidad del contenido, el código que produjo el artefacto, el historial de ejecución, las entradas, el inventario del entorno, el contexto de la conversación de origen y la evidencia del revisor. La evidencia que AIPOCH Open-Science no pudo verificar se marca como no disponible.

### ¿Puedo revisar una solicitud anterior sin perder la conversación que siguió?

R: Sí. Edite un mensaje de usuario completo y reenvíelo para crear una nueva rama desde ese punto. Los turnos posteriores originales permanecen disponibles y las flechas de revisión junto al mensaje permiten cambiar entre las rutas alternativas.

## Participe

AIPOCH Open-Science agradece informes de errores, propuestas de funciones, debates sobre diseño, preguntas de la comunidad y contribuciones a través de GitHub, Discord, X y el sitio web de AIPOCH. Elija el canal que mejor se adapte a su objetivo, luego siga la guía de contribución vinculada y el recordatorio de seguridad de publicación pública antes de compartir los detalles del proyecto.

| Canal                                                                    | Úselo para                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [GitHub Problemas](https://github.com/aipoch/open-science/issues)        | Errores, fallos reproducibles y propuestas de funciones concretas                    |
| [GitHub Discusiones](https://github.com/aipoch/open-science/discussions) | Preguntas de diseño, propuestas de hoja de ruta y conversaciones técnicas más largas |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Ayuda comunitaria, coordinación de contribuyentes y discusión informal               |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Anuncios de versiones y novedades sobre el desarrollo público                        |
| [Sitio web de AIPOCH Open-Science](https://aipoch.com/open-science)      | Descripción general oficial del producto y descargas                                 |

Antes de abrir una incidencia pública, elimine de los registros y las capturas de pantalla las claves API, los tokens, las rutas de archivos privados, los datos no publicados, los identificadores de pacientes y cualquier otro material confidencial. Consulte [CONTRIBUTING.md](../../CONTRIBUTING.md) para conocer el flujo de trabajo de desarrollo.

> **Dar Star al repositorio:** Si este proyecto le ha resultado útil, agradeceríamos que le diera Star en GitHub. Ayuda a sostener el desarrollo y solo lleva un segundo.

Las capacidades entregadas, parciales y previstas aparecen en el [mapa de capacidades](../../ROADMAP.md#capability-map).

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
