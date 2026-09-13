const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

const MOCK_RANGES = {
  "'Deudas - Resumen'!A5:H10": [
    ["Bancolombia", "Crédito Educativo", 5000000, 0.012, 450000, 0.6, 12, 46200],
    ["Sufi", "Crédito de Consumo", 2000000, 0.015, 200000, 0.4, 10, 46300],
  ],
  "'Deudas - Resumen'!A12:C12": [["Mastercard", "Deuda en USD aparte", 350.5]],
  // Bancolombia: sin datos cargados todavía (todo vacío).
  "'Deuda - Bancolombia'!B6:B17": [],
  // Sufi: con datos completos, para probar precarga + edición.
  "'Deuda - Sufi'!B6:B17": [
    ["OBL-123"],       // B6  numero_obligacion
    [45000],           // B7  fecha_desembolso (serial)
    [3000000],         // B8  monto_inicial
    [2000000],         // B9  saldo_actual
    [46200],           // B10 fecha_saldo (serial)
    [0.015],           // B11 tasa_ea
    [],                // B12 (sin usar)
    [200000],          // B13 cuota_mensual
    [24],              // B14 plazo_meses
    [10],              // B15 numero_cuota_actual
    [46300],           // B16 proxima_fecha_pago (serial)
    ["nota de prueba"],// B17 nota
  ],
  "'Deuda - Scotiabank Colpatria'!B6:B17": [],
  "'Deuda - Fondo de Empleados'!B6:B17": [],
};

let sheetsCalls = [];

async function setupMocks(page) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(ctx, cfg) { this.destroy = function(){}; this._cfg = cfg; };" })
  );

  // Generic PUT catch-all registered first so more specific routes
  // (registered after) take priority — see run-tests.js for why.
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
    sheetsCalls.push({ type: "batchUpdate", valueInputOption: body.valueInputOption, data: body.data });
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

  await page.click('.nav-btn:has-text("🏦 Deudas")');
  await page.waitForTimeout(400);

  const filasResumen = await page.locator("#deudas-contenido table tbody tr").count();
  check(filasResumen === 2, `Resumen de deudas muestra 2 filas (vi: ${filasResumen})`);

  // Tab por defecto: Bancolombia (sin datos) -> debe mostrar el aviso.
  const avisoBancolombia = await page.locator("#panel-deudas .aviso").first().innerText().catch(() => "");
  check(/Todavía no hay datos/i.test(avisoBancolombia), `Bancolombia sin datos: muestra aviso (vi: "${avisoBancolombia}")`);
  const saldoBancolombia = await page.locator('#panel-deudas input[id^="deuda_saldo_"]').inputValue().catch(() => "");
  check(saldoBancolombia === "0", `Bancolombia: campo Saldo Actual precargado en 0 (vi: "${saldoBancolombia}")`);

  // Cambiar a la tab de Sufi -> debe precargar todos los campos del mock.
  await page.click('#tabs-deudas .tab-btn[data-tab="sufi"]');
  await page.waitForTimeout(300);
  const saldoSufi = await page.locator("#deuda_saldo_sufi").inputValue();
  check(saldoSufi === "2000000", `Sufi: Saldo Actual precargado (vi: "${saldoSufi}")`);
  const tasaSufi = await page.locator("#deuda_tasa_sufi").inputValue();
  check(tasaSufi === "1.50", `Sufi: Tasa E.A. precargada como % (vi: "${tasaSufi}")`);
  const cuotaSufi = await page.locator("#deuda_cuota_sufi").inputValue();
  check(cuotaSufi === "200000", `Sufi: Cuota Mensual precargada (vi: "${cuotaSufi}")`);

  await page.click('#panel-deudas details summary');
  const noblSufi = await page.locator("#deuda_nobl_sufi").inputValue();
  check(noblSufi === "OBL-123", `Sufi: N° Obligación precargado (vi: "${noblSufi}")`);
  const fsaldoSufi = await page.locator("#deuda_fsaldo_sufi").inputValue();
  check(/^\d{4}-\d{2}-\d{2}$/.test(fsaldoSufi), `Sufi: Fecha del Saldo precargada en formato ISO (vi: "${fsaldoSufi}")`);
  const notaSufi = await page.locator("#deuda_nota_sufi").inputValue();
  check(notaSufi === "nota de prueba", `Sufi: Nota precargada (vi: "${notaSufi}")`);

  // Editar Saldo Actual y Cuota Mensual, dejar Tasa E.A. en 0 -> no debe
  // reescribir tasa_ea (matching el guard "solo si es truthy" de Python).
  sheetsCalls = [];
  await page.fill("#deuda_saldo_sufi", "1800000");
  await page.fill("#deuda_tasa_sufi", "0");
  await page.click("#deuda_guardar_sufi");
  await page.waitForTimeout(400);

  const batchUpdateCall = sheetsCalls.find((c) => c.type === "batchUpdate");
  check(!!batchUpdateCall, "Guardar Sufi: llamó a values:batchUpdate");
  check(batchUpdateCall && batchUpdateCall.valueInputOption === "RAW", `Guardar Sufi: valueInputOption RAW (vi: "${batchUpdateCall && batchUpdateCall.valueInputOption}")`);

  const saldoUpdate = batchUpdateCall && batchUpdateCall.data.find((d) => d.range.includes("B9"));
  check(!!saldoUpdate && saldoUpdate.values[0][0] === 1800000, `Guardar Sufi: B9 (saldo_actual) = 1800000 (vi: ${JSON.stringify(saldoUpdate)})`);
  check(saldoUpdate.range === "'Deuda - Sufi'!B9", `Guardar Sufi: rango correcto con nombre de hoja (vi: "${saldoUpdate.range}")`);

  const tasaUpdate = batchUpdateCall && batchUpdateCall.data.find((d) => d.range.includes("B11"));
  check(!tasaUpdate, "Guardar Sufi: Tasa E.A. en 0 NO se reescribió (guard de Python respetado)");

  const notaUpdate = batchUpdateCall && batchUpdateCall.data.find((d) => d.range.includes("B17"));
  check(!!notaUpdate, "Guardar Sufi: la Nota (siempre se guarda) sí está en el batch");

  const fsaldoUpdate = batchUpdateCall && batchUpdateCall.data.find((d) => d.range.includes("B10"));
  check(fsaldoUpdate && fsaldoUpdate.values[0][0] === 46200, `Guardar Sufi: fecha del saldo se re-convierte a serial correctamente (vi: ${fsaldoUpdate && fsaldoUpdate.values[0][0]})`);

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
