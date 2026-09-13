# Presupuesto App — versión web (GitHub Pages)

Versión estática (HTML/CSS/JS puro, sin Streamlit ni backend) de
[presupuesto-app](https://github.com/JuanMaRobledo/presupuesto-app). Corre
enteramente en el navegador: quien la abre inicia sesión con su propia cuenta
de Google y el navegador lee (y, en Declaraciones de Renta, también escribe)
el Google Sheet directamente vía la API de Sheets — no hay servidor, no hay
cuenta de servicio, no hay ninguna llave guardada en el código. El PDF de
cada declaración se sube directo a Google Drive con esa misma sesión (queda
de tu propiedad, la app nunca lo aloja).

La carpeta `streamlit-app-original/` es una copia congelada de la app de
Streamlit (para no perder ese trabajo) — no se usa para nada acá, es solo
referencia/backup. La versión de Streamlit sigue viva y desplegada en
[presupuesto-app-jmr.streamlit.app](https://presupuesto-app-jmr.streamlit.app).

`index.html` es una portada simple con dos tarjetas para elegir entre esta
versión (`app.html`, la app en sí) y la de Streamlit — la URL raíz de
GitHub Pages abre esa portada.

## Estado de la migración

✅ Portado:
- Login con Google (OAuth del lado del navegador, sin backend)
- 📲 Instalable como app propia (PWA) — en computador, Chrome/Edge ofrecen
  "Instalar Presupuesto App" (ícono propio, ventana propia sin barra del
  navegador — la definición de "app de escritorio autónoma" que da un PWA,
  sin necesitar un proyecto de Electron/Tauri aparte); en celular, "Agregar
  a pantalla de inicio" hace lo mismo (Android e iOS, cada uno con su
  splash/ícono). `manifest.json` + `sw.js` (service worker mínimo, cachea
  el shell propio con network-first + fallback a caché — los DATOS siempre
  van en vivo a la API de Sheets, nunca se cachean) + `icons/` — nada de
  esto pide un scope de Google nuevo.
- 💾 Copia de seguridad — botón siempre visible en la barra lateral (no hace
  falta entrar a ninguna página puntual): descarga TODAS las hojas del
  Sheet, tal como están hoy, en un solo archivo `.xlsx` armado del lado del
  navegador con [SheetJS](https://sheetjs.com/) — sin backend ni scope
  nuevo (el mismo scope `spreadsheets` que ya usa el resto de la app
  alcanza para listar y leer todas las hojas, no solo los rangos con
  nombre que usa cada página).
- 🏠 Resumen — **completo**: Ingresos, Gastos, Balance (con tasa de ahorro
  discriminada por origen — efectivo/ahorro/inversión, incluyendo el cruce
  de cada movimiento "Inversiones" contra la plataforma real y el neteo de
  retiros), Deudas e Inversiones (estado actual), con el selector Total
  histórico / Un año / Un mes, y al pie "📊 Tendencia de los últimos meses"
  (vista efectivo real, leyendo la hoja 'Resumen Mensual'). Verificado con
  casos de prueba calculados a mano y comparados contra la lógica de
  `_ingresos_gastos_periodo()` / `read_resumen_mensual()`.
- 💳 Egresos — **completo, con escritura**: tabla de Efectivo/Visa/Mastercard
  (sub-tabs), con búsqueda, filtro de categoría/año/mes, "ocultar no
  presupuestar", y para las tarjetas el toggle Consumo (mes de compra) /
  Efectivo real (mes de pago, con el corrimiento de mes al corte
  correspondiente). Incluye los gráficos de tendencia por período y gasto
  por categoría y mes (Chart.js), el sub-tab de solo lectura "📊 Tendencia
  por Tarjeta" (Visa vs. Mastercard período a período), "➕ Agregar un
  gasto en efectivo manualmente", y para Visa/Mastercard "🛠️ Gestionar
  extractos y compras" (agregar el resumen de un corte nuevo — rechaza
  duplicar un período ya cargado —, agregar una compra suelta en COP o USD,
  y eliminar un extracto completo con confirmación), "🔍 Ver un extracto
  puntual" (cupo/saldo/pago del corte + sus compras, igual que elegir un
  mes en Colillas de Pago) y el detalle de compras en USD de Mastercard.
  Todas las escrituras usan el mismo truco de `as_text()` — un apóstrofe
  adelante — para que Sheets no reinterprete "2026-07" como fecha ni "1/1"
  como fracción.
