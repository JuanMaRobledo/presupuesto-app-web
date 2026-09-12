// Puerto (parcial, solo lectura) de render_inversiones() (app_presupuesto.py):
// aportes/retiros en pesos y dólares (con flujo neto por plataforma y en el
// tiempo), posiciones (cantidad, precio, valor de mercado, ganancia/pérdida),
// y el historial de posiciones/cuenta de margen importado del broker (cierres
// realizados, ventas en corto, dividendos e intereses).
//
// TODAVÍA NO portado: patrimonio unificado, importar portafolios/actualizar
// precios y Crecimiento y Rentabilidad — dependen de la TRM/benchmarks vía
// Yahoo Finance, que un sitio estático no puede consultar del lado del
// navegador (CORS — Yahoo no habilita ese origen para JS de terceros), y
// _form_agregar_dividendo()/_form_editar_historial() (escritura sobre el
// historial de operaciones).

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
  const charts = {};

  async function cargarDatos() {
    const raw = await SheetsApi.batchGet([
      "aportes_inversion_pesos", "aportes_inversion_dolares", "posiciones_pesos", "posiciones_dolares",
      "historial_inversion",
    ]);
    return {
      aportesPesos: filasAObjetos(raw.aportes_inversion_pesos, APORTE_COLS, ["Fecha"]),
      aportesDolares: filasAObjetos(raw.aportes_inversion_dolares, APORTE_COLS, ["Fecha"]),
      posicionesPesos: filasAObjetos(raw.posiciones_pesos, POSICION_COLS),
      posicionesDolares: filasAObjetos(raw.posiciones_dolares, POSICION_COLS),
      historial: filasAObjetos(raw.historial_inversion, HISTORIAL_COLS, ["Fecha"]),
    };
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
        <div class="col-2">
          <div>
            <h4>Pesos (COP)</h4>
            <p class="caption">Trii / Acciones y Valores — acciones y fondos</p>
            ${renderAportes(datos.aportesPesos, "pesos")}
          </div>
          <div>
            <h4>Dólares (USD)</h4>
            <p class="caption">Plenti, Binance, Hapi, Interactive Brokers</p>
            ${renderAportes(datos.aportesDolares, "dolares")}
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
        ${renderPosiciones(datos.posicionesPesos, "COP")}

        <h4>Posiciones — Dólares</h4>
        ${renderPosiciones(datos.posicionesDolares, "USD")}

        <div id="inv-historial"></div>

        <div class="aviso">⚠️ Todavía no portados: patrimonio unificado, actualizar precios (Yahoo Finance) y
        el gráfico de Crecimiento y Rentabilidad — dependen de la TRM/benchmarks vía Yahoo Finance, que este
        sitio no puede consultar del lado del navegador. Usá
        <a href="https://presupuesto-app-jmr.streamlit.app" target="_blank" rel="noopener">la versión de
        Streamlit</a> para eso mientras tanto.</div>
      `;

      renderGraficos(contenido, datos);
      renderHistorialInversion(contenido.querySelector("#inv-historial"), datos);
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  function renderAportes(aportes, sufijo) {
    if (!aportes.length) return `<p>Todavía no hay aportes registrados.</p>`;
    const { dep, ret, neto } = resumenAportes(aportes);
    const filas = [...aportes].sort((a, b) => {
      const fa = parseFechaISO(a.Fecha) || "";
      const fb = parseFechaISO(b.Fecha) || "";
      return fb.localeCompare(fa);
    });
    return `
      <div class="metric-row">
        ${metric("Depósitos", fmtMoneda(dep))}
        ${metric("Retiros", fmtMoneda(ret))}
        ${metric("Flujo neto", fmtMoneda(neto))}
      </div>
      <div class="tabla-scroll" style="max-height:300px;">
        <table class="tabla">
          <thead><tr><th>Fecha</th><th>Plataforma</th><th>Flujo</th><th>Monto</th><th>Notas</th></tr></thead>
          <tbody>${filas.map((f) => {
            const m = toNumber(f.MontoTransferido);
            return `<tr><td>${f.Fecha ?? ""}</td><td>${f.Plataforma ?? ""}</td>
              <td>${m >= 0 ? "Depósito" : "Retiro"}</td><td>${fmtMoneda(m)}</td><td>${f.Notas ?? ""}</td></tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    `;
  }

  function renderPosiciones(posiciones, moneda) {
    if (!posiciones.length) return `<p>Todavía no hay posiciones cargadas.</p>`;
    const fmtVal = (v) => moneda === "USD" ? "US$ " + toNumber(v).toLocaleString("en-US", { minimumFractionDigits: 2 }) : fmtMoneda(v);
    const costoTotal = posiciones.reduce((s, f) => s + toNumber(f.CostoTotal), 0);
    const valorTotal = posiciones.reduce((s, f) => s + toNumber(f.ValorActual), 0);
    return `
      <div class="metric-row">
        ${metric("Costo Total", fmtVal(costoTotal))}
        ${metric("Valor Actual", fmtVal(valorTotal))}
        ${metric("Ganancia/Pérdida", fmtVal(valorTotal - costoTotal))}
      </div>
      <div class="tabla-scroll" style="max-height:340px;">
        <table class="tabla">
          <thead><tr><th>Ticker / Fondo</th><th>Tipo</th><th>Cantidad</th><th>Precio Compra Prom.</th>
            <th>Costo Total</th><th>Precio Actual</th><th>Valor Actual</th><th>Ganancia/Pérdida</th></tr></thead>
          <tbody>${posiciones.map((f) => `<tr>
            <td>${f.TickerFondo ?? ""}</td><td>${f.Tipo ?? ""}</td>
            <td>${toNumber(f.Cantidad).toLocaleString("en-US")}</td>
            <td>${fmtVal(f.PrecioCompra)}</td><td>${fmtVal(f.CostoTotal)}</td>
            <td>${fmtVal(f.PrecioActual)}</td><td>${fmtVal(f.ValorActual)}</td>
            <td>${fmtVal(f.GananciaPerdida)}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    `;
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
      const key = `${f.Plataforma} ${f.Activo} ${f.Moneda}`;
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

  function renderHistorialInversion(div, datos) {
    div.innerHTML = `<h4>Historial de posiciones y cuenta de margen</h4>`;
    if (!datos.historial.length) {
      div.insertAdjacentHTML("beforeend", "<p>Importá un reporte del broker para ver posiciones cerradas, ventas en corto y coberturas.</p>");
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
