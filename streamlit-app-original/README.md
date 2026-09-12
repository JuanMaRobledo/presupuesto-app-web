# presupuesto-app

App web de presupuesto personal. La base de datos es un **Google Sheet**
—una copia en vivo de tu `Presupuesto_Juan_Robledo.xlsx`, con las mismas 19
hojas y fórmulas que ya tenías— así que todo lo que subís desde la app
(colillas de pago, extractos de tarjeta) queda guardado ahí para siempre.
Nada se sube ni se descarga en cada sesión: la app se conecta directo al
Sheet.

Además de cargar documentos, la app tiene un **Dashboard** que lee los
totales que tu Excel ya calculaba por fórmulas (gasto por categoría,
evolución mensual, resumen financiero) y los muestra como gráficos y
tarjetas, en vez de tener que abrir la hoja de cálculo para verlos.

## Contenido del repositorio

- **`app_presupuesto.py`** — la app (Streamlit): Dashboard + carga de
  colillas + carga de extractos + carga de extracto de cuenta de ahorros.
- **`sheets_backend.py`** — toda la lectura/escritura contra el Google
  Sheet (vía la API de Google Sheets). La app nunca toca un archivo local.
- **`cuenta_formatos.py`** y **`tests/`** — lectores de los formatos de
  extracto de cuenta de Bancolombia, la categorización de esos movimientos
  (incluida la regla de qué es "(no presupuestar)") y su deduplicación; es
  lógica pura, sin dependencias de Streamlit, así que tiene tests unitarios
  directos.
- **`requirements.txt`** — dependencias de Python.
- **`.streamlit/secrets.toml.example`** — plantilla de las credenciales que
  necesita la app (ver más abajo). El archivo real (`secrets.toml`) nunca
  se sube al repo.
- **`scripts/actualizar_colillas.py`** y **`scripts/actualizar_extractos.py`**
  — versiones de línea de comandos de la lógica de carga, para correr sobre
  una copia local del `.xlsx` (por ejemplo un backup viejo). Son
  independientes de la app web y de Google Sheets — no las necesitás para
  el uso normal.

## Qué hace

- **Dashboard**: cifras clave (ingresos, gasto real, deuda pendiente,
  ahorro forzoso, etc.), gasto real por categoría, evolución mensual
  (ingresos vs. gasto vs. balance) y una tabla filtrable de movimientos
  recientes. Todo se lee directo del Sheet — los cálculos los sigue
  haciendo la hoja de cálculo, como siempre.
- **Colillas de pago (PDF)**: detecta quincena, mes, año, fecha de pago,
  cada devengo y descuento (con su valor) y los totales. Si esa quincena ya
  está cargada, la salta — nunca duplica.
- **Extractos de tarjeta (Excel)**: detecta si es la Visa o la Mastercard
  (por los últimos 4 dígitos, o por el nombre del archivo si la tarjeta fue
  reemitida con un número nuevo), el mes del extracto, y cada movimiento.
  Soporta los dos formatos de extracto que ha usado Bancolombia. Si ese
  extracto (tarjeta + mes) ya está cargado, lo salta.
- **Extracto de cuenta de ahorros (Excel)**: acepta tanto el extracto
  tradicional como la exportación tabular "Detalle de transacciones"
  (`Fecha`, `Tipo de transacción`, `Descripción`, `Valor`) y separa automáticamente
  ingresos (→ Otros Ingresos) y gastos (→ Egresos - Efectivo), excluyendo
  lo que ya está contado en otro lado (nómina, pagos automáticos de
  tarjeta, préstamos) para no duplicar cifras.
- **Categorización automática** de comercios y conceptos de nómina. Lo que
  no reconoce queda marcado ("Otros" / "Otro") para que lo clasifiques
  vos, directamente en el Google Sheet si querés.
- Escribe los renglones nuevos en las mismas filas reservadas que ya usaba
  el Excel — no toca ninguna fórmula.

## Configurar la conexión a Google Sheets

Esto se hace **una sola vez**. Son dos partes: migrar tu Excel a Google
Sheets, y darle a la app un usuario técnico ("cuenta de servicio") con
permiso para leer y escribir esa hoja.

### Paso 1 — Migrar tu Excel a Google Sheets

