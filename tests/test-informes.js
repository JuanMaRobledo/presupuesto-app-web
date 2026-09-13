const { chromium } = require("playwright");
const BASE = "http://localhost:8123";

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`OK: ${label}`);
  else { console.log(`FAIL: ${label}`); failures++; }
}

async function setupMocks(page, MOCK_RANGES) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(ctx, cfg) { this.destroy = function(){}; this._cfg = cfg; };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.XLSX = {};" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.pdfjsLib = { GlobalWorkerOptions: {} };" })
  );

  const escrituras = [];
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const body = route.request().postDataJSON();
    const range = decodeURIComponent(new URL(route.request().url()).pathname.split("/values/")[1].split("?")[0]);
    escrituras.push({ kind: "update", range, body });
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
    const range = decodeURIComponent(new URL(route.request().url()).pathname.split("/values/")[1].split(":append")[0]);
    escrituras.push({ kind: "append", range, body });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updates: { updatedRows: body.values.length } }) });
  });
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchUpdate**", async (route) => {
    const body = route.request().postDataJSON();
    escrituras.push({ kind: "batchUpdate", body });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ totalUpdatedCells: 0 }) });
  });
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchClear**", async (route) => {
    const body = route.request().postDataJSON();
    escrituras.push({ kind: "batchClear", body });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });

  page.escrituras = escrituras;
}

async function gotoLoggedIn(page) {
  await page.goto(`${BASE}/app.html`);
  await page.waitForFunction(() => typeof Auth !== "undefined");
  await page.evaluate(() => { Auth.getToken = () => "FAKE_TOKEN_FOR_TESTS"; });
  await page.evaluate(() => mostrarApp());
}

