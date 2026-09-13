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
  "'Historial de Valor de Cartera'!A2:F5000": [],
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

// "Rentabilidad personalizada" (página 📈 Inversiones, no el Informe): con
// "Interactive Brokers" seleccionado por defecto (y su cuenta de Efectivo/
// Margen NO seleccionada, también por defecto), tiene que aparecer sola la
// métrica "XIRR (selección, sobre capital propio...)" -- sin que el usuario
// tenga que buscar y marcar la casilla de Efectivo/Margen a mano.
async function testXirrCapitalPropioRentabilidadPersonalizada() {
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
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(600);

  // Acotado a #rentper_dolares -- desde que existe la sección "Rentabilidad
  // unificada personalizada" (#patrimonio_rentper_unificada), la misma
  // cuenta también aparece ahí como una segunda casilla independiente.
  const chkMargen = page.locator('#rentper_dolares input[type="checkbox"][value="Interactive Brokers - Efectivo/Margen"]');
  check(await chkMargen.count() === 1, `Existe la casilla "Interactive Brokers - Efectivo/Margen" en Rentabilidad personalizada (vi ${await chkMargen.count()})`);
  check(!(await chkMargen.isChecked()), "La casilla de Efectivo/Margen viene DESmarcada por defecto");

  const texto = await page.locator("#inv-contenido").innerText();
  check(texto.includes("XIRR (selección, sobre capital propio"),
    `Aparece "XIRR (selección, sobre capital propio...)" sin marcar la casilla a mano (vi: "${texto.slice(texto.indexOf("Rentabilidad personalizada"), texto.indexOf("Rentabilidad personalizada") + 500)}")`);

  const filaPropio = texto.match(/XIRR \(selección, sobre capital propio[^)]*\)\s*([+-]?[\d.]+)%/);
  check(!!filaPropio, `El XIRR de la selección sobre capital propio tiene un valor calculado (vi: "${texto.slice(0, 50)}")`);
  if (filaPropio) {
    check(parseFloat(filaPropio[1]) < 0,
      `Es negativo (800 USD de capital propio * TRM 4.000 = 3.200.000 < 4.000.000 aportado) (vi: ${filaPropio[1]}%)`);
  }

  await browser.close();
}

// XIRR sobre capital propio en USD puro (Informe de Inversiones): el mismo
// escenario de margen, pero verificando que la fila "(USD puro)" también
// aparece y da un número calculado -- usa la TRM histórica de
// 'Historial TRM (Auto)' (ya en MOCK_DOLARES_CON_MARGEN: 4000 el 2026-01-01),
// sin ninguna conversión final a pesos.
async function testXirrCapitalPropioUsdInforme() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    ...MOCK_DOLARES_CON_MARGEN,
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#ii-contenido").innerText();
  check(texto.includes("XIRR sobre capital propio (USD puro)"),
    `Aparece la fila "XIRR sobre capital propio (USD puro)" (vi: "${texto.slice(0, 100)}")`);
  const filaUsd = texto.match(/XIRR sobre capital propio \(USD puro\)\s*([+-]?[\d.]+)%/);
  check(!!filaUsd, "Tiene un valor calculado, no \"—\"");
  if (filaUsd) {
    // Mismo escenario que el XIRR sobre capital propio en pesos (TRM
    // constante en 4000 en todo el mock) -- debería dar prácticamente el
    // mismo signo y magnitud, calculado directo en dólares.
    check(parseFloat(filaUsd[1]) < 0, `Es negativo, mismo motivo que la versión en pesos (vi: ${filaUsd[1]}%)`);
  }

  await browser.close();
}

// TWR sobre capital propio: con 2 fotos donde el capital propio (Valor
// Actual + liquidez) crece de 700 a 800 USD, el TWR tiene que dar
// POSITIVO -- aunque el margen sigue restando, lo que importa acá es que
// el capital propio en sí mejoró entre una foto y la siguiente.
async function testTwrCapitalPropio() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    ...MOCK_DOLARES_CON_MARGEN,
    "'Historial de Valor de Cartera'!A2:F5000": [
      ["2026-01-01", "dolares", 900, 1000, 1000, 700],
      ["2026-02-01", "dolares", 900, 1100, 1000, 800],
    ],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#ii-contenido").innerText();
  check(texto.includes("TWR sobre capital propio"), `Aparece la fila de TWR sobre capital propio (vi: "${texto.slice(0, 100)}")`);
  const filaTwr = texto.match(/TWR sobre capital propio \(anualizado\)\s*([+-]?[\d.]+)%/);
  check(!!filaTwr, `Tiene un valor calculado, no "—" (vi ausencia en: "${texto.slice(texto.indexOf("TWR sobre capital"), texto.indexOf("TWR sobre capital") + 60)}")`);
  if (filaTwr) {
    check(parseFloat(filaTwr[1]) > 0, `Es positivo -- el capital propio creció de 700 a 800 entre las 2 fotos (vi: ${filaTwr[1]}%)`);
  }

  // También en 📈 Inversiones -> Rentabilidad personalizada (toda la
  // moneda, no filtrable por selección).
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(600);
  const textoInv = await page.locator("#inv-contenido").innerText();
  check(textoInv.includes("TWR sobre capital propio (toda la moneda, anualizado)"),
    `También aparece en Rentabilidad personalizada (vi: "${textoInv.slice(textoInv.indexOf("Rentabilidad personalizada"), textoInv.indexOf("Rentabilidad personalizada") + 300)}")`);

  await browser.close();
}

