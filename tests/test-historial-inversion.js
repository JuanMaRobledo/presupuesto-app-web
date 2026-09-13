const { chromium } = require("playwright");
const BASE = "http://localhost:8123";

async function setupMocks(page, MOCK_RANGES) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(ctx, cfg) { this.destroy = function(){}; this._cfg = cfg; };" })
  );

  const escrituras = [];
  // Playwright prioriza el route MÁS RECIENTE registrado -- el catch-all
  // genérico de PUT va PRIMERO (menos prioridad) para que los handlers
  // específicos de :append/:clear, registrados después, sí lo intercepten
  // (mismo orden que usa run-tests.js para este mismo motivo).
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const body = route.request().postDataJSON();
    const range = decodeURIComponent(new URL(route.request().url()).pathname.split("/values/")[1].split("?")[0]);
    escrituras.push({ kind: "update", range, body });
    MOCK_RANGES["'Historial de Inversiones'!A2:J5000"] = body.values;
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updatedRows: body.values.length }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
  });
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**:append**", async (route) => {
    const body = route.request().postDataJSON();
    escrituras.push({ kind: "append", url: route.request().url(), body });
    // Refleja el append en el mock, para que un guardado posterior en la
    // misma sesión (o un recargar()) vea la fila recién agregada.
    const range = decodeURIComponent(new URL(route.request().url()).pathname.split("/values/")[1].split(":append")[0]);
    if (MOCK_RANGES[range]) MOCK_RANGES[range] = [...MOCK_RANGES[range], ...body.values];
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updates: { updatedRows: body.values.length } }) });
  });
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**:clear**", async (route) => {
    const range = decodeURIComponent(new URL(route.request().url()).pathname.split("/values/")[1].split(":clear")[0]);
    escrituras.push({ kind: "clear", range });
    if (range.startsWith("'Historial de Inversiones'!")) MOCK_RANGES["'Historial de Inversiones'!A2:J5000"] = [];
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ clearedRange: range }) });
  });

  page.escrituras = escrituras;
}

async function gotoLoggedIn(page) {
  await page.goto(`${BASE}/app.html`);
  await page.waitForFunction(() => typeof Auth !== "undefined");
  await page.evaluate(() => { Auth.getToken = () => "FAKE_TOKEN_FOR_TESTS"; });
  await page.evaluate(() => mostrarApp());
}

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`OK: ${label}`);
  else { console.log(`FAIL: ${label}`); failures++; }
}

const MOCK_RANGES_BASE = {
  "'Inversiones - Pesos'!A5:H45": [],
  "'Inversiones - Dólares'!A5:H45": [
    ["IBKR - MSFT", "Acción", 2, 363.18, 726.36, 495.63, 991.26, 264.90],
  ],
  "'Inversiones - Pesos'!A79:D1000": [],
  "'Inversiones - Dólares'!A79:D1000": [
    ["2025-06-01", "Interactive Brokers", 800000, ""],
  ],
  "'Historial de Inversiones'!A2:J5000": [
    ["01/03/2025", "IBKR", "USD", "MSFT", "BUY", 2, 363.18, 1, 0, "Importado"],
  ],
  "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
  "'Historial de Valor de Cartera'!A2:E5000": [],
};

