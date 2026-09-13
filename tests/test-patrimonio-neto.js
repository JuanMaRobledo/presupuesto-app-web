const { chromium } = require("playwright");
const BASE = "http://localhost:8123";

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`OK: ${label}`);
  else { console.log(`FAIL: ${label}`); failures++; }
}

async function setupMocks(page, MOCK_RANGES, { hojaPatrimonioExiste = true } = {}) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(ctx, cfg) { this.destroy = function(){}; this._cfg = cfg; };" })
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
    const range = decodeURIComponent(new URL(route.request().url()).pathname.split("/values/")[1].split("?")[0]);
    escrituras.push({ kind: "update", range, body });
    if (range.startsWith("'Historial de Patrimonio Neto'!A1:D1")) {
      // encabezado -- no hace falta reflejarlo en MOCK_RANGES
    } else if (range.startsWith("'Historial de Patrimonio Neto'!")) {
      const m = range.match(/!A(\d+):/);
      const idx = Number(m[1]) - 2;
      MOCK_RANGES["'Historial de Patrimonio Neto'!A2:D5000"][idx] = body.values[0];
    }
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updatedRows: body.values.length }) });
  });
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values:batchGet**", (route) => {
    const url = new URL(route.request().url());
    const ranges = url.searchParams.getAll("ranges");
    if (!hojaPatrimonioExiste && ranges.some((r) => r.includes("Historial de Patrimonio Neto"))) {
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "Unable to parse range: Historial de Patrimonio Neto!A2:D5000" } }) });
      return;
    }
    const valueRanges = ranges.map((r) => ({ range: r, values: MOCK_RANGES[r] || [] }));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ valueRanges }) });
  });
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**/values/**:append**", async (route) => {
    const body = route.request().postDataJSON();
    const range = decodeURIComponent(new URL(route.request().url()).pathname.split("/values/")[1].split(":append")[0]);
    escrituras.push({ kind: "append", range, body });
    if (MOCK_RANGES[range]) MOCK_RANGES[range] = [...MOCK_RANGES[range].filter((r) => r), ...body.values];
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ updates: { updatedRows: body.values.length } }) });
  });
  // Endpoint estructural (crear hoja) -- distinto de values:batchUpdate.
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/*:batchUpdate", async (route) => {
    const body = route.request().postDataJSON();
    escrituras.push({ kind: "crearHoja", body });
    hojaPatrimonioExiste = true;
    MOCK_RANGES["'Historial de Patrimonio Neto'!A2:D5000"] = MOCK_RANGES["'Historial de Patrimonio Neto'!A2:D5000"] || [];
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ replies: [{}] }) });
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

const MOCK_BASE = {
  "'Balance Mensual'!A66:D265": [["2026-01", 1000000, 2000000, "01/02/2026"]],
  "'Resumen'!B5:E18": [
    ["Valor actual del portafolio de inversiones en pesos", "", "", 5000000],
    ["Valor actual del portafolio de inversiones en dólares", "", "", 0],
  ],
  "'Deudas - Resumen'!A5:H10": [
    ["Banco X", "Libre inversión", 3000000, 0.02, 200000, 50, 12, "01/01/2027"],
  ],
  "'Deudas - Resumen'!A12:C12": [],
};

// ---------------------------------------------------------------------
// Escenario A: primera vez que se abre Balance General -- la hoja
// "Historial de Patrimonio Neto" no existe todavía, se crea sola y se
// guarda el primer snapshot (sin gráfico: hace falta 2+ para mostrarlo).
// ---------------------------------------------------------------------
async function testPrimerSnapshotCreaLaHoja() {
  const MOCK_RANGES = { ...MOCK_BASE };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES, { hojaPatrimonioExiste: false });
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("🏢 Estados Financieros")');
  await page.click('.tab-btn[data-tab="balance"]');
  await page.waitForTimeout(700);

  const crearHoja = page.escrituras.find((e) => e.kind === "crearHoja");
  check(!!crearHoja, `Crea la hoja "Historial de Patrimonio Neto" la primera vez (vi ${JSON.stringify(page.escrituras.map((e) => e.kind))})`);
  if (crearHoja) {
    check(crearHoja.body.requests[0].addSheet.properties.title === "Historial de Patrimonio Neto",
      `El título de la hoja creada es correcto (vi: "${crearHoja.body.requests[0].addSheet.properties.title}")`);
  }
  const appendSnapshot = page.escrituras.find((e) => e.kind === "append" && e.range.includes("Historial de Patrimonio Neto"));
  check(!!appendSnapshot, "Agrega el primer snapshot tras crear la hoja");
  if (appendSnapshot) {
    // Activos = 2.000.000 (SaldoFinal de efectivo) + 5.000.000 (portafolio
    // pesos) = 7.000.000; Pasivos = 3.000.000; Patrimonio Neto = 4.000.000.
    check(JSON.stringify(appendSnapshot.body.values[0].slice(1)) === JSON.stringify([7000000, 3000000, 4000000]),
      `El snapshot tiene Activos/Pasivos/Patrimonio Neto correctos (vi: ${JSON.stringify(appendSnapshot.body.values[0])})`);
  }
  const texto = await page.locator("#panel-ef").innerText();
  check(!texto.includes("Patrimonio Neto en el tiempo"), "Con un solo snapshot todavía no muestra el gráfico de tendencia");

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario B: ya hay 2 fotos de días distintos -- aparece el gráfico de
// tendencia, y abrir la pantalla hoy hace upsert (no un append nuevo) si
// ya existe una fila de hoy.
// ---------------------------------------------------------------------
async function testTendenciaConDosFotos() {
  const MOCK_RANGES = {
    ...MOCK_BASE,
    // La fecha de la fila "de hoy" va como número de serie de Sheets (como
    // la devolvería la API real tras escribir un ISO con USER_ENTERED),
    // para poder probar de verdad la rama de upsert vía serialToText().
    "'Historial de Patrimonio Neto'!A2:D5000": [
      ["2026-08-01", 5000000, 3200000, 1800000],
      [46266, 5800000, 3100000, 2700000], // 2026-09-01
    ],
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES, { hojaPatrimonioExiste: true });
  // Fija la fecha "de hoy" al mismo día que ya tiene fila guardada, para
  // probar la rama de upsert (no append).
  await page.addInitScript(() => {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : ["2026-09-01T12:00:00"])); }
      static now() { return new RealDate("2026-09-01T12:00:00").getTime(); }
    }
    window.Date = FakeDate;
  });

  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("🏢 Estados Financieros")');
  await page.click('.tab-btn[data-tab="balance"]');
  await page.waitForTimeout(700);

  const texto = await page.locator("#panel-ef").innerText();
  check(texto.includes("Patrimonio Neto en el tiempo"), `Con 2+ snapshots aparece el gráfico de tendencia (vi: "${texto.slice(0, 400)}")`);
  check(await page.locator("#be_chart_patrimonio").count() === 1, "El canvas del gráfico se renderiza");

  const updateHoy = page.escrituras.find((e) => e.kind === "update" && e.range.includes("Historial de Patrimonio Neto"));
  const appendHoy = page.escrituras.find((e) => e.kind === "append" && e.range.includes("Historial de Patrimonio Neto"));
  check(!!updateHoy && !appendHoy, `Ya había fila de "hoy" (2026-09-01) -- hace upsert (update), no otro append (vi update=${!!updateHoy}, append=${!!appendHoy})`);

  await browser.close();
}

(async () => {
  await testPrimerSnapshotCreaLaHoja();
  await testTendenciaConDosFotos();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