// Peso % / Contribución % por posición: con 2 posiciones de tamaños y
// resultados distintos, cada columna nueva tiene que dar el número exacto
// esperado -- no solo "aparece", sino que calcula bien.
async function testPesoYContribucionPorPosicion() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A5:H45": [
      ["IBKR - MSFT", "Acción", 2, 450, 900, 550, 1100, 200],
      ["IBKR - AAPL", "Acción", 1, 100, 100, 200, 200, 100],
    ],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
    "'Historial TRM (Auto)'!A2:B5000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Historial de Valor de Cartera'!A2:F5000": [],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page.waitForTimeout(600);

  // Acotado al <details> que tiene el texto "posiciones en detalle" --
  // desde que existen los paneles colapsables (.panel-colapsable) que
  // agrupan gráficos/métricas, ".last()" sobre TODOS los <details> de la
  // página ya no apunta de forma confiable a la tabla de posiciones (puede
  // haber un panel colapsable de "Efecto cambiario" después).
  await page.click('#ii-contenido details summary:has-text("posiciones en detalle")');
  const texto = await page.locator('#ii-contenido details:has-text("posiciones en detalle")').last().innerText();
  // Valor total = 1100 + 200 = 1300. MSFT: Peso = 1100/1300 = 84.6%.
  // Ganancia total = 200 + 100 = 300. MSFT: Contribución = 200/300 = 66.7%.
  check(texto.includes("84.6%"), `Peso % de MSFT = 1100/1300 = 84.6% (vi: "${texto}")`);
  check(texto.includes("66.7%"), `Contribución % de MSFT = 200/300 = 66.7% (vi: "${texto}")`);
  // AAPL: Peso = 200/1300 = 15.4%. Contribución = 100/300 = 33.3%.
  check(texto.includes("15.4%"), "Peso % de AAPL = 200/1300 = 15.4%");
  check(texto.includes("33.3%"), "Contribución % de AAPL = 100/300 = 33.3%");

  await browser.close();
}

// Filtro de plataforma sobre gráficos y tabla (Informe de Inversiones,
// panel "📊 Gráficos y detalle por posición"): desmarcar una plataforma
// tiene que actualizar el conteo y sacar sus posiciones de la tabla de
// detalle, sin tocar "Mejor/Peor posición" (esas son sobre TODA la
// cartera, no filtrables -- mismo criterio que Peso %/Contribución %).
async function testFiltroPlataformaGraficos() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A5:H45": [
      ["IBKR - MSFT", "Acción", 2, 450, 900, 550, 1100, 200],
      ["IBKR - AAPL", "Acción", 1, 100, 100, 200, 200, 100],
      ["Binance - BTC", "Cripto", 0.01, 40000, 400, 60000, 600, 200],
    ],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
    "'Historial TRM (Auto)'!A2:B5000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Historial de Valor de Cartera'!A2:F5000": [],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page.waitForTimeout(600);

  // Mejor = AAPL (+100%, costo 100 -> ganancia 100), Peor = MSFT (+22.2%,
  // costo 900 -> ganancia 200) -- BTC (+50%, costo 400 -> ganancia 200)
  // queda en el medio, ninguna de las dos.
  const panel = page.locator("#ii-contenido .panel-colapsable", { hasText: "Gráficos y detalle por posición" }).last();
  let texto = await panel.innerText();
  check(texto.includes("3 posiciones activas"), `Sin filtrar, muestra las 3 posiciones (vi: "${texto.slice(0, 200)}")`);
  check(texto.includes("AAPL") && texto.includes("+100.0%"), `Mejor posición = AAPL +100% (vi: "${texto.slice(0, 150)}")`);
  check(texto.includes("MSFT") && texto.includes("+22.2%"), `Peor posición = MSFT +22.2% (vi: "${texto.slice(0, 150)}")`);

  const chkBinance = panel.locator('input[type="checkbox"][value="Binance"]');
  check(await chkBinance.count() === 1, "Existe la casilla 'Binance' en el filtro");
  await chkBinance.uncheck();
  await page.waitForTimeout(200);

  texto = await panel.innerText();
  check(texto.includes("2 de 3 posiciones (filtradas)"), `Tras desmarcar Binance, muestra 2 de 3 (vi: "${texto.slice(0, 250)}")`);

  // Abrir el detalle para confirmar que BTC ya no aparece en la tabla.
  await panel.locator('summary:has-text("posiciones en detalle")').click();
  const tablaTexto = await panel.locator("details:has-text('posiciones en detalle')").last().innerText();
  check(!tablaTexto.includes("BTC"), `BTC ya no aparece en la tabla de detalle filtrada (vi: "${tablaTexto.slice(0, 300)}")`);
  check(tablaTexto.includes("MSFT") && tablaTexto.includes("AAPL"), "MSFT y AAPL (IBKR) siguen en la tabla");

  // Mejor/Peor posición no se filtran -- siguen siendo AAPL/MSFT (de TODA
  // la cartera) aunque Binance esté desmarcada de gráficos/tabla.
  const textoCompleto = await panel.innerText();
  check(textoCompleto.includes("AAPL") && textoCompleto.includes("+100.0%"),
    "Mejor posición sigue mostrando AAPL +100% pese al filtro (no es filtrable)");
  check(textoCompleto.includes("MSFT") && textoCompleto.includes("+22.2%"),
    "Peor posición sigue mostrando MSFT +22.2% pese al filtro (no es filtrable)");

  await browser.close();
}

