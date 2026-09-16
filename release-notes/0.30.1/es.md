## ✨ Lo más destacado

- **Revise las actualizaciones de habilidades como un diff real.** Las vistas previas de actualización se muestran a través de un visor de diferencias de código fuente compartido — encabezados de archivo con recuentos de cambios, margen de números de línea, franjas discontinuas rojas para las eliminaciones y franjas verdes sólidas para las adiciones, resaltado de sintaxis opcional y alternativas legibles para parches malformados o demasiado grandes. (#2632)
- **Las conversaciones laterales comienzan como borradores con el modelo adecuado.** Las conversaciones laterales nuevas abren de inmediato un borrador vacío, heredan el modelo y el esfuerzo de razonamiento actuales de la conversación principal, y aplican su propia selección en el siguiente envío; los borradores vacíos que no se tocan se descartan automáticamente. (#2598)
- **Una utilidad de restablecimiento independiente para Windows.** Cuando los datos dañados sobreviven a una reinstalación, una herramienta guiada de línea de comandos enumera los datos resueltos, la configuración, el perfil y las cachés autenticadas de los entornos de ejecución, rechaza los destinos inseguros y elimina solo después de escribir una confirmación exacta — con los entornos de ejecución en marcha bloqueando la limpieza. (#2626)
- **Pequeñas comodidades en todo el espacio de trabajo.** Los selectores de etiquetas y recursos incorporan búsqueda y creación por teclado, la licencia del proyecto se muestra durante la instalación, los paquetes `.science` pueden incluir los PDF de literatura que seleccione, y las vistas previas de ejecución y los botones comparten un mismo lenguaje de movimiento. (#2600, #2591, #2637, #2639)

## 🚀 Novedades

- **Visor de diferencias resaltado y compartido** — reutilizable en toda la aplicación y conectado por primera vez al diálogo de actualización de habilidades, con separadores de contexto omitido traducidos y etiquetas para lectores de pantalla que conservan el significado del cambio. (#2632)
- **Borradores de conversaciones laterales y modelos de conversación** — los borradores con texto o anotaciones sobreviven a la navegación, la intención de proveedor predeterminado sobrevive a los reinicios y a los fallos de reanudación, y el menú de envío ya no parece deshabilitado con el compositor vacío. (#2598)
- **Utilidad independiente de restablecimiento de datos para Windows** — basada en PowerShell y enlazada desde la documentación; valida cada destino antes de eliminarlo, desvincula los enlaces descendentes sin seguirlos, procesa la configuración al final y mantiene los errores visibles. (#2626)
- **Selectores de etiquetas con búsqueda y creación por teclado** en los selectores de recursos (#2600), **presentación de la licencia durante la instalación** (#2591), **PDF de literatura seleccionables en los paquetes `.science`**, una **tarjeta de vista previa de ejecución compartida y animada** (#2637), y **movimiento de botones y retroalimentación de acciones unificados** (#2639).

## 🔧 Mejoras

- Los proveedores incompatibles se sondean en su propia ruta en lugar de perturbar la activa, y las puertas de enlace locales sin clave ya están permitidas. (#2569)
- La aprobación de lectura web se recuerda durante el resto de la conversación en lugar de solicitarse de nuevo. (#2635)
- Las notas de evidencia de PDF aclaran sus limitaciones y diagnostican las fuentes de los marcadores. (#2594)
- El mercado de habilidades resuelve los conflictos de actualización mediante actualizaciones revisadas in situ, y las redirecciones de los activos de versiones de especialistas se siguen de forma segura. (#2615)

## 🐛 Correcciones

- **Sesiones y planes** — el bloqueo de la aprobación del plan de sesión sobrevive a los tiempos de espera de MCP (#2631); las vinculaciones verificadas de artefactos históricos se restauran (#2633); la cancelación de la ejecución de tareas se sincroniza con la admisión de la sesión (#2618); los entornos de ejecución se conservan cuando el inicio de la sesión sigue pendiente (#2620); las conversaciones laterales quedan excluidas del ámbito de exportación de paquetes (#2619) y las instrucciones de las conversaciones laterales de OpenCode ya no se filtran a las conversaciones principales (#2624); las vistas de literatura vuelven a la conversación del proyecto de origen (#2599).
- **Notebook y cómputo** — las ejecuciones en cola y el estado del entorno de ejecución se mantienen coherentes (#2589); los reintentos de limpieza conservan la prueba de terminación nativa (#2623); los directorios PATH heredados inaccesibles se toleran (#2613); las rutas de Linux ya ocultas no se enmascaran de nuevo.
- **PDF y vistas previas** — el análisis bloqueado se recupera y los fallos de extracción se notifican (#2597); los diseños nativos de figuras y tablas se recuperan de nuevo tras una regresión (#2617); las superposiciones de fondo permanecen por debajo de los modales activos. (#2593)
- **Habilidades y conectores** — se corrige la agrupación de residuos por lotes de ESM-2 (#2601); los argumentos de región de gnomAD se validan (#2616) y las compilaciones de referencia se corresponden con los conjuntos de datos (#2596).
- **Plataforma** — las instalaciones de macOS de solo lectura se guían para corregir los permisos antes de actualizar (#2603); las importaciones faltantes de credenciales de Codex respaldadas por archivo se explican en Configuración (#2609); la retroalimentación de la asignación de etiquetas vuelve a ser inmediata (#2610) y el cursor del puntero se mantiene mientras se guarda.
