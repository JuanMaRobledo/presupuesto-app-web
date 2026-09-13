const { chromium } = require("playwright");

const BASE = "http://localhost:8123";

async function setupMocks(page, MOCK_RANGES) {
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

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`OK: ${label}`);
  else { console.log(`FAIL: ${label}`); failures++; }
}

// ---------------------------------------------------------------------
// Escenario A: reproduce el caso real que reportó el usuario -- posiciones
// "Fondo (liquidez)" y "Fiducuenta" en pesos, "IBKR - Efectivo/Margen" (Otro)
// en dólares con saldo negativo, y el retiro grande al fondo bancario para
// pagar impuestos, que antes producía "-768%" en "Rentabilidad sobre aportes
// netos" -- ahora ese retiro no debe restar de la base (Plataforma "Fondo de
// Inversión (banco)" no tiene fila en Posiciones).
// ---------------------------------------------------------------------
async function testCasoReal() {
  const MOCK_RANGES = {
  "'Inversiones - Pesos'!A5:H45": [
    ["Acciones y Valores - EIMICO", "Acción", 16, 185370.5769, 2965929, 177400, 2838400, -127529],
    ["Trii - Cuenta Dinámica", "Fondo (liquidez)", 1, 220000, 220000, 294000, 294000, 74000],
    ["Fiducuenta (reserva impuestos)", "Fiducuenta", 1, 7303735, 7303735, 7303735, 7303735, 0],
  ],
  "'Inversiones - Dólares'!A5:H45": [
    ["IBKR - Efectivo/Margen", "Otro", 1, 0, 0, -5533.22, -5533.22, -5533.22],
    ["IBKR - MSFT", "Acción", 2, 363.18, 726.36, 495.63, 991.26, 264.90],
  ],
  // Depósitos 10,800,000 - Retiros 28,714,000 (incluye el retiro grande de
  // impuestos, 26,714,000) = neto -17,914,000: negativo a propósito, para
  // reproducir el caso real que dio "-768%" en "Rentabilidad sobre aportes netos".
  "'Inversiones - Pesos'!A79:D1000": [
    ["2025-10-31", "Acciones y Valores", 5000000, ""],
    ["2025-09-16", "Fiducuenta (reserva impuestos)", -26714000, "Retiro para pagar impuestos"],
    ["2025-12-12", "Acciones y Valores", -2000000, ""],
    ["2026-01-08", "Acciones y Valores", 3800000, ""],
    ["2026-02-02", "Acciones y Valores", 2000000, ""],
  ],
  "'Inversiones - Dólares'!A79:D1000": [
    ["2025-12-12", "Interactive Brokers", 2000000, ""],
  ],
  "'Historial de Inversiones'!A2:J5000": [],
  "'Datos de Mercado (Auto)'!A1:B10": [
    ["Fecha de Actualización", "2026-09-12T18:16:59Z"],
    ["TRM (USD/COP)", 3077.49],
    ["TRM Fecha", "2026-09-12"],
    ["Benchmark Pesos", "COLCAP"],
    ["Benchmark Pesos Valor Shadow (COP)", -11500032.09],
    ["Benchmark Dólares", "S&P 500"],
    ["Benchmark Dólares Valor Shadow (USD)", 7600.72],
  ],
  "'Historial de Valor de Cartera'!A2:F5000": [
    ["01/09/2026", "pesos", 2965929, 2838400, -17914000],
    ["01/09/2026", "dolares", 726.36, 991.26, 2000000],
  ],
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);

  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  // ---------- Patrimonio unificado: Acciones+Fondos juntos, liquidez aparte ----------
  // "Trii - Cuenta Dinámica" es Tipo "Fondo (liquidez)" pero SÍ es un fondo de
  // inversión de verdad (con retorno de mercado) -- cuenta para "Total en
  // inversiones", no para la liquidez. Solo Fiducuenta (Tipo "Fiducuenta") y
  // el efectivo/margen del broker son liquidez de verdad.
  const metPatrimonio = await page.locator("#inv-patrimonio .metric-row").first().locator(".metric-value").allTextContents();
  check(metPatrimonio[0] === "$3,132,400", `Patrimonio: Pesos = EIMICO + Cuenta Dinámica (2,838,400+294,000) (vi: "${metPatrimonio[0]}")`);
  // 991.26 USD * TRM 3077.49 = 3,050,592.74 (redondeado)
  check(metPatrimonio[1] === "$3,050,593", `Patrimonio: Dólares->COP = solo MSFT, sin Efectivo/Margen (vi: "${metPatrimonio[1]}")`);

  const textoPatrimonio = await page.locator("#inv-patrimonio").innerText();
  check(textoPatrimonio.includes("Efectivo, margen y cuentas de liquidez"), "Patrimonio: aparece el bloque separado de liquidez");
  check(textoPatrimonio.includes("Acciones (COP)") && textoPatrimonio.includes("Fondos de Inversión (COP)"),
    "Patrimonio: desglose Acciones vs. Fondos de Inversión aparece");
  check(textoPatrimonio.includes("$5,888,993"), "Patrimonio: Acciones (COP) = EIMICO + MSFT convertido (vi desglose)");
  check(textoPatrimonio.includes("$294,000"), "Patrimonio: Fondos de Inversión (COP) = solo Cuenta Dinámica");
  // Liquidez pesos ahora es SOLO Fiducuenta (ya no incluye Cuenta Dinámica).
  const liquidezMatch = textoPatrimonio.match(/Pesos \(COP\)\s*\$([\d,]+)\s*Dólares/s);
  check(!!liquidezMatch, "Patrimonio: se encuentra la sección de liquidez pesos");

  // ---------- Posiciones — Pesos: 3 grupos separados ----------
  const bloquePesos = await page.locator("#inv-contenido").innerText();
  check(bloquePesos.includes("📈 Acciones") && bloquePesos.includes("💼 Fondos de Inversión")
    && bloquePesos.includes("💰 Efectivo, margen y cuentas de liquidez"),
    "Posiciones: los 3 grupos (Acciones/Fondos de Inversión/Liquidez) aparecen separados");
  // Cuenta Dinámica cae en Fondos de Inversión, NO en el bloque de liquidez.
  // "Posiciones — Pesos" es la sección que nos importa acá -- Patrimonio
  // (arriba) y Posiciones — Dólares (abajo) también tienen su propio bloque
  // "💰 Efectivo..." con el mismo título, así que hay que acotar primero.
  const seccionPosicionesPesos = bloquePesos.split("Posiciones — Pesos")[1].split("Posiciones — Dólares")[0];
  const bloqueLiquidezPesos = seccionPosicionesPesos.split("💰 Efectivo, margen y cuentas de liquidez")[1];
  check(!bloqueLiquidezPesos.includes("Cuenta Dinámica"), "Cuenta Dinámica NO aparece en el bloque de liquidez (va en Fondos de Inversión)");
  check(bloqueLiquidezPesos.includes("Fiducuenta"), "Fiducuenta SÍ aparece en el bloque de liquidez");
  const bloqueFondos = seccionPosicionesPesos.split("💼 Fondos de Inversión")[1].split("💰 Efectivo")[0];
  check(bloqueFondos.includes("Cuenta Dinámica") && !bloqueFondos.includes("EIMICO"),
    "Fondos de Inversión: solo Cuenta Dinámica, sin acciones ni Fiducuenta");
  const bloqueAcciones = seccionPosicionesPesos.split("📈 Acciones")[1].split("💼 Fondos de Inversión")[0];
  check(bloqueAcciones.includes("EIMICO") && !bloqueAcciones.includes("Cuenta Dinámica"),
    "Acciones: solo EIMICO, sin el fondo ni Fiducuenta");

  // ---------- Rentabilidad personalizada -- Pesos ----------
  // Por defecto viene marcado todo menos Fiducuenta -- Acciones y Valores +
  // Trii (Cuenta Dinámica). Aportes de bolsa: 5,000,000-2,000,000+3,800,000+
  // 2,000,000=8,800,000; valor = 2,838,400 (EIMICO) + 294,000 (Cuenta
  // Dinámica) = 3,132,400; (3,132,400-8,800,000)/8,800,000 = -64.40%.
  const divPesos = page.locator("#inv-crecimiento-pesos");
  const chkLabels = await divPesos.locator(".checks-row label").allTextContents();
  check(chkLabels.some((l) => l.includes("Acciones y Valores")) && chkLabels.some((l) => l.includes("Trii"))
    && chkLabels.some((l) => l.includes("Fiducuenta")),
    `Casillas de Rentabilidad personalizada muestran las 3 plataformas (vi: ${JSON.stringify(chkLabels)})`);
  const chkStates = await divPesos.locator(".checks-row input[type=checkbox]").evaluateAll(
    (els) => els.map((e) => ({ value: e.value, checked: e.checked })));
  const fiducuentaChk = chkStates.find((c) => c.value.includes("Fiducuenta"));
  check(fiducuentaChk && fiducuentaChk.checked === false, "Fiducuenta viene DESmarcada por defecto en Rentabilidad personalizada");
  check(chkStates.filter((c) => !c.value.includes("Fiducuenta")).every((c) => c.checked === true),
    "El resto de las plataformas vienen marcadas por defecto");

  let textoPesos = await divPesos.innerText();
  check(textoPesos.includes("Rentabilidad sobre aportes netos (selección)") && textoPesos.includes("-64.40%"),
    `Rentabilidad personalizada por defecto = -64.40% (Acciones y Valores + Trii, sin Fiducuenta) (vi: "${textoPesos}")`);
  check(!textoPesos.includes("-768"), "El número engañoso -768% ya no aparece en ningún lado");

  // Desmarcar Trii reproduce el número de ANTES de la reclasificación
  // (-67.75%, solo EIMICO/Acciones y Valores) -- confirma que el recálculo
  // en vivo funciona y que Cuenta Dinámica sí estaba metida en el default.
  await divPesos.locator('.checks-row input[value="Trii"]').uncheck();
  await page.waitForTimeout(150);
  textoPesos = await divPesos.innerText();
  check(textoPesos.includes("-67.75%"), `Al desmarcar Trii, la rentabilidad recalcula a -67.75% (solo EIMICO) (vi: "${textoPesos}")`);

  // El consolidado (acciones + fondos + Fiducuenta) SÍ debe caer al aviso acá
  // -- el mock solo tiene el retiro grande de Fiducuenta sin depósitos que lo
  // compensen, así que el neto combinado es negativo a propósito.
  check(textoPesos.includes('No se puede calcular "Rentabilidad consolidada (acciones + Fiducuenta)"'),
    `El consolidado SÍ muestra su propio aviso cuando el neto combinado es negativo (vi: "${textoPesos.includes("Consolidado") ? "aparece la sección" : "NO aparece la sección"}")`);

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario B: el guard sigue vivo si algún día los retiros DE BOLSA (no del
// fondo bancario) superan los depósitos de bolsa -- debe seguir ocultando la
// métrica con el aviso, en vez de mostrar un porcentaje sin sentido.
// ---------------------------------------------------------------------
async function testGuardSigueVivo() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [
      ["Acciones y Valores - EIMICO", "Acción", 16, 185370.5769, 2965929, 177400, 2838400, -127529],
    ],
    "'Inversiones - Dólares'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [
      ["2025-10-31", "Acciones y Valores", 1000000, ""],
      ["2025-12-12", "Acciones y Valores", -5000000, "retiro grande de bolsa, no del fondo bancario"],
    ],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [
      ["Fecha de Actualización", "2026-09-12T18:16:59Z"],
      ["TRM (USD/COP)", 3077.49],
      ["TRM Fecha", "2026-09-12"],
      ["Benchmark Pesos", "COLCAP"],
      ["Benchmark Pesos Valor Shadow (COP)", 1000000],
      ["Benchmark Dólares", "S&P 500"],
      ["Benchmark Dólares Valor Shadow (USD)", 0],
    ],
    "'Historial de Valor de Cartera'!A2:F5000": [
      ["01/09/2026", "pesos", 2965929, 2838400, -4000000],
    ],
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  const divPesos = page.locator("#inv-crecimiento-pesos");
  const textoPesos = await divPesos.innerText();
  check(textoPesos.includes('No se puede calcular "Rentabilidad sobre aportes netos (selección)"'),
    `Guard: se muestra el aviso (no un % engañoso) cuando los retiros DE BOLSA (1,000,000-5,000,000=-4,000,000) superan los depósitos (vi: "${textoPesos}")`);
  check(textoPesos.includes("$4,000,000"), `Guard: el aviso muestra el monto del retiro neto de bolsa (vi: "${textoPesos}")`);

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario C: el usuario agrega "Fiducuenta (reserva impuestos)" como posición
// de liquidez (con su propio saldo) -- debe calcular una rentabilidad propia
// para ese fondo, separada de las acciones, usando SOLO los aportes/retiros
// de esa plataforma.
// ---------------------------------------------------------------------
async function testRentabilidadFondoBanco() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [
      ["Acciones y Valores - EIMICO", "Acción", 16, 185370.5769, 2965929, 177400, 2838400, -127529],
      ["Fiducuenta (reserva impuestos)", "Fiducuenta", 1, 10000000, 10000000, 11000000, 11000000, 1000000],
    ],
    "'Inversiones - Dólares'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [
      ["2025-06-01", "Acciones y Valores", 5000000, ""],
      // Aportes al fondo bancario: neto 10,000,000 (positivo) -- distinto del
      // valor actual de esa posición (11,000,000), para que la rentabilidad
      // de ese fondo (10%) no se confunda con la de las acciones.
      ["2025-01-01", "Fiducuenta (reserva impuestos)", 12000000, ""],
      ["2025-03-01", "Fiducuenta (reserva impuestos)", -2000000, "retiro para un gasto puntual"],
    ],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [
      ["Fecha de Actualización", "2026-09-12T18:16:59Z"],
      ["TRM (USD/COP)", 3077.49],
      ["TRM Fecha", "2026-09-12"],
      ["Benchmark Pesos", "COLCAP"],
      ["Benchmark Pesos Valor Shadow (COP)", 1000000],
      ["Benchmark Dólares", "S&P 500"],
      ["Benchmark Dólares Valor Shadow (USD)", 0],
    ],
    "'Historial de Valor de Cartera'!A2:F5000": [
      ["01/09/2026", "pesos", 2965929, 2838400, 3000000],
    ],
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  const bloquePesos = await page.locator("#inv-contenido").innerText();
  check(bloquePesos.includes("Rentabilidad de Fiducuenta (reserva impuestos)"),
    `Métrica de rentabilidad propia del fondo bancario presente (vi: "${bloquePesos.includes("Rentabilidad de Fondo") ? "sí aparece" : "NO aparece"}")`);
  // (11,000,000 - 10,000,000) / 10,000,000 = 10.00%
  check(bloquePesos.includes("10.00%"), `Rentabilidad del fondo bancario = 10.00% (11M actual vs 10M neto aportado) (vi: "${bloquePesos}")`);
  check(bloquePesos.includes(`Rentabilidad anualizada de Fiducuenta (reserva impuestos) (XIRR)`),
    `Métrica de XIRR propia del fondo bancario también presente, separada de la de acciones`);

  // La rentabilidad de las ACCIONES (aportes 5,000,000, sin el fondo bancario)
  // no debe confundirse con la del fondo: (2,838,400 - 5,000,000) / 5,000,000 = -43.23%.
  const divPesos = page.locator("#inv-crecimiento-pesos");
  const textoAcciones = await divPesos.innerText();
  check(textoAcciones.includes("-43.23%"), `Rentabilidad de las acciones separada = -43.23% (vi: "${textoAcciones}")`);

  // Consolidado (acciones + Fiducuenta): valor = 2,838,400 + 11,000,000 =
  // 13,838,400; aportes netos = 5,000,000 + 12,000,000 - 2,000,000 =
  // 15,000,000; (13,838,400 - 15,000,000) / 15,000,000 = -7.74%.
  check(textoAcciones.includes("Consolidado (acciones + fondos + Fiducuenta)"), "Sección de Consolidado aparece junto a las de acciones");
  check(textoAcciones.includes("-7.74%"),
    `Rentabilidad consolidada = -7.74% (13.8M consolidado vs 15M aportado neto) (vi: "${textoAcciones}")`);

  await browser.close();
}

