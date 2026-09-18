## ✨ Lo más destacado

- **Duplica una sesión en una copia nueva y editable.** Una sesión local o importada puede duplicarse con todo su historial de investigación: las ramas de conversación, los registros del Notebook, las versiones de artefactos, la literatura, las anotaciones y los marcadores privados reciben identidades nuevas. La sesión de origen nunca se altera, y las sesiones importadas permanecen de solo lectura. (#2719)
- **Un único nombre de producto: Open-Science.** La aplicación ahora se presenta de forma coherente como Open-Science en la interfaz, la CLI y el empaquetado. Las instalaciones existentes conservan sus nombres y ubicaciones actuales — los datos de investigación, las credenciales y la configuración se mantienen intactos. (#2567)
- **Los planes de sesión sobreviven a la reconstrucción del contexto.** Tras reconstruir su contexto, el agente recupera el plan de sesión activo con su identidad, revisión y aprobaciones pendientes, y las herramientas de plan de sesión permanecen disponibles en la conversación. (#2661)
- **Las conexiones de proveedores se validan antes de guardarse.** Las ediciones de proveedores se prueban y se guardan solo cuando la conexión funciona; cuando un proveedor guardado se rechaza en tiempo de ejecución, su disponibilidad se actualiza en lugar de fallar en silencio. (#2746)

## 🚀 Novedades

- Una tarjeta de información de la sesión en el encabezado de la conversación muestra el número, el título, la descripción, la sesión de origen, las marcas de tiempo y los recuentos de mensajes y artefactos de la sesión, con un control para anclar que mantiene compactos los títulos largos. (#2764)
- Las solicitudes de credenciales de OpenAlex y NCBI enlazan directamente a las páginas oficiales de claves de API. (#2761)
- Las búsquedas de variantes en gnomAD pueden incluir de forma opcional frecuencias alélicas a nivel de población y recuentos de genotipos. (#2741)
- Las sesiones ramificadas en un chat nuevo muestran un separador de "continuado desde" anclado a su turno de origen. (#2747)
- Configuración unifica los títulos de paneles, los encabezados de sección, la confirmación de guardado y la alineación de controles en todos los paneles. (#2739)

## ⚠️ Cambios importantes

- Las redes de STRING expandidas ahora informan del grafo completo devuelto en `nodes`: los vecinos añadidos llevan `is_query=false`, y `n_nodes` ya no coincide con el número de proteínas de entrada. Los scripts del Notebook que trataban `nodes` como asignaciones de entrada deben filtrar por `is_query`. (#2737)

## 🐛 Correcciones

- **Notebook y cómputo** — el R de Windows se ejecuta en modo estándar sin configuración de modo protegido (#2708); los registros de ejecución de artefactos ya no muestran huecos falsos de evidencia de entorno (#2720); los diagnósticos de bloqueo por ejecución se conservan para las comprobaciones de reproducibilidad (#2738).
- **Entorno de ejecución de agentes** — las conversaciones de Codex siguen siendo utilizables al cambiar el esfuerzo de razonamiento (#2724); las órdenes de detención, reanudación y seguimiento en cola que se atascan se resuelven de forma fiable (#2745); las aprobaciones de red canceladas se retiran en lugar de quedar como tarjetas muertas (#2744).
- **Sesiones y permisos** — el progreso de los pasos del plan de sesión permanece visible mientras llegan las actualizaciones de permisos (#2759); la finalización de permisos se concilia con los turnos concurrentes y los reintentos de envío duplicados ya no añaden mensajes no despachados (#2743); los cambios de permisos se permiten antes de la reproducción del historial de ramas (#2736); los separadores de duplicación se anclan al turno copiado (#2733); las cabezas de artefactos sin publicar sobreviven a la duplicación sin bloquear el inicio (#2730).
- **Conectores** — las accesiones secundarias de UniProt se resuelven a sus entradas primarias actuales (#2762); Ensembl resuelve los identificadores de FlyBase, WormBase y la levadura antes de recurrir al símbolo y conserva los errores de solicitud de secuencias (#2715, #2752); las frecuencias de mutación de cBioPortal cuentan las muestras con perfil de gen (#2721); los filtros de elegibilidad de ensayos clínicos respetan los límites de edad y sexo (#2734); la representación de moléculas conserva las cabeceras de molfile y rechaza las estructuras vacías (#2751).
- **Interfaz y almacenamiento** — el modelo personalizado activo se sincroniza al guardar su proveedor (#2712); abrir adjuntos conserva los diálogos padre (#2735); descartar un diálogo ya no parpadea ni restablece el contenido (#2723, #2742); la intención de seguir la transcripción sobrevive a los cambios de diseño (#2732); la limpieza de almacenamiento y las importaciones locales quedan protegidas frente a directorios con enlaces simbólicos y archivos de origen reescritos (#2711); los paquetes de especialistas alinean los valores de importación y los controles de exportación por defecto (#2756); las habilidades de OpenCode de solo lectura se limpian tras la delegación (#2716).