// ---------------------------------------------------------------------
// Escenario A: agregar un dividendo -- se agrega al historial y aparece
// tras recargar; repetir el mismo (misma fecha/plataforma/activo/tipo)
// se detecta como duplicado y no se vuelve a agregar.
// ---------------------------------------------------------------------
async function testAgregarDividendo() {
  const MOCK_RANGES = JSON.parse(JSON.stringify(MOCK_RANGES_BASE));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  await page.click('summary:has-text("Agregar un dividendo o interés recibido")');
  await page.fill("#div_fecha", "2026-08-15");
  await page.selectOption("#div_tipo", "DIVIDEND");
  await page.fill("#div_plataforma", "IBKR");
  await page.selectOption("#div_moneda", "USD");
  await page.fill("#div_activo", "MSFT");
  await page.fill("#div_valor", "12.50");
  await page.click("#div_guardar");
  await page.waitForTimeout(500);

  const escrituras = page.escrituras;
  const appendDiv = escrituras.find((e) => e.kind === "append" && e.url.includes("Historial"));
  check(!!appendDiv, `Se agregó una fila al historial (vi ${escrituras.length} escrituras)`);
  if (appendDiv) {
    check(JSON.stringify(appendDiv.body.values[0]) === JSON.stringify(["2026-08-15", "IBKR", "USD", "MSFT", "DIVIDEND", 0, 0, 0, 12.5, "Manual"]),
      `Fila del dividendo con los valores correctos (vi: ${JSON.stringify(appendDiv.body.values[0])})`);
  }

  // La página se recargó sola (recargar()) -- confirmar que el dividendo
  // ahora aparece en "Dividendos e intereses recibidos".
  await page.waitForTimeout(300);
  const texto = await page.locator("#inv-historial").innerText();
  check(texto.includes("Dividendos e intereses"), `Tras guardar, la sección de dividendos aparece (vi: "${texto.slice(0, 300)}")`);

  // Repetir el mismo dividendo -- debe detectarse como duplicado, sin
  // escritura nueva. La página se recargó sola tras el guardado anterior,
  // así que hay que volver a abrir el <details> (quedó cerrado de nuevo).
  await page.click('summary:has-text("Agregar un dividendo o interés recibido")');
  await page.fill("#div_fecha", "2026-08-15");
  await page.selectOption("#div_tipo", "DIVIDEND");
  await page.fill("#div_plataforma", "IBKR");
  await page.selectOption("#div_moneda", "USD");
  await page.fill("#div_activo", "MSFT");
  await page.fill("#div_valor", "12.50");
  const escriturasAntes = page.escrituras.length;
  await page.click("#div_guardar");
  await page.waitForTimeout(300);
  check(page.escrituras.length === escriturasAntes, "Repetir el mismo dividendo NO agrega otra fila");
  const msgDup = await page.locator("#div_msg").innerText();
  check(msgDup.includes("idéntico"), `Muestra el aviso de duplicado (vi: "${msgDup}")`);

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario B: editar el historial -- corregir una celda y borrar una fila,
// después guardar reescribe TODO el rango (clear + update, no append).
// ---------------------------------------------------------------------
async function testEditarHistorial() {
  const MOCK_RANGES = JSON.parse(JSON.stringify(MOCK_RANGES_BASE));
  MOCK_RANGES["'Historial de Inversiones'!A2:J5000"] = [
    ["01/03/2025", "IBKR", "USD", "MSFT", "BUY", 2, 363.18, 1, 0, "Importado"],
    ["05/03/2025", "IBKR", "USD", "ADBE", "BUY", 1, 500, 1, 0, "Importado"],
  ];
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  await page.click('summary:has-text("Editar o eliminar operaciones del historial")');
  const filas = page.locator("#hist_editor_tbody tr");
  check(await filas.count() === 2, `El editor arranca con las 2 filas existentes (vi ${await filas.count()})`);

  // Corregir el precio de la primera fila (MSFT).
  await filas.nth(0).locator(".hist-precio").fill("400");
  // Borrar la segunda fila (ADBE).
  await filas.nth(1).locator(".btn-quitar-fila").click();
  check(await filas.count() === 1, "Tras borrar, queda 1 sola fila en el editor");

  await page.click("#hist_editor_guardar");
  await page.waitForTimeout(500);

  const escrituras = page.escrituras;
  const clearOp = escrituras.find((e) => e.kind === "clear" && e.range.includes("Historial"));
  check(!!clearOp, "Guardar limpia primero todo el rango del historial (clearRange)");
  const updateOp = escrituras.find((e) => e.kind === "update" && e.range.includes("Historial"));
  check(!!updateOp, `Guardar reescribe el rango con las filas que quedaron (vi ${JSON.stringify(escrituras.map((e) => e.kind))})`);
  if (updateOp) {
    check(updateOp.body.values.length === 1, `Solo se escribe 1 fila (la que no se borró) (vi: ${JSON.stringify(updateOp.body.values)})`);
    check(updateOp.body.values[0][6] === 400, `El precio corregido (400) se guardó (vi: ${JSON.stringify(updateOp.body.values[0])})`);
    check(updateOp.range.endsWith("A2:J2"), `El rango de escritura es exacto al tamaño de los datos (vi: "${updateOp.range}")`);
  }
  // Nota: el mensaje de éxito vive dentro del mismo <details> que
  // recargar() reemplaza por completo al recargar la página entera -- se
  // muestra un instante y luego desaparece con el resto del DOM viejo
  // (mismo patrón preexistente que declaraciones.js/ingresos.js), así que
  // no es verificable con un timeout fijo; ya se validó el resultado real
  // (clear+update con los datos correctos) arriba.

  await browser.close();
}

(async () => {
  await testAgregarDividendo();
  await testEditarHistorial();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
