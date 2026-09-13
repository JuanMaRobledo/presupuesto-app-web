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

  const escrituras = [];
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
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updates: { updatedRows: 1 } }) });
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
}

async function testEditorPosiciones() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [
      ["Acciones y Valores - ECOPETROL", "Acción", 10, 2500, 25000, 3000, 30000, 5000],
    ],
    "'Inversiones - Dólares'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
    "'Historial de Valor de Cartera'!A2:E5000": [],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  await page.click('#inv-editor-pos-pesos summary');
  const filas = page.locator("#pos_editor_tbody_pesos tr");
  check(await filas.count() === 1, `El editor arranca con la posición existente (vi ${await filas.count()})`);

  // Corregir el precio actual -- Valor Actual/Ganancia-Pérdida se recalculan solos.
  await filas.nth(0).locator(".pos-precio-actual").fill("3500");
  await page.waitForTimeout(100);
  const valorActualTexto = await filas.nth(0).locator(".pos-valor-actual").innerText();
  check(valorActualTexto.includes("35,000") || valorActualTexto.includes("35.000"),
    `Valor Actual se recalcula solo (10 * 3500 = 35.000) (vi: "${valorActualTexto}")`);

  // Agregar una posición nueva.
  await page.click("#pos_editor_agregar_pesos");
  const filasLuego = page.locator("#pos_editor_tbody_pesos tr");
  check(await filasLuego.count() === 2, `Agregar posición suma una fila (vi ${await filasLuego.count()})`);
  await filasLuego.nth(1).locator(".pos-ticker").fill("Trii - MSFT");
  await filasLuego.nth(1).locator(".pos-tipo").selectOption("Acción");
  await filasLuego.nth(1).locator(".pos-cantidad").fill("2");
  await filasLuego.nth(1).locator(".pos-precio-compra").fill("300");
  await filasLuego.nth(1).locator(".pos-precio-actual").fill("310");

  await page.click("#pos_editor_guardar_pesos");
  await page.waitForTimeout(500);

  const batchUpdate = page.escrituras.find((e) => e.kind === "batchUpdate");
  check(!!batchUpdate, `Guardar escribe vía batchUpdate (vi ${JSON.stringify(page.escrituras.map((e) => e.kind))})`);
  if (batchUpdate) {
    const rangos = batchUpdate.body.data.map((d) => d.range);
    check(rangos.some((r) => r.includes("A5:D5")), `Escribe la fila 5 (primera posición) en A:D (vi: ${JSON.stringify(rangos.slice(0, 4))})`);
    const filaA5 = batchUpdate.body.data.find((d) => d.range.includes("A5:D5"));
    check(JSON.stringify(filaA5.values[0]) === JSON.stringify(["Acciones y Valores - ECOPETROL", "Acción", 10, 2500]),
      `La fila 5 conserva el ticker/tipo/cantidad/precio compra original (vi: ${JSON.stringify(filaA5.values[0])})`);
    const filaA6 = batchUpdate.body.data.find((d) => d.range.includes("A6:D6"));
    check(JSON.stringify(filaA6.values[0]) === JSON.stringify(["Trii - MSFT", "Acción", 2, 300]),
      `La fila 6 (nueva) tiene los datos correctos (vi: ${JSON.stringify(filaA6.values[0])})`);
    const filaF5 = batchUpdate.body.data.find((d) => d.range.includes("F5"));
    check(filaF5.values[0][0] === 3500, `El Precio Actual corregido (F5=3500) se guarda (vi: ${JSON.stringify(filaF5.values[0])})`);
    // Nunca debe escribir Costo Total/Valor Actual/Ganancia-Pérdida (columnas
    // E/G/H, fórmulas del Sheet).
    check(!rangos.some((r) => /![EGH]\d+/.test(r)), `No escribe las columnas de fórmula E/G/H (vi: ${JSON.stringify(rangos)})`);
  }

  await browser.close();
}

(async () => {
  await testEditorPosiciones();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
