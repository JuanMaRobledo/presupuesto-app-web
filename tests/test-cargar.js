const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = "http://localhost:8123";
const NODE_MODULES = path.join(__dirname, "..", "node_modules");

async function setupMocks(page, { colillasResumen = [], otrosIngresos = [], efectivoDetalle = [], visaResumen = [], mcResumen = [] } = {}) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(){ this.destroy=function(){}; };" })
  );
  // Sin acceso de red saliente a jsdelivr en este sandbox -- se sirven las
  // mismas librerías (xlsx, pdf.js) desde el node_modules local en vez de la
  // CDN real, para poder probar el parseo real de un .xlsx/.pdf de verdad.
  await page.route("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(`${NODE_MODULES}/xlsx/dist/xlsx.full.min.js`, "utf8") })
  );
  await page.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(`${NODE_MODULES}/pdfjs-dist/build/pdf.min.js`, "utf8") })
  );
  await page.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(`${NODE_MODULES}/pdfjs-dist/build/pdf.worker.min.js`, "utf8") })
  );

  const MOCK_RANGES = {
    "'Colillas de Pago'!A150:G294": colillasResumen,
    "'Otros Ingresos'!A4:E5263": otrosIngresos,
    "'Egresos - Efectivo'!A15:K1999": efectivoDetalle,
    "'Egresos - Tarjeta Visa 7497'!A5621:K5660": visaResumen,
    "'Egresos - Mastercard 5922'!A5608:K5647": mcResumen,
  };

  const escrituras = []; // { url, method, body } de cada llamada de escritura (append/update/batchUpdate)

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**:append**", async (route) => {
    const body = route.request().postDataJSON();
    escrituras.push({ url: route.request().url(), kind: "append", body });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updates: { updatedRows: body.values.length } }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchUpdate**", async (route) => {
    const body = route.request().postDataJSON();
    escrituras.push({ url: route.request().url(), kind: "batchUpdate", body });
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

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`OK: ${label}`);
  else { console.log(`FAIL: ${label}`); failures++; }
}

function rangoDe(url) {
  const m = decodeURIComponent(url).match(/values\/(.+?):append/);
  return m ? m[1] : url;
}

