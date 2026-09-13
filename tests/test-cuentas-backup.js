const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const BASE = "http://localhost:8123";
const NODE_MODULES = path.join(__dirname, "..", "node_modules");

async function setupMocks(page, MOCK_RANGES, { hojas } = {}) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(ctx, cfg) { this.destroy = function(){}; this._cfg = cfg; };" })
  );
  // Sin acceso de red saliente a jsdelivr en este sandbox -- se sirve xlsx
  // real desde el node_modules local (usado por Backup.descargarExcel()).
  await page.route("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(`${NODE_MODULES}/xlsx/dist/xlsx.full.min.js`, "utf8") })
  );
  await page.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(`${NODE_MODULES}/pdfjs-dist/build/pdf.min.js`, "utf8") })
  );
  await page.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(`${NODE_MODULES}/pdfjs-dist/build/pdf.worker.min.js`, "utf8") })
  );
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
  });
  if (hojas) {
    // La llamada de metadata (listarHojas) es un GET plano al recurso del
    // spreadsheet, sin sufijo :batchGet -- va antes que la ruta de arriba
    // para no chocar (Playwright prioriza la más reciente).
    await page.route(`https://sheets.googleapis.com/v4/spreadsheets/${"1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk"}?**`, (route) => {
      if (route.request().url().includes(":batchGet")) return route.continue();
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ sheets: hojas.map((t) => ({ properties: { title: t } })) }) });
    });
  }
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

