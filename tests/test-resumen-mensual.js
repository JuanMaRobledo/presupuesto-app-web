const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

const MESES_NOMBRE = {
  1: "Enero", 2: "Febrero", 3: "Marzo", 4: "Abril", 5: "Mayo", 6: "Junio",
  7: "Julio", 8: "Agosto", 9: "Septiembre", 10: "Octubre", 11: "Noviembre", 12: "Diciembre",
};

// --- Filas de 'Resumen Mensual'!B5:G30, en el mismo orden cronológico que
// tendría la hoja real. Dos años completos (2022/2023, meses 01-03) para
// probar Año vs. Año, más 13 meses no-cero (2025-01..2026-01) para probar el
// tail(12) de Resumen, y un mes en cero (2026-02) para probar el filtro
// "Ingresos ganados != 0" de esa misma sección.
const filasAnios = [];
for (const [anio, factor] of [[2022, 1], [2023, 1.3]]) {
  for (let m = 1; m <= 3; m++) {
    filasAnios.push([
      `${anio}-${String(m).padStart(2, "0")}`,
      Math.round(1000000 * factor + m * 100000),
      Math.round(400000 * factor + m * 50000),
      100000, 50000,
      Math.round(1000000 * factor + m * 100000) - Math.round(400000 * factor + m * 50000) - 150000,
    ]);
  }
}
const filas12 = [];
for (let i = 0; i < 13; i++) {
  const anio = 2025 + Math.floor(i / 12);
  const mes = (i % 12) + 1;
  const ingresos = 2000000 + i * 100000;
  const gastos = 800000 + i * 50000;
  filas12.push([`${anio}-${String(mes).padStart(2, "0")}`, ingresos, gastos, 100000, 50000, ingresos - gastos - 150000]);
}
const filaCero = ["2026-02", 0, 0, 0, 0, 0];

const RESUMEN_MENSUAL_ROWS = [...filasAnios, ...filas12, filaCero];

const MOCK_RANGES = {
  "'Resumen Mensual'!B5:G30": RESUMEN_MENSUAL_ROWS,
  "'Colillas de Pago'!A150:G294": [],
  "'Otros Ingresos'!A4:E5263": [],
  "'Egresos - Efectivo'!A15:K1999": [],
  "'Egresos - Tarjeta Visa 7497'!A15:K5614": [],
  "'Egresos - Mastercard 5922'!A15:K5601": [],
  "'Inversiones - Pesos'!A79:D1000": [],
  "'Inversiones - Dólares'!A79:D1000": [],
  "'Deudas - Resumen'!A5:H10": [],
  "'Resumen'!B5:E18": [],
};

