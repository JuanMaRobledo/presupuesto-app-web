const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

const MOCK_RANGES = {
  "'Colillas de Pago'!A150:G294": [
    [46200, "1a quincena jul-2026", 5000000, 1000000],
  ],
  "'Colillas de Pago'!A326:D531": [
    ["1a quincena jul-2026", "Sueldo", "Salario Base", 4500000],
  ],
  "'Colillas de Pago'!A545:D2010": [
    ["1a quincena jul-2026", "Salud", "Seguros", 400000],
    ["1a quincena jul-2026", "Ahorro programado", "Ahorro", 600000],
  ],
  "'Otros Ingresos'!A4:E5263": [],
};

const BLOCK_INFO = [
  { sheet: "Colillas de Pago", first: 150, last: 294, key: "'Colillas de Pago'!A150:G294" },
  { sheet: "Colillas de Pago", first: 326, last: 531, key: "'Colillas de Pago'!A326:D531" },
  { sheet: "Colillas de Pago", first: 545, last: 2010, key: "'Colillas de Pago'!A545:D2010" },
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
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
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

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchClear**", (route) => {
    const body = route.request().postDataJSON();
    sheetsCalls.push({ type: "batchClear", ranges: body.ranges });
    for (const range of body.ranges) {
      const m = range.match(/^'([^']+)'!A(\d+):[A-Z]+\d+$/);
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

  await page.click('.nav-btn:has-text("💰 Ingresos")');
  await page.waitForTimeout(400);

  const filasResumenAntes = await page.locator("#cp_detalle > .tabla-scroll table tbody tr").count();
  check(filasResumenAntes === 1, `Colillas: resumen muestra 1 fila existente (vi: ${filasResumenAntes})`);

  // ---------- Agregar quincena: sin filas válidas ----------
  await page.click('summary:has-text("Agregar una quincena")');
  const periodoPreview = await page.locator("#col_periodo_preview").innerText();
  check(/quincena/.test(periodoPreview), `Periodo preview se calcula en vivo (vi: "${periodoPreview}")`);

  // Vaciar la fila default de devengos y descuentos (concepto vacío -> no válida) y guardar.
  sheetsCalls = [];
  await page.click("#col_guardar");
  await page.waitForTimeout(300);
  const msgVacio = await page.locator("#col_msg").innerText();
  check(/Agregá al menos un devengo o un descuento/i.test(msgVacio), `Sin filas válidas: rechazado (vi: "${msgVacio}")`);
  check(!sheetsCalls.some((c) => c.type === "append"), "Sin filas válidas: NO llamó appendRows");

  // ---------- Agregar quincena: rechazo de duplicado ----------
  await page.selectOption("#col_anio", "2026");
  await page.selectOption("#col_mes", "7");
  await page.selectOption("#col_quincena", "1a");
  await page.fill(".dev-concepto", "Sueldo");
  await page.fill(".dev-valor", "1000");
  sheetsCalls = [];
  await page.click("#col_guardar");
  await page.waitForTimeout(300);
  const msgDup = await page.locator("#col_msg").innerText();
  check(/Ya existe una quincena/i.test(msgDup), `Duplicado: rechazado (vi: "${msgDup}")`);
  check(!sheetsCalls.some((c) => c.type === "append"), "Duplicado: NO llamó appendRows");

  // ---------- Agregar quincena: caso nuevo válido ----------
  await page.selectOption("#col_mes", "9"); // 1a quincena sep-2026, no existe todavía
  await page.fill(".dev-concepto", "Sueldo base");
  await page.fill(".dev-valor", "4800000");
  await page.click("#col_dev_agregar");
  const devConceptos = page.locator("#col_dev_tbody .dev-concepto");
  await devConceptos.nth(1).fill("Bono");
  await page.locator("#col_dev_tbody .dev-valor").nth(1).fill("200000");
  await page.locator("#col_dev_tbody select.dev-categoria").nth(1).selectOption("Bonificación");

  await page.fill(".desc-concepto", "Salud");
  await page.fill(".desc-valor", "450000");

  sheetsCalls = [];
  await page.click("#col_guardar");
  await page.waitForTimeout(400);

  const appendResumen = sheetsCalls.find((c) => c.type === "append" && c.range.includes("A150:G294"));
  check(!!appendResumen, "Agregar quincena: llamó appendRows sobre colillas_resumen");
  const filaResumen = appendResumen && appendResumen.values[0];
  check(filaResumen && filaResumen[1] === "1a quincena sep-2026", `Agregar quincena: Periodo correcto (vi: "${filaResumen && filaResumen[1]}")`);
  check(filaResumen && filaResumen[2] === 5000000, `Agregar quincena: Total Devengos = suma de filas válidas (4800000+200000) (vi: ${filaResumen && filaResumen[2]})`);
  check(filaResumen && filaResumen[3] === 450000, `Agregar quincena: Total Descuentos correcto (vi: ${filaResumen && filaResumen[3]})`);

  const appendDev = sheetsCalls.find((c) => c.type === "append" && c.range.includes("A326:D531"));
  check(!!appendDev && appendDev.values.length === 2, `Agregar quincena: 2 filas de devengos válidas enviadas (vi: ${appendDev && appendDev.values.length})`);
  check(appendDev && appendDev.values[0][0] === "1a quincena sep-2026" && appendDev.values[1][2] === "Bonificación",
    `Agregar quincena: filas de devengo con Quincena/Categoría correctas (vi: ${JSON.stringify(appendDev && appendDev.values)})`);

  const appendDesc = sheetsCalls.find((c) => c.type === "append" && c.range.includes("A545:D2010"));
  check(!!appendDesc && appendDesc.values.length === 1, `Agregar quincena: 1 fila de descuento válida enviada (vi: ${appendDesc && appendDesc.values.length})`);

  await page.waitForTimeout(300);
  const filasResumenLuego = await page.locator("#cp_detalle > .tabla-scroll table tbody tr").count();
  check(filasResumenLuego === 2, `Colillas: tabla recargada muestra 2 filas tras agregar (vi: ${filasResumenLuego})`);

  // ---------- Eliminar quincena ----------
  await page.click('summary:has-text("Eliminar una quincena")');
  await page.selectOption("#del_col_periodo", "1a quincena jul-2026");
  const captionEliminar = await page.locator("#del_col_caption").innerText();
  check(/1 línea\(s\)/.test(captionEliminar) && /2 línea\(s\)/.test(captionEliminar),
    `Eliminar quincena: caption cuenta 1 devengo + 2 descuentos (vi: "${captionEliminar}")`);
  await page.check("#del_col_confirmar");
  sheetsCalls = [];
  await page.click("#del_col_btn");
  await page.waitForTimeout(400);

  const batchClearCalls = sheetsCalls.filter((c) => c.type === "batchClear");
  check(batchClearCalls.length === 3, `Eliminar quincena: 3 llamadas a batchClear (resumen/devengos/descuentos) (vi: ${batchClearCalls.length})`);
  const totalRangosBorrados = batchClearCalls.reduce((s, c) => s + c.ranges.length, 0);
  check(totalRangosBorrados === 4, `Eliminar quincena: borra 1 resumen + 1 devengo + 2 descuentos = 4 filas (vi: ${totalRangosBorrados})`);

  await page.waitForTimeout(300);
  const filasResumenFinal = await page.locator("#cp_detalle > .tabla-scroll table tbody tr").count();
  check(filasResumenFinal === 1, `Colillas: tras eliminar 'jul-2026', queda solo la de 'sep-2026' (vi: ${filasResumenFinal})`);

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
