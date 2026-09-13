// Puerto (parcial, solo lectura) de render_inversiones() (app_presupuesto.py):
// aportes/retiros en pesos y dólares (con flujo neto por plataforma y en el
// tiempo), posiciones (cantidad, precio, valor de mercado, ganancia/pérdida),
// patrimonio unificado (pesos + dólares convertidos con la TRM), Crecimiento
// y Rentabilidad (valor de cartera vs. aportes netos, XIRR, comparación
// contra benchmark) y el historial de posiciones/cuenta de margen importado
// del broker (cierres realizados, ventas en corto, dividendos e intereses).
//
// Precios, TRM y el valor "shadow" del benchmark vienen de Yahoo Finance, que
// un sitio estático no puede consultar del lado del navegador (CORS — Yahoo
// no habilita ese origen para JS de terceros) -- en vez de eso los calcula un
// GitHub Action programado (scripts/actualizar_mercado.py, en la raíz del
// repo) con la misma cuenta de servicio que usa la versión de Streamlit
// (guardada como secret de GitHub, nunca expuesta al navegador) y los deja
// escritos en el Sheet: columna 'Precio Actual' de cada posición, la hoja
// 'Historial de Valor de Cartera' (snapshot diario) y 'Datos de Mercado
// (Auto)' (TRM + valor shadow de cada benchmark). Esta página solo lee esos
// valores ya calculados -- ver cargarDatos() más abajo para cómo se degrada
// si el Action todavía no corrió ni una vez (esas dos hojas no existen).
//
// TODAVÍA NO portado: importar portafolios, _form_agregar_dividendo() y
// _form_editar_historial() (escritura sobre el historial de operaciones).
//
// Posiciones se separa en 3 grupos, no 2 -- Acciones, Fondos de Inversión y
// Liquidez -- para no mezclar cosas con riesgo de mercado distinto ni
// cuentas sin retorno de mercado. Puerto/extensión de la regla "Es efectivo/
// margen" que ya usa _render_resumen_cartera() (app_presupuesto.py, ticker
// terminado en " - Efectivo/Margen"), más criterios nuevos por Tipo que
// Python no distingue en ningún lado (confirmado leyendo el código fuente):
// - Liquidez: Tipo "Fiducuenta" (reserva de impuestos) + sufijo "Efectivo/
//   Margen" (caja/deuda de margen del broker) -- sin retorno de mercado, un
//   saldo que sube y baja a mano o por depósitos/retiros, no por precio.
// - Fondos de Inversión: Tipo "Fondo de Inversión" + Tipo "Fondo (liquidez)"
//   (p. ej. "Trii - Cuenta Dinámica", el fondo de más bajo riesgo del
//   broker -- SÍ tiene rendimiento de mercado, así que va acá y no en
//   Liquidez pese al nombre del Tipo, confirmado con el usuario).
// - Acciones: todo lo demás (Acción/ETF/Cripto/Otro que no sea Efectivo/
//   Margen).
// Mezclar Liquidez con inversiones de verdad distorsionaba el patrimonio
// unificado y, sobre todo, "Rentabilidad sobre aportes netos"/XIRR/
// comparación contra benchmark. Mezclar Acciones con Fondos de Inversión no
// rompía ningún cálculo, pero sí volvía ilegible la tabla de Posiciones.

