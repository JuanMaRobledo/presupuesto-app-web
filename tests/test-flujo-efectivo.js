const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

const MOCK_RANGES = {
  "'Colillas de Pago'!A150:G294": [
    [46200, "1a quincena jun-2026", 5000000, 800000],
  ],
  "'Colillas de Pago'!A326:D531": [
    ["1a quincena jun-2026", "Sueldo", "Salario Base", 5000000],
  ],
  "'Colillas de Pago'!A545:D2010": [
    ["1a quincena jun-2026", "Ahorro programado", "Ahorro", 300000],
  ],
  "'Otros Ingresos'!A4:E5263": [
    ["2026-06-10", "Transferencia interna", "Ajustes y Reversiones (no presupuestar)", 50000, ""],
  ],
  "'Egresos - Efectivo'!A15:K1999": [
    ["2026-06", "2026-06-15", "Super", "COP", "1/1", 200000, 200000, 0, "Mercado y Supermercado", "No", ""],
    ["2026-06", "2026-06-20", "Cuota prestamo", "COP", "1/1", 150000, 150000, 0, "Pago de deuda (no presupuestar)", "No", ""],
    ["2026-06", "2026-06-25", "Pago TC Visa", "COP", "1/1", 500000, 500000, 0, "Pago Tarjeta de Crédito (no presupuestar)", "No", "ya contabilizado en el detalle de la tarjeta"],
    ["2026-06", "2026-06-28", "Intereses/4x1000", "COP", "1/1", 20000, 20000, 0, "Intereses y Cargos Financieros (no presupuestar)", "No", ""],
  ],
  "'Egresos - Tarjeta Visa 7497'!A15:K5614": [],
  "'Egresos - Mastercard 5922'!A15:K5601": [],
  "'Inversiones - Pesos'!A79:D1000": [],
  "'Inversiones - Dólares'!A79:D1000": [],
  "'Deudas - Resumen'!A5:H10": [],
  "'Resumen'!B5:E18": [],
  "'Balance Mensual'!A66:D265": [
    ["2026-05", 1000000, 1200000, "2026-06-01"],
    ["2025-12", 500000, 900000, "2026-01-01"],
  ],
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
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    sheetsCalls.push({ type: "update", path: url.pathname, values: body.values });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updatedRows: 1 }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
    sheetsCalls.push({ type: "batchGet", ranges });
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
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

  await page.click('.nav-btn:has-text("🏢 Estados Financieros")');
  await page.waitForTimeout(400);

  // ---------- Flujo de Efectivo ----------
  await page.click('.tab-btn:has-text("Flujo de Efectivo")');
  await page.waitForTimeout(300);
  await page.selectOption("#fe_anio", "2026");
  await page.selectOption("#fe_mes", "6");
  await page.waitForTimeout(400);

  const saldoIniInput = await page.locator("#fe_saldo_ini").inputValue();
  check(saldoIniInput === "1200000", `Flujo: saldo inicial encadenado desde mayo-2026 (SaldoFinal) (vi: "${saldoIniInput}")`);

  const flujoMetrics = await page.locator("#fe_flujo_metrics .metric-value").allTextContents();
  check(flujoMetrics[0] === "$4,000,000", `Flujo: Operación = 5,000,000 ingresos - 200,000 gasto - 800,000 descuentos (vi: "${flujoMetrics[0]}")`);
  check(flujoMetrics[1] === "$0", `Flujo: Inversión = 0 (vi: "${flujoMetrics[1]}")`);
  check(flujoMetrics[2] === "-$150,000", `Flujo: Financiación = -150,000 (Pago de deuda) (vi: "${flujoMetrics[2]}")`);
  check(flujoMetrics[3] === "$30,000",
    `Flujo: Conciliación = 50,000 ingreso - 20,000 egreso (el pago de TC de 500,000 se excluye por dedup de Notas) (vi: "${flujoMetrics[3]}")`);

  const saldoFinalCalc = await page.locator("#fe_saldo_final_calc .metric-value").innerText();
  check(saldoFinalCalc === "$5,080,000", `Flujo: Saldo Final Calculado = 1,200,000 + 4,000,000 + 0 - 150,000 + 30,000 (vi: "${saldoFinalCalc}")`);

  // Desglose: Financiación debe mostrar la cuota de préstamo -- el panel
  // ya viene abierto por defecto (.panel-colapsable), no hace falta
  // clickearlo (clickearlo lo cerraría en vez de abrirlo).
  const textoDesglose = await page.locator("#fe_desglose").innerText();
  check(textoDesglose.includes("Cuota prestamo"), "Flujo: desglose de Financiación muestra 'Cuota prestamo'");
  check(textoDesglose.includes("Transferencia interna"), "Flujo: desglose de Conciliación (entradas) muestra 'Transferencia interna'");
  check(textoDesglose.includes("Intereses/4x1000"), "Flujo: desglose de Conciliación (salidas) muestra 'Intereses/4x1000'");
  check(!textoDesglose.includes("Pago TC Visa"), "Flujo: el pago de TC deduplicado NO aparece en el desglose de Conciliación");

  // Guardar saldos -- debe ir a la primera fila libre después de mayo (fila 67).
  sheetsCalls = [];
  await page.fill("#fe_saldo_fin", "5100000");
  await page.click("#fe_guardar");
  await page.waitForTimeout(400);
  const updateCall = sheetsCalls.find((c) => c.type === "update");
  check(!!updateCall && updateCall.path.includes("A68"), `Guardar: escribe en la primera fila libre (A68, tras mayo en fila 66) (vi: "${updateCall && updateCall.path}")`);
  check(!!updateCall && updateCall.values[0][0] === "'2026-06", `Guardar: Mes con apóstrofe forzando texto (vi: "${updateCall && updateCall.values[0][0]}")`);
  check(!!updateCall && updateCall.values[0][2] === 5100000, `Guardar: Saldo Final = 5,100,000 (vi: ${updateCall && updateCall.values[0][2]})`);

  // ---------- Auditoría Anual ----------
  await page.click('.tab-btn:has-text("Auditoría Anual")');
  await page.waitForTimeout(300);
  await page.selectOption("#aud_anio", "2026");
  await page.waitForTimeout(400);

  const audMetrics = await page.locator("#aud-contenido .metric-row").nth(3).locator(".metric-value").allTextContents();
  check(audMetrics[0] === "$4,000,000" && audMetrics[1] === "$0" && audMetrics[2] === "-$150,000" && audMetrics[3] === "$30,000",
    `Auditoría: Operación/Inversión/Financiación/Conciliación del año = mismos totales que junio, único mes con datos (vi: ${JSON.stringify(audMetrics)})`);

  const saldosAud = await page.locator("#aud-contenido .metric-row").nth(4).locator(".metric-value").allTextContents();
  check(saldosAud[0] === "$900,000", `Auditoría: Saldo Inicial = SaldoFinal de dic-2025 (900,000) (vi: "${saldosAud[0]}")`);
  check(saldosAud[1] === "$4,780,000", `Auditoría: Saldo Final Calculado = 900,000 + 4,000,000 + 0 - 150,000 + 30,000 (vi: "${saldosAud[1]}")`);

  await page.click('summary:has-text("Ver detalle mes a mes")');
  await page.waitForTimeout(200);
  const filaJunio = await page.locator("#aud_mes_tabla tbody tr").nth(5).innerText(); // fila 0=ene ... 5=jun
  check(filaJunio.includes("2026-06") && filaJunio.includes("$4,780,000"),
    `Auditoría: detalle mes a mes -- junio muestra el saldo final calculado correcto (vi: "${filaJunio.replace(/\n/g, " | ")}")`);
  const filaMayo = await page.locator("#aud_mes_tabla tbody tr").nth(4).innerText();
  check(filaMayo.includes("$900,000"), `Auditoría: mayo (sin datos) mantiene el saldo de arranque sin cambios (vi: "${filaMayo.replace(/\n/g, " | ")}")`);

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
