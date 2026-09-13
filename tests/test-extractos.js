const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

const MOCK_RANGES = {
  "'Egresos - Efectivo'!A15:K1999": [],
  "'Egresos - Tarjeta Visa 7497'!A15:K5614": [
    ["2026-05", 46180, "Restaurante", "COP", "1/1", 80000, 80000, 0, "Restaurantes", "No", ""],
    ["2026-05", 46181, "Cine", "COP", "1/1", 40000, 40000, 0, "Entretenimiento", "No", ""],
  ],
  "'Egresos - Tarjeta Visa 7497'!A5621:K5660": [
    ["2026-05", 46184, 46200, 5000000, 3500000, 0.3, 100000, 120000, 30000, 120000, "nota visa"],
  ],
  "'Egresos - Mastercard 5922'!A15:K5601": [
    ["2026-05", 46181, "Gasolina", "COP", "1/1", 120000, 120000, 0, "Transporte", "No", ""],
  ],
  "'Egresos - Mastercard 5922'!A5608:K5647": [
    ["2026-05", 46184, 46200, 8000000, 6000000, 0.25, 200000, 220000, 50000, 220000, 120.5],
  ],
  "'Egresos - Mastercard 5922'!A5698:K6697": [
    ["2026-05", 46182, "Amazon", "USD", "1/1", 30, 30, 0, "Compras", "No", ""],
  ],
  "'Categorías'!A2:A25": [["Mercado"], ["Restaurantes"], ["Transporte"], ["Salud"], ["Entretenimiento"], ["Compras"]],
};

