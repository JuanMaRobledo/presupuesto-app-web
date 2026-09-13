// Puerto de render_informe_inversiones() (app_presupuesto.py): informe
// ejecutivo de lectura corrida del portafolio, en vez de las herramientas
// interactivas de 📈 Inversiones. Reusa el mismo criterio de separación
// liquidez/inversión que el resto de la app (ver comentario de
// js/pages/inversiones.js).
//
// NO disponible acá (a diferencia de Streamlit): el "Efecto cambiario de los
// aportes (TRM)" y el TWR en dólares -- ambos necesitan la TRM HISTÓRICA día
// a día de Yahoo Finance para convertir cada aporte en pesos a su
// equivalente en dólares de esa fecha, y eso solo lo puede calcular un
// GitHub Action (Yahoo Finance bloquea el acceso por CORS a un sitio
// estático) -- el Action actual (scripts/actualizar_mercado.py) todavía no
// guarda esa serie histórica en el Sheet, solo la TRM de hoy. El TWR en
// pesos SÍ es 100% calculable acá (los aportes ya están en COP, no
// necesitan conversión).
const PaginaInformeInversiones = (() => {
  const APORTE_COLS = ["Fecha", "Plataforma", "MontoTransferido", "Notas"];
  const POSICION_COLS = [
    "TickerFondo", "Tipo", "Cantidad", "PrecioCompra", "CostoTotal", "PrecioActual", "ValorActual", "GananciaPerdida",
  ];
  const HISTORIAL_COLS = [
    "Fecha", "Plataforma", "Moneda", "Activo", "Operacion", "Cantidad", "Precio", "Comision", "ResultadoRealizado", "Fuente",
  ];
  const VALOR_CARTERA_COLS = ["Fecha", "Moneda", "ValorCosto", "ValorActual", "AportesNetos"];
  const charts = {};

  const TIPOS_LIQUIDEZ = new Set(["Fiducuenta"]);
  function esCuentaLiquidez(f) {
    return TIPOS_LIQUIDEZ.has(String(f.Tipo || "").trim()) || /Efectivo\/Margen$/i.test(String(f.TickerFondo || ""));
  }

  async function cargarDatos() {
    const raw = await SheetsApi.batchGet([
      "aportes_inversion_pesos", "aportes_inversion_dolares", "posiciones_pesos", "posiciones_dolares", "historial_inversion",
    ]);
    let historialValorCartera = [];
    let trm = null;
    try {
      const rawMercado = await SheetsApi.batchGet(["historial_valor_cartera", "datos_mercado"]);
      historialValorCartera = filasAObjetos(rawMercado.historial_valor_cartera, VALOR_CARTERA_COLS, ["Fecha"]);
      for (const r of rawMercado.datos_mercado || []) {
        if (r && r[0] === "TRM (USD/COP)" && typeof r[1] === "number") trm = r[1];
      }
    } catch (err) {
      console.warn("Todavía no hay datos de mercado del GitHub Action:", err.message);
    }
    return {
      aportesPesos: filasAObjetos(raw.aportes_inversion_pesos, APORTE_COLS, ["Fecha"]),
      aportesDolares: filasAObjetos(raw.aportes_inversion_dolares, APORTE_COLS, ["Fecha"]),
      posicionesPesos: filasAObjetos(raw.posiciones_pesos, POSICION_COLS),
      posicionesDolares: filasAObjetos(raw.posiciones_dolares, POSICION_COLS),
      historial: filasAObjetos(raw.historial_inversion, HISTORIAL_COLS, ["Fecha"]),
      historialValorCartera,
      trm,
    };
  }

  // Puerto de _xirr() (app_presupuesto.py).
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

  // Puerto de _rentabilidad_xirr(moneda) -- TODOS los aportes/retiros contra
  // el valor de mercado de HOY (acciones+fondos, sin liquidez).
  function rentabilidadXirrTodo(aportes, valorActualNativo, moneda, trm) {
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

  // Puerto de _analizar_portafolio_moneda(moneda).
  function analizarPortafolioMoneda(posiciones) {
    const posConTicker = posiciones.filter((f) => String(f.TickerFondo || "").trim() !== "");
    if (!posConTicker.length) return null;
    const esAjuste = posConTicker.map(esCuentaLiquidez);
    const dfReal = posConTicker.filter((f, i) => !esAjuste[i]);
    const ajuste = posConTicker.filter((f, i) => esAjuste[i]).reduce((s, f) => s + toNumber(f.ValorActual), 0);
    const costo = dfReal.reduce((s, f) => s + toNumber(f.CostoTotal), 0);
    const valor = dfReal.reduce((s, f) => s + toNumber(f.ValorActual), 0);
    const ganancia = valor - costo;
    const enriquecido = dfReal.map((f) => {
      const ticker = String(f.TickerFondo || "");
      const idx = ticker.indexOf(" - ");
      const plataforma = idx === -1 ? ticker : ticker.slice(0, idx);
      const simbolo = idx === -1 ? ticker : ticker.slice(idx + 3);
      const costoTotal = toNumber(f.CostoTotal);
      const gp = costoTotal ? (toNumber(f.GananciaPerdida) / costoTotal * 100) : 0;
      return { ...f, Plataforma: plataforma, Ticker: simbolo, Etiqueta: `${simbolo} (${plataforma})`, GPpct: gp };
    });
    return { df: enriquecido, ajuste, costo, valor, ganancia, costoPropio: costo + ajuste, valorPropio: valor + ajuste };
  }

  // Puerto de _twr_moneda("pesos") -- Modified Dietz encadenado entre fotos
  // consecutivas de 'Historial de Valor de Cartera'; solo pesos (ver
  // comentario de encabezado: dólares necesita TRM histórica, no disponible).
  function twrPesos(historialValorCartera, aportesPesos) {
    const snaps = historialValorCartera
      .filter((f) => f.Moneda === "pesos")
      .map((f) => ({ fecha: parseFechaISO(f.Fecha), valor: toNumber(f.ValorActual) }))
      .filter((f) => f.fecha)
      .sort((a, b) => a.fecha.localeCompare(b.fecha));
    // Una fecha puede repetirse si el Action corrió más de una vez el mismo
    // día -- se queda con la última (mismo criterio que drop_duplicates(keep="last")).
    const porFecha = {};
    for (const s of snaps) porFecha[s.fecha] = s.valor;
    const fechas = Object.keys(porFecha).sort();
    if (fechas.length < 2) return null;

    const flujos = [];
    for (const f of aportesPesos) {
      const fechaISO = parseFechaISO(f.Fecha);
      const monto = toNumber(f.MontoTransferido);
      if (fechaISO && monto) flujos.push({ fecha: fechaISO, monto });
    }

    let factor = 1.0;
    let nSub = 0;
    for (let i = 1; i < fechas.length; i++) {
      const t0 = fechas[i - 1], t1 = fechas[i];
      const v0 = porFecha[t0], v1 = porFecha[t1];
      const diasSub = (new Date(t1) - new Date(t0)) / 86400000;
      if (diasSub <= 0) continue;
      const cfs = flujos.filter((fl) => fl.fecha > t0 && fl.fecha <= t1);
      const sumaCf = cfs.reduce((s, fl) => s + fl.monto, 0);
      const denom = v0 + cfs.reduce((s, fl) => s + fl.monto * ((new Date(t1) - new Date(fl.fecha)) / 86400000) / diasSub, 0);
      if (denom === 0) continue;
      factor *= 1 + (v1 - v0 - sumaCf) / denom;
      nSub += 1;
    }
    if (nSub === 0) return null;
    const diasTotales = (new Date(fechas[fechas.length - 1]) - new Date(fechas[0])) / 86400000;
    const twrTotal = factor - 1;
    const twrAnual = diasTotales > 0 ? Math.pow(factor, 365 / diasTotales) - 1 : null;
    return { twrTotal, twrAnual, dias: diasTotales, nSubperiodos: nSub, nSnapshots: fechas.length };
  }

  async function render(container) {
    container.innerHTML = `
      <h1>📈 Informe de Inversiones</h1>
      <p class="caption">Resumen ejecutivo del portafolio en pesos y en dólares, por separado — posiciones,
      rentabilidad, composición y operaciones cerradas.</p>
      <div class="aviso">El "Efecto cambiario de los aportes (TRM)" y el TWR en dólares de la versión de
      Streamlit necesitan la TRM histórica día a día de Yahoo Finance, que un sitio estático no puede
      descargar (CORS) y el GitHub Action de precios todavía no guarda — no están disponibles acá. El resto
      del informe (retorno bruto, capital propio, XIRR, TWR en pesos, composición, operaciones cerradas) sí.</p>
      <div id="ii-contenido">Cargando datos del Sheet…</div>
    `;
    const contenido = container.querySelector("#ii-contenido");
    try {
      const datos = await cargarDatos();
      let html = "";
      for (const [moneda, nombre, unidad] of [["pesos", "Portafolio en pesos", "COP"], ["dolares", "Portafolio en dólares", "USD"]]) {
        html += `<div id="ii-${moneda}"></div><hr>`;
      }
      html += `<div id="ii-aportes"></div><hr><div id="ii-cierres"></div>`;
      contenido.innerHTML = html;

      renderMoneda(contenido.querySelector("#ii-pesos"), datos, "pesos", "Portafolio en pesos", "COP");
      renderMoneda(contenido.querySelector("#ii-dolares"), datos, "dolares", "Portafolio en dólares", "USD");
      renderCapitalAportado(contenido.querySelector("#ii-aportes"), datos);
      renderOperacionesCerradas(contenido.querySelector("#ii-cierres"), datos.historial);
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  function renderMoneda(div, datos, moneda, nombre, unidad) {
    const posiciones = moneda === "pesos" ? datos.posicionesPesos : datos.posicionesDolares;
    const aportes = moneda === "pesos" ? datos.aportesPesos : datos.aportesDolares;
    const info = analizarPortafolioMoneda(posiciones);
    if (!info) { div.innerHTML = `<h3>${nombre}</h3><p>Todavía no hay posiciones cargadas acá.</p>`; return; }

    const fmt = (v) => (moneda === "dolares" ? "US$ " + v.toLocaleString("en-US", { minimumFractionDigits: 2 }) : fmtMoneda(v));
    const retornoBruto = info.costo ? (info.ganancia / info.costo * 100) : 0;
    const capitalPropioValido = info.costoPropio > 0;
    const retornoPropio = capitalPropioValido ? (info.ganancia / info.costoPropio * 100) : null;
    // Puerto de _rentabilidad_xirr(moneda): para dólares, el valor final se
    // convierte a pesos con la TRM de HOY (los aportes ya están en pesos
    // reales, no hace falta tocarlos) -- si el GitHub Action de precios
    // todavía no corrió, no hay TRM y el XIRR en dólares queda "—".
    const xirrVal = rentabilidadXirrTodo(aportes, info.valor, moneda, datos.trm);

    let html = `<h3>${nombre}</h3>`;
    html += `
      <div class="metric-row">
        ${metric("Valor de las posiciones", fmt(info.valor))}
        ${metric("Ganancia/pérdida no realizada", `${fmt(info.ganancia)} (${retornoBruto >= 0 ? "+" : ""}${retornoBruto.toFixed(1)}% bruto)`)}
      </div>
      <div class="metric-row">
        ${capitalPropioValido
          ? metric("Capital propio hoy", `${fmt(info.valorPropio)} (${retornoPropio >= 0 ? "+" : ""}${retornoPropio.toFixed(1)}% sobre capital propio)`)
          : metric("Capital propio hoy", `${fmt(info.valorPropio)} — apalancado más de 1:1, % no legible`)}
        ${metric("Rentabilidad anualizada (XIRR)", xirrVal !== null ? `${(xirrVal * 100).toFixed(1)}%` : "—")}
      </div>
    `;
    if (Math.abs(info.ajuste) > 1) {
      const motivo = info.ajuste < 0 ? "margen prestado por el bróker" : "efectivo sin invertir";
      html += `<p class="caption">Hay ${fmt(Math.abs(info.ajuste))} de ${motivo} mezclados en el valor de la
        cuenta, fuera de las posiciones. El retorno bruto de arriba lo ignora — compará mejor contra "Capital
        propio", que sí lo descuenta de los dos lados, o contra el XIRR.</p>`;
    }

    html += `<p><strong>📐 Métricas de rendimiento</strong></p>`;
    const filasMetricas = [
      ["Retorno simple (bruto)", `${retornoBruto >= 0 ? "+" : ""}${retornoBruto.toFixed(1)}%`, "Ganancia / costo de las posiciones — sin apalancamiento, sin importar fechas."],
    ];
    if (capitalPropioValido) {
      filasMetricas.push(["Retorno sobre capital propio", `${retornoPropio >= 0 ? "+" : ""}${retornoPropio.toFixed(1)}%`, "Ídem, descontando el margen prestado — tu retorno real sobre tu plata."]);
    }
    filasMetricas.push(["XIRR (anualizado)", xirrVal !== null ? `${(xirrVal * 100).toFixed(1)}%` : "—", "Money-weighted: pondera CUÁNDO metiste cada peso, no solo cuánto."]);
    if (moneda === "pesos") {
      const twr = twrPesos(datos.historialValorCartera, aportes);
      if (twr) {
        filasMetricas.push(["TWR (anualizado)", twr.twrAnual !== null ? `${(twr.twrAnual * 100).toFixed(1)}%` : "—",
          `Time-weighted: encadena ${twr.nSubperiodos} sub-período(s) entre fotos guardadas — mide qué tan bien elegiste, no cuándo invertiste.`]);
        filasMetricas.push(["TWR del período (sin anualizar)", `${(twr.twrTotal * 100).toFixed(1)}%`, `Retorno acumulado en los últimos ${twr.dias} días entre fotos.`]);
        if (xirrVal !== null && twr.twrAnual !== null && Math.abs(xirrVal - twr.twrAnual) > 0.05) {
          const mejorCuando = twr.twrAnual > xirrVal ? "elegiste mejor de lo que sugiere el timing de tus aportes" : "el timing de tus aportes te ayudó más de lo que sugiere la calidad de tus elecciones";
          html += `<p class="caption">XIRR y TWR difieren bastante acá — probablemente ${mejorCuando}.</p>`;
        }
      } else {
        filasMetricas.push(["TWR", "—", "Necesita al menos 2 fotos en 'Historial de Valor de Cartera' — se guardan solas cada vez que actualizás precios o posiciones/aportes."]);
      }
    } else {
      filasMetricas.push(["TWR", "—", "No disponible en dólares acá (necesita TRM histórica, ver aviso arriba)."]);
    }
    html += `<table class="tabla"><thead><tr><th>Métrica</th><th>Valor</th><th>Qué mide</th></tr></thead>
      <tbody>${filasMetricas.map((f) => `<tr><td>${f[0]}</td><td>${f[1]}</td><td>${f[2]}</td></tr>`).join("")}</tbody></table>`;

    const mejor = [...info.df].sort((a, b) => b.GPpct - a.GPpct)[0];
    const peor = [...info.df].sort((a, b) => a.GPpct - b.GPpct)[0];
    const multiPlataforma = new Set(info.df.map((f) => f.Plataforma)).size > 1;
    const etiquetaPos = (f) => (multiPlataforma ? `${f.Ticker} (${f.Plataforma})` : f.Ticker);
    html += `
      <div class="metric-row">
        ${metric("Mejor posición", `${etiquetaPos(mejor)} (${mejor.GPpct >= 0 ? "+" : ""}${mejor.GPpct.toFixed(1)}%)`)}
        ${metric("Peor posición", `${etiquetaPos(peor)} (${peor.GPpct >= 0 ? "+" : ""}${peor.GPpct.toFixed(1)}%)`)}
      </div>
      <p class="caption">${info.df.length} posiciones activas.</p>
      <p><strong>Composición por posición (valor actual)</strong></p>
      <canvas id="ii_chart_comp_${moneda}" height="${Math.max(160, 28 * info.df.length)}"></canvas>
      <p><strong>Ganancia/pérdida por posición</strong></p>
      <canvas id="ii_chart_gp_${moneda}" height="${Math.max(160, 28 * info.df.length)}"></canvas>
      <details>
        <summary>Ver las ${info.df.length} posiciones en detalle</summary>
        <div class="tabla-scroll" style="max-height:350px;"><table class="tabla">
          <thead><tr><th>Ticker</th><th>Plataforma</th><th>Tipo</th><th>Cantidad</th><th>Precio Compra Prom.</th>
            <th>Costo Total</th><th>Precio Actual</th><th>Valor Actual</th><th>Ganancia/Pérdida</th><th>G/P %</th></tr></thead>
          <tbody>${[...info.df].sort((a, b) => toNumber(b.ValorActual) - toNumber(a.ValorActual)).map((f) => `<tr>
            <td>${f.Ticker}</td><td>${f.Plataforma}</td><td>${f.Tipo}</td>
            <td>${toNumber(f.Cantidad).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
            <td>${fmt(toNumber(f.PrecioCompra))}</td><td>${fmt(toNumber(f.CostoTotal))}</td>
            <td>${fmt(toNumber(f.PrecioActual))}</td><td>${fmt(toNumber(f.ValorActual))}</td>
            <td>${fmt(toNumber(f.GananciaPerdida))}</td><td>${f.GPpct.toFixed(1)}%</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </details>
    `;
    div.innerHTML = html;

    const compOrdenado = [...info.df].sort((a, b) => toNumber(a.ValorActual) - toNumber(b.ValorActual));
    charts[`comp_${moneda}`]?.destroy();
    charts[`comp_${moneda}`] = new Chart(div.querySelector(`#ii_chart_comp_${moneda}`).getContext("2d"), {
      type: "bar",
      data: { labels: compOrdenado.map((f) => f.Etiqueta), datasets: [{ label: "Valor Actual", data: compOrdenado.map((f) => toNumber(f.ValorActual)), backgroundColor: "#4573d6" }] },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } } },
    });
    const gpOrdenado = [...info.df].sort((a, b) => a.GPpct - b.GPpct);
    charts[`gp_${moneda}`]?.destroy();
    charts[`gp_${moneda}`] = new Chart(div.querySelector(`#ii_chart_gp_${moneda}`).getContext("2d"), {
      type: "bar",
      data: { labels: gpOrdenado.map((f) => f.Etiqueta), datasets: [{ label: "G/P %", data: gpOrdenado.map((f) => f.GPpct), backgroundColor: gpOrdenado.map((f) => (f.GPpct >= 0 ? "#0ca30c" : "#d03b3b")) }] },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } } },
    });
  }

  function renderCapitalAportado(div, datos) {
    div.innerHTML = `<h3>Capital aportado</h3>
      <p class="caption">Lo que efectivamente salió de tu cuenta hacia cada plataforma (siempre en pesos, sea
      cual sea la moneda de destino) — no incluye el margen prestado.</p>
      <div id="ii_aportes_contenido"></div>`;
    const todos = [...datos.aportesPesos, ...datos.aportesDolares];
    if (!todos.length) { div.querySelector("#ii_aportes_contenido").innerHTML = "<p>Todavía no hay aportes registrados.</p>"; return; }
    const porPlataforma = {};
    for (const f of todos) porPlataforma[f.Plataforma] = (porPlataforma[f.Plataforma] || 0) + toNumber(f.MontoTransferido);
    const entradas = Object.entries(porPlataforma).sort((a, b) => b[1] - a[1]);
    const totalAportado = entradas.reduce((s, [, v]) => s + v, 0);
    div.querySelector("#ii_aportes_contenido").innerHTML = `
      <div class="metric-row">
        ${metric("Total transferido (neto)", fmtMoneda(totalAportado))}
        ${metric("Plataformas activas", entradas.length)}
      </div>
      <canvas id="ii_chart_aportes" height="${Math.max(140, 40 * entradas.length)}"></canvas>
    `;
    charts.aportes?.destroy();
    charts.aportes = new Chart(div.querySelector("#ii_chart_aportes").getContext("2d"), {
      type: "bar",
      data: { labels: entradas.map((e) => e[0]), datasets: [{ label: "Monto Transferido (COP)", data: entradas.map((e) => e[1]), backgroundColor: "#4573d6" }] },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } } },
    });
  }

  function renderOperacionesCerradas(div, historial) {
    div.innerHTML = `<h3>Operaciones cerradas</h3>`;
    if (!historial.length) { div.insertAdjacentHTML("beforeend", "<p>Todavía no hay historial de operaciones importado.</p>"); return; }
    const cierres = historial.filter((f) => ["SELL", "COVER"].includes(String(f.Operacion || "").toUpperCase()));
    if (!cierres.length) { div.insertAdjacentHTML("beforeend", "<p>Todavía no hay operaciones cerradas (solo compras abiertas).</p>"); return; }
    const ganadoras = cierres.filter((f) => toNumber(f.ResultadoRealizado) > 0).length;
    const total = cierres.length;
    const tasaAcierto = (ganadoras / total * 100);
    const realizadoCop = cierres.filter((f) => f.Moneda === "COP").reduce((s, f) => s + toNumber(f.ResultadoRealizado), 0);
    const realizadoUsd = cierres.filter((f) => f.Moneda === "USD").reduce((s, f) => s + toNumber(f.ResultadoRealizado), 0);
    div.insertAdjacentHTML("beforeend", `
      <div class="metric-row">
        ${metric("Operaciones cerradas", total)}
        ${metric("Tasa de acierto", `${tasaAcierto.toFixed(0)}% (${ganadoras}/${total})`)}
      </div>
      <div class="metric-row">
        ${metric("Resultado realizado (COP)", fmtMoneda(realizadoCop))}
        ${metric("Resultado realizado (USD)", "US$ " + realizadoUsd.toLocaleString("en-US", { minimumFractionDigits: 2 }))}
      </div>
      <p class="caption">Ya queda reflejado en el costo promedio de lo que sigue abierto arriba — no lo sumes
      aparte a la ganancia no realizada.</p>
    `);
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
