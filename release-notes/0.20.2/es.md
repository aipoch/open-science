## ✨ Lo más destacado

- **Interfaz en español.** La interfaz completa — el asistente de configuración inicial, los ajustes, las superficies de conversación, los diálogos nativos y las notas de la versión — ya está disponible en español, y se suma a los siete idiomas existentes con un selector de idioma en tiempo de ejecución en los ajustes. (#1771)
- **Vistas previas de fuentes dentro de la app.** Los enlaces de las respuestas del agente se abren en una vista previa aislada dentro de la aplicación: al pasar el cursor se revelan el título de la fuente y la URL completa, y un clic carga la página en el panel lateral con un indicador de progreso, sin salir de su espacio de trabajo. (#1524)
- **Variables de Notebook en vivo.** Una nueva vista de Variables inspecciona el espacio de nombres de Python o R en ejecución — nombres, tipos, formas y vistas previas — en modo de solo lectura, actualizada tras cada ejecución, sin iniciar un kernel solo para explorar. (#1748)
- **Vistas previas de sesión al pasar el cursor.** Al pasar el cursor o enfocar una sesión en la barra lateral se muestran su título y descripción, y los títulos desbordados se desplazan para que los nombres largos sigan siendo distinguibles. (#1775)

## 🚀 Novedades

- **Localización al español** — catálogos completos (común, nativo y del renderizador) en un español internacional neutro, mensajes nativos de Electron, formato de fechas y documentación localizada. (#1771, #1780)
- **Vistas previas de fuentes dentro de la app** — los enlaces HTTPS de las respuestas del agente se convierten en enlaces de origen nativos con una ventana emergente interactiva, carga aislada en el panel con un indicador de progreso en la barra de herramientas, un acceso directo al navegador externo, navegación con teclado y conservación de la URL completa. (#1524)
- **Explorador de espacio de nombres en vivo** — una vista de Variables de segundo nivel para los kernels de Notebook, con filtrado, alternancia de nombres privados, actualización manual y estados de obsoleto/actualizando/no disponible; las instantáneas están acotadas y nunca se conservan. (#1748)
- **Vistas previas de sesión al pasar el cursor** — vista previa inmediata del título y la descripción al pasar el cursor o enfocar con el teclado, con respeto por las preferencias de movimiento reducido y disponible solo en escritorio. (#1775, #1796, #1797)
- **Menú contextual de las pestañas de vista previa** — Cerrar, Cerrar las demás, además de Descargar, Copiar la ruta y Guardar como artefacto según el contexto, anclado al puntero sin activar la pestaña. (#1764)
- **Tarjetas de aclaración con revisión por pregunta** — las tarjetas de preguntas respondidas u omitidas se convierten en registros compactos cuyas respuestas se expanden para revisar las preguntas originales, con recuentos de selección exactos y controles más compactos. (#1772)
- **Nuevos proveedores y modelos** — OpenCode Go y OpenCode Zen como proveedores integrados con clave de API, y GLM-5.3-Flash junto a GLM-4.5-Air y GLM-5.3 para Zhipu AI (GLM). (#1763, #1790, #1762, #1766)

## 🔧 Mejoras

- El renderizado de conversaciones carga los entornos de ejecución de Mermaid y de resaltado de código solo cuando un mensaje realmente los contiene, lo que acelera el arranque del renderizador. (#1789)
- Las sesiones de larga duración se guardan con una frecuencia acotada en lugar de una escritura por cada fotograma, eliminando una presión sostenida de CPU, memoria y disco en sesiones grandes. (#1779)
- El pie de la respuesta etiqueta su resumen de solicitudes al modelo como llamadas, en consonancia con la vista de la ventana de contexto. (#1781)
- Archivar un proyecto ahora espera el trabajo de revisión activo y los trabajos de cómputo remoto no terminados, y pone en pausa la cola de mensajes hasta que el proyecto se restaure. (#1785)
- Los resúmenes largos de los planes se limitan a tres líneas con revelación al pasar el cursor, y la vista previa del plan conserva su posición de desplazamiento entre las actualizaciones de progreso en streaming. (#1783)

## 🐛 Correcciones

- **Sesiones** — las aprobaciones de permisos ya no colisionan con la generación del título y la descripción; se conservan ambas en lugar de mostrar una alerta de persistencia. (#1768)
- **Sesiones** — las sesiones interrumpidas se reanudan conservando el fallo autoritativo cuando los proveedores informan errores estructurados, en lugar de restablecer el contexto en silencio. (#1774)
- **Proyectos** — el contexto de agente del proyecto configurado se aplica de forma coherente: los fallos de búsqueda cierran de manera segura y las ediciones del contexto se aplican a las sesiones inactivas antes del siguiente mensaje. (#1786)
- **Archivos del proyecto** — los cambios de permisos de una carpeta concedida que fallan ahora muestran una explicación reintentable en lugar de conservar en silencio el permiso anterior. (#1793)
- **Notebook** — las solicitudes RPC locales se validan estrictamente por método, rechazando parámetros malformados antes de la ejecución. (#1794)
- **Vistas previas de sesión** — las vistas previas al pasar el cursor se cierran de inmediato y siguen funcionando tras los cambios del puente del puntero. (#1796, #1797)
