const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

// Fechas como texto (ya "post-serialToText") ya que solo importa el orden
// cronológico relativo, no el valor exacto de cada serial.
const MOCK_RANGES = {
  "'Inversiones - Pesos'!A79:D1000": [],
  "'Inversiones - Dólares'!A79:D1000": [],
  "'Inversiones - Pesos'!A5:H45": [],
  "'Inversiones - Dólares'!A5:H45": [],
  "'Historial de Inversiones'!A2:J5000": [
    // AAPL en Trii (USD): compra + venta parcial -> queda abierta larga, con resultado realizado.
    ["01/01/2025", "Trii", "USD", "AAPL", "BUY", 10, 150, 1, 0, "reporte1.csv"],
    ["01/03/2025", "Trii", "USD", "AAPL", "SELL", 4, 180, 1, 120, "reporte1.csv"],
    // ECOPETROL en Acciones y Valores (COP): compra + venta total -> cerrada.
    ["05/01/2025", "Acciones y Valores", "COP", "ECOPETROL", "BUY", 100, 2000, 0, 0, "reporte2.csv"],
    ["05/06/2025", "Acciones y Valores", "COP", "ECOPETROL", "SELL", 100, 2500, 0, 50000, "reporte2.csv"],
    // TSLA en corto -> Estrategia "Corto", sigue abierta corta.
    ["10/02/2025", "Trii", "USD", "TSLA", "SHORT", 5, 200, 1, 0, "reporte1.csv"],
    // Dividendo de AAPL -> va a "pasivos", no a hist.
    ["15/03/2025", "Trii", "USD", "AAPL", "DIVIDEND", 0, 0, 0, 8.5, "reporte1.csv"],
    ["15/06/2025", "Trii", "USD", "AAPL", "DIVIDEND", 0, 0, 0, 9.2, "reporte1.csv"],
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

  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  const tituloVisible = await page.locator('#inv-historial h4:has-text("Historial de posiciones")').count();
  check(tituloVisible === 1, "Historial: título de la sección se renderiza");

  const metricLabels = await page.locator("#inv-historial .metric-row").first().locator(".metric-label").allTextContents();
  check(metricLabels.includes("Posiciones cerradas") && metricLabels.includes("Estrategias en corto"),
    `Historial: metric-row con los 4 KPIs (vi: ${JSON.stringify(metricLabels)})`);
  const metricValues = await page.locator("#inv-historial .metric-row").first().locator(".metric-value").allTextContents();
  // 1 posición cerrada (ECOPETROL); 2 estrategias en corto? No -- solo TSLA es "Corto" -> 1.
  check(metricValues[0] === "1", `Historial: 1 posición cerrada (ECOPETROL) (vi: "${metricValues[0]}")`);
  check(metricValues[1] === "1", `Historial: 1 estrategia en corto (TSLA) (vi: "${metricValues[1]}")`);

  const filasResumen = await page.locator("#hist_resumen_tabla tbody tr").count();
  check(filasResumen === 3, `Historial: resumen agrupa en 3 posiciones (AAPL/ECOPETROL/TSLA) (vi: ${filasResumen})`);

  const textoResumen = await page.locator("#hist_resumen_tabla").innerText();
  check(/Abierta larga/.test(textoResumen) && /Abierta corta/.test(textoResumen) && /Cerrada/.test(textoResumen),
    "Historial: los 3 estados (Abierta larga/Abierta corta/Cerrada) aparecen en el resumen");
  check(/Corto/.test(textoResumen) && /Largo/.test(textoResumen),
    "Historial: las 2 estrategias (Corto/Largo) aparecen en el resumen");

  const filasCompletas = await page.locator("#hist_todas_tabla tbody tr").count();
  check(filasCompletas === 5, `Historial: 'Ver todas las operaciones' excluye los 2 dividendos (5 de 7) (vi: ${filasCompletas})`);

  // Dividendos e intereses (2 filas DIVIDEND de AAPL en USD).
  const pasivoLabels = await page.locator("#hist_pasivos .metric-row .metric-label").allTextContents();
  check(pasivoLabels.includes("Recibido en USD") && pasivoLabels.includes("Recibido en COP"),
    `Dividendos: metric-row presente (vi: ${JSON.stringify(pasivoLabels)})`);
  const pasivoValues = await page.locator("#hist_pasivos .metric-row .metric-value").allTextContents();
  check(pasivoValues[0] === "US$ 17.70", `Dividendos: Recibido en USD = 8.5+9.2 (vi: "${pasivoValues[0]}")`);

  const filasPasivos = await page.locator("#hist_pasivos_tabla tbody tr").count();
  check(filasPasivos === 2, `Dividendos: detalle muestra las 2 filas de DIVIDEND (vi: ${filasPasivos})`);

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
