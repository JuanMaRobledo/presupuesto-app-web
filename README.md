# Presupuesto App — versión web (GitHub Pages)

Versión estática (HTML/CSS/JS puro, sin Streamlit ni backend) de
[presupuesto-app](https://github.com/JuanMaRobledo/presupuesto-app). Corre
enteramente en el navegador: quien la abre inicia sesión con su propia cuenta
de Google y el navegador lee el Google Sheet directamente vía la API de
Sheets — no hay servidor, no hay cuenta de servicio, no hay ninguna llave
guardada en el código.

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

⏳ Todavía no portado (usá la versión de Streamlit mientras tanto):
- El gráfico de "Tendencia de los últimos meses" al pie de Resumen
- Dentro de Egresos: gestionar extractos (agregar/eliminar — son
  escritura), "ver un extracto puntual" (cupo/saldo/pago de un corte), y
  el detalle de compras en USD de Mastercard
- Dentro de Deudas: el formulario "Actualizar deudas manualmente" (escritura)
- 📊 Análisis, 📋 Presupuesto, 📈 Inversiones (detalle),
  🏢 Estados Financieros, 💰 Ingresos, 🧾 Facturación Electrónica,
  📑 Declaraciones de Renta
- Cualquier operación de **escritura** (agregar/editar/borrar) — esta primera
  versión es de solo lectura

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
2. **APIs & Services → Library** → buscá "Google Sheets API" → **Enable**
   (si no estaba ya habilitada).
3. **APIs & Services → OAuth consent screen** → configurala como "Internal"
   si tu cuenta es de Google Workspace, o "External" + agregá tu propio
   email en "Test users" si es una cuenta @gmail.com normal (mientras la app
   no esté "publicada", solo vos vas a poder iniciar sesión — perfecto para
   uso personal).
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
js/sheets-api.js      — wrapper sobre la API REST de Google Sheets
js/app.js            — nav lateral y bootstrap
js/pages/*.js        — una página por sección, cada una expone render(container)
```

Para portar una página nueva: agregar sus rangos a `RANGOS` en `config.js`,
crear `js/pages/<nombre>.js` siguiendo el patrón de `resumen.js`, sumarla al
`<script>` en `index.html` y a `PAGINAS` en `app.js` con `disponible: true`.
