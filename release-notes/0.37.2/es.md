## ✨ Lo más destacado

- **Se recupera por sí mismo de problemas de tiempo de ejecución.** El arranque repara fallos del backend, de configuración y de red sin reinstalación; los fallos de tiempo de ejecución se aíslan para que la aplicación siga respondiendo; y una desconexión del tiempo de ejecución ya no bloquea la aplicación: Salir permanece disponible y se ofrece una reconexión manual. (#3525, #3414, #3528)
- **Las instantáneas grandes de sesiones y cuadernos se transfieren con fiabilidad**, de modo que restaurar o mover espacios de trabajo pesados ya no se detiene ni falla a mitad de camino. (#3533)

## 🚀 Novedades

- La línea de comandos de Linux ahora también se distribuye como **paquetes .deb y .rpm** independientes junto a los archivos existentes. (#3491)
- Los enlaces del Centro de ayuda y la búsqueda en Configuración se **localizan** junto con el resto de la interfaz. (#3489)

## 🔧 Mejoras

- La interfaz web permanece receptiva bajo una actividad intensa de agentes: las ráfagas de eventos se acotan con una cola de envío compartida, y los lotes de eventos de tiempo de ejecución tienen un límite según su tamaño codificado. (#3530, #3524)
- Los registros del backend redirigidos se compactan, manteniendo pequeñas las carpetas de diagnóstico. (#3535)

## 🐛 Correcciones

- La extracción de estructura de PDF científicos mantiene la titularidad de figuras y tablas con el elemento correcto en más disposiciones de maquetación. (#3537)
- El análisis de dependencias científicas y de linaje de archivos de los cuadernos se robustece frente a evidencia engañosa. (#3511)
- El comportamiento de compresión y reintento del proveedor vuelve a publicarse correctamente desde Configuración. (#3520)
- Las confirmaciones de metadatos de literatura con identidades en conflicto se rechazan en lugar de corromper los registros. (#3518)
- El estado de la literatura se preserva a lo largo de las operaciones asíncronas. (#3504)
- La evidencia de recuperación de trabajos remotos sobrevive a la cancelación y limpieza en los equipos de cálculo. (#3506)
- Se corrigen los metadatos de especies de Bgee. (#3505)
- Los archivos adjuntos de imagen vacíos se señalan claramente en los errores de indicación del agente. (#3513)
- La carga de arranque de la interfaz web se unifica, y los diálogos de recuperación esperan a que el arranque se asiente realmente. (#3488)
- La preparación del primer uso del cuaderno muestra el código que se está recibiendo. (#3487)
- Los subprocesos en segundo plano de Windows ya no hacen parpadear ventanas de consola. (#3519)