// ---------------------------------------------------------------------
// Escenario A: subir una colilla PDF real (colilla_test.pdf) -- Sheet vacío,
// así que debe salir "nueva" y escribir resumen+devengos+descuentos.
// ---------------------------------------------------------------------
async function testColillaNueva() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, {});
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📤 Cargar Extractos")');
  await page.waitForTimeout(300);

  const input = page.locator("#col_input");
  await input.setInputFiles(path.join(__dirname, "colilla_test.pdf"));
  await page.waitForSelector("#col_resultado .card", { timeout: 10000 });

  const texto = await page.locator("#col_resultado").innerText();
  check(texto.includes("1a quincena ene-2026"), `Colilla parseada muestra el período correcto (vi: "${texto.slice(0, 200)}")`);
  check(texto.includes("nueva"), "Colilla marcada como 'nueva'");
  check(texto.includes("$4,500,000") || texto.includes("$ 4,500,000"), "Muestra el total de devengos correcto");

  await page.click("#col_aplicar");
  await page.waitForTimeout(500);

  const escrituras = page.escrituras;
  const resumen = escrituras.find((e) => rangoDe(e.url).includes("Colillas de Pago") && e.body.values[0].length === 4);
  check(!!resumen, `Se escribió una fila en colillas_resumen (vi ${escrituras.length} escrituras totales)`);
  if (resumen) {
    check(resumen.body.values[0][1] === "1a quincena ene-2026", `Resumen tiene el período correcto (vi: ${JSON.stringify(resumen.body.values[0])})`);
    check(resumen.body.values[0][2] === 4500000 && resumen.body.values[0][3] === 1200000,
      `Resumen tiene los totales correctos (vi: ${JSON.stringify(resumen.body.values[0])})`);
  }
  const devengos = escrituras.find((e) => rangoDe(e.url).includes("colillas_devengos".split("_")[0]) === false && rangoDe(e.url).includes("A326"));
  const filaDevengos = escrituras.find((e) => rangoDe(e.url).includes("A326"));
  check(!!filaDevengos && filaDevengos.body.values.length === 2, `Se escribieron 2 filas de devengos (Sueldo + Bonificación) (vi: ${JSON.stringify(filaDevengos && filaDevengos.body.values)})`);
  const filaDescuentos = escrituras.find((e) => rangoDe(e.url).includes("A545"));
  check(!!filaDescuentos && filaDescuentos.body.values.length === 1, `Se escribió 1 fila de descuento (Aporte Salud) (vi: ${JSON.stringify(filaDescuentos && filaDescuentos.body.values)})`);

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario B: la misma colilla, pero el Sheet YA tiene ese período -- debe
// salir "ya cargada" y NO debe aparecer el botón de aplicar.
// ---------------------------------------------------------------------
async function testColillaYaCargada() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, { colillasResumen: [["2026-01-15", "1a quincena ene-2026", 4500000, 1200000]] });
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📤 Cargar Extractos")');
  await page.waitForTimeout(300);

  await page.locator("#col_input").setInputFiles(path.join(__dirname, "colilla_test.pdf"));
  await page.waitForSelector("#col_resultado .card", { timeout: 10000 });

  const texto = await page.locator("#col_resultado").innerText();
  check(texto.includes("ya cargada"), `Colilla ya existente se marca 'ya cargada' (vi: "${texto.slice(0, 300)}")`);
  check(await page.locator("#col_aplicar").count() === 0, "No aparece el botón de aplicar cuando ya está todo cargado");

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario C: subir un extracto de cuenta .xlsx real (Detalle de
// transacciones) -- 4 movimientos: nómina (no presupuestar), retiro cajero
// (no presupuestar), aporte a Acciones y Valores (Inversiones + aporte), y
// un comercio desconocido (Otros).
// ---------------------------------------------------------------------
async function testExtractoCuentaNuevo() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, {});
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📤 Cargar Extractos")');
  await page.click('.tab-btn:has-text("Cuenta de Ahorros")');
  await page.waitForTimeout(300);

  await page.locator("#cta_input").setInputFiles(path.join(__dirname, "extracto_test.xlsx"));
  await page.waitForSelector("#cta_resultado table.tabla", { timeout: 10000 });

  const texto = await page.locator("#cta_resultado").innerText();
  check(texto.includes("COMERCIO DESCONOCIDO XYZ"), `Movimiento no reconocido aparece en la vista previa (vi: "${texto.slice(0, 400)}")`);
  check(texto.includes("Ingresos nuevos") || texto.includes("Gastos nuevos"), "Se muestran las secciones de ingresos/gastos nuevos");

  await page.click("#cta_aplicar");
  await page.waitForTimeout(500);

  const escrituras = page.escrituras;
  const ingresos = escrituras.find((e) => rangoDe(e.url).includes("Otros Ingresos"));
  check(!!ingresos, `Se escribió en Otros Ingresos (nómina) (vi ${escrituras.length} escrituras)`);
  const egresos = escrituras.find((e) => rangoDe(e.url).includes("Egresos - Efectivo"));
  check(!!egresos && egresos.body.values.length === 3,
    `Se escribieron 3 egresos (retiro cajero + aporte acciones + comercio desconocido) (vi: ${JSON.stringify(egresos && egresos.body.values.map((r) => r[2]))})`);
  const aportes = escrituras.find((e) => rangoDe(e.url).includes("Inversiones - Pesos"));
  check(!!aportes, `Se registró el aporte en Inversiones - Pesos (vi ${escrituras.map((e) => rangoDe(e.url))})`);
  if (aportes) {
    check(aportes.body.values[0][1] === "Acciones y Valores" && aportes.body.values[0][2] === 500000,
      `Aporte de inversión con plataforma y monto correctos (vi: ${JSON.stringify(aportes.body.values[0])})`);
  }

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario D: subir un extracto de tarjeta .xlsx real (formato v2, hoja
// PESOS, Visa ****7497) -- Sheet vacío, debe salir "nuevo" y escribir el
// resumen (batchUpdate por tramos de columnas) + el detalle (append) de
// los 2 movimientos (uno reconocido, uno no).
// ---------------------------------------------------------------------
async function testTarjetaNueva() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, {});
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📤 Cargar Extractos")');
  await page.click('.tab-btn:has-text("Tarjeta de Crédito")');
  await page.waitForTimeout(300);

  await page.locator("#tj_input").setInputFiles(path.join(__dirname, "tarjeta_test.xlsx"));
  await page.waitForSelector("#tj_resultado .card", { timeout: 10000 });

  const texto = await page.locator("#tj_resultado").innerText();
  check(texto.includes("Visa ****7497"), `Se reconoce la tarjeta Visa por los últimos 4 dígitos (vi: "${texto.slice(0, 200)}")`);
  check(texto.includes("2026-03"), `Se muestra el período correcto (vi: "${texto.slice(0, 200)}")`);
  check(texto.includes("nuevo"), "Extracto marcado como 'nuevo'");
  check(texto.includes("$300,000") || texto.includes("$ 300,000"), "Muestra el pago total correcto");
  check(texto.includes("COMERCIO NUEVO XYZ"), "Comercio no reconocido aparece en la vista previa de movimientos");
  check(texto.includes("clasifícalos tú"), "Aviso de comercio no reconocido aparece");

  await page.click("#tj_aplicar");
  await page.waitForTimeout(500);

  const escrituras = page.escrituras;
  const batchUpdates = escrituras.filter((e) => e.kind === "batchUpdate");
  check(batchUpdates.length === 1, `Se hizo una sola llamada batchUpdate para el resumen (vi ${batchUpdates.length})`);
  if (batchUpdates.length) {
    const segments = batchUpdates[0].body.data;
    const segA = segments.find((s) => s.range.includes("!A"));
    check(!!segA && segA.values[0][0] === "2026-03", `Segmento A:C tiene el período correcto (vi: ${JSON.stringify(segA && segA.values)})`);
    const segD = segments.find((s) => s.range.includes("!D"));
    check(!!segD && segD.values[0][0] === 5000000 && segD.values[0][1] === 3000000,
      `Segmento D:E tiene cupo total/disponible correctos (vi: ${JSON.stringify(segD && segD.values)})`);
    const segG = segments.find((s) => s.range.includes("!G"));
    check(!!segG && segG.values[0][0] === 200000, `Segmento G tiene el saldo anterior correcto (vi: ${JSON.stringify(segG && segG.values)})`);
    const segI = segments.find((s) => s.range.includes("!I"));
    check(!!segI && segI.values[0][0] === 50000 && segI.values[0][1] === 300000,
      `Segmento I:J tiene pago mínimo/total correctos (vi: ${JSON.stringify(segI && segI.values)})`);
  }
  const detalle = escrituras.find((e) => e.kind === "append" && rangoDe(e.url).includes("Tarjeta Visa"));
  check(!!detalle && detalle.body.values.length === 2, `Se escribieron 2 filas de detalle (vi: ${JSON.stringify(detalle && detalle.body.values)})`);
  if (detalle) {
    check(detalle.body.values[0][2] === "PRICESMART" && detalle.body.values[0][8] === "Mercado y Supermercado",
      `Movimiento reconocido con categoría correcta (vi: ${JSON.stringify(detalle.body.values[0])})`);
    check(detalle.body.values[1][2] === "COMERCIO NUEVO XYZ" && detalle.body.values[1][8] === "Otros",
      `Movimiento no reconocido cae en 'Otros' (vi: ${JSON.stringify(detalle.body.values[1])})`);
  }

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario E: el mismo extracto, pero el Sheet YA tiene ese período -- debe
// salir "ya cargado" y NO debe aparecer el botón de aplicar.
// ---------------------------------------------------------------------
async function testTarjetaYaCargada() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, { visaResumen: [["2026-03", "2026-03-15", "2026-04-05"]] });
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📤 Cargar Extractos")');
  await page.click('.tab-btn:has-text("Tarjeta de Crédito")');
  await page.waitForTimeout(300);

  await page.locator("#tj_input").setInputFiles(path.join(__dirname, "tarjeta_test.xlsx"));
  await page.waitForSelector("#tj_resultado .card", { timeout: 10000 });

  const texto = await page.locator("#tj_resultado").innerText();
  check(texto.includes("ya cargado"), `Extracto ya existente se marca 'ya cargado' (vi: "${texto.slice(0, 300)}")`);
  check(await page.locator("#tj_aplicar").count() === 0, "No aparece el botón de aplicar cuando ya está todo cargado");

  await browser.close();
}

(async () => {
  await testColillaNueva();
  await testColillaYaCargada();
  await testExtractoCuentaNuevo();
  await testTarjetaNueva();
  await testTarjetaYaCargada();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
