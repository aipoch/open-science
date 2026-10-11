## ✨ Lo más destacado

- **Fidelidad de PDF restaurada.** La extracción de estructura conserva las figuras completas con sus títulos y leyendas, reconstruye tablas con filetes que se sitúan junto a fórmulas sin rechazarlas, y preserva la atribución nativa de las regiones de figura, los registros de tabla y el texto con origen. (#3456, #3465)
- **Una experiencia en Windows más tranquila y robusta.** La CLI de escritorio funciona desde rutas de instalación no ASCII, la traducción de PDF admite rutas de unidad de Windows, y los kernels de Notebook y la captura de entornos ya no abren ventanas de consola. (#3457, #3460)

## 🔧 Mejoras

- Los instaladores de escritorio y el tiempo de ejecución independiente eliminan componentes no usados — dependencias empaquetadas duplicadas, recursos de tiempo de ejecución del modelo y tokenizador sin uso y bibliotecas de plataforma que la aplicación nunca carga —, revirtiendo el crecimiento de tamaño introducido por la separación del backend en v0.37.0 (#3451, #3470)

## 🐛 Correcciones

- Una referencia de panel con espacios en el texto en ejecución ya no divide una figura en recortes ráster y vectoriales independientes, y el relleno del detector bajo el filete de cierre de una tabla ya no hace que se rechace la tabla completa como fórmula dañada (#3465)
- La extracción nativa de PDF mantiene la titularidad del título y los gráficos con el elemento correcto, recupera registros de tabla de límites independientes con encabezados agrupados y grupos de filas, y conserva las referencias de origen de las celdas y el texto enriquecido (#3456)
- La CLI de escritorio ya no malinterpreta su lanzador bajo páginas de códigos heredadas cuando la ruta de instalación contiene caracteres chinos, y preserva la página de códigos del llamador y el código de salida (#3457)
- La traducción local de PDF en Windows ya no falla con una URL de módulo no admitida cuando los recursos WASM residen en una ruta de unidad (#3457)
- Los kernels de Notebook, la huella de entorno, el inventario de paquetes y la captura de bloqueos ya no muestran una ventana de consola ni Windows Terminal durante la ejecución (#3460)
