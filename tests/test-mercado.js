const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

// Copia exacta de xirr()/rentabilidadXirr() (js/pages/inversiones.js) -- para
// calcular el XIRR esperado con el mismo "hoy" real que usa el navegador,
// en vez de hardcodear un número que dependería del día en que corre el test.
function xirr(flujos) {
  if (flujos.length < 2) return null;
  const fecha0 = flujos.reduce((min, f) => (f.fecha < min ? f.fecha : min), flujos[0].fecha);
  const dias = (fecha) => (new Date(fecha) - new Date(fecha0)) / 86400000;
  const van = (tasa) => flujos.reduce((s, f) => s + f.monto / Math.pow(1 + tasa, dias(f.fecha) / 365), 0);
  let lo = -0.99, hi = 10.0;
  let vanLo = van(lo);
  const vanHi = van(hi);
  if (vanLo === 0) return lo;
  if (vanLo * vanHi > 0) return null;
  let mid = lo;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const vanMid = van(mid);
    if (Math.abs(vanMid) < 1e-6) return mid;
    if (vanLo * vanMid < 0) hi = mid; else { lo = mid; vanLo = vanMid; }
  }
  return mid;
}
const hoyISO = new Date().toISOString().slice(0, 10);
const xirrPesosEsperado = xirr([{ fecha: "2026-01-01", monto: -200000 }, { fecha: hoyISO, monto: 220000 }]);
// 800,000 COP aportados -> 220 USD * TRM 4000 = 880,000 COP equivalentes hoy (ganancia modesta, ~10%).
const xirrDolaresEsperado = xirr([{ fecha: "2026-01-01", monto: -800000 }, { fecha: hoyISO, monto: 880000 }]);

