const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

// --- Balance Mensual mock: 'Balance Mensual'!A6:Q61 (56 filas, índice 0 = fila 6) ---
const balanceVals = Array.from({ length: 56 }, () => []);
function setCelda(fila, col, valor) {
  const row = balanceVals[fila - 6];
  row[col - 1] = valor;
}
setCelda(6, 2, 5000000);   // Ingresos brutos (col B)
setCelda(6, 7, 2000000);   // Egresos tarjetas+efectivo (col G)
setCelda(6, 12, 800000);   // Descuentos de nómina (col L)
setCelda(6, 17, 2200000);  // Balance (col Q)
setCelda(14, 1, "Efectivo"); setCelda(14, 2, 500000);
setCelda(15, 1, "Visa"); setCelda(15, 2, 1000000);
setCelda(16, 1, "Mastercard"); setCelda(16, 2, 500000);
setCelda(35, 1, "Ahorro"); setCelda(35, 2, 300000);
setCelda(36, 1, "Salud"); setCelda(36, 2, 200000);
setCelda(60, 1, "Colillas"); setCelda(60, 2, 4800000);
setCelda(61, 1, "Otros Ingresos"); setCelda(61, 2, 200000);

const MOCK_RANGES = {
  "'Colillas de Pago'!A326:D531": [],
  "'Colillas de Pago'!A545:D2010": [],
  "'Egresos - Tarjeta Visa 7497'!A15:K5614": [
    ["2026-08", "2026-08-10", "Restaurante X", "COP", "1/1", 50000, 50000, 0, "Restaurantes y Domicilios", "No", ""],
  ],
  "'Egresos - Mastercard 5922'!A15:K5601": [
    ["2026-08", "2026-08-05", "Tienda Z", "COP", "1/1", 30000, 30000, 0, "ZZZ Categoria Custom", "No", ""],
  ],
  "'Egresos - Mastercard 5922'!A5698:K6697": [],
  "'Egresos - Efectivo'!A15:K1999": [
    ["2026-08", "2026-08-15", "Supermercado Y", "COP", "1/1", 100000, 100000, 0, "Mercado y Supermercado", "No", ""],
  ],
  "'Otros Ingresos'!A4:E5263": [],
  "'Categorías Esenciales'!A5:B60": [
    ["Restaurantes y Domicilios", "Esencial"], // override: por defecto es "No esencial"
  ],
  "'Balance Mensual'!A6:Q61": balanceVals,
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

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchUpdate**", (route) => {
    const body = route.request().postDataJSON();
    sheetsCalls.push({ type: "batchUpdate", data: body.data });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ totalUpdatedCells: body.data.length }) });
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

  await page.click('.nav-btn:has-text("📊 Análisis")');
  await page.waitForTimeout(400);

  // ---------- Esenciales / No Esenciales ----------
  await page.click('.tab-btn:has-text("Esenciales / No Esenciales")');
  await page.waitForTimeout(400);

  const metricLabels = await page.locator("#es_contenido .metric-row .metric-label").allTextContents();
  const metricValues = await page.locator("#es_contenido .metric-row .metric-value").allTextContents();
  const idxEsencial = metricLabels.findIndex((l) => l.startsWith("Esencial ("));
  const idxNoEsencial = metricLabels.findIndex((l) => l.startsWith("No esencial ("));
  const idxSinClasificar = metricLabels.findIndex((l) => l.startsWith("Sin clasificar ("));
  check(idxEsencial >= 0 && idxNoEsencial >= 0 && idxSinClasificar >= 0,
    `Esenciales: las 3 clasificaciones aparecen (vi: ${JSON.stringify(metricLabels)})`);
  check(metricValues[idxEsencial] === "$150,000",
    `Esenciales: Mercado (esencial estático) + Restaurantes (override a esencial) = 150,000 (vi: "${metricValues[idxEsencial]}")`);
  check(metricValues[idxNoEsencial] === "$0",
    `Esenciales: No esencial = 0 porque Restaurantes fue sobreescrito (vi: "${metricValues[idxNoEsencial]}")`);
  check(metricValues[idxSinClasificar] === "$30,000",
    `Esenciales: ZZZ Categoria Custom sin clasificar = 30,000 (vi: "${metricValues[idxSinClasificar]}")`);

  const avisoSinClasificar = await page.locator("#es_aviso_sin_clasificar").innerText();
  check(avisoSinClasificar.includes("ZZZ Categoria Custom"), `Esenciales: aviso menciona la categoría sin clasificar (vi: "${avisoSinClasificar}")`);

  const filasDetalle = await page.locator("#es_tabla tbody tr").count();
  check(filasDetalle === 3, `Esenciales: detalle por categoría muestra 3 filas (vi: ${filasDetalle})`);

  // ---------- Balance Mensual ----------
  sheetsCalls = [];
  await page.click('.tab-btn:has-text("Balance Mensual")');
  await page.waitForTimeout(400);

  const batchUpdateCall = sheetsCalls.find((c) => c.type === "batchUpdate");
  check(!!batchUpdateCall, "Balance Mensual: escribe el selector de mes (E4/G4) antes de leer");
  const rangoE4 = batchUpdateCall && batchUpdateCall.data.find((d) => d.range.includes("E4"));
  const rangoG4 = batchUpdateCall && batchUpdateCall.data.find((d) => d.range.includes("G4"));
  check(!!rangoE4 && !!rangoG4, "Balance Mensual: escribe tanto E4 (año) como G4 (mes)");

  const metricsBalance = await page.locator("#bal_metricas .metric-value").allTextContents();
  check(metricsBalance[0] === "$5,000,000", `Balance: Ingresos brutos (vi: "${metricsBalance[0]}")`);
  check(metricsBalance[1] === "$2,000,000", `Balance: Egresos tarjetas+efectivo (vi: "${metricsBalance[1]}")`);
  check(metricsBalance[2] === "$800,000", `Balance: Descuentos de nómina (vi: "${metricsBalance[2]}")`);
  check(metricsBalance[3] === "$2,200,000", `Balance: Balance del mes (vi: "${metricsBalance[3]}")`);

  const filasMetodo = await page.locator("#bal_tablas table").first().locator("tbody tr").count();
  check(filasMetodo === 3, `Balance: tabla 'Egresos por método' tiene 3 filas (vi: ${filasMetodo})`);

  // Toggle a vista "Consumo" -- para probar con datos determinísticos, elegimos año=2026 mes=agosto.
  await page.selectOption("#bal_anio", "2026");
  await page.selectOption("#bal_mes", "8");
  await page.waitForTimeout(500);
  await page.click('input[name="bal_vista"][value="consumo"]');
  await page.waitForTimeout(500);

  const metricsConsumo = await page.locator("#bal_metricas .metric-value").allTextContents();
  // Efectivo 100000 (ago) + Visa 50000 (ago) + Mastercard 30000 (ago) = 180000.
  check(metricsConsumo[1] === "$180,000", `Balance (vista Consumo): suma Fecha Compra en agosto-2026 = 180,000 (vi: "${metricsConsumo[1]}")`);
  const balanceConsumoEsperado = 5000000 - 180000 - 800000;
  check(metricsConsumo[3] === `$${balanceConsumoEsperado.toLocaleString("en-US")}`,
    `Balance (vista Consumo): Balance recalculado = Ingresos - Consumo - Descuentos (vi: "${metricsConsumo[3]}")`);

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