async function setupMocks(page) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken(){} }), revoke: (t,cb)=>cb() } } };" })
  );
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.Chart = function(ctx, cfg) { this.destroy = function(){}; this._cfg = cfg; };" })
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
  // Resumen -> "Tendencia de los últimos meses"
  // ---------------------------------------------------------------------
  await page.click('.nav-btn:has-text("🏠 Resumen")');
  await page.waitForTimeout(500);

  const esperadoTendencia = RESUMEN_MENSUAL_ROWS
    .map((r) => ({ mes: r[0], ingresos: r[1] }))
    .filter((r) => r.ingresos !== 0)
    .slice(-12);

  check((await page.locator("#chart_tendencia_resumen").count()) === 1, "Resumen: el canvas de Tendencia se renderiza");
  const filasTendenciaVisibles = await page.locator("#resumen-tendencia").innerHTML();
  check(!filasTendenciaVisibles.includes("todavía no está portado"), "Resumen: ya no muestra el aviso de 'no portado'");
  check(esperadoTendencia.length === 12, `(sanity) el mock produce 12 meses tras filtrar+recortar (vi: ${esperadoTendencia.length})`);

  // Resumen: tabla y promedio de los meses escogidos, independiente del
  // alcance usado para los indicadores históricos de la página.
  const mesDesde = await page.locator("#mensual-desde").inputValue();
  const mesHasta = await page.locator("#mensual-hasta").inputValue();
  check(mesDesde === "2025-08" && mesHasta === "2026-01",
    `Resumen mensual: muestra por defecto los seis últimos meses con movimientos (${mesDesde} a ${mesHasta})`);
  check(await page.locator("#tabla-resumen-mensual tbody tr").count() === 6,
    "Resumen mensual: muestra seis filas y excluye el mes futuro sin movimientos");
  let promedios = await page.locator("#tabla-resumen-mensual tfoot").innerText();
  check(promedios.includes("$2,950,000") && promedios.includes("$1,375,000"),
    `Resumen mensual: calcula ingresos y gastos promedio de seis meses (${promedios.replace(/\n/g, " | ")})`);

  await page.selectOption("#mensual-desde", "2025-01");
  await page.selectOption("#mensual-hasta", "2025-03");
  check(await page.locator("#tabla-resumen-mensual tbody tr").count() === 3,
    "Resumen mensual: permite elegir un intervalo de tres meses");
  promedios = await page.locator("#tabla-resumen-mensual tfoot").innerText();
  check(promedios.includes("$2,100,000") && promedios.includes("$950,000"),
    `Resumen mensual: recalcula promedios solo con el período seleccionado (${promedios.replace(/\n/g, " | ")})`);
  await page.check('input[name="alcance"][value="anio"]');
  check(await page.locator("#mensual-desde").inputValue() === "2025-01" &&
    await page.locator("#tabla-resumen-mensual tbody tr").count() === 3,
    "Resumen mensual: conserva su selección al cambiar el alcance de los indicadores");

  // ---------------------------------------------------------------------
  // Análisis -> Evolución
  // ---------------------------------------------------------------------
  await page.click('.nav-btn:has-text("📊 Análisis")');
  await page.waitForTimeout(400);
  await page.click('.tab-btn:has-text("Evolución")');
  await page.waitForTimeout(300);
  await page.click('summary:has-text("Ver tabla")');

  const filasTablaEvolTotal = await page.locator("#ev_tabla tbody tr").count();
  check(filasTablaEvolTotal === RESUMEN_MENSUAL_ROWS.length,
    `Evolución: sin filtro de año, la tabla muestra todos los meses (vi: ${filasTablaEvolTotal} de ${RESUMEN_MENSUAL_ROWS.length})`);

  const headerEvol = await page.locator("#ev_tabla thead").innerText();
  check(headerEvol.includes("Ingresos ganados") && headerEvol.includes("Disponible del mes"),
    `Evolución: encabezados con las etiquetas reales del Sheet (vi: "${headerEvol.replace(/\n/g, " | ")}")`);

  await page.selectOption("#ev_anio", "2022");
  await page.waitForTimeout(200);
  const filasTablaEvol2022 = await page.locator("#ev_tabla tbody tr").count();
  check(filasTablaEvol2022 === 3, `Evolución: filtro año=2022 muestra solo esos 3 meses (vi: ${filasTablaEvol2022})`);

  // ---------------------------------------------------------------------
  // Análisis -> Año vs. Año
  // ---------------------------------------------------------------------
  await page.click('.tab-btn:has-text("Año vs. Año")');
  await page.waitForTimeout(300);

  const metricaDefault = await page.locator("#av_metrica").inputValue();
  check(metricaDefault === "IngresosGanados", `Año vs. Año: la métrica por defecto es la primera columna (Ingresos ganados) (vi: "${metricaDefault}")`);

  const aniosMarcados = await page.locator("#av_anios input:checked").evaluateAll((els) => els.map((e) => e.value));
  // Años disponibles en los datos <= hoy: 2022, 2023, 2025, 2026 -- los últimos 2 son 2025 y 2026.
  check(JSON.stringify(aniosMarcados.sort()) === JSON.stringify(["2025", "2026"]),
    `Año vs. Año: por defecto vienen marcados los últimos 2 años (vi: ${JSON.stringify(aniosMarcados)})`);

  // Nos quedamos solo con 2022 y 2023 para verificar la tabla de totales con números que podemos calcular a mano.
  for (const chk of await page.locator("#av_anios input").all()) {
    const val = await chk.getAttribute("value");
    const marcado = await chk.isChecked();
    if ((val === "2022" || val === "2023") && !marcado) await chk.check();
    if (val !== "2022" && val !== "2023" && marcado) await chk.uncheck();
  }
  await page.waitForTimeout(300);

  const filas2022 = filasAnios.filter((r) => r[0].startsWith("2022"));
  const filas2023 = filasAnios.filter((r) => r[0].startsWith("2023"));
  const total2022 = filas2022.reduce((s, r) => s + r[1], 0);
  const total2023 = filas2023.reduce((s, r) => s + r[1], 0);
  const variacionEsperada = `${(((total2023 - total2022) / Math.abs(total2022)) * 100).toFixed(0)}%`;

  const textoTablaAv = await page.locator("#av_tabla").innerText();
  check(textoTablaAv.includes("2022") && textoTablaAv.includes("2023"), "Año vs. Año: la tabla de totales muestra ambos años elegidos");
  check(textoTablaAv.includes(variacionEsperada),
    `Año vs. Año: variación 2023 vs 2022 = ${variacionEsperada} (vi: "${textoTablaAv.replace(/\n/g, " | ")}")`);

  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
