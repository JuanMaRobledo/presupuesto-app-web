const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

// Mock data keyed by the literal RANGOS value (as sent in the "ranges" query
// param) so any page's SheetsApi.batchGet() call gets realistic rows,
// including raw Sheets date-serial numbers to exercise serialToText().
const MOCK_RANGES = {
  "'Colillas de Pago'!A150:G294": [
    [46580, "1a quincena jul-2027", 5000000, 1000000],
    [46595, "2a quincena jul-2027", 5200000, 1050000],
  ],
  "'Colillas de Pago'!A326:D531": [
    ["1a quincena jul-2027", "Sueldo", "Salario", 4500000],
  ],
  "'Colillas de Pago'!A545:D2010": [
    ["1a quincena jul-2027", "Salud", "Salud", 400000],
  ],
  "'Otros Ingresos'!A4:E5263": [
    [46200, "Reembolso viaje", "Reembolso (esposa/otros)", 50000, "nota A"],
    [46200, "Venta bici", "Venta", 300000, ""],
  ],
  "'Facturación Electrónica'!A2:H2000": [],
};

let sheetsCalls = [];

async function setupMocks(page) {
  // Stub Google Identity Services + Chart.js (both unreachable from this
  // sandbox) before any script on the page runs.
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(ctx, cfg) { this.destroy = function(){}; this._cfg = cfg; };" })
  );

  // Playwright checks routes most-recently-registered-first, so the
  // generic "PUT update" catch-all (which matches /values/** and would
  // otherwise also swallow the more specific :append/:clear/:batchGet
  // URLs below) must be registered FIRST — the specific routes registered
  // afterward take priority over it.
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const url = new URL(route.request().url());
    sheetsCalls.push({ type: "update", range: url.pathname });
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
    // Find which mock range this append targets and push the new row(s) in,
    // so a subsequent batchGet (recarga) sees the just-added row.
    if (MOCK_RANGES[range]) MOCK_RANGES[range] = [...MOCK_RANGES[range], ...body.values];
    sheetsCalls.push({ type: "append", range, values: body.values });
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updates: { updatedRows: body.values.length } }) });
  });

  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**:clear**", (route) => {
    const url = new URL(route.request().url());
    const range = decodeURIComponent(url.pathname.split("/values/")[1].split(":clear")[0]);
    sheetsCalls.push({ type: "clear", range });
    // Mirror what a real Sheets values:clear does to a single row: blank it
    // out in place (doesn't shift other rows up) — so a subsequent
    // batchGet sees an empty row there, exactly like filasAObjetos()
    // filters out on the real API.
    if (range.startsWith("'Otros Ingresos'!")) {
      const m = range.match(/![A-Z]+(\d+):/);
      if (m) {
        const idx = Number(m[1]) - 4; // BLOCKS.otros_ingresos.first = 4
        const key = "'Otros Ingresos'!A4:E5263";
        if (MOCK_RANGES[key] && MOCK_RANGES[key][idx]) MOCK_RANGES[key][idx] = [];
      }
    }
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ clearedRange: range }) });
  });
}

async function gotoLoggedIn(page) {
  await page.goto(`${BASE}/app.html`);
  // Bypass the real OAuth popup flow: force Auth.getToken() to return a
  // fake token, then drive app.js's own mostrarApp()/nav exactly like a
  // real sign-in would.
  await page.waitForFunction(() => typeof Auth !== "undefined");
  await page.evaluate(() => { Auth.getToken = () => "FAKE_TOKEN_FOR_TESTS"; });
  await page.evaluate(() => mostrarApp());
}