// ---------------------------------------------------------------------
// Escenario A: Verificar Datos -- tabla de tarjetas + conciliación de
// efectivo (cuadra y no cuadra) + guardar saldos.
// ---------------------------------------------------------------------
async function testVerificarDatos() {
  const MOCK_RANGES = {
    "'Egresos - Tarjeta Visa 7497'!A5621:K5660": [
      ["ene-2026", "15/01/2026", "05/02/2026", 5000000, 3000000, 40, 100000, 2000000, 50000, 2100000, ""],
    ],
    "'Egresos - Mastercard 5922'!A5608:K5647": [
      ["ene-2026", "15/01/2026", "05/02/2026", 4000000, 3500000, 12, 50000, 500000, 20000, 520000, 150.5],
    ],
    "'Egresos - Mastercard 5922'!A5698:K6697": [
      ["ene-2026", "20/01/2026", "AMAZON", "USD", "1/1", 100, 100, 0, "Compras Online / Varios", "No", ""],
    ],
    "'Balance Mensual'!A66:D265": [
      ["2025-12", 1000000, 1500000, "01/01/2026"],
    ],
    "'Otros Ingresos'!A4:E5263": [
      ["05/01/2026", "Sueldo extra", "Otro", 2000000, ""],
    ],
    "'Egresos - Efectivo'!A15:K1999": [
      ["2026-01", "10/01/2026", "MERCADO", "COP", "1/1", 800000, 800000, 0, "Mercado y Supermercado", "No", ""],
    ],
    "'Colillas de Pago'!A150:G294": [],
    "'Colillas de Pago'!A326:D531": [],
    "'Colillas de Pago'!A545:D2010": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Deudas - Resumen'!A5:H10": [],
    "'Resumen'!B5:E18": [],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("✅ Verificar Datos")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#vd-contenido").innerText();
  check(texto.includes("Visa 7497") && texto.includes("Mastercard 5922"), `Muestra el resumen de ambas tarjetas (vi: "${texto.slice(0, 200)}")`);
  check(texto.includes("150.50") || texto.includes("US$ 150.50"), `Muestra el saldo a pagar USD de Mastercard (vi: "${texto.slice(200, 500)}")`);

  // Mes 2026-01: saldo inicial autocompletado con el Saldo Final de 2025-12
  // (1500000) -- ingresos (2000000, Otros Ingresos) - egresos (800000,
  // Efectivo) = saldo calculado 1500000+2000000-800000 = 2700000.
  await page.selectOption("#vd_anio", "2026");
  await page.selectOption("#vd_mes", "1");
  await page.waitForTimeout(300);
  const saldoIniVal = await page.locator("#vd_saldo_ini").inputValue();
  check(Number(saldoIniVal) === 1500000, `Saldo inicial autocompletado con el saldo final del mes anterior (vi: ${saldoIniVal})`);
  const metricsTexto = await page.locator("#vd_metrics").innerText();
  check(metricsTexto.includes("2.700.000") || metricsTexto.includes("2,700,000"), `Saldo calculado correcto: 1.500.000+2.000.000-800.000=2.700.000 (vi: "${metricsTexto}")`);

  await page.fill("#vd_saldo_fin", "2700000");
  await page.waitForTimeout(200);
  const estadoTexto = await page.locator("#vd_estado").innerText();
  check(estadoTexto.includes("cuadra"), `Muestra que la conciliación cuadra cuando el saldo final coincide (vi: "${estadoTexto}")`);

  await page.click("#vd_guardar");
  await page.waitForTimeout(500);
  const updateConc = page.escrituras.find((e) => e.kind === "update" && e.range.includes("Balance Mensual"));
  check(!!updateConc, `Guardar escribe en 'Balance Mensual' (vi ${JSON.stringify(page.escrituras.map((e) => e.kind))})`);

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario B: Salud de los Datos -- quincena duplicada, Prima mal
// etiquetada (corregir), y recategorizar un comercio en "Otros".
// ---------------------------------------------------------------------
async function testSaludDatos() {
  const MOCK_RANGES = {
    "'Colillas de Pago'!A150:G294": [
      ["01/06/2025", "2a quincena jun-2025", 3000000, 500000, "", "", ""],
      ["16/06/2025", "2a quincena jun-2025", 3100000, 510000, "", "", ""], // duplicada (sin Prima)
      ["16/07/2025", "2a quincena jul-2025", 3200000, 520000, "", "", ""], // esta SÍ trae la Prima
    ],
    "'Colillas de Pago'!A326:D531": [
      ["2a quincena jul-2025", "Prima de Servicios", "Prima de Servicios", 3200000],
    ],
    "'Colillas de Pago'!A545:D2010": [
      ["2a quincena jul-2025", "Salud", "Salud", 520000],
    ],
    "'Otros Ingresos'!A4:E5263": [],
    "'Egresos - Efectivo'!A15:K1999": [
      ["2026-01", "10/01/2026", "TIENDA X", "COP", "1/1", 50000, 50000, 0, "Otros", "No", ""],
    ],
    "'Egresos - Tarjeta Visa 7497'!A15:K5614": [],
    "'Egresos - Mastercard 5922'!A15:K5601": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Deudas - Resumen'!A5:H10": [],
    "'Resumen'!B5:E18": [],
    "'Categorías'!A2:A25": [["Otros"], ["Mercado y Supermercado"], ["Transporte"]],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("🔍 Salud de los Datos")');
  await page.waitForTimeout(600);

  const dupTexto = await page.locator("#sd-duplicadas").innerText();
  check(dupTexto.includes("2a quincena jun-2025"), `Detecta la quincena duplicada (vi: "${dupTexto}")`);

  const primasTexto = await page.locator("#sd-primas").innerText();
  check(primasTexto.includes("2a quincena jul-2025") && primasTexto.includes("Corregir"), `Detecta la Prima mal etiquetada (vi: "${primasTexto.slice(0, 200)}")`);

  await page.click("#sd_corregir_primas");
  await page.waitForTimeout(500);
  const batchUpdatePrima = page.escrituras.find((e) => e.kind === "batchUpdate" && JSON.stringify(e.body).includes("Prima jul-2025"));
  check(!!batchUpdatePrima, `Corregir Prima escribe 'Prima jul-2025' en el resumen/devengos/descuentos (vi ${JSON.stringify(page.escrituras.map((e) => e.kind))})`);
  if (batchUpdatePrima) {
    const rangosEscritos = batchUpdatePrima.body.data.map((d) => d.range);
    check(rangosEscritos.some((r) => r.includes("B")), `Incluye la celda del resumen (columna B) (vi: ${JSON.stringify(rangosEscritos)})`);
  }

  // Recategorizar el comercio "Otros".
  await page.waitForTimeout(300);
  const gastoOtrosTexto = await page.locator("#sd-gasto-otros").innerText();
  check(gastoOtrosTexto.includes("TIENDA X"), `Muestra el comercio en 'Otros' para recategorizar (vi: "${gastoOtrosTexto.slice(0, 200)}")`);
  await page.selectOption(".sd-gasto-nueva-cat", "Mercado y Supermercado");
  await page.click("#sd_gasto_aplicar");
  await page.waitForTimeout(500);
  const batchUpdateRecat = page.escrituras.find((e) => e.kind === "batchUpdate" && JSON.stringify(e.body).includes("Mercado y Supermercado"));
  check(!!batchUpdateRecat, `Recategorizar comercio escribe la nueva categoría (vi ${JSON.stringify(page.escrituras.map((e) => e.kind))})`);

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario C: Informe de Inversiones -- separa Fiducuenta (liquidez) del
// valor/costo real, capital propio y XIRR.
// ---------------------------------------------------------------------
async function testInformeInversiones() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [
      ["Acciones y Valores - ECOPETROL", "Acción", 10, 2500, 25000, 3000, 30000, 5000],
      ["Fiducuenta (reserva impuestos)", "Fiducuenta", 1, 1000000, 1000000, 1, 1000000, 0],
    ],
    "'Inversiones - Dólares'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [
      ["01/01/2026", "Acciones y Valores", 25000, ""],
    ],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Historial de Valor de Cartera'!A2:F5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#ii-contenido").innerText();
  // Valor de las posiciones (solo ECOPETROL, sin Fiducuenta) = 30.000.
  check(texto.includes("30.000") || texto.includes("30,000"), `Valor de las posiciones excluye Fiducuenta (vi: "${texto.slice(0, 400)}")`);
  // Ganancia = 30000-25000 = 5000, retorno bruto = 5000/25000*100 = 20.0%.
  check(texto.includes("20.0%") || texto.includes("+20.0%"), `Retorno bruto correcto (20%) (vi: "${texto.slice(0, 600)}")`);
  check(texto.includes("Fiducuenta") === false || texto.includes("margen prestado") || texto.includes("efectivo sin invertir"),
    "Fiducuenta no aparece como posición real, solo como ajuste (si aparece, es en el aviso de margen/efectivo)");

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario D: Informe de Presupuesto -- ingresos/gastos, tasa de ahorro,
// esencial/no esencial, presupuesto vs. real.
// ---------------------------------------------------------------------
async function testInformePresupuesto() {
  const MOCK_RANGES = {
    "'Colillas de Pago'!A150:G294": [
      ["10/01/2026", "1a quincena ene-2026", 3000000, 500000, "", "", ""],
    ],
    "'Colillas de Pago'!A326:D531": [],
    "'Colillas de Pago'!A545:D2010": [],
    "'Otros Ingresos'!A4:E5263": [],
    "'Egresos - Efectivo'!A15:K1999": [
      ["2026-01", "10/01/2026", "MERCADO", "COP", "1/1", 500000, 500000, 0, "Mercado y Supermercado", "No", ""],
      ["2026-01", "12/01/2026", "CINE", "COP", "1/1", 100000, 100000, 0, "Entretenimiento", "No", ""],
    ],
    "'Egresos - Tarjeta Visa 7497'!A15:K5614": [],
    "'Egresos - Mastercard 5922'!A15:K5601": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Deudas - Resumen'!A5:H10": [],
    "'Resumen'!B5:E18": [],
    "'Resumen Mensual'!B5:G30": [
      ["2025-12", 2800000, 400000, 0, 0, 2400000],
      ["2026-01", 3000000, 600000, 0, 0, 2400000],
    ],
    "'Presupuesto'!A5:E63": (() => {
      // Filas 5..63 -> índice 0 = fila 5. Fila 8 (índice 3) = primera categoría.
      const vals = [];
      for (let n = 5; n <= 63; n++) {
        if (n === 8) vals.push(["Mercado y Supermercado", 400000, 500000, -100000, 125]);
        else if (n === 9) vals.push(["Entretenimiento", 200000, 100000, 100000, 50]);
        else vals.push(["", "", "", "", ""]);
      }
      return vals;
    })(),
    "'Categorías Esenciales'!A5:B60": [],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📊 Informe de Presupuesto, Ingresos y Gastos")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#ip-contenido").innerText();
  // Total histórico: ingresos = 3.000.000 (colilla devengos totales).
  check(texto.includes("3.000.000") || texto.includes("3,000,000"), `Ingresos totales correctos (vi: "${texto.slice(0, 300)}")`);
  // Las categorías del gráfico de gastos viven en el canvas (Chart.js), no
  // en el DOM/innerText -- se verifica que el gráfico se armó (el canvas
  // sigue en el DOM, no fue reemplazado por "(sin datos)") en vez de buscar
  // el texto de la categoría en la página.
  const chartGastosExiste = await page.locator("#ip_chart_gastos").count();
  check(chartGastosExiste === 1, "El gráfico de gastos por categoría se renderiza (no 'sin datos')");

  const presupuestoTexto = await page.locator("#ip_presupuesto").innerText();
  check(presupuestoTexto.includes("Mercado y Supermercado"), `Presupuesto vs. real: categoría pasada de meta detectada (vi: "${presupuestoTexto}")`);
  check(presupuestoTexto.toLowerCase().includes("pasaste"), `Aviso de categoría pasada de presupuesto (vi: "${presupuestoTexto}")`);

  const esencialesTexto = await page.locator("#ip_esenciales").innerText();
  check(esencialesTexto.includes("Esencial") && esencialesTexto.includes("No esencial"), `Desglose esencial/no esencial presente (vi: "${esencialesTexto}")`);

  await browser.close();
}

(async () => {
  await testVerificarDatos();
  await testSaludDatos();
  await testInformeInversiones();
  await testInformePresupuesto();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
