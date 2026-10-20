## ✨ Open-Science 1.0

AIPOCH Open-Science es un entorno de investigación con IA, de código abierto y con prioridad al almacenamiento local. La versión 1.0 reúne bibliografía, datos científicos, análisis con agentes, resultados inspeccionables y registros de investigación portátiles en macOS, Windows y Linux.

## 🚀 Funciones de investigación

- **Proyectos y conversaciones:** organizar la investigación en proyectos y sesiones, explorar ramas de mensajes y conversaciones laterales, crear copias de sesiones para seguir otras líneas de investigación y consultar planes, preguntas de aclaración, actividad de herramientas y notificaciones.
- **Modelos y agentes:** elegir Claude Code, OpenCode, Codex o CodeBuddy con proveedores de nube compatibles, endpoints personalizados o accesos admitidos mediante suscripciones de Claude/Codex. Configurar modelos y razonamiento, consultar el uso y activar la memoria del proyecto cuando sea necesario.
- **Habilidades, especialistas y conectores:** instalar y actualizar habilidades y especialistas desde sus mercados, crearlos o importarlos, delegar tareas y acceder a recursos científicos mediante conectores integrados o servidores MCP personalizados con permisos delimitados.
- **Python, R y cálculo:** ejecutar código en entornos persistentes de Notebook, inspeccionar variables e historial, gestionar paquetes y exportar `.ipynb`. Ejecutar tareas en segundo plano localmente o mediante hosts SSH y clústeres Slurm configurados, con cancelación, recuperación y recopilación de resultados.
- **Bibliografía y PDF:** gestionar referencias, colecciones, etiquetas, notas y duplicados; buscar textos completos de acceso abierto y filtrar artículos según criterios de investigación. Leer y anotar PDF, extraer figuras y tablas, utilizar fuentes en conversaciones y generar bibliografías o exportar BibTeX/RIS.
- **Archivos y artefactos:** previsualizar tablas científicas, secuencias, estructuras moleculares, PDF, documentos de Office, imágenes y código. Editar formatos de texto compatibles y conservar versiones inmutables con el código, las entradas, el historial de ejecución y las evidencias del entorno registrados.
- **Revisión y verificación:** activar la revisión opcional de un turno del agente y sus evidencias disponibles. En la aplicación de escritorio, volver a ejecutar versiones de artefactos aptas con una receta completa y un entorno disponible, comparar resultados y exportar registros de verificación y paquetes de entorno capturados compatibles.
- **Intercambio de investigación:** exportar ramas, archivos, registros de Notebook y evidencias de verificación seleccionados como paquete `.science`. Importarlo para inspección de solo lectura y reproducción de pasos registrados, conversar sobre su contenido o crear una copia editable para continuar. Exportar la procedencia de artefactos como RO-Crate.
- **Escritorio, navegador y automatización:** utilizar el escritorio, la interfaz web local, un navegador móvil vinculado o la CLI independiente y Task SDK. La interfaz incluye inglés y ocho traducciones; cada acceso mantiene sus límites de funciones documentados.
- **Datos locales y control:** guardar registros localmente, revisar permisos de herramientas y carpetas, configurar los controles de red compatibles y exportar diagnósticos cuando sea necesario. Los proveedores de modelos, conectores remotos y hosts de cálculo siguen intercambiando datos con sus servicios configurados.

## 🧭 Alcance y límites

- Los protocolos y las funciones de los modelos dependen del framework del agente. Escritorio, navegador y CLI no ofrecen funciones idénticas; la protección del entorno aislado depende de la ruta de ejecución y la plataforma. WSL2 Bash sigue siendo una vista previa opcional en Windows x64.
- La reproducción de sesiones registradas no ejecuta código. La verificación requiere entradas capturadas y un entorno disponible; no garantiza la reproducción determinista de una sesión completa ni la validez científica. El filtrado bibliográfico y la revisión opcional apoyan el criterio del investigador.
- Los registros `.science` importados son de solo lectura y no restauran credenciales. Los paquetes excluyen conversaciones laterales y marcadores privados. Los paquetes de entorno deben estar completos y ser compatibles con la plataforma de destino.
- El cálculo remoto admite SSH y Slurm. La versión 1.0 no incluye envío gestionado de tareas a GPU en la nube, un backend de cálculo con GPU local ni edición simultánea multiusuario.

## 📦 Instalación y actualización

- Obtenga los instaladores de escritorio y paquetes CLI en la [página oficial](https://aipoch.com/open-science/download) o en [GitHub Releases](https://github.com/aipoch/open-science/releases). Los archivos CLI incluyen Node y se denominan `open-science-cli-<version>-<target>`; actualice los scripts que dependan del prefijo anterior.
- Actualice la CLI con el instalador o gestor de paquetes que la administra; `open-science update` ya no está disponible. Las actualizaciones de escritorio siguen disponibles. Detenga todos los perfiles que utilicen una instalación independiente antes de sustituirla y mantenga versiones coincidentes de escritorio y backend.
- 1.0 conserva las rutas existentes de actualización e importación de datos históricos; el cambio de versión no introduce un formato ni una migración nuevos. Haga una copia de seguridad del perfil antes de actualizar. Volver a un ejecutable anterior no revierte los datos y puede impedir su lectura.
- La [política de compatibilidad 1.x](https://github.com/aipoch/open-science/blob/main/docs/compatibility.md) cubre las interfaces CLI/SDK documentadas, la automatización Task, las importaciones `.science` y las actualizaciones de perfiles admitidas. Las correcciones de seguridad se destinan a la última versión estable y a `main`.