// ---------------------------------------------------------------------
// Escenario A: la tabla de aportes (reportado por el usuario: Fiducuenta
// aparecía mezclada con Acciones y Valores en la misma tabla/leyenda fija) --
// ahora Fiducuenta vive en su propio bloque, aparte del de las plataformas
// de inversión de verdad, cada uno con su propio Depósitos/Retiros/Flujo
// neto (no una casilla compartida dentro de la misma tabla).
// ---------------------------------------------------------------------
async function testAportesFiducuentaAparte() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [
      ["Acciones y Valores - EIMICO", "Acción", 16, 185370.5769, 2965929, 177400, 2838400, -127529],
    ],
    "'Inversiones - Dólares'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [
      ["2025-10-31", "Acciones y Valores", 5000000, ""],
      ["2025-09-16", "Fiducuenta (reserva impuestos)", -7000000, "Retiro para pagar impuestos"],
      ["2025-07-01", "Fiducuenta (reserva impuestos)", 7000000, ""],
    ],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 3077.49]],
    "'Historial de Valor de Cartera'!A2:F5000": [],
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  const divPesos = page.locator("#aportes-pesos");
  const textoCompleto = await divPesos.innerText();
  check(textoCompleto.includes("Trii / Acciones y Valores") && textoCompleto.includes("Fiducuenta (reserva de impuestos)"),
    `Hay dos encabezados separados, uno por bloque (vi: "${textoCompleto.slice(0, 200)}")`);

  const textoInv = await divPesos.locator("#aportes_inv_pesos").innerText();
  check(textoInv.includes("EIMICO") === false && textoInv.includes("Fiducuenta") === false,
    `El bloque de Acciones y Valores no muestra filas de Fiducuenta (vi: "${textoInv}")`);
  check(textoInv.includes("$5,000,000"), `El bloque de Acciones y Valores solo suma su propio depósito = 5.000.000 (vi: "${textoInv}")`);

  const textoFid = await divPesos.locator("#aportes_fid_pesos").innerText();
  check(textoFid.includes("Acciones y Valores") === false,
    `El bloque de Fiducuenta no muestra filas de Acciones y Valores (vi: "${textoFid}")`);
  check(textoFid.includes("$7,000,000"), `El bloque de Fiducuenta suma depósitos y retiros de 7.000.000 cada uno, aparte (vi: "${textoFid}")`);

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario B: bug fix -- marcar Fiducuenta en "Rentabilidad personalizada"
// debe sumar TAMBIÉN su valor de posición (antes solo sumaba sus aportes,
// con el valor en cero -- el mismo patrón de bug "-768%" reintroducido).
// ---------------------------------------------------------------------
async function testRentabilidadPersonalizadaIncluyeFiducuenta() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [
      ["Acciones y Valores - EIMICO", "Acción", 16, 185370.5769, 2965929, 177400, 2838400, -127529],
      ["Fiducuenta (reserva impuestos)", "Fiducuenta", 1, 10000000, 10000000, 11000000, 11000000, 1000000],
    ],
    "'Inversiones - Dólares'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [
      ["2025-06-01", "Acciones y Valores", 5000000, ""],
      ["2025-01-01", "Fiducuenta (reserva impuestos)", 10000000, ""],
    ],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 3077.49]],
    "'Historial de Valor de Cartera'!A2:F5000": [
      ["01/09/2026", "pesos", 2965929, 2838400, 5000000],
    ],
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  const divPesos = page.locator("#inv-crecimiento-pesos");
  // Marcar Fiducuenta -- valor combinado = 2,838,400 + 11,000,000 =
  // 13,838,400; aportes combinados = 5,000,000 + 10,000,000 = 15,000,000;
  // (13,838,400-15,000,000)/15,000,000 = -7.74% (NO 0% ni un valor que
  // ignore los 11,000,000 de Fiducuenta).
  await divPesos.locator('.checks-row input[value="Fiducuenta (reserva impuestos)"]').check();
  await page.waitForTimeout(100);
  const texto = await divPesos.innerText();
  check(texto.includes("-7.74%"),
    `Al marcar Fiducuenta, el valor de SU posición (11,000,000) se suma correctamente (vi: "${texto}")`);
  check(!texto.includes("-100.00%"), "No debería dar -100% (que pasaría si el valor de Fiducuenta se ignorara)");

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario C: el efectivo/margen del broker es una cuenta seleccionable
// aparte de las acciones de esa misma plataforma.
// ---------------------------------------------------------------------
async function testEfectivoMargenCuentaAparte() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Dólares'!A5:H45": [
      ["IBKR - Efectivo/Margen", "Otro", 1, 0, 0, -500, -500, -500],
      ["IBKR - MSFT", "Acción", 2, 363.18, 726.36, 495.63, 991.26, 264.90],
    ],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A79:D1000": [
      ["2025-06-01", "Interactive Brokers", 800000, ""],
    ],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
    "'Historial de Valor de Cartera'!A2:F5000": [],
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  const divDolares = page.locator("#inv-crecimiento-dolares");
  const chkLabels = await divDolares.locator(".checks-row label").allTextContents();
  check(chkLabels.some((l) => l.includes("Interactive Brokers - Efectivo/Margen")),
    `El efectivo/margen aparece como cuenta propia, separada de "Interactive Brokers" (vi: ${JSON.stringify(chkLabels)})`);
  const chkStates = await divDolares.locator(".checks-row input[type=checkbox]").evaluateAll(
    (els) => els.map((e) => ({ value: e.value, checked: e.checked })));
  const efectivoChk = chkStates.find((c) => c.value.includes("Efectivo/Margen"));
  check(efectivoChk && efectivoChk.checked === false, "El efectivo/margen viene DESmarcado por defecto (sin retorno de mercado)");

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario D: botón de copia de seguridad -- lista las hojas reales del
// spreadsheet y arma el .xlsx con SheetJS (se verifica que el flujo llegue
// hasta "Listo", que implica que ambas llamadas de red se resolvieron bien).
// ---------------------------------------------------------------------
async function testBotonBackup() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  const MOCK_RANGES = {
    "'Hoja Uno'": [["a", "b"], [1, 2]],
    "'Hoja Dos'": [["x"]],
  };
  await setupMocks(page, MOCK_RANGES, { hojas: ["Hoja Uno", "Hoja Dos"] });
  await gotoLoggedIn(page);
  await page.waitForTimeout(300);

  check(await page.locator("#btn-backup").count() === 1, "El botón de copia de seguridad está en la barra lateral");

  await page.click("#btn-backup");
  await page.waitForTimeout(800);
  const estado = await page.locator("#backup-estado").innerText();
  check(estado.includes("Listo"), `El flujo de backup termina en "Listo" (vi: "${estado}")`);

  await browser.close();
}

(async () => {
  await testAportesFiducuentaAparte();
  await testRentabilidadPersonalizadaIncluyeFiducuenta();
  await testEfectivoMargenCuentaAparte();
  await testBotonBackup();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