// "Rentabilidad unificada personalizada" (página 📈 Inversiones, sección
// Patrimonio unificado): dos filas de casillas, una por moneda, que se
// combinan en un solo XIRR -- verifica que desmarcar la cuenta en pesos
// recalcula al vuelo y da el mismo número que la selección "solo dólares"
// (mismo escenario y mismos montos que testXirrCapitalPropioRentabilidadPersonalizada).
async function testRentabilidadUnificadaSeleccion() {
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

  const seccion = page.locator("#patrimonio_rentper_unificada");
  check(await seccion.locator("text=Rentabilidad unificada personalizada").count() > 0,
    "Aparece la sección 'Rentabilidad unificada personalizada'");

  const chkPesos = seccion.locator('input[type="checkbox"][value="Acciones y Valores"]');
  const chkDolares = seccion.locator('input[type="checkbox"][value="Interactive Brokers"]');
  check(await chkPesos.count() === 1, `Casilla "Acciones y Valores" (pesos) presente (vi ${await chkPesos.count()})`);
  check(await chkDolares.count() === 1, `Casilla "Interactive Brokers" (dólares) presente (vi ${await chkDolares.count()})`);
  check(await chkPesos.isChecked(), "Pesos viene marcado por defecto");
  check(await chkDolares.isChecked(), "Dólares viene marcado por defecto");

  const metricSel = seccion.locator("text=XIRR unificado (selección, sobre capital propio)").locator("..");
  const textoInicial = await metricSel.innerText();
  const filaInicial = textoInicial.match(/([+-]?[\d.]+)%/);
  check(!!filaInicial, `El XIRR de selección (todo marcado) tiene un valor calculado (vi: "${textoInicial}")`);
  if (filaInicial) {
    check(parseFloat(filaInicial[1]) < 0,
      `Con todo marcado da negativo, igual que el fijo (4.200.000 propio combinado < 4.800.000 aportado) (vi: ${filaInicial[1]}%)`);
  }

  // Desmarcar pesos -> selección queda solo con dólares -> debe coincidir
  // con el escenario "solo dólares, sobre capital propio" ya probado en
  // testXirrCapitalPropioRentabilidadPersonalizada (mismos montos: aporte
  // 4.000.000 COP, capital propio 800 USD * TRM 4.000 = 3.200.000).
  await chkPesos.uncheck();
  await page.waitForTimeout(150);
  const textoSoloDolares = await metricSel.innerText();
  const filaSoloDolares = textoSoloDolares.match(/([+-]?[\d.]+)%/);
  check(!!filaSoloDolares, `Tras desmarcar pesos, sigue habiendo un valor calculado (vi: "${textoSoloDolares}")`);
  if (filaSoloDolares) {
    check(parseFloat(filaSoloDolares[1]) < 0,
      `Solo dólares también da negativo (800 USD propio * TRM 4.000 = 3.200.000 < 4.000.000 aportado) (vi: ${filaSoloDolares[1]}%)`);
  }

  // Desmarcar también dólares -> ninguna cuenta elegida -> aviso, no "—".
  await chkDolares.uncheck();
  await page.waitForTimeout(150);
  const textoVacio = await seccion.innerText();
  check(textoVacio.includes("Elegí al menos una cuenta"), `Sin ninguna cuenta marcada, muestra el aviso (vi: "${textoVacio.slice(-200)}")`);

  await browser.close();
}

