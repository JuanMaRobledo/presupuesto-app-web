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
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(){ this.destroy=function(){}; };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.XLSX = {};" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.pdfjsLib = { GlobalWorkerOptions: {} };" })
  );
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
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

// Dólares: IBKR - MSFT vale 1.100 USD (bruto), pero hay 300 USD de margen
// prestado (Efectivo/Margen negativo) -- capital propio = 800 USD. Un solo
// aporte de 4.000.000 COP el 2026-01-01. TRM de hoy = 4.000.
//   - Bruto (1.100 USD -> 4.400.000 COP): MÁS que lo aportado -> XIRR positivo.
//   - Capital propio (800 USD -> 3.200.000 COP): MENOS que lo aportado -> XIRR negativo.
// El signo (no el % exacto, que depende de cuántos días pasaron desde la
// fecha fija del aporte hasta "hoy") es lo que prueba que el margen prestado
// de verdad se está restando del valor final en el XIRR, y no solo en la
// rentabilidad simple/estática que ya existía.
const MOCK_DOLARES_CON_MARGEN = {
  "'Inversiones - Dólares'!A5:H45": [
    ["IBKR - MSFT", "Acción", 2, 450, 900, 550, 1100, 200],
    ["IBKR - Efectivo/Margen", "Otro", 1, 0, 0, -300, -300, 0],
  ],
  "'Inversiones - Dólares'!A79:D1000": [
    ["2026-01-01", "Interactive Brokers", 4000000, ""],
  ],
  "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
  "'Historial TRM (Auto)'!A2:B5000": [["2026-01-01", 4000]],
  "'Historial de Inversiones'!A2:J5000": [],
  "'Historial de Valor de Cartera'!A2:E5000": [],
};

async function testXirrCapitalPropioInforme() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    ...MOCK_DOLARES_CON_MARGEN,
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
  check(texto.includes("XIRR sobre capital propio"), `El informe muestra la fila "XIRR sobre capital propio" (vi: "${texto.slice(0, 200)}")`);

  const filaXirr = texto.match(/XIRR \(anualizado\)\s*([+-]?[\d.]+)%/);
  const filaXirrPropio = texto.match(/XIRR sobre capital propio\s*([+-]?[\d.]+)%/);
  check(!!filaXirr && !!filaXirrPropio, `Ambas filas de XIRR tienen un valor calculado (vi: XIRR=${filaXirr && filaXirr[1]}, propio=${filaXirrPropio && filaXirrPropio[1]})`);
  if (filaXirr && filaXirrPropio) {
    check(parseFloat(filaXirr[1]) > 0, `XIRR bruto es positivo (ignora los 300 USD de margen, 1.100 USD > lo aportado) (vi: ${filaXirr[1]}%)`);
    check(parseFloat(filaXirrPropio[1]) < 0, `XIRR sobre capital propio es NEGATIVO (800 USD de capital propio < lo aportado, el margen restado lo cambia todo) (vi: ${filaXirrPropio[1]}%)`);
  }

  await browser.close();
}

async function testXirrUnificado() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [
      ["Acciones y Valores - ECOPETROL", "Acción", 1, 800000, 800000, 1000000, 1000000, 200000],
    ],
    "'Inversiones - Pesos'!A79:D1000": [
      ["2026-01-01", "Acciones y Valores", 800000, ""],
    ],
    ...MOCK_DOLARES_CON_MARGEN,
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#inv-contenido").innerText();
  check(texto.includes("Rentabilidad unificada"), `Muestra la sección "Rentabilidad unificada" (vi: "${texto.slice(0, 300)}")`);
  check(texto.includes("XIRR unificado (pesos + dólares, sobre capital propio)"),
    `Muestra la métrica "XIRR unificado..." (vi: "${texto.slice(0, 400)}")`);

  // Capital propio combinado hoy: 1.000.000 (pesos) + (1.100 - 300) USD * TRM 4.000 = 1.000.000 + 3.200.000 = 4.200.000
  // Aportado combinado: 800.000 (pesos) + 4.000.000 (dólares, ya en COP) = 4.800.000
  // 4.200.000 < 4.800.000 -> el XIRR unificado tiene que dar negativo.
  const filaUnificado = texto.match(/XIRR unificado \(pesos \+ dólares, sobre capital propio\)\s*([+-]?[\d.]+)%/);
  check(!!filaUnificado, `El XIRR unificado tiene un valor calculado, no "—" (vi: "${texto.slice(texto.indexOf("Rentabilidad unificada"), texto.indexOf("Rentabilidad unificada") + 400)}")`);
  if (filaUnificado) {
    check(parseFloat(filaUnificado[1]) < 0,
      `XIRR unificado es negativo (4.200.000 de capital propio combinado < 4.800.000 aportado) (vi: ${filaUnificado[1]}%)`);
  }

  await browser.close();
}

(async () => {
  await testXirrCapitalPropioInforme();
  await testXirrUnificado();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
