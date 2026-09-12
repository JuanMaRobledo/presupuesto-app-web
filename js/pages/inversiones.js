// Puerto (parcial, solo lectura) de render_inversiones() (app_presupuesto.py):
// aportes/retiros en pesos y dólares (con flujo neto por plataforma y en el
// tiempo) y posiciones (cantidad, precio, valor de mercado, ganancia/pérdida).
//
// TODAVÍA NO portado: patrimonio unificado, importar portafolios/actualizar
// precios vía Yahoo Finance (necesitan escritura + una API externa),
// historial de operaciones (compras/ventas de broker), y el gráfico de
// Crecimiento y Rentabilidad.

const PaginaInversiones = (() => {
  const APORTE_COLS = ["Fecha", "Plataforma", "MontoTransferido", "Notas"];
  const POSICION_COLS = [
    "TickerFondo", "Tipo", "Cantidad", "PrecioCompra", "CostoTotal", "PrecioActual", "ValorActual", "GananciaPerdida",
  ];
  const charts = {};

  async function cargarDatos() {
    const raw = await SheetsApi.batchGet([
      "aportes_inversion_pesos", "aportes_inversion_dolares", "posiciones_pesos", "posiciones_dolares",
    ]);
    return {
      aportesPesos: filasAObjetos(raw.aportes_inversion_pesos, APORTE_COLS, ["Fecha"]),
      aportesDolares: filasAObjetos(raw.aportes_inversion_dolares, APORTE_COLS, ["Fecha"]),
      posicionesPesos: filasAObjetos(raw.posiciones_pesos, POSICION_COLS),
      posicionesDolares: filasAObjetos(raw.posiciones_dolares, POSICION_COLS),
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

        <div class="aviso">⚠️ Todavía no portados: patrimonio unificado, actualizar precios (Yahoo Finance),
        historial de operaciones del broker, y el gráfico de Crecimiento y Rentabilidad — usá
        <a href="https://presupuesto-app-jmr.streamlit.app" target="_blank" rel="noopener">la versión de
        Streamlit</a> para eso mientras tanto.</div>
      `;

      renderGraficos(contenido, datos);
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
