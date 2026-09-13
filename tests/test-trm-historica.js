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
    if (ranges.some((r) => r.includes("Historial TRM (Auto)")) && MOCK_RANGES.__sinHistorialTrm) {
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "Unable to parse range: Historial TRM (Auto)!A2:B5000" } }) });
      return;
    }
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

const MOCK_BASE = {
  "'Inversiones - Pesos'!A5:H45": [],
  "'Inversiones - Dólares'!A5:H45": [
    ["IBKR - MSFT", "Acción", 2, 450, 900, 550, 1100, 200],
  ],
  "'Inversiones - Pesos'!A79:D1000": [],
  "'Inversiones - Dólares'!A79:D1000": [
    ["2026-01-01", "Interactive Brokers", 4000000, ""],
  ],
  "'Historial de Inversiones'!A2:J5000": [],
  "'Historial de Valor de Cartera'!A2:F5000": [
    ["2026-01-01", "dolares", 900, 1000, 1000],
    ["2026-02-01", "dolares", 900, 1100, 1000],
  ],
  "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4200]],
  "'Historial TRM (Auto)'!A2:B5000": [
    ["2026-01-01", 4000],
    ["2026-01-15", 4100],
    ["2026-02-01", 4200],
  ],
};

// ---------------------------------------------------------------------
// Escenario A: con 'Historial TRM (Auto)' disponible -- TWR en dólares y
// "Efecto cambiario de los aportes" se calculan (ya no dicen "no disponible").
// ---------------------------------------------------------------------
async function testConHistorialTrm() {
  const MOCK_RANGES = { ...MOCK_BASE };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#ii-contenido").innerText();
  check(texto.includes("Efecto cambiario de los aportes"), `Muestra la sección de efecto cambiario (vi: "${texto.slice(0, 200)}")`);
  check(!texto.includes("No pude calcular el efecto cambiario"), "No muestra el aviso de 'no disponible' cuando SÍ hay histórico de TRM");

  // Aportado histórico = 4.000.000; TRM en 2026-01-01 = 4000 -> USD equiv = 1000;
  // TRM hoy = 4200 -> valor hoy = 4.200.000; diferencia = +200.000 (+5%).
  check(texto.includes("4.000.000") || texto.includes("4,000,000"), `Aportado histórico correcto (vi ausencia en: "${texto.slice(0, 1500)}")`);
  check(texto.includes("US$ 1,000.00") || texto.includes("US$ 1.000,00") || texto.includes("1,000.00"),
    "Equivalente en dólares al aportar = 1.000 (4.000.000 / TRM 4000 del día del aporte)");
  check(texto.includes("4.200.000") || texto.includes("4,200,000"), "Esos mismos dólares valen hoy 4.200.000 (1000 * TRM hoy 4200)");
  check(texto.includes("dólar subió"), "El efecto cambiario es positivo (TRM subió de 4000 a 4200) -> aviso de éxito");

  check(!texto.includes("Necesita el histórico de TRM"), "El TWR en dólares ya no dice que necesita el histórico (porque sí está disponible)");

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario B: SIN 'Historial TRM (Auto)' todavía (Action nunca corrió con
// esto, o nunca hubo aporte en dólares) -- degrada con avisos claros, sin
// romper el resto del informe.
// ---------------------------------------------------------------------
async function testSinHistorialTrm() {
  const MOCK_RANGES = { ...MOCK_BASE, __sinHistorialTrm: true };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#ii-contenido").innerText();
  check(!texto.includes("<div class=\"error\">"), "La página entera no se rompe cuando falta 'Historial TRM (Auto)'");
  check(texto.includes("No pude calcular el efecto cambiario"), `Efecto cambiario muestra el aviso de no disponible (vi: "${texto.slice(0, 300)}")`);
  check(texto.includes("Necesita el histórico de TRM"), "TWR en dólares muestra el aviso explicando por qué falta");
  // El resto del informe (retorno bruto, XIRR, composición) sigue andando.
  check(texto.includes("Retorno simple (bruto)"), "El resto de las métricas de rendimiento sigue mostrándose");

  await browser.close();
}

(async () => {
  await testConHistorialTrm();
  await testSinHistorialTrm();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