async function setupCommonMocks(page) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(ctx, cfg) { this.destroy = function(){}; this._cfg = cfg; };" })
  );
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
// Escenario A: el GitHub Action todavía no corrió ni una vez -- 'Datos de
// Mercado (Auto)' y 'Historial de Valor de Cartera' no existen todavía, así
// que ESE batchGet responde 400 (como hace la API real de Sheets cuando un
// rango referencia una hoja inexistente). El resto de Inversiones no debe
// romperse.
// ---------------------------------------------------------------------
async function testSinAction() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Inversiones - Pesos'!A5:H45": [["Trii - ECOPETROL", "Acción", 100, 2000, 200000, 2200, 220000, 20000]],
    "'Inversiones - Dólares'!A5:H45": [],
    "'Historial de Inversiones'!A2:J5000": [],
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await setupCommonMocks(page);

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
    if (ranges.some((r) => r.includes("Datos de Mercado") || r.includes("Historial de Valor de Cartera"))) {
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "Unable to parse range: hoja inexistente" } }) });
      return;
    }
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
  });

  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  check(await page.locator(".error").count() === 0, "Sin Action: la página NO se rompe (sin .error) cuando faltan las hojas");
  const textoPatrimonio = await page.locator("#inv-patrimonio").innerText();
  check(textoPatrimonio.includes("No pude leer la TRM"), `Sin Action: patrimonio unificado avisa que no hay TRM (vi: "${textoPatrimonio}")`);
  check(textoPatrimonio.includes("$220,000"), "Sin Action: igual muestra el patrimonio en pesos (sin unificar)");

  const textoCrecPesos = await page.locator("#inv-crecimiento-pesos").innerText();
  check(textoCrecPesos.includes("Todavía no hay historial para graficar"), "Sin Action: Crecimiento y Rentabilidad avisa que no hay historial todavía");

  // El resto de la página (Posiciones, que no depende del Action) sigue andando.
  check((await page.locator("h4:has-text(\"Posiciones — Pesos\")").count()) === 1, "Sin Action: el resto de Inversiones (Posiciones) sigue renderizando");

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario B: el Action ya corrió -- datos completos.
// ---------------------------------------------------------------------
async function testConAction() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A79:D1000": [["01/01/2026", "Trii", 200000, ""]],
    "'Inversiones - Dólares'!A79:D1000": [["01/01/2026", "Hapi", 800000, ""]],
    "'Inversiones - Pesos'!A5:H45": [["Trii - ECOPETROL", "Acción", 100, 2000, 200000, 2200, 220000, 20000]],
    // ValorActual=220 USD -- a propósito modesto frente al aporte de 800,000 COP (~10% de ganancia,
    // TRM 4000 => 880,000 COP equivalentes) para que la bisección de XIRR converja dentro de [-99%,1000%].
    "'Inversiones - Dólares'!A5:H45": [["Hapi - AAPL", "Acción", 10, 15, 150, 22, 220, 70]],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [
      ["Fecha de Actualización", "2026-09-12T22:00:00Z"],
      ["TRM (USD/COP)", 4000],
      ["TRM Fecha", "2026-09-11"],
      ["Benchmark Pesos", "COLCAP"],
      ["Benchmark Pesos Valor Shadow (COP)", 210000],
      ["Benchmark Dólares", "S&P 500"],
      ["Benchmark Dólares Valor Shadow (USD)", 200],
    ],
    "'Historial de Valor de Cartera'!A2:E5000": [
      ["01/01/2026", "pesos", 150000, 180000, 150000],
      ["01/09/2026", "pesos", 200000, 220000, 200000],
      ["01/01/2026", "dolares", 150, 200, 150],
      ["01/09/2026", "dolares", 180, 220, 180],
    ],
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await setupCommonMocks(page);

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
  });

  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  // ---------- Patrimonio unificado ----------
  const metPatrimonio = await page.locator("#inv-patrimonio .metric-row .metric-value").allTextContents();
  check(metPatrimonio[0] === "$220,000", `Patrimonio: Pesos = ValorActual de la posición (vi: "${metPatrimonio[0]}")`);
  check(metPatrimonio[1] === "$880,000", `Patrimonio: Dólares->COP = 220 USD * TRM 4000 (vi: "${metPatrimonio[1]}")`);
  check(metPatrimonio[2] === "$1,100,000", `Patrimonio: Total = 220,000 + 880,000 (vi: "${metPatrimonio[2]}")`);

  // ---------- Crecimiento y Rentabilidad -- Pesos ----------
  // Rentabilidad personalizada: única plataforma en pesos es "Trii", sin
  // Fiducuenta, así que viene marcada por defecto -- mismo resultado que la
  // vieja métrica fija.
  const divPesos = page.locator("#inv-crecimiento-pesos");
  const metPesos = await divPesos.locator("#rentper_metrics_pesos .metric-value").allTextContents();
  const labelsPesos = await divPesos.locator("#rentper_metrics_pesos .metric-label").allTextContents();
  const idxRentab = labelsPesos.indexOf("Rentabilidad sobre aportes netos (selección)");
  check(idxRentab >= 0 && metPesos[idxRentab] === "10.00%",
    `Crecimiento pesos: rentabilidad sobre aportes = (220,000-200,000)/200,000 (vi: "${metPesos[idxRentab]}")`);
  const idxXirrPesos = labelsPesos.indexOf("Rentabilidad anualizada (XIRR, selección)");
  check(idxXirrPesos >= 0, "Crecimiento pesos: métrica de XIRR presente");
  if (idxXirrPesos >= 0) {
    const xirrMostrado = parseFloat(metPesos[idxXirrPesos].replace("%", ""));
    check(Math.abs(xirrMostrado - xirrPesosEsperado * 100) < 0.05,
      `Crecimiento pesos: XIRR = ${xirrMostrado}% ~= esperado ${(xirrPesosEsperado * 100).toFixed(2)}%`);
  }

  // ---------- Crecimiento y Rentabilidad -- Dólares ----------
  const divDolares = page.locator("#inv-crecimiento-dolares");
  const metDolares = await divDolares.locator("#rentper_metrics_dolares .metric-value").allTextContents();
  const labelsDolares = await divDolares.locator("#rentper_metrics_dolares .metric-label").allTextContents();
  check(!labelsDolares.includes("Rentabilidad sobre aportes netos (selección)"), "Crecimiento dólares: NO calcula 'rentabilidad sobre aportes' (solo aplica a pesos)");
  const idxXirrDolares = labelsDolares.indexOf("Rentabilidad anualizada (XIRR, selección, con TRM de hoy)");
  check(idxXirrDolares >= 0, "Crecimiento dólares: métrica de XIRR (con TRM de hoy) presente");
  if (idxXirrDolares >= 0) {
    const xirrMostradoD = parseFloat(metDolares[idxXirrDolares].replace("%", ""));
    check(Math.abs(xirrMostradoD - xirrDolaresEsperado * 100) < 0.05,
      `Crecimiento dólares: XIRR = ${xirrMostradoD}% ~= esperado ${(xirrDolaresEsperado * 100).toFixed(2)}%`);
  }

  // ---------- Comparación contra benchmark ----------
  const textoPesos = await divPesos.innerText();
  check(textoPesos.includes("Comparación contra COLCAP"), "Benchmark pesos: título con el nombre correcto");
  check(textoPesos.includes("$210,000") && textoPesos.includes("+$10,000"),
    "Benchmark pesos: valor shadow y diferencia (220,000-210,000) correctos");

  const textoDolares = await divDolares.innerText();
  check(textoDolares.includes("Comparación contra S&P 500"), "Benchmark dólares: título con el nombre correcto");
  check(textoDolares.includes("US$ 200.00") && textoDolares.includes("+US$ 20.00"),
    "Benchmark dólares: valor shadow y diferencia (220-200 USD) correctos");

  await browser.close();
}

(async () => {
  await testSinAction();
  await testConAction();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