async function clickNav(page, texto) {
  await page.click(`.nav-btn:has-text("${texto}")`);
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

  // ---------------------------------------------------------------------
  // 1) serialToText regression, end-to-end via Resumen + Ingresos→Colillas
  // ---------------------------------------------------------------------
  await clickNav(page, "🏠 Resumen");
  await page.waitForSelector("#panel-ingresos, .metric, h1", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  let resumenHtml = await page.content();
  check(!/NaN/.test(await page.locator("#contenido").innerText()), "Resumen no muestra NaN (fechas serial convertidas OK)");

  await clickNav(page, "💰 Ingresos");
  await page.waitForTimeout(300);
  const cpFechaPago = await page.locator("#cp_detalle table tbody tr td").first().innerText().catch(() => "");
  check(/^\d{2}\/\d{2}\/\d{4}$/.test(cpFechaPago), `Colillas: FechaPago serial convertida a dd/mm/yyyy (vi: "${cpFechaPago}")`);
  check(cpFechaPago === "12/07/2027" || cpFechaPago === "27/07/2027", `FechaPago serial 46580 -> texto esperado (vi: "${cpFechaPago}")`);

  // ---------------------------------------------------------------------
  // 2) Otros Ingresos: fecha serial convertida en la tabla + agregar + eliminar
  // ---------------------------------------------------------------------
  await page.click('.tab-btn[data-tab="otros"]');
  await page.waitForTimeout(300);
  const oiFechaCelda = await page.locator("#oi_tabla tbody tr td").first().innerText().catch(() => "");
  check(/^\d{2}\/\d{2}\/\d{4}$/.test(oiFechaCelda), `Otros Ingresos: Fecha serial convertida (vi: "${oiFechaCelda}")`);

  sheetsCalls = [];
  await page.click('#panel-ingresos details summary:has-text("Agregar un ingreso")');
  await page.fill("#ing_concepto", "Test agregar ingreso");
  await page.fill("#ing_valor", "75000");
  await page.selectOption("#ing_cat", "Regalo");
  await page.click("#ing_guardar");
  // Nota: el mensaje de éxito (#ing_msg) vive dentro del mismo panel que
  // recargar() reemplaza por completo al recargar — se muestra un instante
  // y luego desaparece con el resto del DOM viejo (mismo patrón preexistente
  // que declaraciones.js). No es verificable de forma confiable con un
  // timeout fijo, así que se valida el resultado real: el POST correcto y
  // que la tabla recargada refleje la fila nueva.
  await page.waitForTimeout(400);
  const appendCall = sheetsCalls.find((c) => c.type === "append" && c.range.includes("Otros Ingresos"));
  check(!!appendCall, "Agregar ingreso: llamó SheetsApi.appendRows sobre 'Otros Ingresos'");
  check(appendCall && appendCall.values[0][1] === "Test agregar ingreso" && appendCall.values[0][3] === 75000,
    "Agregar ingreso: fila enviada con concepto y valor correctos");

  await page.waitForTimeout(300);
  const filasTablaLuegoAgregar = await page.locator("#oi_tabla tbody tr").count();
  check(filasTablaLuegoAgregar === 3, `Otros Ingresos: tabla recargada muestra 3 filas tras agregar (vi: ${filasTablaLuegoAgregar})`);

  // Eliminar: elegir la primera fila del select de borrado y confirmar
  sheetsCalls = [];
  await page.click('#oi-dinamico details summary:has-text("Eliminar un ingreso")');
  const delSelectOptions = await page.locator("#oi_del_select option").count();
  check(delSelectOptions === 3, `Selector de borrar tiene 3 opciones (vi: ${delSelectOptions})`);
  await page.selectOption("#oi_del_select", "0");
  await page.check("#oi_del_confirmar");
  await page.click("#oi_del_btn");
  await page.waitForTimeout(400);
  const clearCall = sheetsCalls.find((c) => c.type === "clear" && c.range.includes("Otros Ingresos"));
  check(!!clearCall, "Eliminar ingreso: llamó SheetsApi.clearRange sobre 'Otros Ingresos'");
  await page.waitForTimeout(300);
  const filasTablaLuegoBorrar = await page.locator("#oi_tabla tbody tr").count();
  check(filasTablaLuegoBorrar === 2, `Otros Ingresos: tabla recargada muestra 2 filas tras borrar (vi: ${filasTablaLuegoBorrar})`);

  // ---------------------------------------------------------------------
  // 3) Facturación Electrónica: agregar factura + rechazo de duplicado
  // ---------------------------------------------------------------------
  await clickNav(page, "🧾 Facturación Electrónica");
  await page.waitForTimeout(300);
  const sinFacturasMsg = await page.locator("#fe-contenido").innerText().catch(() => "");
  check(/Todavía no hay facturas/i.test(sinFacturasMsg), "Facturación: arranca vacía (mock inicial sin filas)");

  sheetsCalls = [];
  await page.fill("#fac_emisor", "Proveedor de Prueba SAS");
  await page.fill("#fac_nit", "900123456");
  await page.fill("#fac_numero", "FE-001");
  await page.fill("#fac_valor", "120000");
  await page.click("#fac_guardar");
  await page.waitForTimeout(400);
  const msgFactura = await page.locator("#fac_msg").innerText().catch(() => "");
  check(/agregada/i.test(msgFactura), `Agregar factura: mensaje de éxito (vi: "${msgFactura}")`);
  const appendFactura = sheetsCalls.find((c) => c.type === "append" && c.range.includes("Facturación Electrónica"));
  check(!!appendFactura, "Agregar factura: llamó SheetsApi.appendRows sobre 'Facturación Electrónica'");

  await page.waitForTimeout(300);
  const filasFacturaLuegoAgregar = await page.locator("#fe_tabla tbody tr").count();
  check(filasFacturaLuegoAgregar === 1, `Facturación: tabla recargada muestra 1 fila tras agregar (vi: ${filasFacturaLuegoAgregar})`);

  // Duplicado: mismo NIT + Número -> debe rechazar sin llamar appendRows otra vez
  sheetsCalls = [];
  await page.fill("#fac_emisor", "Proveedor de Prueba SAS (repetido)");
  await page.fill("#fac_nit", "900123456");
  await page.fill("#fac_numero", "FE-001");
  await page.click("#fac_guardar");
  await page.waitForTimeout(400);
  const msgDup = await page.locator("#fac_msg").innerText().catch(() => "");
  check(/ya existía/i.test(msgDup), `Factura duplicada: mensaje de rechazo (vi: "${msgDup}")`);
  const appendDup = sheetsCalls.find((c) => c.type === "append");
  check(!appendDup, "Factura duplicada: NO llamó SheetsApi.appendRows de nuevo");
  const filasFacturaLuegoDup = await page.locator("#fe_tabla tbody tr").count();
  check(filasFacturaLuegoDup === 1, `Facturación: sigue mostrando 1 sola fila tras el intento duplicado (vi: ${filasFacturaLuegoDup})`);

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