1. Subí `Presupuesto_Juan_Robledo.xlsx` a tu Google Drive (arrastralo a
   [drive.google.com](https://drive.google.com)).
2. Click derecho sobre el archivo → **Abrir con → Google Sheets**. Esto
   crea una copia convertida, con las mismas hojas y fórmulas — el Excel
   original en Drive queda intacto, sin usarse más.
3. Renombrá esa copia a algo como "Presupuesto" (arriba a la izquierda, en
   el nombre del archivo).
4. De la URL del Sheet, copiá el **ID**: es la parte entre `/d/` y `/edit`,
   por ejemplo en
   `https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlmNoPQRstuvWXyz/edit`
   el ID es `1AbCdEfGhIjKlmNoPQRstuvWXyz`. Lo vas a necesitar en el paso 3.

### Paso 2 — Crear la cuenta de servicio en Google Cloud

1. Entrá a la [Google Cloud Console](https://console.cloud.google.com/)
   con tu cuenta de Google (es gratis, no pide tarjeta para esto).
2. Arriba, creá un proyecto nuevo (por ejemplo "presupuesto-app").
3. Con ese proyecto seleccionado, andá a **"APIs & Services" → "Library"**,
   buscá **"Google Sheets API"** y clic en **"Enable"**.
4. Andá a **"APIs & Services" → "Credentials"** → **"Create Credentials"**
   → **"Service account"**. Ponele un nombre (p. ej. `presupuesto-app`) y
   creala (no hace falta darle ningún rol de proyecto).
5. Entrá a la cuenta de servicio recién creada → pestaña **"Keys"** →
   **"Add Key" → "Create new key"** → tipo **JSON** → **"Create"**. Se
   descarga un archivo `.json` — **guardalo, es la credencial**.
6. Copiá el campo `"client_email"` de ese JSON (algo como
   `presupuesto-app@tu-proyecto.iam.gserviceaccount.com`).
7. Volvé a tu Google Sheet (paso 1) → botón **"Compartir"** → pegá ese
   correo → dale permiso de **Editor** → **Enviar** (aunque diga que no es
   un usuario de Google normal, funciona igual).

### Paso 3 — Cargar las credenciales en la app

Necesitás dos cosas en los "secrets" de la app: el `sheet_id` (paso 1) y el
contenido completo del JSON de la cuenta de servicio (paso 2), en formato
TOML. Usá `.streamlit/secrets.toml.example` de este repo como plantilla —
tiene los mismos campos que el JSON descargado, solo hay que copiar los
valores.

**Para correrla en tu computador:**

```bash
cp .streamlit/secrets.toml.example .streamlit/secrets.toml
```

Editá `.streamlit/secrets.toml` y completá `sheet_id` y cada campo de
`[gcp_service_account]` con los valores de tu JSON. Ese archivo nunca se
sube al repo (está en `.gitignore`).

**Para la versión desplegada en Streamlit Community Cloud:** los mismos
valores van en **Settings → Secrets** de la app en
[share.streamlit.io](https://share.streamlit.io) (ver paso siguiente) —
tampoco se suben al repositorio.

## Correrla en tu computador

Requiere Python 3.9+ y tener configurados los secrets (paso anterior).

```bash
pip3 install -r requirements.txt
streamlit run app_presupuesto.py
```

Se abre en tu navegador (`http://localhost:8501`).

## Ponerla en internet (sin usar terminal), solo para ti

Esto crea un link privado, restringido a tu correo, al que entrás desde
cualquier dispositivo. Se usa **Streamlit Community Cloud** (gratis) para
correr la app; el código ya está en este repositorio de GitHub.

### Paso 1 — Desplegar en Streamlit Community Cloud

1. Entrá a [share.streamlit.io](https://share.streamlit.io) e iniciá sesión
   con tu cuenta de GitHub (botón "Continue with GitHub").
2. Clic en **"New app"** (o "Create app").
3. Elegí:
   - **Repository**: `JuanMaRobledo/presupuesto-app`
   - **Branch**: `main`
   - **Main file path**: `app_presupuesto.py`
4. Antes de desplegar (o después, en Settings), abrí **"Advanced settings" →
   "Secrets"** y pegá ahí el contenido completo de tu
   `.streamlit/secrets.toml` (el mismo `sheet_id` y `[gcp_service_account]`
   del paso 3 de la configuración).
5. Clic en **"Deploy"**. Tarda uno o dos minutos la primera vez.

### Paso 2 — Restringir el acceso solo a vos

1. Ya desplegada, en la esquina inferior derecha de tu app en
   [share.streamlit.io](https://share.streamlit.io), buscá los tres puntos
   (**⋮**) junto al nombre de tu app → **"Settings"**.
2. Andá a la pestaña **"Sharing"**.
3. En "Who can view this app", elegí **"Only specific people can view this
   app"** y agregá tu correo (el mismo con el que usás Streamlit/GitHub).
4. Guardá. Desde ahora, solo vos (con sesión iniciada) podés abrir ese link.

### Listo

Guardá el link de tu app (algo como
`https://juanmarobledo-presupuesto-app.streamlit.app`) — ese es tu acceso
permanente.

### Cuando quieras actualizar la app

Cualquier cambio que subas a la rama `main` de este repositorio hace que
Streamlit Cloud vuelva a desplegar la app solo, en uno o dos minutos. Los
secrets no se tocan al redesplegar.

## Si un bloque reservado se llena

Cada hoja tiene una cantidad fija de filas reservadas para datos nuevos
(con fórmulas ya puestas en cada una). Si algún día se llenan y la app
avisa "No queda espacio reservado...", hay que extender el bloque a mano en
el Google Sheet: seleccioná la última fila con fórmulas del bloque y
arrastrala hacia abajo (o copiá/pegá) para que las fórmulas se repliquen en
más filas — y avisame para que actualice los rangos en `sheets_backend.py`.

## Precios de inversiones

En **Inversiones → Precios y seguimiento**, el botón **Actualizar precios de mercado** consulta el último
cierre disponible en Yahoo Finance y guarda los precios en las posiciones del Google Sheet. Las cotizaciones
se conservan en caché durante 15 minutos. La app calcula valor de cartera, ganancia o pérdida, rentabilidad y
distribución por activo, separados en COP y USD. Las posiciones sin costo informado se incluyen en el valor
neto, pero no en la rentabilidad para evitar mostrar una ganancia ficticia.

## Privacidad

- El repositorio de GitHub es **privado** y nunca contiene tus datos — solo
  código.
- La app privada de Streamlit está restringida a tu correo.
- El único que puede escribir en el Google Sheet además de vos es la cuenta
  de servicio (un usuario técnico que solo la app usa, con el JSON que
  guardaste en el paso 2 — no lo compartas).
- Para consultar precios, la app envía a Yahoo Finance únicamente los símbolos públicos de mercado. No envía
  cantidades, costos, saldos, nombres ni datos bancarios.
- El archivo `.json` de la cuenta de servicio y `.streamlit/secrets.toml`
  nunca deben subirse a ningún repositorio.