- 🏦 Deudas — **con escritura**: tarjetas de saldo total/cuota mensual, deuda
  de Mastercard en dólares aparte, torta de participación por entidad,
  tabla completa y gráfico de cuota mensual por entidad, más el formulario
  "✏️ Actualizar deudas manualmente" (4 tabs, uno por crédito con cuota
  fija — Bancolombia, Sufi, Scotiabank y Fondo de Empleados; ninguno tiene
  extracto automático). Los campos numéricos en 0 y el N° de Obligación
  vacío no se guardan, para no pisar lo que ya había con un cero — mismo
  comportamiento que `_form_actualizar_deuda()`.
- 📈 Inversiones — aportes/retiros en pesos y dólares (métricas + tabla),
  depósitos y retiros por plataforma, capital neto transferido en el
  tiempo, posiciones (cantidad, precio, valor de mercado, ganancia/
  pérdida) de cada moneda, "🌎 Patrimonio total en inversiones" (pesos +
  dólares convertidos a COP con la TRM), "📊 Crecimiento y Rentabilidad"
  por moneda (valor de cartera vs. aportes netos en el tiempo, XIRR
  anualizado, y "📈 Comparación contra el benchmark" — COLCAP para pesos,
  S&P 500 para dólares), y el "Historial de posiciones y cuenta de margen"
  importado del broker: resumen agrupado por Plataforma/Activo/Moneda con
  Estado (abierta larga/corta o cerrada) y Estrategia (Largo/Corto),
  resultado realizado por posición y acumulado en el tiempo (con
  gráficos), el detalle completo de compras/ventas/cortos/coberturas, y
  Dividendos e intereses recibidos aparte. La TRM, los precios de cada
  posición y el valor "shadow" del benchmark vienen de Yahoo Finance —
  imposible de consultar desde el navegador por CORS — así que los calcula
  un GitHub Action programado (ver "Actualizar precios de mercado (Yahoo
  Finance)" más abajo) y esta página solo lee lo que ese Action ya dejó
  escrito en el Sheet, con degradación explícita si todavía no corrió ni
  una vez. Posiciones se separa en 3 grupos, no solo inversión/liquidez:
  **Acciones** (Tipo Acción/ETF/Cripto/Otro), **Fondos de Inversión** (Tipo
  "Fondo de Inversión" o "Fondo (liquidez)" — p. ej. "Trii - Cuenta
  Dinámica", que SÍ tiene retorno de mercado pese al nombre del Tipo) y
  **Efectivo, margen y cuentas de liquidez** (Tipo "Fiducuenta" o un ticker
  terminado en " - Efectivo/Margen" — sin retorno de mercado). Los 3 se
  muestran separados en todos lados: Posiciones (una tabla por grupo, con
  sus propias métricas de Costo/Valor/Ganancia), Patrimonio unificado
  (desglose Acciones vs. Fondos de Inversión en COP, más el bloque aparte
  de liquidez), y Liquidez no cuenta para XIRR/Rentabilidad/Comparación
  contra benchmark. Tanto la tabla de "Depósitos y retiros" de arriba de
  todo como "🎛️ Rentabilidad personalizada" tienen una casilla por cuenta
  (Acciones y Valores, Trii, Fiducuenta, Plenti, Binance, Hapi, Interactive
  Brokers, y el efectivo/margen de cada broker aparte de sus acciones —
  p. ej. "Interactive Brokers - Efectivo/Margen" es una cuenta propia,
  distinta de "Interactive Brokers"): marcar/desmarcar recalcula la tabla y
  el resumen Depósitos/Retiros/Flujo neto, o la rentabilidad/XIRR, al
  vuelo, sin volver a pedirle nada al Sheet. El valor de cada cuenta se
  calcula del lado del cliente a partir del TickerFondo de cada posición
  (Posiciones no tiene columna Plataforma propia), y un aporte/retiro se
  cuenta completo por la plataforma a la que fue destinado — no se puede
  partir entre el tipo de activo que compró esa plataforma con esa plata.
  Por defecto, Rentabilidad personalizada viene marcada con todo lo que
  tiene retorno de mercado (ni Fiducuenta ni el efectivo/margen del
  broker), mismo resultado que la vieja métrica fija que reemplaza. Como
  siempre, se oculta el % (con un aviso explicando por qué) si los retiros
  de la selección superan los depósitos, para no dividir por un neto
  negativo y mostrar un porcentaje sin sentido (el caso real que motivó
  esto daba "-768%"). Fiducuenta
  (Fiducuenta *5601, un fondo de inversión colectiva de Bancolombia usado
  como reserva de impuestos, no una posición de bolsa) tiene además su
  propia "Rentabilidad de Fiducuenta (reserva impuestos)" fija (más su
  XIRR, que sigue dando un número interpretable aunque los retiros superen
  los aportes, a diferencia de la rentabilidad simple) — calculada solo con
  los aportes/retiros de esa plataforma (reconstruidos y verificados mes a
  mes contra los extractos oficiales de Bancolombia de nov-2024 a
  ago-2026), en el bloque de liquidez de Posiciones. Además de las métricas
  separadas, hay una sección "🔗 Consolidado (acciones + fondos +
  Fiducuenta)" que sí junta el valor y los aportes de todo para quien
  quiera ver el rendimiento total en pesos en un solo número (con su propio
  aviso si el neto combinado da negativo). "Historial de posiciones y
  cuenta de margen" ya tiene escritura: "💵 Agregar un dividendo o interés
  recibido" (con el mismo rechazo de duplicado por fecha/plataforma/
  activo/tipo que `agregar_historial_inversion()`) y "✏️ Editar o eliminar
  operaciones del historial" — tabla editable con agregar/quitar fila,
  igual que `_form_editar_historial()`; como esa hoja crece por filas en
  vez de ser un bloque reservado, "guardar" limpia todo el rango y lo
  reescribe desde cero con lo que quede en la tabla. "📥 Importar
  portafolios y conciliar flujos con la cuenta 1031" (`js/pages/
  importar-portafolio.js`) admite CSV de Hapi, Binance, Interactive Brokers
  (reporte de portafolio) y Acciones y Valores/Trii — subís uno o varios a
  la vez, reconstruye posiciones abiertas/cortas/cerradas con costo
  promedio (mismo algoritmo BUY/SELL/SHORT/COVER que
  `resumen_operaciones_inversion()`, incluida la venta parcial con costo
  promedio ponderado), y concilia cada depósito/retiro contra "Egresos -
  Efectivo" y "Otros Ingresos" (mismo emparejamiento por fecha ±7 días,
  palabras clave por plataforma y tolerancia de tasa de cambio 2.500-5.500
  que `_cruzar_flujos_1031()`) antes de guardar. "💾 Guardar" combina las
  posiciones nuevas con las existentes de la misma moneda (reemplazando
  solo los prefijos de plataforma recién importados, sin tocar Costo Total/
  Valor Actual/Ganancia-Pérdida que son fórmulas del Sheet), agrega los
  flujos conciliados a Aportes y las operaciones nuevas al Historial (con
  la misma deduplicación económica que ya usan "Agregar un dividendo" y
  "Editar historial" de arriba, así que volver a subir el mismo reporte no
  duplica nada), y recategoriza a "Inversiones" los pagos PSE que financian
  estas plataformas (mismo mapeo que `recategorizar_comercios()`, para no
  contarlos dos veces como gasto genérico). **Ojo:** a diferencia de
  Streamlit, todavía NO admite el PDF "Transaction History" de Interactive
  Brokers — Python lo lee con `pdfplumber.extract_tables()`, que ubica
  columnas por las líneas/espacios reales del PDF; pdf.js (ya usado acá
  para las colillas de pago) solo da texto posicionado, no tablas, y sin un
  extracto de ejemplo para validar un parser hecho a mano el riesgo de
  reconstruir mal una cantidad/precio y guardar un monto financiero
  incorrecto es demasiado alto — para ese caso puntual seguí usando la
  versión de Streamlit. Además, "✏️ Editar posiciones a mano" (dentro de
  cada pestaña Pesos/Dólares) es una tabla editable — Ticker/Fondo, Tipo,
  Cantidad, Precio Compra Promedio, Precio Actual, con Costo Total/Valor
  Actual/Ganancia-Pérdida recalculados en vivo del lado del cliente para
  mostrarlos mientras se edita (son fórmulas del Sheet, nunca se escriben)
  — agregar/quitar fila con un botón, mismo puerto de
  `set_posiciones_inversion()` que ya usa "Importar portafolios" al
  combinar posiciones nuevas con las existentes: "Guardar" reemplaza TODAS
  las posiciones de esa moneda con lo que quede en la tabla.
- 💰 Ingresos — **completo, con escritura**: sub-tabs Colillas de Pago
  (resumen histórico, tendencia por quincena, y el detalle devengos/
  descuentos tanto general como filtrado a un mes puntual, quincena por
  quincena, más "➕ Agregar una quincena manualmente" — con una tabla
  editable de filas de devengos/descuentos, agregar/quitar fila con un
  botón, categoría por desplegable — y "🗑️ Eliminar una quincena", ambas
  con confirmación/rechazo de duplicado igual que el original) y Otros
  Ingresos (búsqueda, filtros, "ocultar no presupuestar", agrupamiento de
  Rendimientos Financieros por mes, total por categoría y gráfico, más
  agregar un ingreso a mano y eliminar una fila puntual — mismo match
  exacto Fecha/Concepto/Categoría/Valor que `eliminar_otro_ingreso()`).
- 📤 Cargar Extractos — **con escritura, los tres uploaders de Streamlit**:
  subí una o varias colillas de pago del Hospital Pablo Tobón Uribe (PDF),
  extractos/detalle de transacciones de la cuenta de ahorros (.xlsx) o
  extractos detallados de la Visa/Mastercard (.xlsx, en cualquiera de los
  dos formatos de Bancolombia) directo desde el navegador — sin backend: el
  PDF se lee con [pdf.js](https://mozilla.github.io/pdf.js/) y el .xlsx con
  [SheetJS](https://sheetjs.com/), ambos cargados desde CDN. Categoriza cada
  movimiento/compra solo (mismas tablas `CONCEPTOS`/`CUENTA_CATEGORY_INGRESO`/
  `CUENTA_CATEGORY_EGRESO`/`MERCHANT_CATEGORY` que Streamlit, puerto en
  `js/parsers/colillas.js`, `js/parsers/cuenta.js` y `js/parsers/tarjeta.js`),
  detecta aportes a Acciones y Valores/Trii/Plenti/Binance/Hapi/Interactive
  Brokers en el extracto de cuenta y los registra también en Inversiones, y
  muestra una vista previa de solo lectura (nuevo/repetido en esta subida/ya
  cargado, con la misma deduplicación que `marcar_novedad_movimientos()` para
  cuenta y por período+moneda para tarjeta) antes de escribir nada. Para
  tarjeta, el resumen del corte se escribe por tramos de columnas (igual que
  `write_row_segments()`, ya que hay columnas de fórmula intercaladas) y el
  detalle de movimientos se agrega al final del bloque.
- 🧾 Facturación Electrónica — **con escritura**: registro año a año, con
  resumen por año, búsqueda por emisor, filtros de año/mes, el link
  "Correo" al mail original en Gmail para las facturas de la carga
  histórica, y un formulario para agregar una factura a mano (rechaza
  duplicados por NIT Emisor + Número de Documento).
- 📑 Declaraciones de Renta — **con escritura**: tabla + gráfico de
  Patrimonio Líquido/Impuesto a Cargo por año, y un formulario que sube el
  PDF directo a tu Google Drive (o aceptá pegar un link a mano) y guarda el
  registro en el Sheet — guardar el mismo Año reemplaza esa fila, igual que
  `guardar_declaracion_renta()`. Es la primera sección con escritura del
  sitio: necesita el scope completo de Sheets + `drive.file` (ver más
  abajo).
- 📈 Informe de Inversiones — **completo**: informe ejecutivo de lectura
  corrida (a diferencia de las herramientas interactivas de 📈 Inversiones)
  — retorno bruto, capital propio (descuenta el margen/efectivo de ambos
  lados), XIRR y TWR por moneda, mejor/peor posición, composición y G/P%
  por posición (gráficos), capital aportado por plataforma, operaciones
  cerradas (tasa de acierto, resultado realizado) y, en dólares, "💱 Efecto
  cambiario de los aportes (TRM)" (cuánto ganaste/perdiste solo por el tipo
  de cambio, aparte del rendimiento de las posiciones, más el "Retorno
  combinado en pesos"). El TWR en dólares y el efecto cambiario necesitan
  la TRM histórica día a día (convertir cada aporte en pesos a su
  equivalente en dólares de la fecha exacta de esa transferencia) — un
  sitio estático no puede descargarla de Yahoo Finance (CORS), así que
  `scripts/actualizar_mercado.py` la trae server-side y la deja en la hoja
  nueva `'Historial TRM (Auto)'` (serie diaria desde el aporte en dólares
  más antiguo, se reescribe completa en cada corrida). Si esa hoja todavía
  no existe (Action nunca corrió con este cambio, o nunca hubo un aporte
  en dólares que la dispare), esas dos métricas puntuales quedan en "—"
  con un aviso explicando por qué, sin romper el resto del informe — el
  TWR en pesos nunca tuvo este problema (los aportes ya están en COP, no
  necesitan conversión).
- 📊 Informe de Presupuesto, Ingresos y Gastos — **completo**: informe
  ejecutivo que junta en un solo lugar lo que hoy está repartido entre
  Resumen/Análisis/Presupuesto — ingresos/gastos del alcance elegido (Total
  histórico/Un año/Un mes), tasa de ahorro discriminada por origen, gasto
  por categoría, esencial vs. no esencial, evolución de los últimos 12
  meses (efectivo real) y presupuesto vs. real del mes seleccionado en 📋
  Presupuesto. Reusa `IngresosGastosPeriodo.calcular()` (la misma pieza
  central que ya usan Resumen y Estados Financieros) en vez de duplicar la
  categorización de gasto real.
- 📊 Análisis — **completo** (6 sub-tabs, con escritura en Balance Mensual):
  **Categorías** (gasto real histórico por categoría, gráfico + tabla),
  **Esenciales / No Esenciales** (gasto de consumo real en pesos
  clasificado con `clasificar_esencial()` — la hoja 'Categorías Esenciales'
  tiene prioridad sobre la clasificación por defecto —, con gráfico de
  torta, detalle por categoría y aviso de categorías sin clasificar
  todavía), **Evolución** (tendencia mes a mes de las 5 métricas de
  'Resumen Mensual' — Ingresos ganados/Gastos personales/Deudas y
  obligaciones/Ahorro e inversiones/Disponible del mes —, filtro de año,
  gráfico de líneas y tabla), **Año vs. Año** (compara el mismo mes entre
  distintos años elegidos a mano, con selector de métrica y tabla de
  totales + variación % año contra año), **Movimientos** (vista unificada
  devengado de las 7 fuentes: colillas devengo/descuento, Visa, Mastercard
  COP/USD, Cuenta de ahorros y Otros Ingresos, con búsqueda/filtros y top
  categorías de gasto), y **Balance Mensual** — **con escritura**: mueve el
  selector de mes de la hoja 'Balance Mensual' (mismo protocolo
  write-then-read que Presupuesto) y lee sus 4 métricas + 3 tablas ya
  calculadas por las fórmulas de la hoja, con el toggle Efectivo real (mes
  en que se paga) / Consumo (mes en que se compra, recalculado del lado
  del cliente por `Fecha Compra`).
- 🏢 Estados Financieros — **completo, con escritura**: sub-tabs Estado de
  Resultados (Ingresos − Gastos operativos = Utilidad Neta, con desglose
  por categoría de ambos lados, mismo selector Total histórico/Un año/Un
  mes que Resumen), Balance General (Activos − Pasivos = Patrimonio Neto,
  foto de hoy — y "Patrimonio Neto en el tiempo": guarda una foto de
  Activos/Pasivos/Patrimonio Neto cada vez que se abre esta pantalla, con
  upsert por fecha en una hoja nueva "Historial de Patrimonio Neto" que se
  crea sola la primera vez (mismo protocolo que el snapshot de valor de
  cartera de 📈 Inversiones, pero disparado al VER la pantalla en vez de al
  guardar algo, porque acá no hay ninguna acción de guardado que lo
  dispare sola); el gráfico de tendencia aparece recién con 2+ fotos, y no
  es retroactivo — arranca desde la primera vez que se abrió la pantalla
  después de este cambio), Flujo de Efectivo (Saldo Inicial + Operación + Inversión +
  Financiación + Conciliación = Saldo Final Calculado de un mes puntual,
  con "💾 Guardar saldos de este mes" — mismo protocolo upsert-por-clave
  que `guardar_conciliacion_efectivo()` — y "🔎 Ver desglose del mes"
  línea por línea) y Auditoría Anual (lo mismo acumulado para un año
  completo, comparado contra el saldo real de diciembre, con "Ver detalle
  mes a mes"). Las cuatro comparten la lógica de cálculo vía
  `js/ingresos-gastos.js`, incluyendo la deduplicación por Notas de
  Financiación/Conciliación (`ya contabilizad...`/`no duplicar` — evita
  contar dos veces el pago automático de tarjeta o la nómina, que ya
  están en Operación por otro camino) y el encadenado de saldo inicial
  desde el último saldo real guardado cuando falta el del mes anterior.
- ✅ Verificar Datos — **completo, con escritura**: chequeo de tranquilidad,
  no algo que haga falta usar seguido — compara lo cargado contra los
  extractos reales del banco/tarjetas. Tarjetas de crédito (resumen Visa/
  Mastercard en COP, y Mastercard en USD aparte) es de solo lectura;
  Efectivo (cuenta de ahorros) sí escribe: el saldo inicial/final de cada
  mes se carga a mano (el extracto no lo trae) para conciliar contra lo ya
  cargado (saldo inicial + ingresos − egresos) — mismo protocolo upsert-
  por-clave que ya usa Estados Financieros → Flujo de Efectivo
  (`guardar_conciliacion_efectivo()`, misma hoja/clave "Mes", reutilizado
  literalmente), con histórico de conciliación mes a mes.
- 🔍 Salud de los Datos — **completo, con escritura**: chequeos automáticos
  DENTRO de los datos ya cargados (a diferencia de Verificar Datos, que
  compara contra el banco) — quincenas duplicadas y comprobantes faltantes
  en Colillas de Pago (lectura), Primas y Cesantías mal etiquetadas como
  quincena con corrección automática de un clic
  (`corregir_prima_mal_etiquetada()`/`corregir_cesantias_mal_etiquetada()` —
  relabels el período conservando los valores, y para Cesantías además
  manda los intereses a Otros Ingresos si los hay), recategorización en
  bloque de gasto sin categorizar/cualquier comercio
  (`recategorizar_comercios()`) y de Otros Ingresos
  (`recategorizar_conceptos_ingreso()`), y detección de categoría
  inconsistente por comercio/concepto (lectura).
- 📋 Presupuesto — **completo, con escritura**: metas mensuales por
  categoría de gasto y por descuento de nómina, comparadas contra el
  gasto real (que calculan las fórmulas de la propia hoja 'Presupuesto' —
  la página escribe el mes elegido en la celda selectora B5 antes de leer,
  mismo protocolo que `set_presupuesto_mes()` + `read_presupuesto()`), con
  "disponible" en vivo al escribir una meta, el gráfico de comparación, y
  "💡 Sugerir metas según el promedio de los últimos meses con datos"
  (mismo criterio "efectivo real" que la columna 'Gasto Real' — el
  efectivo cuenta en su propio mes, las tarjetas en el mes siguiente al
  extracto; solo sugiere sobre categorías con al menos un mes de los
  últimos 3 con gasto > 0, redondeado al millar más cercano).

⏳ Todavía no portado (usá la versión de Streamlit mientras tanto):
- Dentro de Inversiones: importar el PDF "Transaction History" de
  Interactive Brokers — importar CSV (Hapi/Binance/IBKR/Acciones y
  Valores), conciliar contra la cuenta 1031, patrimonio unificado,
  actualizar precios, Crecimiento y Rentabilidad, agregar un dividendo/
  interés manual y editar el historial de operaciones ya están portados,
  ver más arriba.

Todo lo demás de la app, incluyendo el gráfico de "Tendencia de los últimos
meses" de Resumen y Evolución/Año vs. Año de Análisis (las tres leen la hoja
'Resumen Mensual' — se confirmó el orden real de columnas contra el Sheet
antes de portarlas: `Mes | Ingresos ganados | Gastos personales | Deudas y
obligaciones | Ahorro e inversiones | Disponible del mes`) y lo que dependía
de Yahoo Finance, ya está portado. Solo quedan formularios de escritura
puntuales dentro de Inversiones.

## Actualizar precios de mercado (Yahoo Finance)

La TRM, los precios de cada posición y el valor "shadow" de cada benchmark
(cuánto valdrían hoy los mismos aportes puestos en el benchmark en vez de en
la cartera real) vienen de Yahoo Finance — un sitio 100% estático no puede
consultarlo desde el navegador porque Yahoo no habilita ese origen para JS
de terceros (CORS). En vez de eso, un **GitHub Action programado**
(`.github/workflows/actualizar-mercado.yml`, corre
`scripts/actualizar_mercado.py`) lo hace del lado del servidor — sin esa
restricción — y deja los resultados escritos directo en el Sheet:

- Columna "Precio Actual" de cada posición en `Inversiones - Pesos` /
  `Inversiones - Dólares`.
- Un snapshot diario del valor de cartera por moneda, en la hoja
  `Historial de Valor de Cartera` (la crea sola si no existe).
- La TRM y el valor shadow de cada benchmark (COLCAP para pesos, S&P 500
  para dólares), en la hoja `Datos de Mercado (Auto)` (también se crea
  sola).

Esta página web solo **lee** esas tres hojas ya calculadas — nunca llama a
Yahoo Finance. Si el Action todavía no corrió ni una vez, esas dos hojas
nuevas no existen todavía: Inversiones lo detecta y muestra un aviso en vez
de romperse (patrimonio unificado sin unificar, Crecimiento y Rentabilidad
"todavía no hay historial").

**Configuración de una sola vez** (para que el Action pueda escribir en tu
Sheet):

1. El Action usa la **misma cuenta de servicio de Google** que ya usa
   `presupuesto-app` (la de Streamlit) — mismo Sheet, mismo scope de solo
   Sheets. Si no la tenés a mano, es el archivo JSON que descargaste al
   crear esa cuenta de servicio en Google Cloud Console (o `st.secrets`
   `[gcp_service_account]` de tu `secrets.toml` de Streamlit).
2. En este repo (`presupuesto-app-web`): **Settings → Secrets and
   variables → Actions → New repository secret**.
3. Nombre: `GOOGLE_SERVICE_ACCOUNT_JSON`. Valor: pegá el contenido
   **completo** del JSON de la cuenta de servicio (todo el archivo, tal
   cual). Create secret.
4. Listo — el Action corre solo, de lunes a viernes a las 22:00 UTC (después
   del cierre de la bolsa de Colombia y de EE. UU.; ajustá el `cron` en el
   workflow si querés otra frecuencia). También podés correrlo a mano desde
   **Actions → Actualizar datos de mercado → Run workflow** para no esperar
   al próximo horario programado.

Esa credencial **nunca** llega al navegador ni se guarda en el repo — vive
solo como secret de GitHub, la lee el runner del Action en tiempo de
ejecución. Es la misma separación que ya describe la sección de arriba:
Client ID de OAuth (público, vive en el código) vs. cuenta de servicio
(secreta, nunca en el navegador).

## Cómo probarlo en local

```bash
python3 -m http.server 8000
# abrí http://localhost:8000
```

Necesitás haber configurado el Client ID de Google primero (ver abajo) y
haber agregado `http://localhost:8000` como origen autorizado.