// ---------------------------------------------------------------------
// Escenario D: caso real de Fiducuenta -- los retiros netos superan los
// aportes netos (se usa como reserva de impuestos, se vacía casi del todo
// una vez al año), así que "Rentabilidad de Fiducuenta..." debe caer al
// aviso de "no se puede calcular", PERO el XIRR sí debe seguir dando un
// número (no depende del signo del acumulado, solo de la fecha/monto de
// cada flujo).
// ---------------------------------------------------------------------
async function testXirrConAportesNetosNegativos() {
  const MOCK_RANGES = {
    "'Inversiones - Pesos'!A5:H45": [
      ["Fiducuenta (reserva impuestos)", "Fiducuenta", 1, 300000, 300000, 300000, 300000, 0],
    ],
    "'Inversiones - Dólares'!A5:H45": [],
    "'Inversiones - Pesos'!A79:D1000": [
      ["2024-11-30", "Fiducuenta (reserva impuestos)", 9000000, "saldo inicial"],
      ["2025-06-01", "Fiducuenta (reserva impuestos)", 5000000, ""],
      ["2025-09-16", "Fiducuenta (reserva impuestos)", -20000000, "retiro para impuestos"],
    ],
    "'Inversiones - Dólares'!A79:D1000": [],
    "'Historial de Inversiones'!A2:J5000": [],
    "'Datos de Mercado (Auto)'!A1:B10": [
      ["Fecha de Actualización", "2026-09-12T18:16:59Z"],
      ["TRM (USD/COP)", 3077.49],
      ["TRM Fecha", "2026-09-12"],
      ["Benchmark Pesos", "COLCAP"],
      ["Benchmark Pesos Valor Shadow (COP)", 0],
      ["Benchmark Dólares", "S&P 500"],
      ["Benchmark Dólares Valor Shadow (USD)", 0],
    ],
    "'Historial de Valor de Cartera'!A2:F5000": [],
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await setupMocks(page, MOCK_RANGES);
  await gotoLoggedIn(page);
  await page.click('.nav-btn:has-text("📈 Inversiones")');
  await page.waitForTimeout(500);

  const bloquePesos = await page.locator("#inv-contenido").innerText();
  // aportes netos = 9,000,000 + 5,000,000 - 20,000,000 = -6,000,000 (negativo,
  // igual que el caso real) -- rentabilidadSimple debe caer al aviso...
  check(bloquePesos.includes('No se puede calcular "Rentabilidad de Fiducuenta (reserva impuestos)"'),
    `Con aportes netos negativos, la rentabilidad simple muestra el aviso (no un % engañoso) (vi: "${bloquePesos.includes("No se puede calcular") ? "sí aparece el aviso" : "NO aparece ningún aviso"}")`);
  // ...pero el XIRR sí debe seguir calculando un número, porque pondera cada
  // flujo por su fecha real en vez de dividir por el acumulado final.
  check(bloquePesos.includes("Rentabilidad anualizada de Fiducuenta (reserva impuestos) (XIRR)"),
    `XIRR de Fiducuenta SÍ se calcula pese a que la rentabilidad simple no puede (vi: "${bloquePesos.includes("Rentabilidad anualizada de Fiducuenta") ? "sí aparece" : "NO aparece"}")`);

  await browser.close();
}

(async () => {
  await testCasoReal();
  await testGuardSigueVivo();
  await testRentabilidadFondoBanco();
  await testXirrConAportesNetosNegativos();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
