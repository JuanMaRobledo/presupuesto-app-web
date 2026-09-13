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
  // No hace falta XLSX/pdf.js reales para estos tests (no se sube ningún
  // .xlsx ni PDF) -- stub mínimo para que app.html no truene al cargar.
  await page.route("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.XLSX = {};" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.pdfjsLib = { GlobalWorkerOptions: {} };" })
  );

  const escrituras = [];
  // Catch-all genérico PRIMERO (menos prioridad) para que los handlers
  // específicos de :append/:batchUpdate, registrados después, intercepten.
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const body = route.request().postDataJSON();
    escrituras.push({ kind: "update", body });
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

  page.escrituras = escrituras;
}

async function gotoLoggedIn(page) {
  await page.goto(`${BASE}/app.html`);
  await page.waitForFunction(() => typeof Auth !== "undefined");
  await page.evaluate(() => { Auth.getToken = () => "FAKE_TOKEN_FOR_TESTS"; });
  await page.evaluate(() => mostrarApp());
  await page.waitForFunction(() => typeof ImportarPortafolio !== "undefined");
}

// ---------------------------------------------------------------------
// Escenario A: lógica pura -- resumenOperacionesInversion (BUY+SELL con
// comisiones), parseInversionCSV para los 4 formatos, y cruzarFlujos1031.
// Se corre dentro del navegador con page.evaluate() para probar el código
// real del módulo, sin reimplementarlo en el test.
// ---------------------------------------------------------------------
async function testLogicaPura() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await setupMocks(page, {});
  await gotoLoggedIn(page);

  const r = await page.evaluate(() => {
    // BUY 5@150 (+1 comisión) luego SELL 2@170 (comisión 1) -- Hapi (USD).
    const operaciones = [
      { date: "2025-03-01", time: "10:00:00", symbol: "AAPL", type: "BUY", quantity: 5, price: 150, commission: 1, current_price: 160, source: "a.csv", moneda: "USD" },
      { date: "2025-03-10", time: "11:00:00", symbol: "AAPL", type: "SELL", quantity: 2, price: 170, commission: 1, current_price: 160, source: "a.csv", moneda: "USD" },
    ];
    const { posiciones, historial } = ImportarPortafolio.resumenOperacionesInversion(operaciones, "Hapi");
    return { posiciones, historial };
  });
  check(r.posiciones.length === 1, `Una posición abierta tras BUY 5 + SELL 2 (vi ${r.posiciones.length})`);
  const pos = r.posiciones[0];
  check(pos.ticker === "Hapi - AAPL", `Ticker correcto (vi "${pos.ticker}")`);
  check(Math.abs(pos.cantidad - 3) < 1e-9, `Quedan 3 unidades (vi ${pos.cantidad})`);
  check(Math.abs(pos.precio_compra - 150.2) < 1e-6, `Costo promedio 150.2 tras vender parcialmente (vi ${pos.precio_compra})`);
  check(pos.precio_actual === 160, `Precio actual tomado de current_price (vi ${pos.precio_actual})`);
  const sell = r.historial.find((h) => h.operacion === "SELL");
  check(Math.abs(sell.resultado_realizado - 38.6) < 1e-6, `Resultado realizado de la venta = 38.6 (vi ${sell.resultado_realizado})`);
  check(sell.estado === "Abierta larga", `La posición sigue "Abierta larga" tras vender solo parte (vi "${sell.estado}")`);

  // CSV de Acciones y Valores -- compra.
  const csvAcciones = `Fecha y hora,Estado,Tipo de orden,Símbolo de la acción,Acciones completadas,Precio por acción,Valor comisión\n"1 mar 2025",Aprobado,Compra,ECOPETROL,10/10,2500,5000\n`;
  const rAcciones = await page.evaluate((csv) => ImportarPortafolio.parseInversionCSV(csv, "acciones.csv"), csvAcciones);
  check(rAcciones.posiciones.length === 1 && rAcciones.posiciones[0].ticker === "Acciones y Valores - ECOPETROL",
    `CSV Acciones y Valores (compra) detecta la posición (vi ${JSON.stringify(rAcciones.posiciones)})`);
  check(rAcciones.posiciones[0].moneda === "pesos", "La posición de Acciones y Valores queda en pesos");
  check(rAcciones.historial[0].fecha === "2025-03-01", `Fecha en español parseada a ISO (vi "${rAcciones.historial[0].fecha}")`);

  // CSV de Acciones y Valores -- movimiento (depósito).
  const csvMov = `Fecha y hora,Estado,Tipo de movimiento,Valor total\n"5 mar 2025",Aprobado,Depósito,500000\n`;
  const rMov = await page.evaluate((csv) => ImportarPortafolio.parseInversionCSV(csv, "mov.csv"), csvMov);
  check(rMov.flujos.length === 1 && rMov.flujos[0].monto_origen === 500000 && rMov.flujos[0].fecha === "2025-03-05",
    `CSV de movimientos detecta el depósito (vi ${JSON.stringify(rMov.flujos)})`);

  // CSV "portfolio" (Hapi) con $$CASH_TX.
  const csvPortfolio = `Transaction Type,Symbol,Trade Date,Quantity,Purchase Price,Commission,Current Price,Time\nDEPOSIT,$$CASH_TX,20250228,1000,,,,\nBUY,MSFT,20250301,1,300,0,310,10:00:00\n`;
  const rPortfolio = await page.evaluate((csv) => ImportarPortafolio.parseInversionCSV(csv, "hapi.csv"), csvPortfolio);
  check(rPortfolio.flujos.length === 1 && rPortfolio.flujos[0].fecha === "2025-02-28" && rPortfolio.flujos[0].monto_origen === 1000,
    `CSV portfolio detecta el depósito $$CASH_TX (vi ${JSON.stringify(rPortfolio.flujos)})`);
  check(rPortfolio.posiciones[0].ticker === "Hapi - MSFT", `Plataforma detectada como Hapi (sin SHORT/COVER ni símbolo -USD) (vi "${rPortfolio.posiciones[0].ticker}")`);

  // CSV Binance -- movimientos.
  const csvBinance = `Hora,Operación,Moneda,Cambiar\n2025-04-01 10:00:00,Deposit,COP,300000\n2025-04-02 11:00:00,P2P Trading,USDT,70.5\n2025-04-03 12:00:00,Buy Crypto With Fiat,BTC,0.002\n`;
  const rBinance = await page.evaluate((csv) => ImportarPortafolio.parseInversionCSV(csv, "binance.csv"), csvBinance);
  check(rBinance.flujos.length === 3, `CSV Binance detecta 3 flujos (vi ${rBinance.flujos.length})`);
  check(rBinance.flujos[2].importe_fiat_desconocido === true, "El flujo 'Buy Crypto With Fiat' queda marcado con importe fiat desconocido");
  check(rBinance.posiciones.some((p) => p.ticker === "Binance - BTC") && rBinance.posiciones.some((p) => p.ticker === "Binance - USDT"),
    `Posiciones de Binance detectadas desde 'Moneda'/'Cambiar' (vi ${JSON.stringify(rBinance.posiciones)})`);

  // Cruce con la cuenta 1031.
  const rCruce = await page.evaluate(() => {
    const flujos = [{ fecha: "2025-03-05", monto_origen: 500000, moneda_origen: "COP", plataforma: "Acciones y Valores", moneda_cuenta: "pesos", tipo_flujo: "Depósito", fuente: "x.csv" }];
    const egresos = [{ FechaCompra: "05/03/2025", Comercio: "PAGO PSE ACCIONES Y VAL", ValorTotal: 500000 }];
    return ImportarPortafolio.cruzarFlujos1031(flujos, egresos, []);
  });
  check(rCruce.length === 1 && rCruce[0].estado === "Conciliado" && rCruce[0].cop === 500000,
    `El flujo se concilia contra el egreso de la cuenta 1031 (vi ${JSON.stringify(rCruce)})`);

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario B: flujo completo desde la UI -- subir un CSV real, ver la
// previsualización y el cruce, y confirmar que "Guardar" escribe posiciones
// (batchUpdate), el aporte conciliado (append a Inversiones - Pesos) y el
// historial (append a Historial de Inversiones).
// ---------------------------------------------------------------------
async function testFlujoCompletoUI() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Dólares'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
    "'Historial de Valor de Cartera'!A2:F5000": [],
    "'Egresos - Efectivo'!A15:K1999": [
      ["2025-03", "05/03/2025", "PAGO PSE ACCIONES Y VAL", "COP", "1/1", 500000, 500000, 0, "Otros", "No", ""],
    ],
    "'Otros Ingresos'!A4:E5263": [],
    "'Egresos - Tarjeta Visa 7497'!A5621:K5660": [],
    "'Egresos - Mastercard 5922'!A5608:K5647": [],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);
  await page.click('#inv-importar summary');

  const csvCompra = `Fecha y hora,Estado,Tipo de orden,Símbolo de la acción,Acciones completadas,Precio por acción,Valor comisión\n"1 mar 2025",Aprobado,Compra,ECOPETROL,10/10,2500,5000\n`;
  const csvDeposito = `Fecha y hora,Estado,Tipo de movimiento,Valor total\n"5 mar 2025",Aprobado,Depósito,500000\n`;
  await page.setInputFiles("#imp_csv", [
    { name: "acciones-compra.csv", mimeType: "text/csv", buffer: Buffer.from(csvCompra, "utf8") },
    { name: "acciones-deposito.csv", mimeType: "text/csv", buffer: Buffer.from(csvDeposito, "utf8") },
  ]);
  await page.waitForTimeout(800);

  const resultadoTexto = await page.locator("#imp_resultado").innerText();
  check(resultadoTexto.includes("Acciones y Valores - ECOPETROL"), `La previsualización muestra la posición detectada (vi: "${resultadoTexto.slice(0, 200)}")`);
  check(resultadoTexto.includes("Conciliado"), `El cruce con la cuenta 1031 se muestra como Conciliado (vi: "${resultadoTexto.slice(0, 400)}")`);

  await page.click("#imp_guardar");
  await page.waitForTimeout(500);

  const escrituras = page.escrituras;
  const batchUpdatePos = escrituras.find((e) => e.kind === "batchUpdate" && JSON.stringify(e.body).includes("ECOPETROL"));
  check(!!batchUpdatePos, `Guardar escribe la posición vía batchUpdate (vi ${escrituras.map((e) => e.kind).join(",")})`);

  const appendAporte = escrituras.find((e) => e.kind === "append" && e.range && e.range.includes("Inversiones - Pesos"));
  check(!!appendAporte, "Guardar agrega el aporte conciliado a 'Inversiones - Pesos'");
  if (appendAporte) {
    check(appendAporte.body.values[0][2] === 500000, `El aporte conciliado tiene el monto correcto (vi ${JSON.stringify(appendAporte.body.values[0])})`);
  }

  const appendHistorial = escrituras.find((e) => e.kind === "append" && e.range && e.range.includes("Historial"));
  check(!!appendHistorial, "Guardar agrega la operación al historial");
  if (appendHistorial) {
    check(appendHistorial.body.values[0][3] === "ECOPETROL", `La fila del historial es la operación importada (vi ${JSON.stringify(appendHistorial.body.values[0])})`);
  }
  // Nota: no se verifica el mensaje de éxito en #imp_msg -- "Guardar" llama
  // a recargar(), que reemplaza TODO el contenido de Inversiones (incluido
  // #imp_msg) por un render nuevo, igual que el patrón ya documentado en
  // declaraciones.js/ingresos.js/test-historial-inversion.js. El efecto real
  // (las escrituras de arriba) ya quedó verificado.

  await browser.close();
}

(async () => {
  await testLogicaPura();
  await testFlujoCompletoUI();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
