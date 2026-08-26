# Open Science - El banco de trabajo de investigación de IA de código abierto con agentes científicos de IA

[![Descargar](https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=for-the-badge&logo=github)](https://github.com/aipoch/open-science/releases/latest)
[![Versión](https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=for-the-badge&color=4dabf7)](https://github.com/aipoch/open-science/releases/latest)
[![Licencia](https://img.shields.io/badge/License-Apache--2.0-4dabf7?style=for-the-badge)](../../LICENSE)
[![Sitio web](https://img.shields.io/badge/Website-aipoch.com-2f9e44?style=for-the-badge)](https://aipoch.com/)
[![Discord](https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/zxQAYjReRv)

<p align="center">
  <a href="../../README.md"><img alt="README en inglés" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="README en ruso" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../es/README.md"><img alt="README en español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> Este documento es una traducción del `README.md` en inglés. En caso de discrepancia, prevalece la [versión en inglés](../../README.md).

Open Science es un banco de trabajo de investigación de IA independiente del modelo, de código abierto y local para científicos e investigadores. Permite una investigación reproducible e inspeccionable con agentes científicos de IA, ejecución de Python y R, conectores de datos científicos y soporte multiplataforma para macOS, Windows y Linux. Cree un proyecto, describa su objetivo de investigación en un lenguaje sencillo y permita que los agentes lean archivos, busquen en la web, ejecuten código, consulten fuentes de datos científicos y produzcan informes, tablas y figuras con procedencia rastreable, todo en un solo espacio de trabajo.

Open Science respalda la investigación computacional y con uso intensivo de datos en todas las disciplinas, incluido el aprendizaje automático, la estadística, las ciencias biológicas, la química, la ciencia de los materiales, la física y las ciencias ambientales. Apoya el proceso de investigación, desde la revisión de la literatura y el desarrollo de hipótesis hasta la ejecución de código, análisis de datos, simulación, visualización y producción de resultados de investigación rastreables.

> 💡 **[Open Science v0.20.1 publicado](https://github.com/aipoch/open-science/releases/latest)** _(última actualización en agosto de 2026)_. Open Science v0.20.1 incorpora detalles de sesión generados y editables (título y descripción), un atajo para rehacer borradores en el editor, importación y exportación de configuraciones de cliente MCP con marcadores de posición para credenciales, detalles de uso por llamada al modelo con un gráfico de ventana de contexto rediseñado, y diagnósticos de solicitudes HTTP correlacionados. También aporta una red coherente con el proxy, descargas validadas, un emparejamiento de acceso remoto reforzado y numerosas correcciones para sesiones, Notebooks, conectores, cómputo y proveedores. Consulte las [notas de la versión más recientes](https://github.com/aipoch/open-science/releases/latest) para obtener todos los detalles.

<p align="center">
 <img width="1920" height="1140" alt="Espacio de trabajo de la aplicación de escritorio Open Science con una sesión del agente y artefactos generados" src="https://github.com/user-attachments/assets/df59db19-98d7-4071-81f2-c682fbecdf86" />
</p>

## Tabla de contenido

- [Inicio rápido](#-inicio-rápido)
- [Recorrido por el producto](#recorrido-por-el-producto)
- [Por qué Open Science](#por-qué-open-science)
- [Principios de diseño](#principios-de-diseño)
- [Capacidades principales](#capacidades-principales)
- [Proveedores de modelos](#proveedores-de-modelos)
- [Datos, permisos y confianza](#datos-permisos-y-confianza)
- [Estado del proyecto](#estado-del-proyecto)
- [Desarrollo y empaquetado](#desarrollo-y-empaquetado)
- [Hoja de ruta](#hoja-de-ruta)
- [Relación con el ecosistema AIPOCH](#relación-con-el-ecosistema-aipoch)
- [Qué no es esto](#qué-no-es-esto)
- [Preguntas frecuentes](#preguntas-frecuentes)
- [Participe](#participe)
- [Licencia](#licencia)
- [Historial de estrellas](#historial-de-estrellas)

## 🚀 Inicio rápido

Ejecute Open Science en tres pasos: descargue el instalador para su plataforma, complete la configuración guiada de primera ejecución y cree un proyecto de investigación.

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

### 2. Complete la configuración inicial

El primer lanzamiento tiene cinco pasos guiados:

1. **Entorno** comprueba la compatibilidad, el almacenamiento de aplicaciones, el almacenamiento seguro de credenciales y el acceso a la red.
2. **Entorno de ejecución del agente** selecciona y prepara Claude Code, OpenCode o Codex. Los entornos de ejecución gestionados por la aplicación se pueden instalar sin necesidad de Node.js, npm o una contraseña de administrador.
3. **Proveedor de modelo** conecta y prueba el modelo que desea utilizar. Elija un proveedor integrado, una puerta de enlace personalizada o un inicio de sesión de suscripción Claude o Codex existente.
4. **Entorno de ejecución de Notebook** prepara opcionalmente entornos Python y R administrados por la aplicación o habilita intérpretes detectados y registrados manualmente.
5. **Ubicación de datos** elige dónde se almacenan los artefactos, Notebooks, cargas y entornos de gran tamaño.

<table>
<tr>
<td width="50%"> <img src="../images/readme/onboarding-environment.jpg" alt="Comprobaciones automáticas del entorno durante el primer inicio de Open Science"> </td>
<td width="50%"> <img src="../images/readme/onboarding-model-provider.jpg" alt="Configuración del proveedor de modelos durante el primer inicio de Open Science"> </td>
</tr>
<tr>
<td align="center"> <sub> Comprobaciones de red, almacenamiento y compatibilidad del host </sub> </td>
<td align="center"> <sub> Proveedor, clave API, endpoint y validación de modelo </sub> </td>
</tr>
</table>

La ejecución de Notebook es opcional. Cada verificación requerida del entorno y del entorno de ejecución del agente debe pasar antes de que `Continue` esté disponible, y la conexión del modelo debe pasar antes de que finalice la instalación. Notebook y la configuración de ubicación de datos pueden mantener sus valores predeterminados y cambiarse más adelante en Configuración.

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

Open Science organiza la investigación en proyectos y sesiones para que cada resultado pueda permanecer conectado con la evidencia que lo produjo. Las secciones siguientes recorren el espacio de trabajo, la procedencia de los artefactos, los avances, las habilidades científicas y los conectores de datos.

### Un espacio de trabajo desde la tarea hasta los artefactos rastreables

Los proyectos mantienen juntas las sesiones relacionadas, las cargas, los archivos generados y el estado de vista previa. La conversación registra la respuesta del agente y los comandos, lecturas de archivos, ediciones, búsquedas y llamadas de conector que la produjeron. Cada artefacto generado se almacena como una versión inmutable con suma de verificación. Su vista **Procedencia** expone la evidencia que Open Science pudo verificar en el momento de la creación: código del productor e historial de ejecución, entradas referenciadas, un inventario del entorno observado, la rama de conversación de producción y cualquier hallazgo del revisor en el ámbito de la versión. Las pruebas faltantes se muestran como no disponibles en lugar de ser adivinadas.

<table>
<tr>
<td width="50%"> <img src="../images/readme/project-files.jpg" alt="Biblioteca de archivos del proyecto con cargas y artefactos de investigación generados"> </td>
<td width="50%"> <img src="../images/readme/csv-preview.jpg" alt="Vista previa de un artefacto CSV junto a una sesión completada del agente"> </td>
</tr>
<tr>
<td align="center"> <sub> Cargas y archivos generados organizados por proyecto y sesión </sub> </td>
<td align="center"> <sub> Las vistas previas nativas mantienen los datos y el historial de investigación uno al lado del otro </sub> </td>
</tr>
</table>

Los informes, las figuras y las tablas generados permanecen vinculados a la sesión y también se recopilan en la biblioteca de archivos del proyecto. Las pestañas de vista previa mantienen visible el resultado activo cuando cambia el tamaño del panel, y los nombres largos conservan el sufijo y la extensión que permiten identificarlos. Open Science previsualiza datos científicos habituales, PDF, documentos de Office (DOCX, XLSX, PPTX), imágenes (con zoom y desplazamiento), código fuente con resaltado de sintaxis, estructuras y reacciones moleculares, y el historial de Notebook. Los límites de la vista previa no truncan el archivo subyacente: el artefacto completo permanece disponible para el agente y las herramientas externas. Utilice `Cmd/Ctrl+F` para buscar transcripciones, resultados de Notebook y páginas renderizadas en todo el espacio de trabajo, o `Cmd/Ctrl+K` para abrir la paleta de comandos del proyecto. El espacio de trabajo también ofrece un modo oscuro: cambie el tema en **Configuración → General** y toda la paleta de la línea de comandos, la transcripción y el renderizador se actualizará sin parpadeos. La interfaz está disponible en español, chino (simplificado y tradicional), japonés, coreano, francés y ruso, con un selector de idioma en tiempo de ejecución dentro de Configuración.

### Bifurque una conversación sin perder la original

Edite un mensaje de usuario completo para reenviar un mensaje revisado desde ese punto. Open Science crea una nueva rama de mensaje en lugar de eliminar los giros que siguieron, y los controles de revisión le permiten moverse entre las rutas original y alternativa. La selección de ramas, la actividad de las herramientas, los archivos adjuntos y los artefactos generados persisten tras los cambios y reinicios del proyecto. La procedencia permanece ligada a la rama exacta que produjo cada versión del artefacto, por lo que explorar una hipótesis diferente no borra el registro del resultado anterior.

### Habilidades científicas y conectores de datos

Open Science incluye un catálogo creciente de **18 habilidades de investigación basadas en archivos** destacadas: AlphaFold2, Boltz, Borzoi, Chai-1, DiffDock, Environment & Packages, ESM-2, ESMFold2, Evo 2, Indication Dossier, LigandMPNN, Literature Review, OpenFold3, ProteinMPNN, scGPT, scvi-tools, SolubleMPNN y **Computación remota (SSH)** para enviar y recopilar trabajos de larga duración en clústeres HPC remotos. Puede crear habilidades personales, cargar paquetes `SKILL.md`, `.skill` o ZIP, previsualizar e importar habilidades compatibles desde GitHub con acceso autenticado opcional, o importar habilidades ya instaladas en sus directorios globales de agentes. El agente también puede solicitar la importación de un paquete desde un archivo adjunto de sesión o una URL pública de GitHub, con una vista previa y un paso de confirmación controlados por la aplicación antes de escribir nada. Las habilidades habilitadas se pueden seleccionar directamente en el compositor con `/`.

También incluye **24 conectores de investigación integrados**: Gráfico de literatura, PubMed, bioRxiv, Genes y ontologías, Genomas, BioMart, Variantes, Genética humana, Genómica clínica, Estructuras e interacciones, Anotación de proteínas, Expresión, Archivos ómicos, CellGuide, Regulación, ARN, Química, ChEMBL, ZINC, Visor de moléculas, Ensayos clínicos, Regulación de fármacos, Modelos de cáncer y Recursos de investigación. Los conectores integrados y personalizados permanecen detrás del sistema de permisos, con controles por herramienta `Always allow`, `Ask each time` y `Block`. La aplicación instalada muestra los catálogos actuales de habilidades, conectores y herramientas.

<table>
<tr>
<td width="50%"> <img src="../images/readme/skills.jpg" alt="Configuración de Open Science con habilidades científicas destacadas"> </td>
<td width="50%"> <img src="../images/readme/connectors.jpg" alt="Configuración de Open Science con conectores de datos científicos integrados"> </td>
</tr>
<tr>
<td align="center"> <sub> Habilidades de investigación legibles y reutilizables </sub> </td>
<td align="center"> <sub> Bases de datos científicas expuestas como herramientas de agentes autorizados </sub> </td>
</tr>
</table>

## Por qué Open Science

Open Science reúne tareas de investigación, ejecución, archivos y pruebas en un espacio de trabajo de escritorio local e inspeccionable.

El trabajo de investigación suele dividirse en ventanas de chat, Notebooks, scripts locales, bases de datos científicas, exploradores de archivos y herramientas de generación de informes. El contexto se pierde en cada transferencia y la respuesta a menudo se separa del código y los archivos que la produjeron.

Open Science reúne esas piezas en un espacio de trabajo de escritorio inspeccionable:

- **Trabajo que persiste.** Los proyectos, sesiones, borradores, archivos, vistas previas e historial de ejecución sobreviven a los reinicios de la aplicación.
- **Ejecución, no solo sugerencias.** El agente puede ejecutar comandos, Python y R, editar archivos, buscar, llamar a conectores y generar artefactos con la aprobación del usuario.
- **Rutas alternativas sin pérdida de trabajo.** Revisar un mensaje anterior en una nueva rama de mensaje y cambiar entre las direcciones de investigación resultantes.
- **Resultados rastreables.** Las versiones de artefactos inmutables conservan la evidencia de producción que Open Science puede verificar y marcan explícitamente la evidencia que no puede.
- **Múltiples opciones de modelo.** Utilice un proveedor de nube integrado, una puerta de enlace personalizada compatible o una suscripción Claude o Codex; Elija el modelo de cada sesión y el esfuerzo de razonamiento juntos en el compositor.
- **Propiedad local primero.** La aplicación y el estado del proyecto se ejecutan en su computadora; Las llamadas externas se realizan a través de servicios que usted configura o aprueba explícitamente.
- **Inspectabilidad.** El código fuente, las habilidades, las definiciones de los conectores, la actividad de las herramientas, los archivos generados y la procedencia de los artefactos están disponibles para su revisión.
- **Extensibilidad.** Agregue habilidades y conectores MCP en lugar de esperar una hoja de ruta cerrada para el complemento.
- **Sin licencia de puesto.** Open Science es el software Apache-2.0. Pagas sólo por el modelo o infraestructura que elijas utilizar.

Open Science es un producto independiente creado desde cero. No es un proxy, un cliente no oficial ni una versión de otra aplicación de investigación de IA.

## Principios de diseño

Open Science se basa en siete principios de diseño que rigen cómo encajan el código, los datos, los modelos y la supervisión humana: abierto de forma predeterminada, compatibilidad explícita con múltiples proveedores, propiedad de datos local primero, supervisión humana, registros de investigación duraderos, capacidades componibles y límites científicos honestos.

- **Abierto de forma predeterminada.** El código fuente, los formatos, los conectores y las habilidades deben permanecer inspeccionables y bifurcables.
- **Multiproveedor con compatibilidad explícita.** La aplicación valida la configuración del proveedor y hace visibles los requisitos de los terminales en lugar de tratar cada protocolo API como intercambiable.
- **Primero lo local y con reconocimiento de datos.** Mantenga el estado del proyecto local, muestre flujos de datos externos y opte por la autonomía.
- **Supervisión humana.** Las ediciones de archivos, los comandos, el acceso a la red y las llamadas a conectores se rigen por perfiles de aprobación explícitos.
- **Registros de investigación duraderos.** Las sesiones, la actividad de las herramientas, el historial de Notebook y las versiones de artefactos inmutables deben seguir siendo revisables una vez finalizada la ejecución, y se indica claramente la evidencia no disponible.
- **Capacidades componibles.** Las habilidades, los conectores, los modelos, las vistas previas y los futuros backends informáticos deben ser piezas reemplazables en lugar de una caja negra.
- **Límites científicos honestos.** Los resultados generados no reemplazan el juicio de expertos, la revisión estadística o la validación contra evidencia primaria.

## Capacidades principales

Open Science combina gestión de proyectos, ejecución de agentes multimodelo, Notebooks de Python y R, conectores de datos científicos, versiones inmutables de artefactos con procedencia y control humano autorizado en un espacio de trabajo local. La aplicación instalada y las [notas de la versión más recientes](https://github.com/aipoch/open-science/releases/latest) son la fuente de referencia para los catálogos actuales, los detalles de empaquetado y las opciones recién incorporadas.

| Área                            | Capacidad central                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proyectos y sesiones**        | Crear, cambiar el nombre y eliminar proyectos; mantener múltiples sesiones con fijación; editar mensajes completados en ramas de mensajes persistentes y seleccionables sin eliminar la ruta descendente original; conversaciones paralelas persistentes dentro de una sesión; detalles de sesión generados y editables (título y descripción); restaurar trabajos recientes, borradores, historial de conversaciones y vista previa del estado.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Flujo de trabajo del agente** | Tareas en lenguaje natural, respuestas transmitidas, tarjetas de actividad de herramientas escritas agrupadas bajo títulos de propósito declarado, un indicador de uso de contexto en vivo con estimaciones a nivel de categoría, compactación de contexto bajo demanda y persistencia en reinicios, controles de detención, pausas de aprobación, un paso de confirmación (con una preferencia recordada) antes de cerrar o salir durante una tarea en ejecución, una cola de mensajes del editor para organizar mensajes de seguimiento durante un turno en ejecución, historial unificado para deshacer y rehacer borradores, bifurcación a una nueva sesión a partir de mensajes de agente completados, notificaciones de escritorio con motivos de atención y duraderas. insignias de conversación no leídas y atención nativa en el bloqueo de aprobaciones, un centro de mensajes de notificación transversal con estado de lectura duradero y objetivos eliminados retenidos, tarjetas de aclaración de agente estructuradas para solicitudes de preguntas múltiples, estado de sesión en vivo en el panel de inicio, metadatos de sincronización de mensajes con ventanas emergentes de uso y tiempo transcurrido, uso de tokens por turno con detalles por llamada al modelo y un gráfico de ventana de contexto por llamada, framework de agentes de turno completado e identificación de modelo, una paleta de comandos con alcance de proyecto, lecturas de marco con alcance de proyecto, acciones de proyecto y contexto de agente, filas de barra lateral de sesión refinadas, referencias de sesión ( `#` ) a otras sesiones en el compositor con acceso de lectura por turnos, avisos de chat lateral inyectados en un turno principal en ejecución, búsqueda de número de sesión en la búsqueda global, planes de sesión controlados por revisión con contratos de ejecución duraderos y comandos de visualización, aprobación y rechazo del plan CLI, representación fluida de respuesta en vivo, paneles laterales plegables, un atajo de teclado para nuevas conversaciones y recuperación de sesiones interrumpidas por un reinicio de la aplicación. |
| **Delegación de subagente**     | Delegación de subagentes de producción con mensajería duradera y recuperación.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Modelos**                     | Proveedores de nube integrados, puertas de enlace compatibles personalizadas, inicios de sesión de suscripción Claude y Codex, validación de conexión, entrada de imágenes multimodales por modelo, un selector de composición por sesión combinado para el esfuerzo de razonamiento basado en modelo y modelo, una tarjeta de modelos de escenario consolidada que cubre las políticas de subagente, revisor y visión, configuraciones predeterminadas para nuevas sesiones y un selector de modelo de visión dedicado con un persistente Retransmisión de evidencia de imagen para backends de solo texto. Los proveedores y formatos de API disponibles se validan con el backend del agente seleccionado.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Backend del agente**          | Un backend de framework de agentes seleccionable para que el mismo espacio de trabajo pueda ejecutarse en más de una implementación de agente subyacente, con opciones de proveedor y modelo validadas contra el backend seleccionado, backends administrados por aplicaciones instalables, intercambiables y extraíbles desde Configuración, y reproducción de contexto consciente del agente que respeta la ruta de contexto de cada framework después de cambios o reanudaciones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Especialistas**               | Perfiles de agentes especializados personales con capacidades específicas, transferencia inmediata en vuelo por parte del agente principal, personalización conversacional, importación/exportación de paquetes, identidades de invocación inmutables, identificaciones basadas en nombres generadas con anulaciones validadas y un mercado de especialistas específico con verificación de paquetes firmados, fuentes GitHub oficiales y aprobadas por el usuario, reserva de CDN, progreso de descarga y resolución de conflictos de habilidades en la importación. El mercado separa las vistas Instalado y Marketplace con una única entrada de navegación principal y una ruta de retorno explícita, abre listas verificadas en caché inmediatamente con actualización manual, admite la instalación directa desde los detalles y proporciona íconos de capacidades compartidas, edición rápida de apariencia y navegación en filas de capacidades.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Organización de capacidad**   | Etiquetas de recursos cruzados para habilidades, conectores y especialistas ejecutables, con una etiqueta de Favoritos protegida, menús de tareas, insignias, filtros, un navegador de configuración de etiquetas con capacidad de búsqueda y orden de arrastre persistente con puntero o teclado.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Ejecución**                   | Kernels de plano de control persistentes para Python, R y REPL con historial duradero de código y resultados, además de comandos de terminal sin estado registrados en el mismo historial de ejecución; inferencia REPL limitada para evaluación impulsada por agentes; entornos administrados por la aplicación con aprovisionamiento sin conexión; intérpretes Python y R aportados por el usuario; hosts de cómputo SSH remotos con autenticación mediante clave o contraseña y credenciales cifradas en el sistema operativo como destinos de ejecución adicionales; un terminal de usuario compartido con el agente; un inventario de paquetes instalados de solo lectura por entorno de ejecución; acceso de lectura a los artefactos de Notebook para que el agente inspeccione archivos; progreso de instalación de paquetes con tiempo transcurrido en la actividad de la sesión; y carga progresiva del historial para Notebooks de larga duración. La gestión de paquetes para entornos de ejecución externos de R sigue siendo manual.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Entradas y archivos**         | Archivos adjuntos (hasta 10 GB por archivo con carga en streaming), una biblioteca a nivel de proyecto con paginación indexada, agrupación de sesiones, búsqueda de nombres de archivos con ámbito de origen, vistas de cuadrícula y lista, un modo de expansión grande para proyectos grandes, vista previa dividida de archivos junto a la sesión, tarjetas de artefactos generadas, `@` referencias a cargas/salidas existentes, `@path` menciona para otorgar acceso a la carpeta local con navegación entre unidades, una barra de ruta editable y un conmutador de unidades, descarga/exportación de archivos, descargas selectivas de artefactos de sesión, pegados largos de texto sin formato convertidos en archivos adjuntos con restauración exacta, exportación de conversaciones como Markdown o PDF y exportación de sesiones como `.ipynb` (por pestaña o descarga total).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Artefactos y procedencia**    | Versiones de artefactos inmutables con alcance de sesión con contenido de suma de verificación y código de productor disponible, historial de ejecución, referencias de entrada exactas, inventario de entorno, contexto de rama de mensajes de producción, acceso al linaje de artefactos y evidencia de revisor con alcance de versión, con navegación de versiones y enlaces directos entre evidencia relacionada.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Formatos de vista previa**    | Vistas previas adaptables con varias pestañas para datos científicos habituales, archivos PDF, documentos de Office (DOCX, XLSX, PPTX), imágenes (incluido TIFF, con zoom y desplazamiento), código fuente con resaltado de sintaxis, estructuras y reacciones moleculares e historial de Notebook, visibles en línea o a pantalla completa, con navegación contextual de regreso a la conversación que produjo el artefacto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Gestión de datos locales**    | Datos de aplicaciones y proyectos locales, ubicación de almacenamiento configurable, migración guiada y configuración de proxy global con modos de sistema, manual y directo; un panel de uso de tokens con resúmenes de períodos, un mapa de actividad de 30 días y gráficos diarios de entrada/caché/salida.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Habilidades**                 | **18 habilidades integradas destacadas**; habilidades personales con nombres inmutables con guiones en minúsculas; creación de habilidades conversacionales a partir del lenguaje natural dentro de una sesión; guardar como habilidad de un turno de conversación completado; soporte directo de carpetas de habilidades del usuario con validación de paquetes fuera de banda; habilitar/deshabilitar administración masiva con filtros de fuente, estado y texto; carga de paquetes; vista previa/importación autenticada GitHub; importación de habilidades globales instaladas con vista previa de candidatos; importaciones de paquetes solicitadas por el agente desde archivos adjuntos de sesión o URL GitHub; API de JavaScript de camelCase Host para secuencias de comandos de habilidades con validación estructurada; habilitar/deshabilitar controles; y selección explícita de `/` en una sesión. El panel Habilidades rediseñado unifica el filtrado de agentes principales y especialistas, muestra pilas de avatares de usuarios reales con un popover limitado Usado por, consolida las acciones de fila y admite la eliminación masiva confirmada mientras protege las habilidades integradas y vinculadas a especialistas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Conectores**                  | **24 conectores de investigación integrados** con estado del entorno de ejecución y superficies de recuperación, conectores MCP locales/remotos personalizados con nombres de invocación en minúsculas inmutables separados de los nombres para mostrar editables, ID locales generados basados ​​en nombres con anulaciones validadas, metadatos de contacto, permisos a nivel de conector/herramienta e importación y exportación de configuraciones estándar de cliente MCP con marcadores de posición para credenciales. Las interacciones del catálogo siguen los mismos patrones de gestión compactos que las habilidades.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Controles de seguridad**      | perfiles de conversación `Ask for approval`, `Auto-approve edits` y `Full access`; diálogos de aprobación con vistas previas de código y decisiones de llamadas/conversaciones; denegaciones por turnos que bloquean los reintentos o soluciones alternativas para la operación rechazada; concesiones duraderas globales, de alcance de proyecto y de sesión con filtrado, revocación por fila y familia, y Deshacer; además de políticas por conector y por herramienta.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Revisión y verificación**     | Un revisor optativo que audita un turno completado comparándolo con su propia transcripción, registro de ejecución y artefactos, informa los resultados de aprobación/advertencia/fallo y puede ejecutar un ciclo de corrección limitado para corregirlos; una política de modelo de revisor configurable que sigue el modelo activo o fija un proveedor, modelo y esfuerzo de razonamiento dedicados; e instantáneas duraderas de la evaluación del revisor con atribución de corrección.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Distribución y soporte**      | Instaladores para macOS, Windows y Linux; un asistente de incorporación inicial para configurar el entorno, el entorno de ejecución del agente, el proveedor de modelos, el entorno de ejecución de Notebook y la ubicación de los datos; interfaz localizada en español, francés, chino (simplificado y tradicional), japonés, coreano y ruso, con un README traducido para cada idioma compatible y guías de contribución multilingües adicionales; una guía de actualización con avisos destacados; diagnósticos locales; y enlaces a la comunidad.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Proveedores de modelos

Open Science es independiente del modelo a nivel de producto: conéctelo a los principales proveedores de LLM en la nube, una puerta de enlace personalizada o reutilice una suscripción Claude o Codex existente. Actualmente, la disponibilidad del proveedor depende del backend del agente seleccionado y de los protocolos API que admite. Hay cuatro formas de conectar un modelo:

| Modo proveedor                     | Cómo funciona                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedores de nube integrados** | Elija de la lista de proveedores que muestra la aplicación instalada y autentíquese con la clave solicitada.                                                                                                                                                                                                                                                                                                                          |
| **Puerta de enlace personalizada** | Proporcione una URL base compatible, una clave API y un ID de modelo exacto. El formato API predeterminado (Messages, Chat Completions o Responses) se deriva del framework de agentes activo, por lo que una nueva puerta de enlace personalizada es compatible desde el primer momento.                                                                                                                                             |
| ** Codex Suscripción**             | Seleccione el framework de agentes Codex y luego elija Codex Suscripción como tipo de proveedor.                                                                                                                                                                                                                                                                                                                                      |
| ** Claude Suscripción**            | Inicie sesión con una suscripción Claude en dos modos: **compartido** (un inicio de sesión en el navegador que almacena las credenciales en su perfil `~/.claude` predeterminado) o **aislado** (un `claude setup-token` administrado por la aplicación que se ejecuta bajo un `CLAUDE_CONFIG_DIR` propiedad de la aplicación, completamente aislado de `~/.claude/`, con un flujo de navegador más un respaldo para pegar un token). |

Se eliminó el proveedor heredado **Local Claude**. Las entradas locales Claude previamente almacenadas se eliminan durante la actualización; agregue ** Claude Suscripción** y autentíquese con el inicio de sesión del navegador compartido o el flujo aislado `claude setup-token` en su lugar.

Los proveedores de nube integrados actualmente incluyen OpenAI, Anthropic, Grok (xAI), DeepSeek, Zhipu AI (GLM) con un punto final de plan de codificación GLM dedicado, Kimi (Moonshot), MiniMax, StepFun con un punto final de suscripción dedicado a Step Plan, Xiaomi MIMO, SenseNova, Volcengine Ark, Bailian (Alibaba Cloud) con un punto final de suscripción dedicado a Bailian for Plan y la puerta de enlace de agregación OpenRouter, entre otros; algunos son específicos de la región.

Los proveedores, los modelos disponibles y los puntos finales regionales pueden evolucionar independientemente de este README. Trate el selector de proveedores y la prueba de conexión en la aplicación instalada como la fuente de verdad.

## Datos, permisos y confianza

Open Science almacena datos del proyecto, configuraciones, versiones de artefactos y evidencia de procedencia en la computadora local. Las claves API se guardan localmente y utilizan el almacenamiento seguro de credenciales del sistema operativo cuando está disponible. Los registros son locales y no se cargan automáticamente.

El flujo de datos externos aún es posible y debe revisarse:

- Las solicitudes de modelo envían el contexto rápido y necesario al proveedor del modelo seleccionado.
- Las búsquedas web y los conectores remotos envían sus parámetros mostrados a servicios externos.
- Los conectores locales pueden ejecutar comandos confiables en la computadora.
- Los archivos adjuntos, las referencias `@`, los registros y los informes generados pueden contener datos de investigación confidenciales.

Elija el perfil de permiso más limitado que se ajuste a la tarea:

| Modo                 | Comportamiento                                                                            | Uso recomendado                                                        |
| -------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `Ask for approval`   | Pregunta antes de realizar ediciones, comandos, redes y llamadas a conectores             | Nuevos flujos de trabajo, datos confidenciales, scripts desconocidos   |
| `Auto-approve edits` | Permite automáticamente ediciones del espacio de trabajo; pide comandos, red y conectores | Trabajo confiable de edición de archivos con acceso externo controlado |
| `Full access`        | Permite automáticamente ediciones, comandos, redes y conectores                           | Trabajo desatendido, de plena confianza y con un alcance claro         |

Revise los parámetros del conector y la actividad de la herramienta antes de aprobarlos. Nunca incluya claves API, tokens de acceso, identificadores de pacientes, datos no publicados o rutas locales confidenciales en capturas de pantalla o registros de problemas públicos.

## Estado del proyecto

Open Science es una aplicación de escritorio desarrollada activamente disponible para macOS, Windows y Linux. El desarrollo se centra en flujos de trabajo de investigación locales confiables, capacidades científicas extensibles, artefactos de investigación rastreables y ejecución controlada por el usuario.

Consulte la [última versión](https://github.com/aipoch/open-science/releases/latest) para conocer las descargas actuales y los cambios específicos de la versión. Para conocer las capacidades publicadas, parciales y planificadas, consulte el [Mapa de capacidades](../../ROADMAP.md#capability-map).

Open Science ayuda a la ejecución de investigaciones y al mantenimiento de registros; Los investigadores siguen siendo responsables de los métodos, la interpretación, la privacidad y la validez científica.

## Desarrollo y empaquetado

Open Science es una aplicación Electron creada con React, TypeScript, Prisma/SQLite y un entorno de ejecución de agentes basado en ACP.

Requisitos previos para el desarrollo de fuentes:

- Node.js 22 (ver [`.nvmrc`](../../.nvmrc) ) con npm
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
| `npm run typecheck`    | Verifique el tipo de código principal y de renderizado                       |
| `npm test`             | Ejecute la suite Vitest                                                      |
| `npm run build`        | Verifique el tipo y cree la aplicación                                       |
| `npm run build:web`    | Cree la interfaz de usuario web localhost opcional                           |
| `npm run build:mac`    | Paquete compilaciones de macOS                                               |
| `npm run build:win`    | Paquete de compilaciones de Windows                                          |
| `npm run build:linux`  | Paquete compilaciones de Linux                                               |

La salida empaquetada está escrita en `dist/`.

### Modos web y sin cabeza de Localhost

Opcionalmente, el backend del escritorio puede servir el mismo renderizador a un navegador en la computadora local. Esta característica está desactivada de forma predeterminada y se vincula solo a `127.0.0.1`.

```bash
npm run build:web
npm run dev:web
```

Abra la URL autenticada que muestra la aplicación. Utilice `npm run dev:headless` para iniciar el backend, la bandeja, el entorno de ejecución del agente y el servicio web localhost sin abrir una ventana de Electron. Configure `OPEN_SCIENCE_WEB_PORT` para elegir un puerto (predeterminado: `44100`). Al salir explícitamente de la aplicación también se cierran con normalidad los procesos del agente y de Notebook.

### Acceso remoto móvil

Se puede acceder a la misma interfaz de usuario web de localhost desde un teléfono o tableta a través del emparejamiento Remote.It. Empareje un navegador con un código Open Science de seis dígitos, apruebelo una vez en el escritorio y el espacio de trabajo permanecerá accesible sin exponer el servidor de bucle invertido directamente. La confianza del navegador es revocable y los cambios de modo o el cierre del servicio invalidan inmediatamente las sesiones remotas activas.

### CLI y SDK sin cabeza

La CLI sin cabeza y el SDK de Node.js sin dependencia utilizan el mismo demonio local, proyectos, sesiones, credenciales y permisos que las interfaces web y de escritorio. El uso detallado se incluye en el paquete publicable, por lo que hay una referencia de comando que mantener:

- [Guía CLI](../../packages/open-science/CLI.md): instalación, ciclo de vida del servicio, automatización de tareas, artefactos, formatos de salida y códigos de salida
- [Descripción general del paquete SDK](../../packages/open-science/README.md) - Inicio rápido de Node.js y punto de entrada del paquete

## Hoja de ruta

La hoja de ruta del producto y el estado de la capacidad se mantienen en [ROADMAP.md](../../ROADMAP.md). Este archivo README no duplica intencionalmente la lista móvil de prioridades ni los objetivos de lanzamiento.

## Relación con el ecosistema AIPOCH

<img width="1920" height="1140" alt="Función de Open Science en el ecosistema AIPOCH como capa de orquestación de escritorio para flujos de trabajo abiertos de IA científica" src="https://github.com/user-attachments/assets/0ab847b1-1b7d-43f4-8c11-480a578e6c7d" />

[AIPOCH](https://aipoch.com/open-science) ([GitHub org](https://github.com/aipoch) ) crea Open Science como la capa de orquestación de escritorio para flujos de trabajo de IA científicos abiertos.

- [aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills) es una colección más amplia de más de 500 habilidades de investigación médica y científica basadas en archivos, todas las cuales pueden inspeccionarse, importarse y combinarse con Open Science de GitHub.
- Open Science proporciona el espacio de trabajo del proyecto/sesión, el entorno de ejecución del agente, la ejecución, los artefactos, las vistas previas, los permisos y los conectores que convierten esas instrucciones en un flujo de trabajo interactivo.

Las habilidades y los conectores pueden ejecutar código o enviar datos externamente. Revise su fuente, licencia, scripts y comportamiento de red antes de habilitarlos.

## ¿Qué no es esto?

Open Science es una herramienta de ejecución de investigaciones y mantenimiento de registros, no un contenedor de chat genérico, un cliente no oficial ni un sustituto de la revisión científica.

- **No es solo una interfaz de usuario de chat.** El producto está organizado en torno a proyectos persistentes, ejecución, archivos, artefactos y actividad de herramientas revisables.
- **No es un cliente no oficial para otro producto.** Es una implementación independiente con su propia base de código, modelo de datos, interfaz y hoja de ruta.
- **No reemplaza el juicio científico.** Los resultados aún requieren revisión de dominio, validación estadística y verificación con fuentes primarias.

## Preguntas frecuentes

### ¿Qué debo hacer la primera vez que abro Open Science?

R: Complete los cinco pasos de configuración: **Entorno**, **Entorno de ejecución del agente**, **Proveedor de modelo**, **Entorno de ejecución de Notebook** y **Ubicación de datos**. Corrija las filas obligatorias marcadas como `Action needed`, instale o repare el agente seleccionado si se ofrece esa opción y pruebe la conexión del modelo. La configuración de Notebook y una ubicación de datos personalizada son opcionales.

### ¿Qué es una clave API y dónde consigo una?

R: Una clave API es una credencial secreta emitida por un proveedor de modelos. Cree o copie uno desde la consola API/desarrollador de ese proveedor. El proveedor podrá facturar las solicitudes realizadas con la clave. Trátela como una contraseña: nunca la comparta ni la envíe a un repositorio.

### ¿Necesito una clave API?

R: No, si reutiliza un inicio de sesión de suscripción existente: una suscripción Claude a través de un inicio de sesión de navegador compartido o un flujo `claude setup-token` administrado por una aplicación aislada, o un inicio de sesión de suscripción ChatGPT/ Codex en el backend Codex. Los proveedores de nube integrados y las puertas de enlace personalizadas requieren sus propias claves.

### ¿Qué proveedores de modelos puedo utilizar?

R: Abra el selector de proveedores durante la configuración o en `Settings → Model` para ver las opciones admitidas por su aplicación instalada y el backend del agente seleccionado. Puede utilizar un proveedor de nube integrado, una puerta de enlace personalizada compatible, una suscripción Claude mediante inicio de sesión compartido o aislado, o una suscripción Codex en el backend Codex.

### ¿Por qué falla la prueba de conexión del modelo?

R: Verifique la clave API para ver si faltan caracteres o espacios, verifique la URL base y la región, use la identificación del modelo exacto del proveedor y confirme el acceso a la red y el saldo de la cuenta. Para una suscripción Claude, vuelva a intentar iniciar sesión en el navegador compartido o actualice la credencial aislada `claude setup-token`, según el modo seleccionado.

### ¿Por qué `Continue` está deshabilitado durante la instalación?

R: El paso actual no ha cumplido la condición requerida. Corrija cualquier fila de entorno marcada `Action needed`, instale o repare el entorno de ejecución del agente seleccionado o valide el proveedor del modelo, según el paso activo. La configuración de Notebook es opcional y solo afecta la ejecución de Notebook.

### La configuración está completa. ¿Cómo inicio una tarea de investigación?

R: Cree o abra un proyecto, inicie una sesión, adjunte los archivos fuente y describa el objetivo, las restricciones, el resultado esperado y los criterios de validación. Utilice `@` para hacer referencia a un archivo de proyecto y `/` para seleccionar una habilidad habilitada.

### ¿Cómo ejecuto trabajos en un clúster HPC remoto?

R: Habilite la habilidad **Computación remota (SSH)** en **Configuración → Habilidades**, registre su clúster en **Configuración → Computación**, luego inicie una sesión y seleccione la habilidad con `/remote-compute-ssh`. La habilidad maneja el registro del host, comandos cortos a través de SSH y el envío de trabajos totalmente asincrónicos: la aplicación inicia automáticamente un turno de análisis cuando finaliza el trabajo, por lo que nunca se escribe un ciclo de sondeo.

### ¿Existe una interfaz de línea de comandos?

R: Sí. Instálela con un solo clic desde **Configuración → General → Herramienta de línea de comandos → Instalar comando** (añade `open-science` a su `PATH`; no requiere una instalación independiente de Node.js). La CLI controla el servicio local y envía tareas de investigación sin abrir un navegador:

```bash
# Start the service in the background
open-science start --no-open

# Create a project and run a task by its exact name
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# Download a generated artifact
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

Consulte la [guía CLI](../../packages/open-science/CLI.md) para obtener la referencia completa de comandos, formatos de salida JSON/JSONL, códigos de salida y opciones de servicio sin cabeza.

### ¿Cómo inspecciono de dónde provino un resultado generado?

R: Abra el artefacto generado y elija **Procedencia**. Seleccione una versión para inspeccionar la identidad del contenido y el código de productor disponible, el historial de ejecución, las entradas, el inventario del entorno, el contexto de la conversación de producción y la evidencia del revisor. La evidencia que Open Science no pudo verificar está marcada como no disponible.

### ¿Puedo revisar una solicitud anterior sin perder la conversación que siguió?

R: Sí. Edite un mensaje de usuario completo y reenvíelo para crear una nueva rama desde ese punto. Los giros posteriores originales permanecen disponibles y las flechas de revisión al lado del mensaje cambian entre las rutas alternativas.

### ¿Los datos de mi investigación permanecen en mi computadora?

R: Los proyectos, sesiones, archivos, configuraciones y credenciales configuradas se almacenan localmente de forma predeterminada. Es posible que el contenido necesario para solicitudes de modelo, búsquedas web o llamadas de conector aún se envíe al servicio externo que seleccionó, así que revise las entradas confidenciales y las políticas del proveedor antes de ejecutar una tarea.

## Participe

Open Science agradece informes de errores, propuestas de funciones, debates sobre diseño, preguntas de la comunidad y contribuciones a través de GitHub, Discord, X y el sitio web de AIPOCH. Elija el canal que mejor se adapte a su objetivo, luego siga la guía de contribución vinculada y el recordatorio de seguridad de publicación pública antes de compartir los detalles del proyecto.

| Canal                                                                    | Úselo para                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [GitHub Problemas](https://github.com/aipoch/open-science/issues)        | Errores, fallos reproducibles y propuestas de funciones concretas                    |
| [GitHub Discusiones](https://github.com/aipoch/open-science/discussions) | Preguntas de diseño, propuestas de hoja de ruta y conversaciones técnicas más largas |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Ayuda comunitaria, coordinación de contribuyentes y discusión informal               |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Anuncios de lanzamiento y actualizaciones públicas integradas                        |
| [Sitio web](https://aipoch.com/)                                         | Descripción general del producto, descargas y el resto del ecosistema AIPOCH         |

Antes de abrir una edición pública, elimine las claves API, tokens, rutas de archivos privados, datos no publicados, identificadores de pacientes y otro material confidencial de los registros y capturas de pantalla. Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para conocer el flujo de trabajo de desarrollo.

> ⭐ **Destacar el repositorio:** Si este proyecto ha sido útil, agradeceríamos mucho una estrella en GitHub. Destacar el repositorio fomenta el desarrollo continuo. Sólo lleva un segundo, pero tiene un impacto significativo en el proyecto.

## Licencia

Licencia Apache 2.0: consulte [LICENCIA](../../LICENSE).

## Historial de estrellas

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Gráfico del historial de estrellas" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>