## Publicarlo en GitHub Pages

1. En este repo: **Settings → Pages → Source: Deploy from a branch → main /
   (root)**.
2. Guardar. GitHub te da una URL tipo
   `https://juanmarobledo.github.io/presupuesto-app-web/`.
3. Agregá esa URL exacta como "Authorized JavaScript origin" en el OAuth
   Client ID (ver abajo) — si no, el login falla con `redirect_uri_mismatch`
   o `origin not allowed`.

## Configurar el login con Google (una sola vez)

El Client ID de OAuth **no es secreto** — es un identificador público, está
pensado para vivir en código de cliente (a diferencia de la llave de la
cuenta de servicio que usa la versión de Streamlit, que nunca debe
publicarse). Los datos reales del Sheet siguen protegidos por el login de
Google de cada persona: solo quien ya tiene acceso al Sheet puede leerlo.

1. Andá a [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   y seleccioná el mismo proyecto que ya usa `presupuesto-app`
   (`presupuesto-app-507514`).
2. **APIs & Services → Library** → habilitá **"Google Sheets API"** y
   **"Google Drive API"** (esta última hace falta desde que Declaraciones de
   Renta sube el PDF a Drive).
3. **APIs & Services → OAuth consent screen** → configurala como "Internal"
   si tu cuenta es de Google Workspace, o "External" + agregá tu propio
   email (y el de cualquier otra persona que vaya a usar el sitio) en "Test
   users" si es una cuenta @gmail.com normal (mientras la app no esté
   "publicada", solo esos correos van a poder iniciar sesión — perfecto para
   uso personal/familiar). `drive.file` es un scope "sensible" para Google,
   así que en el login vas a ver una pantalla de "App no verificada" — es
   normal para una app de uso propio en modo Testing, click en
   "Avanzado" → "Ir a [nombre] (no seguro)" para continuar.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: agregá `http://localhost:8000` (para
     probar en local) y la URL de GitHub Pages del paso anterior
   - Create