// Formato de montos en dólares: SIEMPRE 2 decimales, ni más ni menos --
// reportado por el usuario con un screenshot real mostrando "US$ 12,704.116"
// (3 decimales, ruido de punto flotante de Cantidad*Precio sin redondear).
// Se prueba con un valor "sucio" a propósito en vez de uno redondo, y se
// escanea TODO el texto de la página en dólares -- no solo un campo puntual
// -- para agarrar cualquier otro lugar que use el mismo patrón bugueado.
async function testFormatoUsdDosDecimales() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A5:H45": [
      ["IBKR - AAPL", "Acción", 3, 4234.7053333, 12704.116, 4234.7053333, 12704.116, 0.116],
    ],
    "'Inversiones - Dólares'!A79:D1000": [
      ["2026-01-01", "Interactive Brokers", 40000000, ""],
    ],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
    "'Historial TRM (Auto)'!A2:B5000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Historial de Valor de Cartera'!A2:F5000": [],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#ii-contenido").innerText();
  check(texto.includes("US$ 12,704.12"), `El valor sucio (12704.116) se redondea a 2 decimales (vi: "${texto.slice(texto.indexOf("Valor de las posiciones"), texto.indexOf("Valor de las posiciones") + 60)}")`);
  const conTresDecimales = texto.match(/\$\s?[\d,]+\.\d{3}\b/);
  check(!conTresDecimales, `Ningún monto en dólares de la página queda con 3 decimales (vi: ${conTresDecimales ? conTresDecimales[0] : "ninguno"})`);

  await browser.close();
}

// Aviso de ventana corta: con el único aporte hace pocos días, el XIRR
// anualizado se dispara aunque la ganancia real sea chica -- tiene que
// aparecer el aviso explicando que no es un error, es la anualización.
// Con el mismo aporte pero viejo (MOCK_DOLARES_CON_MARGEN, 2026-01-01), NO
// debe aparecer (ventana ya larga).
async function testXirrVentanaCorta() {
  const hace5Dias = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  // Ganancia chica (+1.25% bruto, similar de magnitud al caso real
  // reportado) sobre una ventana de apenas 5 días -- (1.0125)^(365/5)-1 ≈
  // +147.6% anualizado, dentro del rango de convergencia de _xirr()
  // ([-0.99, 10.0]), a diferencia de una ganancia grande en pocos días
  // (esa combinación puede hacer que el anualizado implícito supere el
  // límite de búsqueda y el XIRR directamente no converja).
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    "'Inversiones - Dólares'!A5:H45": [
      ["IBKR - MSFT", "Acción", 100, 40, 4000, 40.5, 4050, 50],
    ],
    "'Inversiones - Dólares'!A79:D1000": [
      [hace5Dias, "Interactive Brokers", 16000000, ""],
    ],
    "'Datos de Mercado (Auto)'!A1:B10": [["TRM (USD/COP)", 4000]],
    "'Historial TRM (Auto)'!A2:B5000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Historial de Valor de Cartera'!A2:F5000": [],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page.waitForTimeout(600);

  const texto = await page.locator("#ii-contenido").innerText();
  check(texto.includes("ventana tan corta amplifica"),
    `Con un aporte de hace 5 días, aparece el aviso de ventana corta (vi: "${texto.slice(texto.indexOf("Rentabilidad anualizada"), texto.indexOf("Rentabilidad anualizada") + 300)}")`);

  await browser.close();

  // Mismo escenario pero con el aporte viejo (más de 90 días) -> sin aviso.
  const browser2 = await chromium.launch();
  const page2 = await browser2.newPage();
  page2.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await setupMocks(page2, {
    "'Inversiones - Pesos'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [],
    ...MOCK_DOLARES_CON_MARGEN,
  });
  await gotoLoggedIn(page2);
  await page2.click('.nav-btn:has-text("📈 Informe de Inversiones")');
  await page2.waitForTimeout(600);
  const texto2 = await page2.locator("#ii-contenido").innerText();
  check(!texto2.includes("ventana tan corta amplifica"),
    "Con un aporte viejo (2026-01-01), NO aparece el aviso de ventana corta");
  await browser2.close();
}

(async () => {
  await testXirrCapitalPropioInforme();
  await testXirrUnificado();
  await testXirrCapitalPropioRentabilidadPersonalizada();
  await testXirrCapitalPropioUsdInforme();
  await testTwrCapitalPropio();
  await testPesoYContribucionPorPosicion();
  await testRentabilidadUnificadaSeleccion();
  await testFormatoUsdDosDecimales();
  await testXirrVentanaCorta();
  await testFiltroPlataformaGraficos();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
