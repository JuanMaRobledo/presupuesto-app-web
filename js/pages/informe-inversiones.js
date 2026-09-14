// Puerto de render_informe_inversiones() (app_presupuesto.py): informe
// ejecutivo de lectura corrida del portafolio, en vez de las herramientas
// interactivas de 📈 Inversiones. Reusa el mismo criterio de separación
// liquidez/inversión que el resto de la app (ver comentario de
// js/pages/inversiones.js).
//
// El TWR en dólares y el "Efecto cambiario de los aportes (TRM)" necesitan
// la TRM HISTÓRICA día a día de Yahoo Finance (convertir cada aporte en
// pesos a su equivalente en dólares de ESA fecha) -- un sitio estático no
// puede pedirle eso a Yahoo Finance (CORS), así que scripts/
// actualizar_mercado.py la descarga server-side y la deja en la hoja
// 'Historial TRM (Auto)' (ver RANGOS.historial_trm). Si esa hoja todavía no
// existe (el Action nunca corrió con este cambio, o nunca hubo un aporte en
// dólares que la dispare), esas dos métricas quedan en "—"/ocultas en vez
// de romper el resto del informe -- mismo criterio de degradación que ya
// usa esta página cuando falta 'Datos de Mercado (Auto)'.
const PaginaInformeInversiones = (() => {
  const APORTE_COLS = ["Fecha", "Plataforma", "MontoTransferido", "Notas"];
  const POSICION_COLS = [
    "TickerFondo", "Tipo", "Cantidad", "PrecioCompra", "CostoTotal", "PrecioActual", "ValorActual", "GananciaPerdida",
  ];
  const HISTORIAL_COLS = [
    "Fecha", "Plataforma", "Moneda", "Activo", "Operacion", "Cantidad", "Precio", "Comision", "ResultadoRealizado", "Fuente",
  ];
  const VALOR_CARTERA_COLS = ["Fecha", "Moneda", "ValorCosto", "ValorActual", "AportesNetos", "ValorCapitalPropio"];
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
    // Aparte del batchGet de arriba: si 'Historial TRM (Auto)' no existe
    // (Action nunca corrió con esto, o nunca hubo aporte en dólares), que
    // solo afecte a TWR-dólares/efecto cambiario, no a datos_mercado/
    // historial_valor_cartera de arriba.
    let historialTrm = [];
    try {
      const rawTrm = await SheetsApi.batchGet(["historial_trm"]);
      historialTrm = (rawTrm.historial_trm || [])
        .filter((r) => r && r[0])
        .map((r) => ({ fechaISO: parseFechaISO(r[0]), valor: toNumber(r[1]) }))
        .filter((r) => r.fechaISO)
        .sort((a, b) => a.fechaISO.localeCompare(b.fechaISO));
    } catch (err) {
      console.warn("Todavía no hay histórico de TRM del GitHub Action:", err.message);
    }
    return {
      aportesPesos: filasAObjetos(raw.aportes_inversion_pesos, APORTE_COLS, ["Fecha"]),
      aportesDolares: filasAObjetos(raw.aportes_inversion_dolares, APORTE_COLS, ["Fecha"]),
      posicionesPesos: filasAObjetos(raw.posiciones_pesos, POSICION_COLS),
      posicionesDolares: filasAObjetos(raw.posiciones_dolares, POSICION_COLS),
      historial: filasAObjetos(raw.historial_inversion, HISTORIAL_COLS, ["Fecha"]),
      historialValorCartera,
      historialTrm,
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

  // Puerto de _dias_desde_primer_aporte(moneda): días entre el aporte/
  // retiro más antiguo y hoy -- para avisar cuando un XIRR anualizado
  // viene de una ventana muy corta (no es un error de cálculo, pero un
  // retorno chico proyectado a un año entero puede dar un número enorme).
  function diasDesdePrimerAporte(aportes) {
    let masAntigua = null;
    for (const f of aportes) {
      const fechaISO = parseFechaISO(f.Fecha);
      if (fechaISO && toNumber(f.MontoTransferido) && (masAntigua === null || fechaISO < masAntigua)) masAntigua = fechaISO;
    }
    return masAntigua ? Math.round((new Date() - new Date(masAntigua)) / 86400000) : null;
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
      const valorActual = toNumber(f.ValorActual);
      const gananciaPos = toNumber(f.GananciaPerdida);
      const gp = costoTotal ? (gananciaPos / costoTotal * 100) : 0;
      // Peso %: cuánto pesa esta posición sobre el valor total de títulos
      // (concentración). Contribución %: cuánto puso ESTA posición de la
      // ganancia/pérdida TOTAL de la cartera -- distinto de GPpct, que es
      // el retorno de la posición sobre SU propio costo.
      const pesoPct = valor ? (valorActual / valor * 100) : 0;
      const contribucionPct = ganancia ? (gananciaPos / ganancia * 100) : 0;
      return { ...f, Plataforma: plataforma, Ticker: simbolo, Etiqueta: `${simbolo} (${plataforma})`,
               GPpct: gp, PesoPct: pesoPct, ContribucionPct: contribucionPct };
    });
    return { df: enriquecido, ajuste, costo, valor, ganancia, costoPropio: costo + ajuste, valorPropio: valor + ajuste };
  }

  // Puerto de _rentabilidad_xirr_capital_propio_usd() (app_presupuesto.py):
  // XIRR de la cartera en dólares, en USD puro -- sin convertir nada a
  // pesos. Cada aporte se convierte a dólares con la TRM HISTÓRICA de ESA
  // fecha (no la de hoy), igual que twrMoneda()/analisisCambiarioDolares(),
  // así el efecto cambiario queda aislado, no mezclado adentro de este
  // número. El valor final ya es capital propio, en dólares.
  function rentabilidadXirrCapitalPropioUsd(aportesDolares, valorCapitalPropioUsd, serieTrm) {
    if (!serieTrm || !serieTrm.length) return null;
    const flujos = [];
    for (const f of aportesDolares) {
      const fechaISO = parseFechaISO(f.Fecha);
      const montoCop = toNumber(f.MontoTransferido);
      if (!fechaISO || !montoCop) continue;
      const trmFecha = trmEn(serieTrm, fechaISO);
      if (!trmFecha) continue;
      flujos.push({ fecha: fechaISO, monto: -montoCop / trmFecha });
    }
    if (valorCapitalPropioUsd) flujos.push({ fecha: new Date().toISOString().slice(0, 10), monto: valorCapitalPropioUsd });
    if (flujos.length < 2 || !flujos.some((f) => f.monto < 0) || !flujos.some((f) => f.monto > 0)) return null;
    return xirr(flujos);
  }

  // Nearest prior-or-equal: puerto de _precio_en()/_trm_en() (app_presupuesto.py)
  // -- 'serieTrm' ordenada ascendente por fechaISO. Si no hay ningún valor
  // <= fechaISO (la fecha pedida es anterior a la serie entera), usa el
  // primero, mismo fallback que Python.
  function trmEn(serieTrm, fechaISO) {
    let ultimo = null;
    for (const p of serieTrm) {
      if (p.fechaISO <= fechaISO) ultimo = p; else break;
    }
    return ultimo ? ultimo.valor : (serieTrm.length ? serieTrm[0].valor : null);
  }

  // Puerto de _twr_moneda(moneda) -- Modified Dietz encadenado entre fotos
  // consecutivas de 'Historial de Valor de Cartera'. Para dólares, cada
  // aporte (en pesos transferidos) se convierte a su equivalente en USD con
  // la TRM histórica DE ESA FECHA (serieTrm). A diferencia de Python (que
  // siempre puede descargar la TRM en el momento, server-side), acá "no hay
  // serie" es un estado ESPERADO mientras el Action no haya corrido con
  // este cambio -- si hay aportes reales en dólares para convertir, se
  // devuelve null (TWR no disponible) en vez de calcular ignorando esos
  // flujos en silencio, que daría un número engañoso (trataría un aporte
  // grande como si fuera puro rendimiento de las posiciones).
  // 'capitalPropio=true' usa ValorCapitalPropio (Valor Actual + liquidez,
  // descuenta el margen prestado) en vez de ValorActual bruto -- no es
  // retroactivo: fotos guardadas antes de que el Action escribiera esa
  // columna quedan afuera (ValorCapitalPropio vacío/NaN), así que esta
  // serie puede arrancar más tarde que la del TWR bruto.
  function twrMoneda(historialValorCartera, aportes, moneda, serieTrm, capitalPropio = false) {
    const campoValor = capitalPropio ? "ValorCapitalPropio" : "ValorActual";
    const snaps = historialValorCartera
      .filter((f) => f.Moneda === moneda && (!capitalPropio || (f[campoValor] !== null && f[campoValor] !== "")))
      .map((f) => ({ fecha: parseFechaISO(f.Fecha), valor: toNumber(f[campoValor]) }))
      .filter((f) => f.fecha)
      .sort((a, b) => a.fecha.localeCompare(b.fecha));
    // Una fecha puede repetirse si el Action corrió más de una vez el mismo
    // día -- se queda con la última (mismo criterio que drop_duplicates(keep="last")).
    const porFecha = {};
    for (const s of snaps) porFecha[s.fecha] = s.valor;
    const fechas = Object.keys(porFecha).sort();
    if (fechas.length < 2) return null;

    const aportesValidos = aportes.filter((f) => parseFechaISO(f.Fecha) && toNumber(f.MontoTransferido));
    if (moneda === "dolares" && aportesValidos.length && (!serieTrm || !serieTrm.length)) return null;

    const flujos = [];
    for (const f of aportesValidos) {
      const fechaISO = parseFechaISO(f.Fecha);
      let monto = toNumber(f.MontoTransferido);
      if (moneda === "dolares") {
        const trmFecha = trmEn(serieTrm, fechaISO);
        if (!trmFecha) continue;
        monto = monto / trmFecha;
      }
      flujos.push({ fecha: fechaISO, monto });
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

  // Puerto de _analisis_cambiario_dolares() -- para cada aporte en dólares,
  // cuántos dólares equivalió con la TRM del día de esa transferencia, y
  // cuántos pesos valdrían esos mismos dólares hoy con la TRM de hoy.
  function analisisCambiarioDolares(aportesDolares, serieTrm, trmHoy) {
    if (!aportesDolares.length || !serieTrm || !serieTrm.length || trmHoy === null) return null;
    const filas = [];
    for (const f of aportesDolares) {
      const fechaISO = parseFechaISO(f.Fecha);
      const montoCop = toNumber(f.MontoTransferido);
      if (!fechaISO || !montoCop) continue;
      const trmFecha = trmEn(serieTrm, fechaISO);
      if (!trmFecha) continue;
      const usdEquiv = montoCop / trmFecha;
      const valorHoy = usdEquiv * trmHoy;
      filas.push({ fecha: fechaISO, plataforma: f.Plataforma, montoCop, trmFecha, usdEquiv, valorHoy, diferencia: valorHoy - montoCop });
    }
    if (!filas.length) return null;
    const totalCop = filas.reduce((s, f) => s + f.montoCop, 0);
    const totalUsd = filas.reduce((s, f) => s + f.usdEquiv, 0);
    const totalHoy = filas.reduce((s, f) => s + f.valorHoy, 0);
    return { filas, totalCop, totalUsd, totalHoy, diferencia: totalHoy - totalCop, trmPromedio: totalUsd ? totalCop / totalUsd : null, trmHoy };
  }

  async function render(container) {
    container.innerHTML = `
      <h1>📈 Informe de Inversiones</h1>
      <p class="caption">Resumen ejecutivo del portafolio en pesos y en dólares, por separado — posiciones,
      rentabilidad, composición y operaciones cerradas.</p>
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

    const fmt = (v) => (moneda === "dolares" ? fmtUsd(v) : fmtMoneda(v));
    const retornoBruto = info.costo ? (info.ganancia / info.costo * 100) : 0;
    const capitalPropioValido = info.costoPropio > 0;
    const retornoPropio = capitalPropioValido ? (info.ganancia / info.costoPropio * 100) : null;
    // Puerto de _rentabilidad_xirr(moneda): para dólares, el valor final se
    // convierte a pesos con la TRM de HOY (los aportes ya están en pesos
    // reales, no hace falta tocarlos) -- si el GitHub Action de precios
    // todavía no corrió, no hay TRM y el XIRR en dólares queda "—".
    const xirrVal = rentabilidadXirrTodo(aportes, info.valor, moneda, datos.trm);
    // Mismo rentabilidadXirrTodo(), pero contra el valor de capital propio
    // (acciones+fondos+liquidez) en vez de solo acciones+fondos -- descuenta
    // el margen prestado del valor final, no como pérdida sino como plata
    // que no es tuya (ver _rentabilidad_xirr_capital_propio(), app_presupuesto.py).
    const xirrPropio = rentabilidadXirrTodo(aportes, info.valorPropio, moneda, datos.trm);
    const xirrPropioUsd = moneda === "dolares"
      ? rentabilidadXirrCapitalPropioUsd(aportes, info.valorPropio, datos.historialTrm) : null;

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
    // Anualizar un retorno medido sobre pocos días amplifica muchísimo
    // cualquier variación (un +1% en una semana se proyecta como si se
    // repitiera 52 veces en el año) -- no es un error de cálculo, pero sin
    // este aviso un XIRR de +100% con apenas +1-2% de ganancia real se ve
    // como un bug. 90 días (~un trimestre) como umbral.
    const diasHistorial = diasDesdePrimerAporte(aportes);
    if (xirrVal !== null && diasHistorial !== null && diasHistorial < 90) {
      html += `<p class="caption">⚠️ El XIRR de arriba se calculó sobre apenas ${diasHistorial} día(s) desde tu
        primer aporte/retiro en esta moneda -- anualizar una ventana tan corta amplifica muchísimo cualquier
        variación (un par de puntos porcentuales de ganancia real, proyectados como si se repitieran todo el
        año, pueden dar un número enorme). No es un error: con más historial este porcentaje se va a estabilizar
        solo. Mientras tanto, el retorno bruto/sobre capital propio de arriba (sin anualizar) es más
        representativo de lo que de verdad ganaste hasta ahora.</p>`;
    }
    if (Math.abs(info.ajuste) > 1) {
      const motivo = info.ajuste < 0 ? "margen prestado por el bróker" : "efectivo sin invertir";
      html += `<p class="caption">Hay ${fmt(Math.abs(info.ajuste))} de ${motivo} mezclados en el valor de la
        cuenta, fuera de las posiciones. El retorno bruto y el XIRR de arriba lo ignoran — compará mejor contra
        "Capital propio" o, mejor todavía, contra "XIRR sobre capital propio" (más abajo, en Métricas de
        rendimiento), que descuenta el margen prestado Y pondera por fecha a la vez.</p>`;
    }

    html += `<details class="panel-colapsable" open><summary>📐 Métricas de rendimiento</summary><div class="panel-colapsable-body">`;
    const filasMetricas = [
      ["Retorno simple (bruto)", `${retornoBruto >= 0 ? "+" : ""}${retornoBruto.toFixed(1)}%`, "Ganancia / costo de las posiciones — sin apalancamiento, sin importar fechas."],
    ];
    if (capitalPropioValido) {
      filasMetricas.push(["Retorno sobre capital propio", `${retornoPropio >= 0 ? "+" : ""}${retornoPropio.toFixed(1)}%`, "Ídem, descontando el margen prestado — tu retorno real sobre tu plata."]);
    }
    filasMetricas.push(["XIRR (anualizado)", xirrVal !== null ? `${(xirrVal * 100).toFixed(1)}%` : "—", "Money-weighted: pondera CUÁNDO metiste cada peso, no solo cuánto. Ignora el margen prestado, igual que el retorno bruto."]);
    filasMetricas.push(["XIRR sobre capital propio", xirrPropio !== null ? `${(xirrPropio * 100).toFixed(1)}%` : "—", "Ídem, pero descontando el margen prestado del valor final -- no como una pérdida, sino como plata que no es tuya. Tu retorno real anualizado, ponderado por fecha."]);
    if (moneda === "dolares") {
      filasMetricas.push(["XIRR sobre capital propio (USD puro)", xirrPropioUsd !== null ? `${(xirrPropioUsd * 100).toFixed(1)}%` : "—", "Ídem, pero sin convertir nada a pesos -- cada aporte se pasa a dólares con la TRM del día que lo hiciste. Aísla el efecto cambiario (que se ve aparte, más abajo) de tu retorno real en dólares."]);
    }
    const twr = twrMoneda(datos.historialValorCartera, aportes, moneda, datos.historialTrm);
    if (twr) {
      filasMetricas.push(["TWR (anualizado)", twr.twrAnual !== null ? `${(twr.twrAnual * 100).toFixed(1)}%` : "—",
        `Time-weighted: encadena ${twr.nSubperiodos} sub-período(s) entre fotos guardadas — mide qué tan bien elegiste, no cuándo invertiste. Ignora el margen prestado, igual que el retorno bruto.`]);
      filasMetricas.push(["TWR del período (sin anualizar)", `${(twr.twrTotal * 100).toFixed(1)}%`, `Retorno acumulado en los últimos ${twr.dias} días entre fotos.`]);
      if (xirrVal !== null && twr.twrAnual !== null && Math.abs(xirrVal - twr.twrAnual) > 0.05) {
        const mejorCuando = twr.twrAnual > xirrVal ? "elegiste mejor de lo que sugiere el timing de tus aportes" : "el timing de tus aportes te ayudó más de lo que sugiere la calidad de tus elecciones";
        html += `<p class="caption">XIRR y TWR difieren bastante acá — probablemente ${mejorCuando}.</p>`;
      }
    } else if (moneda === "dolares" && (!datos.historialTrm || !datos.historialTrm.length)) {
      filasMetricas.push(["TWR", "—", "Necesita el histórico de TRM del GitHub Action ('Historial TRM (Auto)') — todavía no existe (¿corrió alguna vez con un aporte en dólares ya cargado?)."]);
    } else {
      filasMetricas.push(["TWR", "—", "Necesita al menos 2 fotos en 'Historial de Valor de Cartera' — se guardan solas cada vez que actualizás precios o posiciones/aportes."]);
    }
    const twrPropio = twrMoneda(datos.historialValorCartera, aportes, moneda, datos.historialTrm, true);
    if (twrPropio && twrPropio.twrAnual !== null) {
      filasMetricas.push(["TWR sobre capital propio (anualizado)", `${(twrPropio.twrAnual * 100).toFixed(1)}%`,
        "Ídem, pero sobre capital propio -- lo más parecido a lo que tu bróker te muestra como \"tu rentabilidad %\": no le importa cuándo aportaste ni cuándo tomaste margen, solo qué tan bien le fue a tu plata invertida."]);
    } else {
      filasMetricas.push(["TWR sobre capital propio", "—",
        "Necesita al menos 2 fotos CON capital propio guardado en 'Historial de Valor de Cartera' -- no es retroactivo, arranca desde la primera foto después de este cambio."]);
    }
    html += `<table class="tabla"><thead><tr><th>Métrica</th><th>Valor</th><th>Qué mide</th></tr></thead>
      <tbody>${filasMetricas.map((f) => `<tr><td>${f[0]}</td><td>${f[1]}</td><td>${f[2]}</td></tr>`).join("")}</tbody></table>
      </div></details>`;

    const mejor = [...info.df].sort((a, b) => b.GPpct - a.GPpct)[0];
    const peor = [...info.df].sort((a, b) => a.GPpct - b.GPpct)[0];
    const plataformas = [...new Set(info.df.map((f) => f.Plataforma))].sort();
    const multiPlataforma = plataformas.length > 1;
    const etiquetaPos = (f) => (multiPlataforma ? `${f.Ticker} (${f.Plataforma})` : f.Ticker);
    const claseChkPlat = `ii_chk_plat_${moneda}`;
    html += `
      <details class="panel-colapsable" open>
        <summary>📊 Gráficos y detalle por posición</summary>
        <div class="panel-colapsable-body">
          <div class="metric-row">
            ${metric("Mejor posición", `${etiquetaPos(mejor)} (${mejor.GPpct >= 0 ? "+" : ""}${mejor.GPpct.toFixed(1)}%)`)}
            ${metric("Peor posición", `${etiquetaPos(peor)} (${peor.GPpct >= 0 ? "+" : ""}${peor.GPpct.toFixed(1)}%)`)}
          </div>
          ${multiPlataforma ? `
            <div class="filtro-chart">
              <div class="filtro-chart-titulo">Filtrar gráficos y tabla por plataforma</div>
              <div class="checks-row">${plataformas.map((p) => `
                <label style="white-space:nowrap;"><input type="checkbox" class="${claseChkPlat}" value="${p}" checked> ${p}</label>
              `).join("")}</div>
            </div>` : ""}
          <p class="caption" id="ii_conteo_${moneda}">${info.df.length} posiciones activas.</p>
          <div id="ii_grafico_detalle_${moneda}"></div>
        </div>
      </details>
    `;

    if (moneda === "dolares") {
      html += `
        <details class="panel-colapsable" open>
        <summary>💱 Efecto cambiario de los aportes (TRM)</summary>
        <div class="panel-colapsable-body">
        <p class="caption">Cada peso que mandaste a IBKR/Binance/Hapi se convirtió a dólares a la TRM de ese día.
        Si el dólar cayó desde entonces (menos pesos por dólar), esos mismos dólares valen menos pesos hoy que lo
        que costó comprarlos — un efecto aparte del rendimiento de las posiciones en sí, que ya se mide en
        dólares arriba (retorno bruto, capital propio, XIRR). Este cálculo es la TRM histórica día a día
        guardada por el GitHub Action, no la tasa exacta de cada transferencia real.</p>
      `;
      const fx = analisisCambiarioDolares(aportes, datos.historialTrm, datos.trm);
      if (!fx) {
        html += `<p class="caption">No pude calcular el efecto cambiario — puede ser que no haya aportes
          cargados acá todavía, o que 'Historial TRM (Auto)' no exista (el GitHub Action nunca corrió con un
          aporte en dólares ya cargado).</p>`;
      } else {
        const pctFx = fx.totalCop ? (fx.diferencia / fx.totalCop * 100) : 0;
        html += `
          <div class="metric-row">
            ${metric("Aportado (histórico)", fmtMoneda(fx.totalCop))}
            ${metric("Equivalente en dólares al aportar", fmtUsd(fx.totalUsd))}
            ${metric("TRM promedio ponderado al aportar", fx.trmPromedio ? "$" + fx.trmPromedio.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—")}
          </div>
          <div class="metric-row">
            ${metric("TRM de hoy", "$" + fx.trmHoy.toLocaleString("en-US", { maximumFractionDigits: 0 }))}
            ${metric("Esos mismos dólares valen hoy", fmtMoneda(fx.totalHoy))}
            ${metric("Efecto cambiario", `${fx.diferencia >= 0 ? "+" : ""}${fmtMoneda(fx.diferencia)} (${pctFx >= 0 ? "+" : ""}${pctFx.toFixed(1)}%)`)}
          </div>
        `;
        if (fx.diferencia < 0) {
          html += `<div class="aviso">⚠️ El dólar cayó frente al peso desde que hiciste estos aportes: en pesos
            de hoy, perdiste ${fmtMoneda(Math.abs(fx.diferencia))} (${Math.abs(pctFx).toFixed(1)}%) solo por el
            tipo de cambio, sin contar cómo les fue a las posiciones en sí.</div>`;
        } else {
          html += `<div class="aviso" style="background:var(--success-bg);color:var(--success-text);">✅ El dólar subió frente al peso
            desde que hiciste estos aportes: en pesos de hoy, ganaste ${fmtMoneda(fx.diferencia)}
            (${pctFx.toFixed(1)}%) solo por el tipo de cambio, sin contar cómo les fue a las posiciones en
            sí.</div>`;
        }
        if (fx.trmPromedio) {
          const rUsdPct = capitalPropioValido ? retornoPropio : retornoBruto;
          const rFx = fx.trmHoy / fx.trmPromedio - 1;
          const rTotal = (1 + rUsdPct / 100) * (1 + rFx) - 1;
          html += `
            <p><strong>Retorno combinado en pesos (inversión ponderada por el tipo de cambio)</strong></p>
            <div class="metric-row">
              ${metric("Rendimiento en dólares", `${rUsdPct >= 0 ? "+" : ""}${rUsdPct.toFixed(1)}%`)}
              ${metric("Efecto cambiario", `${rFx >= 0 ? "+" : ""}${(rFx * 100).toFixed(1)}%`)}
              ${metric("Total combinado en pesos", `${rTotal >= 0 ? "+" : ""}${(rTotal * 100).toFixed(1)}%`)}
            </div>
            <p class="caption">Los dos efectos se combinan multiplicando, no sumando — (1 + rendimiento en
            dólares) × (1 + efecto cambiario) − 1 — porque el segundo se aplica sobre el resultado del primero.
            Esta es la cifra que de verdad importa si algún día convertís estos dólares de vuelta a pesos.</p>
          `;
        }
        html += `
          <details>
            <summary>Ver el detalle por aporte</summary>
            <div class="tabla-scroll" style="max-height:300px;"><table class="tabla">
              <thead><tr><th>Fecha</th><th>Plataforma</th><th>Monto (COP)</th><th>TRM ese día</th>
                <th>USD equivalente</th><th>TRM hoy</th><th>Valor hoy (COP)</th><th>Diferencia cambiaria</th></tr></thead>
              <tbody>${fx.filas.map((f) => `<tr><td>${f.fecha}</td><td>${f.plataforma ?? ""}</td>
                <td>${fmtMoneda(f.montoCop)}</td><td>$${f.trmFecha.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                <td>${fmtUsd(f.usdEquiv)}</td>
                <td>$${fx.trmHoy.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                <td>${fmtMoneda(f.valorHoy)}</td><td>${fmtMoneda(f.diferencia)}</td></tr>`).join("")}</tbody>
            </table></div>
          </details>
        `;
      }
      html += `</div></details>`;
    }

    div.innerHTML = html;

    // Renderiza el bloque de gráficos + tabla de detalle para un subconjunto
    // de posiciones (dfSubset) -- se llama una vez al entrar y de nuevo cada
    // vez que cambia el filtro de plataforma, sin tocar el resto de la
    // página (otros paneles quedan como estaban, abiertos o cerrados).
    function renderGraficoDetalle(dfSubset) {
      const cont = div.querySelector(`#ii_grafico_detalle_${moneda}`);
      div.querySelector(`#ii_conteo_${moneda}`).textContent =
        `${dfSubset.length} de ${info.df.length} posiciones${dfSubset.length !== info.df.length ? " (filtradas)" : " activas"}.`;
      if (!dfSubset.length) {
        cont.innerHTML = `<p class="caption">Ninguna posición coincide con el filtro elegido.</p>`;
        charts[`comp_${moneda}`]?.destroy();
        charts[`gp_${moneda}`]?.destroy();
        return;
      }
      cont.innerHTML = `
        <p><strong>Composición por posición (valor actual)</strong></p>
        <canvas id="ii_chart_comp_${moneda}" height="${Math.max(160, 28 * dfSubset.length)}"></canvas>
        <p><strong>Ganancia/pérdida por posición</strong></p>
        <canvas id="ii_chart_gp_${moneda}" height="${Math.max(160, 28 * dfSubset.length)}"></canvas>
        <details>
          <summary>Ver las ${dfSubset.length} posiciones en detalle</summary>
          <p class="caption"><strong>Peso %</strong>: cuánto pesa esta posición sobre el valor total de títulos
          (concentración). <strong>Contribución %</strong>: cuánto puso ESTA posición de la ganancia/pérdida TOTAL
          de la cartera -- distinto de G/P %, que es el retorno de la posición sobre SU propio costo. Ambos se
          calculan sobre TODA la cartera, no solo lo filtrado, así que sus columnas no van a sumar 100% acá si
          hay un filtro activo.</p>
          <div class="tabla-scroll" style="max-height:350px;"><table class="tabla">
            <thead><tr><th>Ticker</th><th>Plataforma</th><th>Tipo</th><th>Cantidad</th><th>Precio Compra Prom.</th>
              <th>Costo Total</th><th>Precio Actual</th><th>Valor Actual</th><th>Ganancia/Pérdida</th><th>G/P %</th>
              <th>Peso %</th><th>Contribución %</th></tr></thead>
            <tbody>${[...dfSubset].sort((a, b) => toNumber(b.ValorActual) - toNumber(a.ValorActual)).map((f) => `<tr>
              <td>${f.Ticker}</td><td>${f.Plataforma}</td><td>${f.Tipo}</td>
              <td>${toNumber(f.Cantidad).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
              <td>${fmt(toNumber(f.PrecioCompra))}</td><td>${fmt(toNumber(f.CostoTotal))}</td>
              <td>${fmt(toNumber(f.PrecioActual))}</td><td>${fmt(toNumber(f.ValorActual))}</td>
              <td>${fmt(toNumber(f.GananciaPerdida))}</td><td>${f.GPpct.toFixed(1)}%</td>
              <td>${f.PesoPct.toFixed(1)}%</td><td>${f.ContribucionPct.toFixed(1)}%</td>
            </tr>`).join("")}</tbody>
          </table></div>
        </details>
      `;

      const compOrdenado = [...dfSubset].sort((a, b) => toNumber(a.ValorActual) - toNumber(b.ValorActual));
      charts[`comp_${moneda}`]?.destroy();
      charts[`comp_${moneda}`] = new Chart(cont.querySelector(`#ii_chart_comp_${moneda}`).getContext("2d"), {
        type: "bar",
        data: { labels: compOrdenado.map((f) => f.Etiqueta),
                 datasets: [{ label: "Valor Actual", data: compOrdenado.map((f) => toNumber(f.ValorActual)), backgroundColor: "#1d4ed8" }] },
        options: {
          indexAxis: "y", responsive: true,
          plugins: {
            legend: { display: false },
            title: { display: true, text: `Valor de mercado por posición (${unidad})` },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const f = compOrdenado[ctx.dataIndex];
                  return `${fmt(ctx.parsed.x)} — Peso: ${f.PesoPct.toFixed(1)}%`;
                },
              },
            },
          },
          scales: { x: { title: { display: true, text: unidad }, ticks: { callback: (v) => fmt(v) } } },
        },
      });
      const gpOrdenado = [...dfSubset].sort((a, b) => a.GPpct - b.GPpct);
      charts[`gp_${moneda}`]?.destroy();
      charts[`gp_${moneda}`] = new Chart(cont.querySelector(`#ii_chart_gp_${moneda}`).getContext("2d"), {
        type: "bar",
        data: { labels: gpOrdenado.map((f) => f.Etiqueta),
                 datasets: [{ label: "G/P %", data: gpOrdenado.map((f) => f.GPpct), backgroundColor: gpOrdenado.map((f) => (f.GPpct >= 0 ? "#0ca30c" : "#d03b3b")) }] },
        options: {
          indexAxis: "y", responsive: true,
          plugins: {
            legend: { display: false },
            title: { display: true, text: "Retorno sobre costo por posición" },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const f = gpOrdenado[ctx.dataIndex];
                  return `${ctx.parsed.x >= 0 ? "+" : ""}${ctx.parsed.x.toFixed(1)}% — ${fmt(toNumber(f.GananciaPerdida))}`;
                },
              },
            },
          },
          scales: { x: { title: { display: true, text: "Retorno sobre costo (%)" }, ticks: { callback: (v) => `${v}%` } } },
        },
      });
    }

    const casillasPlat = div.querySelectorAll(`.${claseChkPlat}`);
    function actualizarFiltro() {
      if (!casillasPlat.length) { renderGraficoDetalle(info.df); return; }
      const seleccion = new Set([...casillasPlat].filter((el) => el.checked).map((el) => el.value));
      renderGraficoDetalle(info.df.filter((f) => seleccion.has(f.Plataforma)));
    }
    casillasPlat.forEach((el) => el.addEventListener("change", actualizarFiltro));
    actualizarFiltro();
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
      data: { labels: entradas.map((e) => e[0]), datasets: [{ label: "Monto Transferido (COP)", data: entradas.map((e) => e[1]), backgroundColor: "#1d4ed8" }] },
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
        ${metric("Resultado realizado (USD)", fmtUsd(realizadoUsd))}
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