5. Copiá el Client ID (termina en `.apps.googleusercontent.com`) y pegalo en
   `js/config.js`, reemplazando `PEGA_ACA_TU_OAUTH_CLIENT_ID...`.
6. Commit + push.

## Estructura

```
index.html          — portada: elegí entre la versión Web (app.html) y la de Streamlit
app.html             — shell de la app en sí (login + nav + contenedor)
css/style.css        — estilos
js/config.js         — Client ID, Sheet ID, rangos con nombre
js/util.js           — funciones puras portadas de Python (toNumber, fmtMoneda, ...)
js/auth.js           — login/logout con Google Identity Services
js/sheets-api.js      — wrapper sobre la API REST de Google Sheets (lectura y escritura)
js/drive-api.js       — wrapper sobre la API REST de Google Drive (subir un PDF)
js/ingresos-gastos.js — puerto de _ingresos_gastos_periodo(), compartido entre
                         Resumen y Estados Financieros → Estado de Resultados
js/app.js            — nav lateral y bootstrap
js/pages/*.js        — una página por sección, cada una expone render(container)
scripts/actualizar_mercado.py — GitHub Action: precios/TRM/benchmarks vía
                         Yahoo Finance, corre server-side (ver "Actualizar
                         precios de mercado" más arriba)
.github/workflows/actualizar-mercado.yml — programación del Action de arriba
```

Para portar una página nueva: agregar sus rangos a `RANGOS` en `config.js`,
crear `js/pages/<nombre>.js` siguiendo el patrón de `resumen.js`, sumarla al
`<script>` en `app.html` y a `PAGINAS` en `app.js` con `disponible: true`.