const BLOCK_INFO = [
  { sheet: "Egresos - Tarjeta Visa 7497", first: 15, last: 5614, key: "'Egresos - Tarjeta Visa 7497'!A15:K5614" },
  { sheet: "Egresos - Tarjeta Visa 7497", first: 5621, last: 5660, key: "'Egresos - Tarjeta Visa 7497'!A5621:K5660" },
  { sheet: "Egresos - Mastercard 5922", first: 15, last: 5601, key: "'Egresos - Mastercard 5922'!A15:K5601" },
  { sheet: "Egresos - Mastercard 5922", first: 5608, last: 5647, key: "'Egresos - Mastercard 5922'!A5608:K5647" },
  { sheet: "Egresos - Mastercard 5922", first: 5698, last: 6697, key: "'Egresos - Mastercard 5922'!A5698:K6697" },
];

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
    // Real Sheets strips a leading apostrophe (it's a forced-text marker,
    // not part of the stored value) once USER_ENTERED processes the write —
    // mirror that here so a written-then-reread value matches reality.
    const sinApostrofe = (fila) => (fila || []).map((v) => (typeof v === "string" && v.startsWith("'") ? v.slice(1) : v));
    const valueRanges = ranges.map((r) => ({ range: r, values: (MOCK_RANGES[r] || []).map(sinApostrofe) }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**:append**", (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    const range = decodeURIComponent(url.pathname.split("/values/")[1].split(":append")[0]);
    if (MOCK_RANGES[range]) MOCK_RANGES[range] = [...MOCK_RANGES[range], ...body.values];
    sheetsCalls.push({ type: "append", range, values: body.values });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updates: { updatedRows: body.values.length } }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchUpdate**", (route) => {
    const body = route.request().postDataJSON();
    sheetsCalls.push({ type: "batchUpdate", valueInputOption: body.valueInputOption, data: body.data });
    for (const d of body.data) {
      const m = d.range.match(/^'([^']+)'!([A-Z]+)(\d+)(?::[A-Z]+(\d+))?$/);
      if (!m) continue;
      const sheet = m[1], colStart = m[2], row = Number(m[3]);
      const block = BLOCK_INFO.find((b) => b.sheet === sheet && row >= b.first && row <= b.last);
      if (!block) continue;
      const idx = row - block.first;
      MOCK_RANGES[block.key] = MOCK_RANGES[block.key] || [];
      while (MOCK_RANGES[block.key].length <= idx) MOCK_RANGES[block.key].push([]);
      const fila = MOCK_RANGES[block.key][idx];
      const colIdx = colStart.charCodeAt(0) - "A".charCodeAt(0);
      d.values[0].forEach((v, i) => { fila[colIdx + i] = v; });
    }
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ totalUpdatedCells: body.data.length }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchClear**", (route) => {
    const body = route.request().postDataJSON();
    sheetsCalls.push({ type: "batchClear", ranges: body.ranges });
    for (const range of body.ranges) {
      const m = range.match(/^'([^']+)'!A(\d+):K(\d+)$/);
      if (!m) continue;
      const sheet = m[1], row = Number(m[2]);
      const block = BLOCK_INFO.find((b) => b.sheet === sheet && row >= b.first && row <= b.last);
      if (block && MOCK_RANGES[block.key]) {
        const idx = row - block.first;
        if (MOCK_RANGES[block.key][idx]) MOCK_RANGES[block.key][idx] = [];
      }
    }
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ clearedRanges: body.ranges }) });
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

  await page.click('.nav-btn:has-text("💳 Egresos")');
  await page.waitForTimeout(300);
  await page.click('.tab-btn:has-text("Egresos - Tarjeta Visa 7497")');
  await page.waitForTimeout(400);

  // ---------- Ver un extracto puntual ----------
  const cupoTotal = await page.locator("#ver_ext_contenido_visa_detalle .metric-value").first().innerText();
  check(cupoTotal.includes("5,000,000"), `Ver extracto: Cupo Total correcto (vi: "${cupoTotal}")`);
  const filasDetalleExt = await page.locator("#ver_ext_tabla_visa_detalle tbody tr").count();
  check(filasDetalleExt === 2, `Ver extracto: detalle muestra 2 compras del período (vi: ${filasDetalleExt})`);

  // ---------- Agregar extracto: rechazo de duplicado ----------
  await page.click('summary:has-text("Agregar extracto")');
  await page.selectOption("#ext_anio_visa_detalle", "2026");
  await page.selectOption("#ext_mes_visa_detalle", "5"); // ya existe un resumen para 2026-05
  sheetsCalls = [];
  await page.click("#ext_guardar_visa_detalle");
  await page.waitForTimeout(300);
  const msgDupExt = await page.locator("#ext_msg_visa_detalle").innerText();
  check(/Ya existe un resumen/i.test(msgDupExt), `Agregar extracto duplicado: rechazado (vi: "${msgDupExt}")`);
  check(!sheetsCalls.some((c) => c.type === "batchUpdate"), "Agregar extracto duplicado: NO llamó batchUpdate");

  // ---------- Agregar extracto: período nuevo ----------
  await page.selectOption("#ext_mes_visa_detalle", "8"); // 2026-08, no existe todavía
  await page.fill("#ext_cupototal_visa_detalle", "6000000");
  await page.fill("#ext_saldoant_visa_detalle", "150000");
  await page.fill("#ext_pagototal_visa_detalle", "150000");
  sheetsCalls = [];
  await page.click("#ext_guardar_visa_detalle");
  await page.waitForTimeout(400);
  const batchUpdateExt = sheetsCalls.find((c) => c.type === "batchUpdate");
  check(!!batchUpdateExt, "Agregar extracto nuevo: llamó batchUpdate");
  const segA = batchUpdateExt && batchUpdateExt.data.find((d) => d.range.includes("A5622:E5622"));
  check(!!segA, `Agregar extracto: escribe en la fila 5622 (primera libre tras la única fila existente) (vi: ${JSON.stringify(batchUpdateExt && batchUpdateExt.data.map((d) => d.range))})`);
  check(segA && segA.values[0][0] === "'2026-08", `Agregar extracto: Periodo con apóstrofe forzando texto (vi: "${segA && segA.values[0][0]}")`);
  const segG = batchUpdateExt && batchUpdateExt.data.find((d) => d.range.includes("G5622"));
  check(!!segG && segG.values[0][0] === 150000, "Agregar extracto: Saldo Anterior en columna G (salta la fórmula F)");
  const segK = batchUpdateExt && batchUpdateExt.data.find((d) => d.range.includes("K5622"));
  check(!segK, "Agregar extracto (Visa, sin USD): NO manda columna K");

  await page.waitForTimeout(300);
  const periodoOptsLuego = await page.locator("#ver_ext_periodo_visa_detalle option").allTextContents();
  check(periodoOptsLuego.includes("2026-08"), `Tras agregar, el nuevo período aparece en 'Ver extracto' (vi: ${JSON.stringify(periodoOptsLuego)})`);

  // ---------- Agregar compra ----------
  await page.click('summary:has-text("Agregar compra")');
  await page.fill("#cmp_comercio_visa_detalle", "Tienda Test");
  await page.fill("#cmp_vtotal_visa_detalle", "50000");
  await page.selectOption("#cmp_cat_visa_detalle", "Mercado");
  sheetsCalls = [];
  await page.click("#cmp_guardar_visa_detalle");
  await page.waitForTimeout(400);
  const appendCompra = sheetsCalls.find((c) => c.type === "append" && c.range.includes("Egresos - Tarjeta Visa 7497"));
  check(!!appendCompra, "Agregar compra: llamó appendRows sobre Visa");
  const filaCompra = appendCompra && appendCompra.values[0];
  check(filaCompra && filaCompra[0].startsWith("'") && filaCompra[4] === "'1/1",
    `Agregar compra: Periodo y Cuotas con apóstrofe forzando texto (vi: ${JSON.stringify(filaCompra)})`);
  check(filaCompra && filaCompra[2] === "Tienda Test" && filaCompra[5] === 50000 && filaCompra[6] === 50000,
    "Agregar compra: Comercio/ValorTotal/ValorCargado correctos (usa ValorTotal cuando ValorPeriodo=0)");

  // ---------- Mastercard: compra en USD va al bloque correcto ----------
  await page.click('.tab-btn:has-text("Egresos - Mastercard 5922")');
  await page.waitForTimeout(400);
  await page.click('summary:has-text("Agregar compra")');
  const monedaSelectExiste = await page.locator("#cmp_moneda_mc_detalle").count();
  check(monedaSelectExiste === 1, "Mastercard: el form de compra SÍ tiene selector de Moneda (tiene USD)");
  await page.selectOption("#cmp_moneda_mc_detalle", "USD");
  await page.fill("#cmp_comercio_mc_detalle", "Netflix");
  await page.fill("#cmp_vtotal_mc_detalle", "15");
  await page.selectOption("#cmp_cat_mc_detalle", "Compras");
  sheetsCalls = [];
  await page.click("#cmp_guardar_mc_detalle");
  await page.waitForTimeout(400);
  const appendUsd = sheetsCalls.find((c) => c.type === "append");
  check(!!appendUsd && appendUsd.range.includes("A5698:K6697"),
    `Compra en USD: va al bloque mc_detalle_usd, no a mc_detalle (vi: "${appendUsd && appendUsd.range}")`);

  // ---------- Compras en USD (cola de Mastercard) ----------
  const filasUsdTail = await page.locator("#mc_usd_tabla tbody tr").count();
  check(filasUsdTail >= 1, `Cola de Mastercard: sección 'Compras en USD' muestra filas (vi: ${filasUsdTail})`);

  // ---------- Eliminar extracto (Mastercard) ----------
  await page.click('summary:has-text("Eliminar extracto")');
  const captionAntes = await page.locator("#del_ext_caption_mc_detalle").innerText();
  check(/1 compra\(s\)/.test(captionAntes) && /1 compra\(s\) en USD/.test(captionAntes),
    `Eliminar extracto: caption cuenta detalle + USD correctamente (vi: "${captionAntes}")`);
  await page.check("#del_ext_confirmar_mc_detalle");
  sheetsCalls = [];
  await page.click("#del_ext_btn_mc_detalle");
  await page.waitForTimeout(400);
  // clearRowsByKey() se llama 3 veces (resumen/detalle/USD), cada una con
  // su propia llamada a batchClearRanges — no es una sola llamada combinada.
  const batchClearCalls = sheetsCalls.filter((c) => c.type === "batchClear");
  check(batchClearCalls.length === 3, `Eliminar extracto: 3 llamadas a batchClear (resumen/detalle/USD) (vi: ${batchClearCalls.length})`);
  const totalRangos = batchClearCalls.reduce((s, c) => s + c.ranges.length, 0);
  check(totalRangos === 3, `Eliminar extracto: borra resumen (1) + detalle (1) + USD (1) = 3 rangos en total (vi: ${totalRangos})`);

  await page.waitForTimeout(300);
  const avisoSinExtractos = await page.locator("#panel-egresos").innerText();
  check(/Todavía no hay extractos cargados/.test(avisoSinExtractos), "Eliminar extracto: tras borrar el único período, 'Ver extracto' muestra aviso vacío");

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