const PaginaInversiones = (() => {
  const APORTE_COLS = ["Fecha", "Plataforma", "MontoTransferido", "Notas"];
  const POSICION_COLS = [
    "TickerFondo", "Tipo", "Cantidad", "PrecioCompra", "CostoTotal", "PrecioActual", "ValorActual", "GananciaPerdida",
  ];
  // Puerto de HISTORIAL_INVERSION_HEADERS (sheets_backend.py).
  const HISTORIAL_COLS = [
    "Fecha", "Plataforma", "Moneda", "Activo", "Operacion", "Cantidad", "Precio", "Comision", "ResultadoRealizado", "Fuente",
  ];
  const SIGNO_OPERACION = { BUY: 1, COVER: 1, SELL: -1, SHORT: -1 };
  // Puerto de VALOR_CARTERA_HEADERS (sheets_backend.py).
  const VALOR_CARTERA_COLS = ["Fecha", "Moneda", "ValorCosto", "ValorActual", "AportesNetos"];
  const charts = {};

  // Tipos que representan un saldo de efectivo/reserva, no una inversión de
  // mercado (ver comentario del encabezado del archivo).
  const TIPOS_LIQUIDEZ = new Set(["Fiducuenta"]);
  function esCuentaLiquidez(f) {
    return TIPOS_LIQUIDEZ.has(String(f.Tipo || "").trim()) || /Efectivo\/Margen$/i.test(String(f.TickerFondo || ""));
  }

  // Tipos que sí son un fondo de inversión de verdad (con retorno de
  // mercado), separado de Acciones/ETF/Cripto/Otro -- "Fondo (liquidez)" es
  // el Tipo real de "Trii - Cuenta Dinámica" en el Sheet, pese al nombre.
  const TIPOS_FONDO = new Set(["Fondo de Inversión", "Fondo (liquidez)"]);
  function esFondoInversion(f) {
    return TIPOS_FONDO.has(String(f.Tipo || "").trim());
  }

  // Deriva la Plataforma de una posición a partir de su TickerFondo (formato
  // "{Plataforma} - {Símbolo}", o el nombre completo sin separador para
  // Fiducuenta) -- Posiciones no tiene columna Plataforma propia, así que
  // esto es lo único disponible para juntar valor de posiciones con
  // aportes/retiros de la misma plataforma (ver renderRentabilidadPersonalizada()).
  // Única abreviatura que no calza 1:1 con el nombre real en Aportes: IBKR.
  const ABREVIATURA_PLATAFORMA = { IBKR: "Interactive Brokers" };
  function plataformaDePosicion(f) {
    const ticker = String(f.TickerFondo || "").trim();
    const idx = ticker.indexOf(" - ");
    if (idx === -1) return ticker;
    const prefijo = ticker.slice(0, idx);
    return ABREVIATURA_PLATAFORMA[prefijo] || prefijo;
  }

  // "Fiducuenta (reserva impuestos)" es Fiducuenta *5601 (puerto de
  // PLATAFORMAS_INVERSION_PESOS + _destino_inversion(), cuenta_formatos.py /
  // app_presupuesto.py) -- un fondo de inversión colectiva de Bancolombia
  // usado como reserva de liquidez, no una posición de bolsa. Un aporte/
  // retiro a ese fondo no corresponde a ningún cambio en las posiciones de
  // acciones, así que mezclarlo en "Rentabilidad sobre aportes netos"
  // comparaba manzanas con peras -- un retiro grande de ese fondo (p. ej.
  // para pagar impuestos) restaba de la base de las ACCIONES sin que su
  // valor hubiera bajado un peso.
  const PLATAFORMA_FONDO_BANCO = "Fiducuenta (reserva impuestos)";
  function separarPosiciones(posiciones) {
    const acciones = [], fondos = [], liquidez = [];
    for (const f of posiciones) {
      if (esCuentaLiquidez(f)) liquidez.push(f);
      else if (esFondoInversion(f)) fondos.push(f);
      else acciones.push(f);
    }
    return { acciones, fondos, liquidez };
  }

  // 'Datos de Mercado (Auto)' es una hoja simple de clave/valor (columna A =
  // etiqueta, B = valor) que escribe scripts/actualizar_mercado.py -- se lee
  // por etiqueta en vez de por posición fija de fila, para no depender de
  // que el Action mantenga siempre el mismo orden.
  function parseDatosMercado(filas) {
    const map = {};
    for (const r of filas || []) {
      if (!r || !r[0]) continue;
      map[String(r[0]).trim()] = r[1];
    }
    const num = (v) => (typeof v === "number" ? v : null);
    return {
      fechaActualizacion: map["Fecha de Actualización"] || null,
      trm: num(map["TRM (USD/COP)"]),
      trmFecha: map["TRM Fecha"] || null,
      benchmarks: {
        pesos: { nombre: map["Benchmark Pesos"] || null, valorShadow: num(map["Benchmark Pesos Valor Shadow (COP)"]) },
        dolares: { nombre: map["Benchmark Dólares"] || null, valorShadow: num(map["Benchmark Dólares Valor Shadow (USD)"]) },
      },
    };
  }

  const MERCADO_VACIO = {
    fechaActualizacion: null, trm: null, trmFecha: null,
    benchmarks: { pesos: { nombre: null, valorShadow: null }, dolares: { nombre: null, valorShadow: null } },
  };

  async function cargarDatos() {
    const raw = await SheetsApi.batchGet([
      "aportes_inversion_pesos", "aportes_inversion_dolares", "posiciones_pesos", "posiciones_dolares",
      "historial_inversion",
    ]);
    // 'datos_mercado'/'historial_valor_cartera' van en un batchGet aparte:
    // las crea recién el primer corrido exitoso del GitHub Action, así que
    // hasta entonces el rango referencia una hoja que no existe -- la API de
    // Sheets responde 400 para el batchGet ENTERO en ese caso, no solo para
    // ese rango, así que aislarlo evita romper el resto de Inversiones.
    let mercado = MERCADO_VACIO;
    let historialValorCartera = [];
    try {
      const rawMercado = await SheetsApi.batchGet(["datos_mercado", "historial_valor_cartera"]);
      mercado = parseDatosMercado(rawMercado.datos_mercado);
      historialValorCartera = filasAObjetos(rawMercado.historial_valor_cartera, VALOR_CARTERA_COLS, ["Fecha"]);
    } catch (err) {
      console.warn("Todavía no hay datos de mercado del GitHub Action (¿corrió alguna vez?):", err.message);
    }
    return {
      aportesPesos: filasAObjetos(raw.aportes_inversion_pesos, APORTE_COLS, ["Fecha"]),
      aportesDolares: filasAObjetos(raw.aportes_inversion_dolares, APORTE_COLS, ["Fecha"]),
      posicionesPesos: filasAObjetos(raw.posiciones_pesos, POSICION_COLS),
      posicionesDolares: filasAObjetos(raw.posiciones_dolares, POSICION_COLS),
      historial: filasAObjetos(raw.historial_inversion, HISTORIAL_COLS, ["Fecha"]),
      mercado,
      historialValorCartera,
    };
  }

  // Puerto de _xirr() (app_presupuesto.py) -- bisección, sin depender de
  // scipy. 'flujos': [{fecha: "yyyy-mm-dd", monto}], salida negativa (aporte)
  // y positiva (retiro o valor final). null si no converge.
  function xirr(flujos) {
    if (flujos.length < 2) return null;
    const fecha0 = flujos.reduce((min, f) => (f.fecha < min ? f.fecha : min), flujos[0].fecha);
    const dias = (fecha) => (new Date(fecha) - new Date(fecha0)) / 86400000;
    const van = (tasa) => flujos.reduce((s, f) => s + f.monto / Math.pow(1 + tasa, dias(f.fecha) / 365), 0);
    let lo = -0.99, hi = 10.0;
    let vanLo = van(lo);
    const vanHi = van(hi);
    if (vanLo === 0) return lo;
    if (vanLo * vanHi > 0) return null;
    let mid = lo;
    for (let i = 0; i < 200; i++) {
      mid = (lo + hi) / 2;
      const vanMid = van(mid);
      if (Math.abs(vanMid) < 1e-6) return mid;
      if (vanLo * vanMid < 0) hi = mid; else { lo = mid; vanLo = vanMid; }
    }
    return mid;
  }

  // Puerto de _rentabilidad_xirr() (app_presupuesto.py).
  function rentabilidadXirr(aportes, valorActualNativo, moneda, trm) {
    const flujos = [];
    for (const f of aportes) {
      const fechaISO = parseFechaISO(f.Fecha);
      const monto = toNumber(f.MontoTransferido);
      if (fechaISO && monto) flujos.push({ fecha: fechaISO, monto: -monto });
    }
    let valorFinal = valorActualNativo;
    if (moneda === "dolares") {
      if (trm === null) return null;
      valorFinal *= trm;
    }
    if (valorFinal) flujos.push({ fecha: new Date().toISOString().slice(0, 10), monto: valorFinal });
    if (flujos.length < 2 || !flujos.some((f) => f.monto < 0) || !flujos.some((f) => f.monto > 0)) return null;
    return xirr(flujos);
  }

  function patrimonioTotal(posiciones) {
    return posiciones.reduce((s, f) => s + toNumber(f.ValorActual), 0);
  }

  // Puerto de _serie_acumulada() (app_presupuesto.py), aplicado a aportes.
  function serieAcumuladaAportes(aportes) {
    const ordenados = aportes
      .map((f) => ({ fechaISO: parseFechaISO(f.Fecha), monto: toNumber(f.MontoTransferido) }))
      .filter((f) => f.fechaISO)
      .sort((a, b) => a.fechaISO.localeCompare(b.fechaISO));
    let acumulado = 0;
    return ordenados.map((f) => { acumulado += f.monto; return { fechaISO: f.fechaISO, acumulado }; });
  }

  // Rentabilidad simple = (valorActual - aportesNetos) / aportesNetos, con
  // guarda: si aportesNetos <= 0 (retiros >= depósitos) el resultado no es
  // un porcentaje interpretable (denominador negativo invierte el signo),
  // así que se devuelve un aviso en vez de un número engañoso.
  function rentabilidadSimple(etiqueta, valorActual, aportesNetos) {
    if (aportesNetos > 0) {
      return { metricHtml: metric(etiqueta, `${(((valorActual - aportesNetos) / aportesNetos) * 100).toFixed(2)}%`), avisoHtml: "" };
    }
    if (aportesNetos < 0) {
      return {
        metricHtml: "",
        avisoHtml: `<p class="caption">No se puede calcular "${etiqueta}": los retiros netos
          (${fmtMoneda(Math.abs(aportesNetos))}) superan los depósitos netos hasta ahora, así que la fórmula
          (valor − aportes) / aportes no da un porcentaje interpretable.</p>`,
      };
    }
    return { metricHtml: "", avisoHtml: "" };
  }

  function serieValorCartera(historial, moneda) {
    return historial
      .filter((f) => f.Moneda === moneda)
      .map((f) => ({ fechaISO: parseFechaISO(f.Fecha), valor: toNumber(f.ValorActual) }))
      .filter((f) => f.fechaISO)
      .sort((a, b) => a.fechaISO.localeCompare(b.fechaISO));
  }

  function resumenAportes(aportes) {
    let dep = 0, ret = 0;
    for (const f of aportes) {
      const m = toNumber(f.MontoTransferido);
      if (m >= 0) dep += m; else ret += -m;
    }
    return { dep, ret, neto: dep - ret };
  }

  function porPlataforma(aportes) {
    const out = {};
    for (const f of aportes) {
      const m = toNumber(f.MontoTransferido);
      const p = f.Plataforma || "(sin plataforma)";
      out[p] = out[p] || { dep: 0, ret: 0 };
      if (m >= 0) out[p].dep += m; else out[p].ret += -m;
    }
    return out;
  }

  async function render(container) {
    container.innerHTML = `
      <h1>📈 Inversiones</h1>
      <p class="caption">Depósitos y retiros entre tu cuenta y las plataformas de inversión, separados en
      pesos y dólares, más las posiciones (cantidad y valor de mercado) de cada una.</p>
      <div id="inv-contenido">Cargando datos del Sheet…</div>
    `;
    const contenido = container.querySelector("#inv-contenido");
    try {
      const datos = await cargarDatos();
      contenido.innerHTML = `
        <div id="inv-patrimonio"></div>
        <hr>

        <div class="col-2">
          <div>
            <h4>Pesos (COP)</h4>
            <div id="aportes-pesos"></div>
          </div>
          <div>
            <h4>Dólares (USD)</h4>
            <div id="aportes-dolares"></div>
          </div>
        </div>

        <h4>Depósitos y retiros por plataforma</h4>
        <div class="col-2">
          <canvas id="chart_plataforma_pesos" height="180"></canvas>
          <canvas id="chart_plataforma_dolares" height="180"></canvas>
        </div>

        <h4>Capital neto transferido en el tiempo</h4>
        <canvas id="chart_flujo_tiempo" height="90"></canvas>

        <h4>Posiciones — Pesos</h4>
        ${renderPosiciones(datos.posicionesPesos, "COP", datos.aportesPesos)}
        <div id="inv-crecimiento-pesos"></div>

        <h4>Posiciones — Dólares</h4>
        ${renderPosiciones(datos.posicionesDolares, "USD")}
        <div id="inv-crecimiento-dolares"></div>

        <div id="inv-historial"></div>

        <div class="aviso">⚠️ Todavía no portado: importar un reporte de portafolio completo (CSV/XLSX) del
        broker. Usá
        <a href="https://presupuesto-app-jmr.streamlit.app" target="_blank" rel="noopener">la versión de
        Streamlit</a> para eso mientras tanto.</div>
      `;

      const recargar = () => render(container);
      renderGraficos(contenido, datos);
      renderAportesConFiltro(contenido.querySelector("#aportes-pesos"), datos.aportesPesos, "pesos");
      renderAportesConFiltro(contenido.querySelector("#aportes-dolares"), datos.aportesDolares, "dolares");
      renderPatrimonioUnificado(contenido.querySelector("#inv-patrimonio"), datos);
      renderCrecimientoRentabilidad(contenido.querySelector("#inv-crecimiento-pesos"), datos, "pesos");
      renderCrecimientoRentabilidad(contenido.querySelector("#inv-crecimiento-dolares"), datos, "dolares");
      renderHistorialInversion(contenido.querySelector("#inv-historial"), datos, recargar);
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  // ---------------------------------------------------------------------
  // Patrimonio unificado (puerto de _render_patrimonio_unificado()) y
  // Crecimiento y Rentabilidad (puerto de _render_crecimiento_rentabilidad())
  // ---------------------------------------------------------------------
  function renderPatrimonioUnificado(div, datos) {
    const sepPesos = separarPosiciones(datos.posicionesPesos);
    const sepDolares = separarPosiciones(datos.posicionesDolares);
    const patrimonioAccionesPesos = patrimonioTotal(sepPesos.acciones);
    const patrimonioFondosPesos = patrimonioTotal(sepPesos.fondos);
    const patrimonioAccionesDolares = patrimonioTotal(sepDolares.acciones);
    const patrimonioFondosDolares = patrimonioTotal(sepDolares.fondos);
    const patrimonioPesos = patrimonioAccionesPesos + patrimonioFondosPesos;
    const patrimonioDolares = patrimonioAccionesDolares + patrimonioFondosDolares;
    const cajaPesos = patrimonioTotal(sepPesos.liquidez);
    const cajaDolares = patrimonioTotal(sepDolares.liquidez);
    const hayLiquidez = sepPesos.liquidez.length > 0 || sepDolares.liquidez.length > 0;
    const hayFondos = sepPesos.fondos.length > 0 || sepDolares.fondos.length > 0;
    const trm = datos.mercado.trm;
    if (trm === null) {
      div.innerHTML = `
        <h4>🌎 Patrimonio total en inversiones</h4>
        <p class="caption">No pude leer la TRM (USD/COP) del último dato de mercado del GitHub Action — mostrando
        cada moneda por separado, sin unificar.</p>
        <div class="metric-row">
          ${metric("Pesos (COP)", fmtMoneda(patrimonioPesos))}
          ${metric("Dólares (USD)", "US$ " + patrimonioDolares.toLocaleString("en-US", { minimumFractionDigits: 2 }))}
        </div>
        ${hayLiquidez ? `
          <h5>💰 Efectivo, margen y cuentas de liquidez</h5>
          <div class="metric-row">
            ${metric("Pesos (COP)", fmtMoneda(cajaPesos))}
            ${metric("Dólares (USD)", "US$ " + cajaDolares.toLocaleString("en-US", { minimumFractionDigits: 2 }))}
          </div>` : ""}
      `;
      return;
    }
    const patrimonioDolaresCop = patrimonioDolares * trm;
    const total = patrimonioPesos + patrimonioDolaresCop;
    const cajaDolaresCop = cajaDolares * trm;
    const cajaTotalCop = cajaPesos + cajaDolaresCop;
    const accionesTotalCop = patrimonioAccionesPesos + patrimonioAccionesDolares * trm;
    const fondosTotalCop = patrimonioFondosPesos + patrimonioFondosDolares * trm;
    div.innerHTML = `
      <h4>🌎 Patrimonio total en inversiones</h4>
      <div class="metric-row">
        ${metric("Pesos (COP)", fmtMoneda(patrimonioPesos))}
        ${metric(`Dólares → COP (TRM $${trm.toLocaleString("en-US", { maximumFractionDigits: 0 })})`, fmtMoneda(patrimonioDolaresCop))}
        ${metric("Total en inversiones (COP)", fmtMoneda(total))}
      </div>
      ${hayFondos ? `
        <p class="caption">De lo anterior — Acciones/ETF/Cripto/Otro separado de Fondos de Inversión, ambas
        monedas convertidas a COP:</p>
        <div class="metric-row">
          ${metric("Acciones (COP)", fmtMoneda(accionesTotalCop))}
          ${metric("Fondos de Inversión (COP)", fmtMoneda(fondosTotalCop))}
        </div>` : ""}
      ${total > 0 ? `<canvas id="chart_patrimonio_pie" height="220"></canvas>` : ""}
      <p class="caption">TRM $${trm.toLocaleString("en-US", { maximumFractionDigits: 2 })} COP/USD
      (${datos.mercado.trmFecha || "sin fecha"}) — la actualiza un GitHub Action programado (no en vivo desde el
      navegador: Yahoo Finance bloquea ese acceso por CORS a un sitio estático).</p>
      ${hayLiquidez ? `
        <h5>💰 Efectivo, margen y cuentas de liquidez</h5>
        <p class="caption">Aparte de las inversiones de arriba — efectivo/deuda de margen en el broker y
        la Fiducuenta (reserva de impuestos), sin retorno de mercado. Un valor negativo es
        financiación del broker (deuda), no una pérdida. No cuenta para "Total en inversiones" ni para las
        métricas de rentabilidad de abajo.</p>
        <div class="metric-row">
          ${metric("Pesos (COP)", fmtMoneda(cajaPesos))}
          ${metric(`Dólares → COP (TRM $${trm.toLocaleString("en-US", { maximumFractionDigits: 0 })})`, fmtMoneda(cajaDolaresCop))}
          ${metric("Total liquidez (COP)", fmtMoneda(cajaTotalCop))}
        </div>` : ""}
    `;
    if (total > 0) {
      charts.patrimonioPie?.destroy();
      charts.patrimonioPie = new Chart(div.querySelector("#chart_patrimonio_pie").getContext("2d"), {
        type: "pie",
        data: {
          labels: ["Pesos", "Dólares (convertido)"],
          datasets: [{ data: [patrimonioPesos, patrimonioDolaresCop], backgroundColor: ["#1d4ed8", "#0d9488"] }],
        },
        options: { responsive: true, plugins: { title: { display: true, text: "Distribución de inversiones por moneda (en COP)" } } },
      });
    }
  }

  function renderCrecimientoRentabilidad(div, datos, moneda) {
    const unidad = moneda === "pesos" ? "COP" : "USD";
    const serieValor = serieValorCartera(datos.historialValorCartera, moneda);
    const aportesMoneda = moneda === "pesos" ? datos.aportesPesos : datos.aportesDolares;
    const serieAportes = serieAcumuladaAportes(aportesMoneda);
    const posicionesMoneda = moneda === "pesos" ? datos.posicionesPesos : datos.posicionesDolares;

    let html = `<h5>📊 Crecimiento y Rentabilidad</h5>`;
    if (!serieValor.length && !serieAportes.length) {
      html += `<p class="caption">Todavía no hay historial para graficar — a medida que el GitHub Action
        actualice precios o cargues aportes, esta sección va a ir acumulando la serie en el tiempo.</p>`;
      div.innerHTML = html;
    } else {
      if (serieValor.length < 2) {
        html += `<p class="caption">El valor de cartera se guarda como una foto cada vez que corre el GitHub
          Action de precios — llevás ${serieValor.length} foto(s) para ${unidad}. El gráfico se va a ir
          llenando solo.</p>`;
      }
      html += `
        <canvas id="chart_crecimiento_${moneda}" height="160"></canvas>
        <div id="rentper_${moneda}"></div>
      `;
      div.innerHTML = html;
      renderChartCrecimiento(div.querySelector(`#chart_crecimiento_${moneda}`), serieValor, serieAportes, moneda, unidad);

      // Acciones y Fondos de Inversión combinados (todo menos Liquidez) --
      // sigue usándose para el Consolidado y la comparación contra
      // benchmark de más abajo. La rentabilidad/XIRR en sí ahora se calcula
      // con la selección de plataformas de renderRentabilidadPersonalizada().
      const sep = separarPosiciones(posicionesMoneda);
      const valorInversion = patrimonioTotal([...sep.acciones, ...sep.fondos]);

      renderRentabilidadPersonalizada(
        div.querySelector(`#rentper_${moneda}`), aportesMoneda, posicionesMoneda, moneda, datos.mercado.trm);

      // Vista consolidada (solo pesos): acciones + Fiducuenta juntos -- acá
      // SÍ se combinan los aportes/retiros de ambas plataformas, pero
      // emparejados con el valor combinado (títulos + Fiducuenta), no solo
      // el de las acciones, así que no repite el error de mezclar fuentes.
      if (moneda === "pesos") {
        const posicionFondo = separarPosiciones(datos.posicionesPesos).liquidez
          .find((f) => (f.TickerFondo || "").trim() === PLATAFORMA_FONDO_BANCO);
        if (posicionFondo) {
          const valorFondo = toNumber(posicionFondo.ValorActual);
          const valorConsolidado = valorInversion + valorFondo;
          const metricsConsolidado = [];
          let avisoConsolidado = "";
          const serieAportesConsolidados = serieAcumuladaAportes(aportesMoneda);
          if (serieAportesConsolidados.length) {
            const aportesNetosConsolidados = serieAportesConsolidados[serieAportesConsolidados.length - 1].acumulado;
            const { metricHtml, avisoHtml } = rentabilidadSimple(
              "Rentabilidad consolidada (acciones + Fiducuenta)", valorConsolidado, aportesNetosConsolidados);
            if (metricHtml) metricsConsolidado.push(metricHtml);
            avisoConsolidado = avisoHtml;
          }
          const xirrConsolidado = rentabilidadXirr(aportesMoneda, valorConsolidado, "pesos", null);
          if (xirrConsolidado !== null) {
            metricsConsolidado.push(metric("Rentabilidad anualizada consolidada (XIRR)", `${(xirrConsolidado * 100).toFixed(2)}%`));
          }
          if (metricsConsolidado.length || avisoConsolidado) {
            div.insertAdjacentHTML("beforeend", `
              <h6>🔗 Consolidado (acciones + fondos + Fiducuenta)</h6>
              <p class="caption">Junta el valor y los aportes/retiros de las acciones y fondos de inversión con
              los de Fiducuenta, como si fuera un solo portafolio -- útil para ver el rendimiento total de tu
              plata en pesos, pero mezcla cosas con riesgo de mercado con una reserva de liquidez (Fiducuenta),
              así que conviene mirar también las métricas separadas de arriba.</p>
              ${metricsConsolidado.length ? `<div class="metric-row">${metricsConsolidado.join("")}</div>` : ""}
              ${avisoConsolidado}
            `);
          }
        }
      }
    }

    const bench = datos.mercado.benchmarks[moneda];
    if (bench && bench.nombre) {
      const sepBench = separarPosiciones(posicionesMoneda);
      const valorReal = patrimonioTotal([...sepBench.acciones, ...sepBench.fondos]);
      const fmtBench = (v) => (moneda === "dolares" ? "US$ " + v.toLocaleString("en-US", { minimumFractionDigits: 2 }) : fmtMoneda(v));
      if (bench.valorShadow !== null) {
        const diferencia = valorReal - bench.valorShadow;
        div.insertAdjacentHTML("beforeend", `
          <h6>📈 Comparación contra ${bench.nombre}</h6>
          <p class="caption">Si cada aporte/retiro real (misma fecha, mismo monto) se hubiera puesto en
          ${bench.nombre} en vez de en tu cartera, hoy valdría lo de abajo — calculado por el GitHub Action con
          datos de Yahoo Finance (para dólares, convirtiendo cada aporte con la TRM histórica del día que lo
          hiciste, no la de hoy).</p>
          <div class="metric-row">
            ${metric(`Tu cartera hoy (${unidad})`, fmtBench(valorReal))}
            ${metric(`${bench.nombre} con los mismos aportes (${unidad})`, fmtBench(bench.valorShadow))}
            ${metric("Diferencia", (diferencia >= 0 ? "+" : "") + fmtBench(diferencia))}
          </div>
        `);
      } else {
        div.insertAdjacentHTML("beforeend", `<p class="caption">No pude descargar el histórico de
          ${bench.nombre} para comparar — puede ser un corte temporal de Yahoo Finance, o que el símbolo no sea
          el correcto.</p>`);
      }
    }
  }

  // Rentabilidad con selección de plataformas a mano (casillas), en vez de
  // una combinación fija -- cada aporte/retiro se cuenta completo por la
  // Plataforma a la que fue destinado (Aportes no tiene columna Tipo de
  // activo, así que no se puede partir un aporte entre "para acciones" y
  // "para fondos" dentro de la misma plataforma). El valor de cada
  // plataforma sí se puede calcular exacto, vía plataformaDePosicion().
  // Por defecto viene marcado todo menos Fiducuenta (mismo criterio que
  // tenía la métrica fija anterior), para no cambiar el resultado por
  // defecto -- desmarcar/marcar plataformas recalcula todo al vuelo, sin
  // volver a pedirle nada al Sheet.
  // Clave de cuenta seleccionable para una posición: la Plataforma
  // (plataformaDePosicion) para posiciones de inversión de verdad, pero un
  // sufijo aparte para el efectivo/margen del broker -- así "Interactive
  // Brokers" (las acciones) y "Interactive Brokers - Efectivo/Margen" (el
  // saldo de caja/deuda de margen) se pueden marcar por separado, ya que
  // uno tiene retorno de mercado y el otro no. Fiducuenta no necesita este
  // tratamiento especial: su TickerFondo ya es igual a su Plataforma.
  function claveCuenta(f) {
    const p = plataformaDePosicion(f);
    return esCuentaLiquidez(f) && /Efectivo\/Margen$/i.test(String(f.TickerFondo || "")) ? `${p} - Efectivo/Margen` : p;
  }

  function renderRentabilidadPersonalizada(div, aportesMoneda, posicionesMoneda, moneda, trm) {
    const cuentas = [...new Set([
      ...aportesMoneda.map((f) => f.Plataforma),
      ...posicionesMoneda.map(claveCuenta),
    ])].filter(Boolean).sort();

    if (!cuentas.length) { div.innerHTML = ""; return; }

    // Por defecto viene marcado todo lo que tenga retorno de mercado --
    // ni Fiducuenta ni el efectivo/margen del broker, mismo resultado que
    // se mostraba antes de que esto fuera seleccionable a mano.
    const marcadaPorDefecto = (c) => c !== PLATAFORMA_FONDO_BANCO && !c.endsWith(" - Efectivo/Margen");

    const claseChk = `chk_plat_${moneda}`;
    div.innerHTML = `
      <h6>🎛️ Rentabilidad personalizada</h6>
      <p class="caption">Elegí qué cuentas juntar para la rentabilidad sobre aportes netos y el XIRR -- por
      defecto viene marcado todo lo que tiene retorno de mercado (ni Fiducuenta ni el efectivo/margen del
      broker, lo mismo que se mostraba antes). Cada aporte/retiro se cuenta completo por la plataforma a la
      que fue destinado -- no se puede partir un aporte entre el tipo de activo que compró esa plataforma con
      esa plata.</p>
      <div class="checks-row">${cuentas.map((c) => `
        <label style="margin-right:14px; white-space:nowrap;">
          <input type="checkbox" class="${claseChk}" value="${c}" ${marcadaPorDefecto(c) ? "checked" : ""}>
          ${c}
        </label>
      `).join("")}</div>
      <div id="rentper_metrics_${moneda}" class="metric-row"></div>
      <div id="rentper_aviso_${moneda}"></div>
    `;

    const metricsDiv = div.querySelector(`#rentper_metrics_${moneda}`);
    const avisoDiv = div.querySelector(`#rentper_aviso_${moneda}`);

    function recalcular() {
      const seleccion = new Set([...div.querySelectorAll(`.${claseChk}:checked`)].map((el) => el.value));
      const aportesSel = aportesMoneda.filter((f) => seleccion.has(f.Plataforma));
      const valorSel = posicionesMoneda
        .filter((f) => seleccion.has(claveCuenta(f)))
        .reduce((s, f) => s + toNumber(f.ValorActual), 0);

      const metricsHtml = [];
      let avisoHtml = "";
      // La rentabilidad simple (valor-aportes)/aportes solo tiene sentido en
      // pesos -- en dólares los aportes se registran en COP transferido
      // (Monto Transferido (COP)) contra un valor en USD, unidades que no
      // se pueden restar entre sí sin convertir (mismo motivo que la
      // versión de Streamlit nunca mostró esta métrica para dólares).
      if (moneda === "pesos") {
        const serieSel = serieAcumuladaAportes(aportesSel);
        if (serieSel.length) {
          const aportesNetosSel = serieSel[serieSel.length - 1].acumulado;
          const r = rentabilidadSimple("Rentabilidad sobre aportes netos (selección)", valorSel, aportesNetosSel);
          if (r.metricHtml) metricsHtml.push(r.metricHtml);
          avisoHtml = r.avisoHtml;
        }
      }
      const xirrSel = rentabilidadXirr(aportesSel, valorSel, moneda, trm);
      if (xirrSel !== null) {
        metricsHtml.push(metric(
          moneda === "pesos" ? "Rentabilidad anualizada (XIRR, selección)" : "Rentabilidad anualizada (XIRR, selección, con TRM de hoy)",
          `${(xirrSel * 100).toFixed(2)}%`));
      }
      metricsDiv.innerHTML = metricsHtml.length ? metricsHtml.join("")
        : `<p class="caption">Elegí al menos una plataforma con aportes y valor para calcular.</p>`;
      avisoDiv.innerHTML = avisoHtml;
    }

    div.querySelectorAll(`.${claseChk}`).forEach((el) => el.addEventListener("change", recalcular));
    recalcular();
  }

  function renderChartCrecimiento(canvas, serieValor, serieAportes, moneda, unidad) {
    charts[`crecimiento_${moneda}`]?.destroy();
    if (moneda === "pesos") {
      const datasets = [];
      if (serieValor.length) datasets.push({
        label: "Valor de Cartera", data: serieValor.map((f) => ({ x: f.fechaISO, y: f.valor })),
        borderColor: "#4573d6", backgroundColor: "#4573d6", tension: 0.1,
      });
      if (serieAportes.length) datasets.push({
        label: "Aportes Netos Acumulados", data: serieAportes.map((f) => ({ x: f.fechaISO, y: f.acumulado })),
        borderColor: "#45a06a", backgroundColor: "#45a06a", tension: 0.1,
      });
      charts[`crecimiento_${moneda}`] = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: { datasets },
        options: {
          responsive: true, parsing: false,
          plugins: { title: { display: true, text: `Crecimiento de la cartera (${unidad})` } },
          scales: { x: { type: "category" }, y: { ticks: { callback: (v) => fmtMoneda(v) } } },
        },
      });
    } else {
      const datasets = [];
      if (serieValor.length) datasets.push({
        label: "Valor de Cartera (USD)", data: serieValor.map((f) => ({ x: f.fechaISO, y: f.valor })),
        borderColor: "#4573d6", backgroundColor: "#4573d6", tension: 0.1, yAxisID: "y",
      });
      if (serieAportes.length) datasets.push({
        label: "Aportes Netos Acumulados (COP)", data: serieAportes.map((f) => ({ x: f.fechaISO, y: f.acumulado })),
        borderColor: "#45a06a", backgroundColor: "#45a06a", tension: 0.1, yAxisID: "y1",
      });
      charts[`crecimiento_${moneda}`] = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: { datasets },
        options: {
          responsive: true, parsing: false,
          plugins: { title: { display: true, text: "Crecimiento de la cartera (USD) vs. aportes transferidos (COP)" } },
          scales: {
            x: { type: "category" },
            y: { type: "linear", position: "left", title: { display: true, text: "USD" } },
            y1: { type: "linear", position: "right", title: { display: true, text: "COP (aportes transferidos)" }, grid: { drawOnChartArea: false } },
          },
        },
      });
    }
  }

  // Puerto extendido de renderAportes() -- antes mostraba TODOS los aportes
  // de la moneda en una sola tabla con una leyenda fija ("Trii / Acciones y
  // Valores", "Plenti, Binance, Hapi, Interactive Brokers") que no
  // mencionaba Fiducuenta, aunque sus filas SÍ aparecían mezcladas ahí
  // (reportado por el usuario). Ahora cada cuenta/plataforma es una casilla
  // -- se puede ver una sola cuenta a la vez, o cualquier combinación, y el
  // resumen (Depósitos/Retiros/Flujo neto) y la tabla se filtran juntos.
  function renderAportesConFiltro(div, aportes, moneda) {
    if (!aportes.length) { div.innerHTML = `<p>Todavía no hay aportes registrados.</p>`; return; }
    const plataformas = [...new Set(aportes.map((f) => f.Plataforma).filter(Boolean))].sort();
    const claseChk = `chk_aportes_${moneda}`;

    div.innerHTML = `
      <div class="checks-row">${plataformas.map((p) => `
        <label style="margin-right:14px; white-space:nowrap;">
          <input type="checkbox" class="${claseChk}" value="${p}" checked> ${p}
        </label>
      `).join("")}</div>
      <div id="aportes_metrics_${moneda}" class="metric-row"></div>
      <div id="aportes_tabla_${moneda}" class="tabla-scroll" style="max-height:300px;"></div>
    `;

    const metricsDiv = div.querySelector(`#aportes_metrics_${moneda}`);
    const tablaDiv = div.querySelector(`#aportes_tabla_${moneda}`);

    function recalcular() {
      const seleccion = new Set([...div.querySelectorAll(`.${claseChk}:checked`)].map((el) => el.value));
      const filtrados = aportes.filter((f) => seleccion.has(f.Plataforma));
      const { dep, ret, neto } = resumenAportes(filtrados);
      metricsDiv.innerHTML = `
        ${metric("Depósitos", fmtMoneda(dep))}
        ${metric("Retiros", fmtMoneda(ret))}
        ${metric("Flujo neto", fmtMoneda(neto))}
      `;
      const filas = [...filtrados].sort((a, b) => {
        const fa = parseFechaISO(a.Fecha) || "";
        const fb = parseFechaISO(b.Fecha) || "";
        return fb.localeCompare(fa);
      });
      tablaDiv.innerHTML = `
        <table class="tabla">
          <thead><tr><th>Fecha</th><th>Plataforma</th><th>Flujo</th><th>Monto</th><th>Notas</th></tr></thead>
          <tbody>${filas.map((f) => {
            const m = toNumber(f.MontoTransferido);
            return `<tr><td>${f.Fecha ?? ""}</td><td>${f.Plataforma ?? ""}</td>
              <td>${m >= 0 ? "Depósito" : "Retiro"}</td><td>${fmtMoneda(m)}</td><td>${f.Notas ?? ""}</td></tr>`;
          }).join("")}</tbody>
        </table>
      `;
    }

    div.querySelectorAll(`.${claseChk}`).forEach((el) => el.addEventListener("change", recalcular));
    recalcular();
  }

  function renderPosiciones(posiciones, moneda, aportes = null) {
    if (!posiciones.length) return `<p>Todavía no hay posiciones cargadas.</p>`;
    const { acciones, fondos, liquidez } = separarPosiciones(posiciones);
    const fmtVal = (v) => moneda === "USD" ? "US$ " + toNumber(v).toLocaleString("en-US", { minimumFractionDigits: 2 }) : fmtMoneda(v);
    const tabla = (filas) => `
      <table class="tabla">
        <thead><tr><th>Ticker / Fondo</th><th>Tipo</th><th>Cantidad</th><th>Precio Compra Prom.</th>
          <th>Costo Total</th><th>Precio Actual</th><th>Valor Actual</th><th>Ganancia/Pérdida</th></tr></thead>
        <tbody>${filas.map((f) => `<tr>
          <td>${f.TickerFondo ?? ""}</td><td>${f.Tipo ?? ""}</td>
          <td>${toNumber(f.Cantidad).toLocaleString("en-US")}</td>
          <td>${fmtVal(f.PrecioCompra)}</td><td>${fmtVal(f.CostoTotal)}</td>
          <td>${fmtVal(f.PrecioActual)}</td><td>${fmtVal(f.ValorActual)}</td>
          <td>${fmtVal(f.GananciaPerdida)}</td>
        </tr>`).join("")}</tbody>
      </table>`;

    const seccionGrupo = (titulo, filas, maxHeight) => {
      if (!filas.length) return "";
      const costoTotal = filas.reduce((s, f) => s + toNumber(f.CostoTotal), 0);
      const valorTotal = filas.reduce((s, f) => s + toNumber(f.ValorActual), 0);
      return `
        ${titulo ? `<h5>${titulo}</h5>` : ""}
        <div class="metric-row">
          ${metric("Costo Total", fmtVal(costoTotal))}
          ${metric("Valor Actual", fmtVal(valorTotal))}
          ${metric("Ganancia/Pérdida", fmtVal(valorTotal - costoTotal))}
        </div>
        <div class="tabla-scroll" style="max-height:${maxHeight}px;">${tabla(filas)}</div>
      `;
    };

    let html = "";
    if (!acciones.length && !fondos.length) {
      html += `<p>Todavía no hay posiciones de inversión cargadas.</p>`;
    } else {
      html += seccionGrupo("📈 Acciones", acciones, 340);
      html += seccionGrupo("💼 Fondos de Inversión", fondos, 220);
    }
    if (liquidez.length) {
      const valorLiquidez = liquidez.reduce((s, f) => s + toNumber(f.ValorActual), 0);
      html += `
        <h5>💰 Efectivo, margen y cuentas de liquidez</h5>
        <p class="caption">Separado de las posiciones de inversión de arriba — no tiene retorno de mercado, así
        que no cuenta para el patrimonio de inversiones ni para las métricas de rentabilidad más abajo.</p>
        <div class="metric-row">${metric("Valor Actual", fmtVal(valorLiquidez))}</div>
        <div class="tabla-scroll" style="max-height:200px;">${tabla(liquidez)}</div>
      `;
      // Fiducuenta: el usuario la usa como liquidez (plata disponible para
      // pagar impuestos), pero sigue queriendo saber cómo rinde esa plata
      // puntual -- a diferencia de Cuenta Dinámica (sin aportes registrados
      // aparte, ver Fondos de Inversión arriba), Fiducuenta sí tiene su
      // propio historial de aportes/retiros (PLATAFORMA_FONDO_BANCO), así
      // que se puede calcular una rentabilidad propia con la misma fórmula/
      // guarda que las acciones, sin mezclarla con nada más.
      if (aportes) {
        const posicionFondo = liquidez.find((f) => (f.TickerFondo || "").trim() === PLATAFORMA_FONDO_BANCO);
        if (posicionFondo) {
          const aportesFondoRaw = aportes.filter((f) => f.Plataforma === PLATAFORMA_FONDO_BANCO);
          const aportesFondo = serieAcumuladaAportes(aportesFondoRaw);
          if (aportesFondo.length) {
            const valorActualFondo = toNumber(posicionFondo.ValorActual);
            const aportesNetosFondo = aportesFondo[aportesFondo.length - 1].acumulado;
            const metricsFondo = [];
            // La rentabilidad simple (valor-aportes)/aportes se cae cuando los
            // retiros acumulados superan los aportes (denominador negativo,
            // ver rentabilidadSimple) -- típico en un fondo que se usa como
            // reserva y se vacía periódicamente (p. ej. para pagar impuestos
            // una vez al año). El XIRR no tiene ese problema: es la misma
            // tasa money-weighted que ya se usa para las acciones, y sigue
            // siendo válida aunque el neto de aportes/retiros sea negativo,
            // porque pondera cada flujo por su fecha en vez de dividir por
            // el acumulado final.
            const { metricHtml, avisoHtml } = rentabilidadSimple(
              `Rentabilidad de ${PLATAFORMA_FONDO_BANCO}`, valorActualFondo, aportesNetosFondo);
            if (metricHtml) metricsFondo.push(metricHtml);
            const xirrFondo = rentabilidadXirr(aportesFondoRaw, valorActualFondo, "pesos", null);
            if (xirrFondo !== null) {
              metricsFondo.push(metric(`Rentabilidad anualizada de ${PLATAFORMA_FONDO_BANCO} (XIRR)`, `${(xirrFondo * 100).toFixed(2)}%`));
            }
            if (metricsFondo.length) html += `<div class="metric-row">${metricsFondo.join("")}</div>`;
            if (!metricHtml && avisoHtml) html += avisoHtml;
          }
        }
      }
    }
    return html;
  }

  // ---------------------------------------------------------------------
  // Historial de posiciones y cuenta de margen (compras/ventas/cortos/
  // coberturas importadas del broker) — puerto de la sección homónima
  // dentro de render_inversiones().
  // ---------------------------------------------------------------------
  function procesarHistorial(filas) {
    const pasivos = [];
    const hist = [];
    for (const f of filas) {
      const op = String(f.Operacion || "").toUpperCase();
      if (op === "DIVIDEND" || op === "INTEREST") pasivos.push(f);
      else hist.push({ ...f, _cantidadNeta: (SIGNO_OPERACION[op] || 0) * toNumber(f.Cantidad), _fechaISO: parseFechaISO(f.Fecha) });
    }
    const grupos = {};
    for (const f of hist) {
      const key = `${f.Plataforma}|||${f.Activo}|||${f.Moneda}`;
      grupos[key] = grupos[key] || { Plataforma: f.Plataforma, Activo: f.Activo, Moneda: f.Moneda, filas: [] };
      grupos[key].filas.push(f);
    }
    const resumen = Object.values(grupos).map((g) => {
      const cantidadNeta = g.filas.reduce((s, f) => s + f._cantidadNeta, 0);
      const estado = cantidadNeta > 1e-8 ? "Abierta larga" : cantidadNeta < -1e-8 ? "Abierta corta" : "Cerrada";
      const estrategia = g.filas.some((f) => String(f.Operacion || "").toUpperCase() === "SHORT") ? "Corto" : "Largo";
      const resultadoRealizado = g.filas.reduce((s, f) => s + toNumber(f.ResultadoRealizado), 0);
      const fechasISO = g.filas.map((f) => f._fechaISO).filter(Boolean).sort();
      const textoDe = (iso) => (g.filas.find((f) => f._fechaISO === iso) || {}).Fecha || "";
      return {
        Plataforma: g.Plataforma, Activo: g.Activo, Moneda: g.Moneda, Estrategia: estrategia, Estado: estado,
        CantidadNeta: cantidadNeta, ResultadoRealizado: resultadoRealizado,
        PrimeraOperacion: fechasISO.length ? textoDe(fechasISO[0]) : "",
        UltimaOperacion: fechasISO.length ? textoDe(fechasISO[fechasISO.length - 1]) : "",
      };
    }).sort((a, b) => a.Estado.localeCompare(b.Estado) || a.Plataforma.localeCompare(b.Plataforma) || a.Activo.localeCompare(b.Activo));
    return { hist, pasivos, resumen };
  }

  function renderHistorialInversion(div, datos, recargar) {
    div.innerHTML = `<h4>Historial de posiciones y cuenta de margen</h4>`;
    if (!datos.historial.length) {
      div.insertAdjacentHTML("beforeend", "<p>Importá un reporte del broker para ver posiciones cerradas, ventas en corto y coberturas.</p>");
      const divFormularios = document.createElement("div");
      div.appendChild(divFormularios);
      renderFormAgregarDividendo(divFormularios, datos, recargar);
      renderFormEditarHistorial(divFormularios, datos, recargar);
      return;
    }
    const { hist, pasivos, resumen } = procesarHistorial(datos.historial);
    const realizadoPorMoneda = {};
    for (const f of hist) realizadoPorMoneda[f.Moneda] = (realizadoPorMoneda[f.Moneda] || 0) + toNumber(f.ResultadoRealizado);

    const body = document.createElement("div");
    body.innerHTML = `
      <div class="metric-row">
        ${metric("Posiciones cerradas", resumen.filter((r) => r.Estado === "Cerrada").length)}
        ${metric("Estrategias en corto", resumen.filter((r) => r.Estrategia === "Corto").length)}
        ${metric("Realizado en compraventas USD", "US$ " + (realizadoPorMoneda.USD || 0).toLocaleString("en-US", { minimumFractionDigits: 2 }))}
        ${metric("Realizado en compraventas COP", fmtMoneda(realizadoPorMoneda.COP || 0))}
      </div>
      <p class="caption">Este resultado realizado corresponde a compras, ventas, cortos y coberturas. Dividendos,
      impuestos, intereses y cargos de margen se concilian aparte.</p>
      <div class="tabla-scroll"><table class="tabla" id="hist_resumen_tabla"></table></div>
      <div id="hist_charts"></div>
      <details>
        <summary>Ver todas las compras, ventas, cortos y coberturas</summary>
        <div class="tabla-scroll" style="max-height:400px;"><table class="tabla" id="hist_todas_tabla"></table></div>
      </details>
      <div id="hist_pasivos"></div>
    `;
    div.appendChild(body);

    body.querySelector("#hist_resumen_tabla").innerHTML = `
      <thead><tr><th>Plataforma</th><th>Activo</th><th>Moneda</th><th>Estrategia</th><th>Estado</th>
        <th>Cantidad neta</th><th>Resultado realizado</th><th>Primera operación</th><th>Última operación</th></tr></thead>
      <tbody>${resumen.map((r) => `<tr>
        <td>${r.Plataforma ?? ""}</td><td>${r.Activo ?? ""}</td><td>${r.Moneda ?? ""}</td>
        <td>${r.Estrategia}</td><td>${r.Estado}</td>
        <td>${r.CantidadNeta.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
        <td>${r.Moneda === "USD" ? "US$ " + r.ResultadoRealizado.toLocaleString("en-US", { minimumFractionDigits: 2 }) : fmtMoneda(r.ResultadoRealizado)}</td>
        <td>${r.PrimeraOperacion}</td><td>${r.UltimaOperacion}</td>
      </tr>`).join("")}</tbody>
    `;

    const cierres = hist.filter((f) => toNumber(f.ResultadoRealizado) !== 0);
    renderChartsHistorial(body.querySelector("#hist_charts"), cierres);

    const todasOrdenadas = [...hist].sort((a, b) => (b._fechaISO || "").localeCompare(a._fechaISO || ""));
    renderTablaOperaciones(body.querySelector("#hist_todas_tabla"), todasOrdenadas);

    if (pasivos.length) renderDividendosIntereses(body.querySelector("#hist_pasivos"), pasivos);

    const divFormularios = document.createElement("div");
    div.appendChild(divFormularios);
    renderFormAgregarDividendo(divFormularios, datos, recargar);
    renderFormEditarHistorial(divFormularios, datos, recargar);
  }

  // Puerto de la clave económica de agregar_historial_inversion()
  // (sheets_backend.py) -- excluye Fuente y ResultadoRealizado a propósito,
  // para que volver a subir el mismo reporte (o renombrado) no duplique una
  // operación ya cargada.
  function claveHistorial(f) {
    const fechaISO = parseFechaISO(f.Fecha) || String(f.Fecha ?? "").trim();
    const num = (v) => Math.round(toNumber(v) * 1e8) / 1e8;
    return [fechaISO, String(f.Plataforma ?? ""), String(f.Activo ?? ""), String(f.Operacion ?? "").toUpperCase(),
      num(f.Cantidad), num(f.Precio), num(f.Comision)].join("|||");
  }

  // Puerto de _form_agregar_dividendo() (app_presupuesto.py).
  function renderFormAgregarDividendo(div, datos, recargar) {
    const sub = document.createElement("div");
    const hoy = new Date();
    sub.innerHTML = `
      <details>
        <summary>💵 Agregar un dividendo o interés recibido</summary>
        <p class="caption">Ingreso pasivo real (no viene de vender nada) — se guarda aparte del resultado
        realizado de compraventas, en 'Historial de posiciones y cuenta de margen' de arriba.</p>
        <form id="form_agregar_dividendo">
          <div class="row">
            <div class="campo"><label>Fecha</label><br><input type="date" id="div_fecha" required></div>
            <div class="campo"><label>Tipo</label><br>
              <select id="div_tipo"><option value="DIVIDEND">Dividendo</option><option value="INTEREST">Interés</option></select>
            </div>
          </div>
          <div class="row">
            <div class="campo"><label>Plataforma (ej. IBKR, Hapi)</label><br><input type="text" id="div_plataforma" required></div>
            <div class="campo"><label>Moneda</label><br><select id="div_moneda"><option value="USD">USD</option><option value="COP">COP</option></select></div>
          </div>
          <div class="campo"><label>Activo (ticker; dejalo vacío si es interés general de la cuenta)</label><br>
            <input type="text" id="div_activo"></div>
          <div class="campo"><label>Valor recibido</label><br><input type="number" step="any" min="0" id="div_valor" required></div>
          <br><button type="submit" id="div_guardar">💾 Guardar</button>
        </form>
        <div class="aviso" id="div_msg" hidden></div>
      </details>
    `;
    div.appendChild(sub);
    sub.querySelector("#div_fecha").valueAsDate = hoy;
    sub.querySelector("#form_agregar_dividendo").addEventListener("submit", (ev) =>
      onGuardarDividendo(ev, sub, datos, recargar));
  }

  async function onGuardarDividendo(ev, div, datos, recargar) {
    ev.preventDefault();
    const msg = div.querySelector("#div_msg");
    const btn = div.querySelector("#div_guardar");
    const fecha = div.querySelector("#div_fecha").value;
    const tipo = div.querySelector("#div_tipo").value;
    const plataforma = div.querySelector("#div_plataforma").value.trim();
    const moneda = div.querySelector("#div_moneda").value;
    const activo = div.querySelector("#div_activo").value.trim() || "(general)";
    const valor = Number(div.querySelector("#div_valor").value) || 0;

    if (valor <= 0) { mostrarMsgInv(msg, "El valor tiene que ser mayor que cero.", true); return; }
    if (!plataforma) { mostrarMsgInv(msg, "Escribí la plataforma.", true); return; }
    if (!fecha) { mostrarMsgInv(msg, "Elegí una fecha.", true); return; }

    const fila = [fecha, plataforma, moneda, activo, tipo, 0, 0, 0, valor, "Manual"];
    const claveNueva = claveHistorial({ Fecha: fecha, Plataforma: plataforma, Activo: activo, Operacion: tipo, Cantidad: 0, Precio: 0, Comision: 0 });
    if (datos.historial.some((f) => claveHistorial(f) === claveNueva)) {
      mostrarMsgInv(msg, "Ya había un registro idéntico (misma fecha/plataforma/activo/tipo/valor) — no se agregó de nuevo.", true);
      return;
    }

    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      await SheetsApi.appendRows(RANGOS.historial_inversion, [fila]);
      const etiqueta = tipo === "DIVIDEND" ? "Dividendo" : "Interés";
      mostrarMsgInv(msg, `${etiqueta} de ${valor.toLocaleString("en-US", { minimumFractionDigits: 2 })} ${moneda} agregado.`, false);
      await recargar();
    } catch (err) {
      mostrarMsgInv(msg, `No pude guardar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "💾 Guardar";
    }
  }

  const OPERACIONES_HISTORIAL = ["BUY", "SELL", "SHORT", "COVER", "DIVIDEND", "INTEREST"];

  function filaEditableHistorial(f) {
    const tr = document.createElement("tr");
    const fechaISO = f ? (parseFechaISO(f.Fecha) || "") : "";
    tr.innerHTML = `
      <td><input type="date" class="hist-fecha" value="${fechaISO}" style="width:100%;"></td>
      <td><input type="text" class="hist-plataforma" value="${f?.Plataforma ?? ""}" style="width:100%;"></td>
      <td><select class="hist-moneda">${["COP", "USD"].map((m) => `<option value="${m}" ${f?.Moneda === m ? "selected" : ""}>${m}</option>`).join("")}</select></td>
      <td><input type="text" class="hist-activo" value="${f?.Activo ?? ""}" style="width:100%;"></td>
      <td><select class="hist-operacion">${OPERACIONES_HISTORIAL.map((o) => `<option value="${o}" ${f?.Operacion === o ? "selected" : ""}>${o}</option>`).join("")}</select></td>
      <td><input type="number" step="any" class="hist-cantidad" value="${toNumber(f?.Cantidad)}" style="width:100%;"></td>
      <td><input type="number" step="any" class="hist-precio" value="${toNumber(f?.Precio)}" style="width:100%;"></td>
      <td><input type="number" step="any" class="hist-comision" value="${toNumber(f?.Comision)}" style="width:100%;"></td>
      <td><input type="number" step="any" class="hist-resultado" value="${toNumber(f?.ResultadoRealizado)}" style="width:100%;"></td>
      <td><input type="text" class="hist-fuente" value="${f?.Fuente ?? ""}" style="width:100%;"></td>
      <td><button type="button" class="btn-quitar-fila">✕</button></td>
    `;
    tr.querySelector(".btn-quitar-fila").addEventListener("click", () => tr.remove());
    return tr;
  }

  // Puerto de la parte "guardar" de _form_editar_historial() -- se salta
  // filas sin Activo o sin Fecha, igual que el filtro de Python.
  function leerFilasHistorial(tbody) {
    const filas = [];
    for (const tr of tbody.querySelectorAll("tr")) {
      const fecha = tr.querySelector(".hist-fecha").value;
      const activo = tr.querySelector(".hist-activo").value.trim();
      if (!fecha || !activo) continue;
      filas.push([
        fecha, tr.querySelector(".hist-plataforma").value.trim(), tr.querySelector(".hist-moneda").value, activo,
        tr.querySelector(".hist-operacion").value, Number(tr.querySelector(".hist-cantidad").value) || 0,
        Number(tr.querySelector(".hist-precio").value) || 0, Number(tr.querySelector(".hist-comision").value) || 0,
        Number(tr.querySelector(".hist-resultado").value) || 0, tr.querySelector(".hist-fuente").value.trim(),
      ]);
    }
    return filas;
  }

  // Puerto de _form_editar_historial() (app_presupuesto.py) -- a diferencia
  // del resto de Inversiones, esta hoja no es un bloque de filas reservadas
  // sino que crece por filas (RANGOS.historial_inversion cubre hasta la
  // 5000), así que "editar o borrar" significa reescribir TODO el rango
  // desde cero con lo que quede en la tabla al guardar (igual que
  // set_historial_inversion(), que primero limpia y después escribe).
  function renderFormEditarHistorial(div, datos, recargar) {
    const sub = document.createElement("div");
    sub.innerHTML = `
      <details>
        <summary>✏️ Editar o eliminar operaciones del historial (${datos.historial.length})</summary>
        <p class="caption">Corregí una operación mal importada o borrala con el botón a la derecha de la fila.
        Operación: BUY (compra), SELL (venta), SHORT (venta en corto), COVER (cobertura de corto), DIVIDEND/
        INTEREST (dividendo o interés recibido, no afecta cantidad ni cuenta como compraventa). Cambiar
        cantidad/precio/comisión NO recalcula "Resultado Realizado" solo — ajustalo a mano si corresponde.</p>
        <div class="tabla-scroll" style="max-height:400px;">
          <table class="tabla">
            <thead><tr><th>Fecha</th><th>Plataforma</th><th>Moneda</th><th>Activo</th><th>Operación</th>
              <th>Cantidad</th><th>Precio</th><th>Comisión</th><th>Resultado Realizado</th><th>Fuente</th><th></th></tr></thead>
            <tbody id="hist_editor_tbody"></tbody>
          </table>
        </div>
        <button type="button" id="hist_editor_agregar">+ Agregar fila</button>
        <br><br>
        <button type="button" id="hist_editor_guardar">💾 Guardar cambios en el historial</button>
        <div class="aviso" id="hist_editor_msg" hidden></div>
      </details>
    `;
    div.appendChild(sub);
    const tbody = sub.querySelector("#hist_editor_tbody");
    for (const f of datos.historial) tbody.appendChild(filaEditableHistorial(f));
    sub.querySelector("#hist_editor_agregar").addEventListener("click", () => tbody.appendChild(filaEditableHistorial(null)));
    sub.querySelector("#hist_editor_guardar").addEventListener("click", () => onGuardarHistorial(sub, recargar));
  }

  async function onGuardarHistorial(div, recargar) {
    const msg = div.querySelector("#hist_editor_msg");
    const btn = div.querySelector("#hist_editor_guardar");
    const filas = leerFilasHistorial(div.querySelector("#hist_editor_tbody"));
    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      await SheetsApi.clearRange(RANGOS.historial_inversion);
      if (filas.length) {
        const hoja = RANGOS.historial_inversion.split("!")[0];
        await SheetsApi.updateRange(`${hoja}!A2:J${filas.length + 1}`, filas);
      }
      mostrarMsgInv(msg, `${filas.length} operación(es) guardada(s).`, false);
      await recargar();
    } catch (err) {
      mostrarMsgInv(msg, `No pude guardar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "💾 Guardar cambios en el historial";
    }
  }

  function mostrarMsgInv(el, texto, esError) {
    el.hidden = false;
    el.textContent = texto;
    el.style.background = esError ? "#f8d7da" : "#d1e7dd";
    el.style.color = esError ? "#842029" : "#0f5132";
  }

  function renderChartsHistorial(div, cierres) {
    if (!cierres.length) { div.innerHTML = ""; return; }
    const porActivo = {}; // moneda -> { posicion -> resultado }
    const porFecha = {}; // moneda -> { fechaISO -> resultado }
    for (const f of cierres) {
      const moneda = f.Moneda;
      const posicion = `${f.Plataforma} - ${f.Activo}`;
      porActivo[moneda] = porActivo[moneda] || {};
      porActivo[moneda][posicion] = (porActivo[moneda][posicion] || 0) + toNumber(f.ResultadoRealizado);
      porFecha[moneda] = porFecha[moneda] || {};
      porFecha[moneda][f._fechaISO] = (porFecha[moneda][f._fechaISO] || 0) + toNumber(f.ResultadoRealizado);
    }
    const monedas = Object.keys(porActivo).sort();

    div.innerHTML = `
      <h5>Resultado realizado por posición</h5>
      <div class="col-2">${monedas.map((m) => `<canvas id="hist_chart_posicion_${m}" height="200"></canvas>`).join("")}</div>
      <h5>Resultado realizado acumulado</h5>
      <div class="col-2">${monedas.map((m) => `<canvas id="hist_chart_acumulado_${m}" height="140"></canvas>`).join("")}</div>
    `;

    monedas.forEach((m) => {
      const entradas = Object.entries(porActivo[m]).sort((a, b) => a[1] - b[1]);
      charts[`hist_pos_${m}`] = new Chart(div.querySelector(`#hist_chart_posicion_${m}`).getContext("2d"), {
        type: "bar",
        data: {
          labels: entradas.map((e) => e[0]),
          datasets: [{ label: `Resultado Realizado (${m})`, data: entradas.map((e) => e[1]),
            backgroundColor: entradas.map((e) => (e[1] >= 0 ? "#0d9488" : "#dc2626")) }],
        },
        options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false }, title: { display: true, text: m } } },
      });

      const fechasOrdenadas = Object.keys(porFecha[m]).filter(Boolean).sort();
      let acumulado = 0;
      const puntos = fechasOrdenadas.map((fISO) => { acumulado += porFecha[m][fISO]; return { x: fISO, y: acumulado }; });
      charts[`hist_acum_${m}`] = new Chart(div.querySelector(`#hist_chart_acumulado_${m}`).getContext("2d"), {
        type: "line",
        data: { datasets: [{ label: `Acumulado (${m})`, data: puntos, borderColor: "#4573d6", backgroundColor: "#4573d6", tension: 0.1 }] },
        options: { responsive: true, parsing: false, plugins: { legend: { display: false }, title: { display: true, text: m } },
          scales: { x: { type: "category" } } },
      });
    });
  }

  function renderTablaOperaciones(tablaEl, filas) {
    tablaEl.innerHTML = `
      <thead><tr><th>Fecha</th><th>Plataforma</th><th>Moneda</th><th>Activo</th><th>Operación</th>
        <th>Cantidad</th><th>Precio</th><th>Comisión</th><th>Resultado Realizado</th><th>Fuente</th></tr></thead>
      <tbody>${filas.map((f) => `<tr>
        <td>${f.Fecha ?? ""}</td><td>${f.Plataforma ?? ""}</td><td>${f.Moneda ?? ""}</td><td>${f.Activo ?? ""}</td>
        <td>${f.Operacion ?? ""}</td><td>${toNumber(f.Cantidad).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
        <td>${toNumber(f.Precio).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
        <td>${toNumber(f.Comision).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
        <td>${toNumber(f.ResultadoRealizado).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
        <td>${f.Fuente ?? ""}</td>
      </tr>`).join("")}</tbody>
    `;
  }

  function renderDividendosIntereses(div, pasivos) {
    const porMoneda = {};
    for (const f of pasivos) porMoneda[f.Moneda] = (porMoneda[f.Moneda] || 0) + toNumber(f.ResultadoRealizado);
    div.innerHTML = `
      <h5>💵 Dividendos e intereses recibidos</h5>
      <p class="caption">Aparte del resultado realizado de compraventas — ingreso pasivo real, no viene de
      vender nada.</p>
      <div class="metric-row">
        ${metric("Recibido en USD", "US$ " + (porMoneda.USD || 0).toLocaleString("en-US", { minimumFractionDigits: 2 }))}
        ${metric("Recibido en COP", fmtMoneda(porMoneda.COP || 0))}
      </div>
      <div id="hist_pasivo_charts" class="col-2"></div>
      <details>
        <summary>Ver el detalle de dividendos e intereses</summary>
        <div class="tabla-scroll" style="max-height:350px;"><table class="tabla" id="hist_pasivos_tabla"></table></div>
      </details>
    `;
    const monedas = [...new Set(pasivos.map((f) => f.Moneda))].sort();
    const chartsDiv = div.querySelector("#hist_pasivo_charts");
    monedas.forEach((m) => {
      const serie = pasivos.filter((f) => f.Moneda === m)
        .map((f) => ({ fechaISO: parseFechaISO(f.Fecha), valor: toNumber(f.ResultadoRealizado) }))
        .filter((f) => f.fechaISO)
        .sort((a, b) => a.fechaISO.localeCompare(b.fechaISO));
      if (serie.length < 2) return;
      const canvas = document.createElement("canvas");
      canvas.height = 140;
      chartsDiv.appendChild(canvas);
      let acumulado = 0;
      const puntos = serie.map((f) => { acumulado += f.valor; return { x: f.fechaISO, y: acumulado }; });
      charts[`hist_pasivo_${m}`] = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: { datasets: [{ label: `Acumulado (${m})`, data: puntos, borderColor: "#8a56c9", backgroundColor: "#8a56c9", tension: 0.1 }] },
        options: { responsive: true, parsing: false, plugins: { title: { display: true, text: m }, legend: { display: false } },
          scales: { x: { type: "category" } } },
      });
    });

    const tablaEl = div.querySelector("#hist_pasivos_tabla");
    const ordenados = [...pasivos].sort((a, b) => (parseFechaISO(b.Fecha) || "").localeCompare(parseFechaISO(a.Fecha) || ""));
    renderTablaOperaciones(tablaEl, ordenados);
  }

  function renderGraficos(contenido, datos) {
    Object.values(charts).forEach((c) => c?.destroy());

    ["pesos", "dolares"].forEach((m) => {
      const aportes = m === "pesos" ? datos.aportesPesos : datos.aportesDolares;
      const canvas = contenido.querySelector(`#chart_plataforma_${m}`);
      if (!aportes.length) { canvas.replaceWith(document.createTextNode("(sin datos)")); return; }
      const porPlat = porPlataforma(aportes);
      const plataformas = Object.keys(porPlat);
      charts[`plat_${m}`] = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
          labels: plataformas,
          datasets: [
            { label: "Depósito", data: plataformas.map((p) => porPlat[p].dep), backgroundColor: "#4573d6" },
            { label: "Retiro", data: plataformas.map((p) => porPlat[p].ret), backgroundColor: "#d64545" },
          ],
        },
        options: { indexAxis: "y", responsive: true,
          scales: { x: { ticks: { callback: (v) => fmtMoneda(v) } } } },
      });
    });

    const cronologia = [];
    for (const [moneda, aportes] of [["Pesos", datos.aportesPesos], ["Dólares", datos.aportesDolares]]) {
      const ordenados = aportes
        .map((f) => ({ fechaISO: parseFechaISO(f.Fecha), monto: toNumber(f.MontoTransferido) }))
        .filter((f) => f.fechaISO)
        .sort((a, b) => a.fechaISO.localeCompare(b.fechaISO));
      let acumulado = 0;
      const puntos = ordenados.map((f) => { acumulado += f.monto; return { x: f.fechaISO, y: acumulado }; });
      if (puntos.length) cronologia.push({ moneda, puntos });
    }
    const canvasFlujo = contenido.querySelector("#chart_flujo_tiempo");
    if (cronologia.length) {
      charts.flujo = new Chart(canvasFlujo.getContext("2d"), {
        type: "line",
        data: {
          datasets: cronologia.map((c, i) => ({
            label: c.moneda, data: c.puntos, borderColor: PALETA[i % PALETA.length],
            backgroundColor: PALETA[i % PALETA.length], fill: false, tension: 0.1,
          })),
        },
        options: { responsive: true, parsing: false,
          scales: { x: { type: "category" }, y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
      });
    } else {
      canvasFlujo.replaceWith(document.createTextNode("(sin datos)"));
    }
  }

  const PALETA = ["#d64545", "#4573d6", "#45a06a", "#d69a45", "#8a56c9", "#45b8c9", "#c9457e", "#a3a3a3"];

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
