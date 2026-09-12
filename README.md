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

## Estado de la migración

✅ Portado:
- Login con Google (OAuth del lado del navegador, sin backend)
- 🏠 Resumen — **completo**: Ingresos, Gastos, Balance (con tasa de ahorro
  discriminada por origen — efectivo/ahorro/inversión, incluyendo el cruce
  de cada movimiento "Inversiones" contra la plataforma real y el neteo de
  retiros), Deudas e Inversiones (estado actual), con el selector Total
  histórico / Un año / Un mes. Verificado con casos de prueba calculados a
  mano y comparados contra la lógica de `_ingresos_gastos_periodo()`.
- 💳 Egresos — tabla de Efectivo/Visa/Mastercard (sub-tabs), con búsqueda,
  filtro de categoría/año/mes, "ocultar no presupuestar", y para las
  tarjetas el toggle Consumo (mes de compra) / Efectivo real (mes de pago,
  con el corrimiento de mes al corte correspondiente). Incluye los
  gráficos de tendencia por período y gasto por categoría y mes (Chart.js).
- 🏦 Deudas — tarjetas de saldo total/cuota mensual, deuda de Mastercard en
  dólares aparte, torta de participación por entidad, tabla completa y
  gráfico de cuota mensual por entidad.
- 📈 Inversiones — aportes/retiros en pesos y dólares (métricas + tabla),
  depósitos y retiros por plataforma, capital neto transferido en el
  tiempo, y posiciones (cantidad, precio, valor de mercado,
  ganancia/pérdida) de cada moneda.
- 💰 Ingresos — sub-tabs Colillas de Pago (resumen histórico, tendencia por
  quincena, y el detalle devengos/descuentos tanto general como filtrado a
  un mes puntual, quincena por quincena) y Otros Ingresos (búsqueda,
  filtros, "ocultar no presupuestar", agrupamiento de Rendimientos
  Financieros por mes, total por categoría y gráfico).
- 🧾 Facturación Electrónica — registro año a año, con resumen por año,
  búsqueda por emisor, filtros de año/mes, y el link "Correo" al mail
  original en Gmail para las facturas de la carga histórica.
- 📑 Declaraciones de Renta — **con escritura**: tabla + gráfico de
  Patrimonio Líquido/Impuesto a Cargo por año, y un formulario que sube el
  PDF directo a tu Google Drive (o aceptá pegar un link a mano) y guarda el
  registro en el Sheet — guardar el mismo Año reemplaza esa fila, igual que
  `guardar_declaracion_renta()`. Es la primera sección con escritura del
  sitio: necesita el scope completo de Sheets + `drive.file` (ver más
  abajo).
- 📊 Análisis — sub-tabs **Categorías** (gasto real histórico por categoría,
  gráfico + tabla) y **Movimientos** (vista unificada devengado de las 7
  fuentes: colillas devengo/descuento, Visa, Mastercard COP/USD, Cuenta de
  ahorros y Otros Ingresos, con búsqueda/filtros y top categorías de gasto).

⏳ Todavía no portado (usá la versión de Streamlit mientras tanto):
- El gráfico de "Tendencia de los últimos meses" al pie de Resumen
- Dentro de Egresos: gestionar extractos (agregar/eliminar — son
  escritura), "ver un extracto puntual" (cupo/saldo/pago de un corte), y
  el detalle de compras en USD de Mastercard
- Dentro de Deudas: el formulario "Actualizar deudas manualmente" (escritura)
- Dentro de Inversiones: patrimonio unificado, actualizar precios (Yahoo
  Finance), historial de operaciones del broker, Crecimiento y Rentabilidad
- Dentro de Ingresos: agregar/eliminar una colilla o un ingreso (escritura)
- Dentro de Facturación Electrónica: agregar una factura a mano (escritura)
- Dentro de Análisis: Esenciales/No Esenciales, Evolución, Año vs. Año y
  Balance Mensual (esta última también necesita escritura)
- 📋 Presupuesto, 🏢 Estados Financieros
- El resto de las secciones sigue siendo de solo lectura (agregar/editar/
  borrar) — Declaraciones de Renta es la única con escritura por ahora

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
index.html          — shell de la página (login + nav + contenedor)
css/style.css        — estilos
js/config.js         — Client ID, Sheet ID, rangos con nombre
js/util.js           — funciones puras portadas de Python (toNumber, fmtMoneda, ...)
js/auth.js           — login/logout con Google Identity Services
js/sheets-api.js      — wrapper sobre la API REST de Google Sheets (lectura y escritura)
js/drive-api.js       — wrapper sobre la API REST de Google Drive (subir un PDF)
js/app.js            — nav lateral y bootstrap
js/pages/*.js        — una página por sección, cada una expone render(container)
```

Para portar una página nueva: agregar sus rangos a `RANGOS` en `config.js`,
crear `js/pages/<nombre>.js` siguiendo el patrón de `resumen.js`, sumarla al
`<script>` en `index.html` y a `PAGINAS` en `app.js` con `disponible: true`.
