## ✨ Highlights

- **Ejecute trabajos en backends en la nube.** Kubernetes, Hugging Face Jobs, Modal y Ray se suman a SSH y Slurm: apruebe el destino, el comando, los recursos y los resultados antes del envío, recupere el trabajo tras un reinicio y abra los resultados publicados desde Compute Preview. (#4191)
- **Agente Open-Science integrado.** Un runtime de agente integrado e independiente, con ejecución de turnos neutral respecto al proveedor y manejo validado de herramientas, es ahora el predeterminado en las nuevas instalaciones (antes Claude); Claude Code, OpenCode, Codex, CodeBuddy y Pi siguen disponibles. (#4147, #4159)
- **Actualizaciones de macOS más rápidas.** Las actualizaciones descargan solo los bloques modificados de la imagen de la aplicación, con respaldo a la descarga completa cuando es necesario. (#4177)
- **Comente una investigación importada paso a paso.** Preguntar desde un paquete `.science` importado o desde un paso de reproducción abre una conversación hija vinculada a ese paso; la conversación principal conserva su identidad y las discusiones sobreviven al archivado. (#4178)
- **Un espacio de trabajo más sereno.** La barra lateral prioriza la investigación fijada e importada y pliega las sesiones antiguas en una única lista de recientes, el historial importado hace de «fork to continue» el siguiente paso evidente, y enviar desde un turno anterior ya no desplaza la posición de lectura. (#4180, #4183, #4188)
- **Actualizaciones y documentos más fiables.** macOS verifica la aplicación en ejecución antes de bloquear una instalación, las actualizaciones de Windows nombran los archivos que mantienen la aplicación abierta, y la traducción de PDF de diseño fijo conserva las páginas correctas cuando una falla. (#4161, #4158, #4186)

## 🚀 New Features

- Envíe trabajos aprobados a Kubernetes, Hugging Face Jobs, Modal o Ray, con aprobación por trabajo del destino, el comando, los recursos y los resultados, además de registros de recuperación que reanudan la recopilación tras un reinicio. Los trabajos remotos se ejecutan bajo la autoridad de su propia cuenta conectada: cada backend necesita sus propias credenciales, y los insumos, el comando y los resultados aprobados salen de esta máquina hacia el proveedor seleccionado. (#4191)
- Use el runtime del agente Open-Science integrado, con adaptadores de transmisión para los principales protocolos de API y almacenes duraderos; es el agente predeterminado en las nuevas instalaciones. (#4147, #4159)
- Descargue las actualizaciones de macOS de forma diferencial mediante blockmaps, con respaldo automático a la descarga completa. (#4177)
- Inicie una conversación hija vinculada a un paso desde la investigación importada o la reproducción; al eliminar la conversación principal, las discusiones se convierten en conversaciones ordinarias. (#4178)
- Previsualice los enlaces de origen en una tarjeta flotante que muestra el dominio de destino y, para los orígenes HTTPS aprobados, los metadatos de título y descripción. (#4194)

## 🔧 Improvements

- La barra lateral del espacio de trabajo ordena los grupos como Fijado, Investigación importada, Activo y Recientes, y las sesiones hijas se leen claramente como ramas de su conversación principal. (#4180)
- El historial de investigación importada conserva las cuatro acciones pero promueve Fork to continue como la única acción principal. (#4183)
- Enviar un mensaje mientras se lee un turno anterior mantiene la transcripción anclada en lugar de saltar al final. (#4188)
- La pestaña de configuración del modelo se convierte en Capacidades locales, que abarca la extracción de PDF, los paquetes de idiomas de OCR y la narración de investigación con tarjetas alineadas. (#4175)
- Preguntar en la reproducción se adjunta al paso seleccionado o a la ejecución de Notebook, incluidas las celdas fuera de la página actual. (#4187, #4185)
- Los mensajes de error de las herramientas ahora indican la llamada fallida y el siguiente paso explícito en lugar de leerse como si la herramienta no estuviera disponible. (#4184)
- El análisis de fuentes grandes de Notebook se ejecuta fuera del hilo principal, la evidencia de archivos reutiliza un proceso residente y las salidas de procesos propios se esperan de forma nativa, manteniendo las ejecuciones y los apagados responsivos. (#4166, #4174, #4169)
- La extracción de PDF de literatura externa recupera solo fragmentos nativos verificados de prosa, matemáticas y tablas, y rechaza leyendas similares y colas de citación. (#4156, #4176)
- El formulario manual Añadir referencia acepta entradas de solo identificador como un PMID, generando un título a partir del primer identificador. (#4150)
- Los controles de exportación de vídeo de investigación permanecen compactos mientras se ejecuta el progreso, y el botón de película ya no muestra fugazmente la acción incorrecta mientras carga su estado. (#4182, #4179)

## 🐛 Bug Fixes

- Los alias de modelos de DeepSeek se enrutan a través de chat completions, corrigiendo los fallos de validación y de ejecución en la ruta Responses. (#4192)
- Los entornos R gestionados de Windows lanzan Rscript con los directorios DLL de Conda activados, corrigiendo las salidas STATUS_DLL_NOT_FOUND. (#4195)
- En Windows con escalado de pantalla, la ventana principal se ajusta al área de trabajo de la pantalla para que la barra de tareas ya no pueda cubrir el área de entrada. (#4200)
- La traducción de PDF de diseño fijo conserva las páginas traducidas de forma independiente cuando una página tiene un diseño no compatible, en lugar de descartar toda la previsualización. (#4186)
- Las comprobaciones de instalación de actualizaciones verifican el paquete de macOS en ejecución antes de informar de installation-busy, nombran los procesos de Windows que mantienen los archivos de la aplicación y resuelven los bloqueos sin bloquear la aplicación. (#4161, #4158, #4153)
- El servicio en segundo plano compartido de macOS se separa del gestor de fallos del escritorio, de modo que un gestor obsoleto ya no retiene archivos ni bloquea actualizaciones. (#4165)
- Los diagnósticos de arranque sobreviven al reinicio automático tras una salida del backend. (#4144)
- La recuperación del runtime de Notebook en Windows comprueba que el árbol de procesos del kernel salió antes de limpiar las barreras de arranque, y las tareas de shell prefieren el Node gestionado por la aplicación frente a shim del host. (#4140, #4142, #4143)
- La limpieza del runtime de Codex resuelve taskkill de forma fiable en entornos de Windows restringidos. (#4199)

## 🙏 Agradecimientos

Gracias a [@daanveer-tech](https://github.com/daanveer-tech) por alinear los detalles de la versión v1.1.0 en los README localizados. ([#4146](https://github.com/aipoch/open-science/pull/4146))
