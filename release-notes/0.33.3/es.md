## ✨ Lo más destacado

- **Revisión de documentos paginada.** La vista previa incorpora lectura paginada de Office con controles de búsqueda (#3024) y revisión de PowerPoint por páginas, de modo que los documentos largos y las presentaciones se leen cómodamente dentro de la app. (#2991)
- **Enriquecimiento de conjuntos de genes con Enrichr.** El conector de genes añade herramientas de Enrichr: explora bibliotecas de enriquecimiento y puntúa tu conjunto de genes frente a ellas. (#2996)
- **Vista previa compacta de la biblioteca.** La barra lateral del espacio de trabajo incorpora una vista previa compacta de la biblioteca para exploraciones rápidas sin salir de tu flujo. (#3030)
- **Firma de Windows, completada.** La firma de código ahora cubre todos los ejecutables incluidos, incluidos los runners del tiempo de ejecución del notebook. (#3001, #3011)

## 🚀 Novedades

- Lectura paginada de documentos de Office con controles de búsqueda en el panel de vista previa. (#3024)
- Revisión de PowerPoint por páginas: avanza por las diapositivas página a página con controles de lectura. (#2991)
- Vista previa compacta de la biblioteca en el espacio de trabajo para explorarla de un vistazo. (#3030)
- Enriquecimiento de conjuntos de genes con Enrichr en el conector de genes: lista las bibliotecas disponibles y enriquece un conjunto de genes enviado. (#2996)
- Las colecciones inteligentes de Literature ganan una acción de evaluación abandonada para referencias que ya no necesitan cribado. (#2973)
- Los paquetes de sesión ganan opciones de velocidad de transferencia adaptativa para exportaciones e importaciones. (#2997)
- El progreso de las exportaciones en segundo plano se minimiza, de modo que las transferencias largas no estorban. (#3005)
- Los atajos de escala de la interfaz se unifican en un único esquema coherente. (#3018)
- Las sugerencias al pasar el cursor y el movimiento de las burbujas se unifican en toda la interfaz. (#3010)
- La llegada de nuevos mensajes se anima en el centro de mensajes. (#3025)
- La navegación de mensajes recibe una onda densa y continua al pasar el cursor para un escaneo más fluido. (#3004)

## 🔧 Mejoras

- La firma de código de Windows ahora cubre todos los ejecutables incluidos, incluidos los runners del tiempo de ejecución del notebook firmados que se verifican al inicio. (#3001, #3011)

## 🐛 Correcciones

- **Vista previa e interfaz** — el tamaño de fuente de la pestaña de lectura de PDF coincide con la cabecera del archivo (#3036); aparecen tooltips en los iconos de la barra lateral contraída (#3017); las zonas de interacción de las filas se alinean con sus superficies de hover (#3013); el movimiento de entrada de las burbujas se omite durante los cambios de hover cálidos (#3032).
- **Notebook** — las barreras de recuperación de kernel se aíslan por carril, de modo que la recuperación de un kernel nunca bloquea a otro (#3031).
- **Sesiones y recuperación** — los guardados de conversación se posponen mientras las ejecuciones están activas (#3012); los reintentos fallidos siguen siendo recuperables y descartables (#3019); los avisos de error de ejecución se pueden descartar (#3002); la puerta de recuperación del archivo se limita a los proyectos afectados (#3023); las exportaciones de diagnóstico renombradas reciben un sufijo de archivo (#3022).
- **Conectores y literature** — el acceso nativo a archivos respeta las carpetas concedidas (#3021); los resúmenes de Crossref se importan durante la finalización de metadatos (#3020); la clasificación selecciona el primer modelo para ambas funciones (#3006).
