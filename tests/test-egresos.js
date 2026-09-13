const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

const MOCK_RANGES = {
  "'Egresos - Efectivo'!A15:K1999": [
    ["2026-06", 46200, "Supermercado", "COP", "1/1", 50000, 50000, 0, "Mercado", "No", ""],
  ],
  "'Egresos - Tarjeta Visa 7497'!A15:K5614": [
    ["2026-05", 46180, "Restaurante", "COP", "1/1", 80000, 80000, 0, "Restaurantes", "No", ""],
    ["2026-06", 46210, "Cine", "COP", "1/1", 40000, 40000, 0, "Entretenimiento", "No", ""],
  ],
  "'Egresos - Mastercard 5922'!A15:K5601": [
    ["2026-05", 46181, "Gasolina", "COP", "1/1", 120000, 120000, 0, "Transporte", "No", ""],
    ["2026-06", 46211, "Farmacia", "COP", "1/1", 60000, 60000, 0, "Salud", "No", ""],
  ],
  "'Categorías'!A2:A25": [["Mercado"], ["Restaurantes"], ["Transporte"], ["Salud"], ["Entretenimiento"]],
};

let sheetsCalls = [];

async function setupMocks(page) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(ctx, cfg) { this.destroy = function(){}; this._cfg = cfg; };" })
  );

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    sheetsCalls.push({ type: "update" });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updatedRows: 1 }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
    sheetsCalls.push({ type: "batchGet", ranges });
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**:append**", (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    const range = decodeURIComponent(url.pathname.split("/values/")[1].split(":append")[0]);
    if (MOCK_RANGES[range]) MOCK_RANGES[range] = [...MOCK_RANGES[range], ...body.values];
    sheetsCalls.push({ type: "append", range, values: body.values });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updates: { updatedRows: body.values.length } }) });
  });
}

async function gotoLoggedIn(page) {
  await page.goto(`${BASE}/app.html`);
  await page.waitForFunction(() => typeof Auth !== "undefined");
  await page.evaluate(() => { Auth.getToken = () => "FAKE_TOKEN_FOR_TESTS"; });
  await page.evaluate(() => mostrarApp());
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page);
  await gotoLoggedIn(page);

  let failures = 0;
  function check(cond, label) {
    if (cond) console.log(`OK: ${label}`);
    else { console.log(`FAIL: ${label}`); failures++; }
  }

  await page.click('.nav-btn:has-text("💳 Egresos")');
  await page.waitForTimeout(400);

  // Tab por defecto: Efectivo, con el form arriba de la tabla.
  const filasEfectivo = await page.locator('[id^="eg_efectivo_detalle_tabla"] tbody tr').count();
  check(filasEfectivo === 1, `Efectivo: tabla muestra 1 fila (vi: ${filasEfectivo})`);
  const formVisible = await page.locator("#form_gasto_efectivo").count();
  check(formVisible === 1, "Efectivo: el formulario 'Agregar un gasto' está presente");

  await page.click('summary:has-text("Agregar un gasto en efectivo")');
  const catOptions = await page.locator("#efec_categoria option").allTextContents();
  check(catOptions.includes("Mercado") && catOptions.includes("Salud"), `Categorías cargadas desde 'Categorías'!A2:A25 (vi: ${JSON.stringify(catOptions)})`);

  sheetsCalls = [];
  await page.fill("#efec_comercio", "Tienda de prueba");
  await page.fill("#efec_valor", "25000");
  await page.selectOption("#efec_categoria", "Mercado");
  await page.check("#efec_reembolsable");
  await page.click("#efec_guardar");
  await page.waitForTimeout(400);

  const appendCall = sheetsCalls.find((c) => c.type === "append" && c.range.includes("Egresos - Efectivo"));
  check(!!appendCall, "Guardar gasto: llamó SheetsApi.appendRows sobre Egresos - Efectivo");
  const fila = appendCall && appendCall.values[0];
  check(fila && fila[0].startsWith("'") && /^\d{4}-\d{2}$/.test(fila[0].slice(1)),
    `PeriodoExtracto se manda con apóstrofe forzando texto (vi: "${fila && fila[0]}")`);
  check(fila && fila[4] === "'1/1", `Cuotas se manda como texto forzado "'1/1" (vi: "${fila && fila[4]}")`);
  check(fila && fila[2] === "Tienda de prueba" && fila[5] === 25000 && fila[6] === 25000 && fila[7] === 0,
    `Comercio/Valor/ValorCargado/SaldoPendiente correctos (vi: ${JSON.stringify(fila)})`);
  check(fila && fila[9] === "Sí", `Reembolsable = "Sí" cuando el checkbox está marcado (vi: "${fila && fila[9]}")`);

  await page.waitForTimeout(300);
  const filasEfectivoLuego = await page.locator('[id^="eg_efectivo_detalle_tabla"] tbody tr').count();
  check(filasEfectivoLuego === 2, `Efectivo: tabla recargada muestra 2 filas tras agregar (vi: ${filasEfectivoLuego})`);

  // Tab Visa: sin form.
  await page.click('.tab-btn:has-text("Egresos - Tarjeta Visa 7497")');
  await page.waitForTimeout(300);
  const formVisa = await page.locator("#form_gasto_efectivo").count();
  check(formVisa === 0, "Visa: NO muestra el formulario de agregar gasto en efectivo");

  // Tab Tendencia por Tarjeta.
  await page.click('.tab-btn:has-text("Tendencia por Tarjeta")');
  await page.waitForTimeout(300);
  const metricLabels = await page.locator("#tend_contenido .metric-label").allTextContents();
  check(metricLabels.includes("Visa 7497") && metricLabels.includes("Mastercard 5922"),
    `Tendencia: metric-row con ambas tarjetas (vi: ${JSON.stringify(metricLabels)})`);
  const metricValues = await page.locator("#tend_contenido .metric-value").allTextContents();
  // Visa: 80000 + 40000 = 120000; Mastercard: 120000 + 60000 = 180000.
  check(metricValues.some((v) => v.includes("120,000")) && metricValues.some((v) => v.includes("180,000")),
    `Tendencia: totales por tarjeta correctos (vi: ${JSON.stringify(metricValues)})`);
  const canvasTendencia = await page.locator("#chart_tendencia_tarjetas").count();
  check(canvasTendencia === 1, "Tendencia: el canvas del gráfico se renderiza");

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
