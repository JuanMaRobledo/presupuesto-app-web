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
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updatedRows: 1 }) });
  });
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
  });
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchUpdate**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ totalUpdatedCells: 0 }) }));
}

async function gotoLoggedIn(page) {
  await page.goto(`${BASE}/app.html`);
  await page.waitForFunction(() => typeof Auth !== "undefined");
  await page.evaluate(() => { Auth.getToken = () => "FAKE_TOKEN_FOR_TESTS"; });
  await page.evaluate(() => mostrarApp());
}

// Presupuesto!A5:E63 -> índice 0 = fila 5. Filas 8/9/10 = 3 categorías con
// meta 100.000 cada una, gasto real 50.000/95.000/120.000 -- normal/naranja
// (90%+)/rojo (pasado), para probar los 3 casos del aviso visual nuevo.
async function testAlertasPresupuesto() {
  const presupuestoVals = [];
  for (let n = 5; n <= 63; n++) presupuestoVals.push(["", "", "", "", ""]);
  presupuestoVals[8 - 5] = ["Bajo (50%)", 100000, 50000, -50000, 50];
  presupuestoVals[9 - 5] = ["Cerca (95%)", 100000, 95000, -5000, 95];
  presupuestoVals[10 - 5] = ["Pasado (120%)", 100000, 120000, 20000, 120];

  const MOCK_RANGES = { "'Presupuesto'!A5:E63": presupuestoVals };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📋 Presupuesto")');
  await page.waitForTimeout(600);

  const dispBajo = await page.locator("#disp_8").innerText();
  check(dispBajo.includes("disponible") && !dispBajo.includes("⚠️") && !dispBajo.includes("🟡"),
    `Meta 100.000 con 50% usado: aviso normal, sin color (vi: "${dispBajo}")`);

  const dispCerca = await page.locator("#disp_9").innerText();
  check(dispCerca.includes("🟡") && dispCerca.includes("95%"),
    `Meta 100.000 con 95% usado: aviso naranja con el % (vi: "${dispCerca}")`);
  // getComputedStyle (no el.style.color) -- el color ahora se asigna vía
  // var(--warning-text)/var(--error) para que responda a dark mode, así
  // que el.style.color literal daría el texto "var(--warning-text)" en
  // vez del valor ya resuelto.
  const colorCerca = await page.locator("#disp_9 span").evaluate((el) => getComputedStyle(el).color);
  check(colorCerca === "rgb(146, 64, 14)", `El aviso "cerca" usa el color naranja esperado (--warning-text, vi: "${colorCerca}")`);

  const dispPasado = await page.locator("#disp_10").innerText();
  check(dispPasado.includes("⚠️") && dispPasado.includes("de más"),
    `Meta 100.000 con 120% usado: aviso rojo "de más" (vi: "${dispPasado}")`);
  const colorPasado = await page.locator("#disp_10 span").evaluate((el) => getComputedStyle(el).color);
  check(colorPasado === "rgb(220, 38, 38)", `El aviso "pasado" usa el color rojo esperado (vi: "${colorPasado}")`);

  // Cambiar la meta a mano recalcula el aviso en vivo (sin recargar el Sheet).
  await page.fill("#meta_cat_8", "40000"); // ahora 50.000 real > 40.000 meta -> pasa a "de más"
  await page.waitForTimeout(150);
  const dispBajoLuego = await page.locator("#disp_8").innerText();
  check(dispBajoLuego.includes("de más"), `Bajar la meta a mano recalcula el aviso en vivo (vi: "${dispBajoLuego}")`);

  await browser.close();
}

(async () => {
  await testAlertasPresupuesto();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
