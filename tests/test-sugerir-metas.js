const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

function shiftMes(mesStr, delta) {
  const anio = parseInt(mesStr.slice(0, 4), 10);
  const mes = parseInt(mesStr.slice(5, 7), 10);
  const total = anio * 12 + (mes - 1) + delta;
  const outAnio = Math.floor(total / 12);
  const outMes = (((total % 12) + 12) % 12) + 1;
  return `${outAnio}-${String(outMes).padStart(2, "0")}`;
}

const MESES_3LETRAS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const hoy = new Date();
const mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
const mesesPrev = [1, 2, 3].map((i) => shiftMes(mesActual, -i));
const [m1, m2] = mesesPrev; // m1 = mes-1 (más reciente), m2 = mes-2

function periodoQuincenaDe(mesStr) {
  const [a, m] = mesStr.split("-").map(Number);
  return `${MESES_3LETRAS[m - 1]}-${a}`;
}

// presupuesto!A5:E63 -> índice 0 = fila 5. Fila 8 = "Mercado", fila 56 = "Ahorro".
const presupuestoVals = new Array(59).fill(null).map(() => []);
presupuestoVals[0] = ["", mesActual];
presupuestoVals[8 - 5] = ["Mercado", 0, 300000, 0, 0];
presupuestoVals[56 - 5] = ["Ahorro", 0, 60000, 0, 0];

const MOCK_RANGES = {
  "'Presupuesto'!A5:E63": presupuestoVals,
  "'Egresos - Efectivo'!A15:K1999": [
    [m1, 46200, "Supermercado", "COP", "1/1", 100000, 100000, 0, "Mercado", "No", ""],
    [m2, 46170, "Supermercado", "COP", "1/1", 200000, 200000, 0, "Mercado", "No", ""],
    [m1, 46201, "Otro gasto", "COP", "1/1", 999999, 999999, 0, "Salud", "No", ""],
  ],
  "'Egresos - Tarjeta Visa 7497'!A15:K5614": [],
  "'Egresos - Mastercard 5922'!A15:K5601": [],
  "'Colillas de Pago'!A545:D2010": [
    [`1a quincena ${periodoQuincenaDe(m1)}`, "Ahorro programado", "Ahorro", 50000],
    [`2a quincena ${periodoQuincenaDe(m2)}`, "Ahorro programado", "Ahorro", 70000],
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

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    sheetsCalls.push({ type: "update" });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updatedRows: 1 }) });
  });

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

  await page.click('.nav-btn:has-text("📋 Presupuesto")');
  await page.waitForTimeout(500);

  const metaCatAntes = await page.locator("#meta_cat_8").inputValue();
  check(metaCatAntes === "0", `Mercado: meta inicial en 0 (vi: "${metaCatAntes}")`);

  await page.click("#pr_sugerir");
  await page.waitForTimeout(500);

  const metaCatLuego = await page.locator("#meta_cat_8").inputValue();
  check(metaCatLuego === "150000", `Mercado: sugerencia = promedio(100000,200000) = 150000 (vi: "${metaCatLuego}")`);

  const metaDescLuego = await page.locator("#meta_desc_56").inputValue();
  check(metaDescLuego === "60000", `Ahorro: sugerencia = promedio(50000,70000) = 60000 (vi: "${metaDescLuego}")`);

  // Meta sugerida (150.000) < gasto real fijo del fixture (300.000) -- se
  // recalcula a "de más" (rojo), no "disponible", con el aviso nuevo de
  // presupuesto excedido.
  const dispCat = await page.locator("#disp_8").innerText();
  check(/de más/.test(dispCat), `Mercado: el aviso se recalcula tras sugerir, meta < gasto real (vi: "${dispCat}")`);

  const msg = await page.locator("#pr_sugerir_msg").innerText();
  check(msg.includes(m1) && msg.includes(m2), `Mensaje de éxito menciona los meses usados (vi: "${msg}")`);

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
