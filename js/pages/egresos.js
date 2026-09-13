// Puerto de _render_egreso_tab() (app_presupuesto.py) para las 3 hojas de
// egresos (Efectivo, Visa, Mastercard) — tabla con búsqueda/filtros +
// tendencia por período + gasto por categoría y mes — más "➕ Agregar un
// gasto en efectivo manualmente" (render_egresos_efectivo), "📊 Tendencia
// por Tarjeta" (render_egresos_tendencia, Visa vs. Mastercard), y para las
// tarjetas "🛠️ Gestionar extractos y compras" (agregar extracto/compra,
// eliminar extracto — _gestionar_extractos_tarjeta), "🔍 Ver un extracto
// puntual" (_ver_extracto_puntual) y el detalle de compras en USD de
// Mastercard.

const PaginaEgresos = (() => {
  const EGRESO_COLS = [
    "PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal",
    "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas",
  ];
  // Puerto de read_tarjeta_resumen() (sheets_backend.py) — "Col11" es
  // "Notas" en Visa y "Saldo a pagar USD" en Mastercard.
  const RESUMEN_COLS = [
    "PeriodoExtracto", "FechaCorte", "FechaLimitePago", "CupoTotal", "CupoDisponible",
    "PctCupoUtilizado", "SaldoAnterior", "ComprasDelMes", "PagoMinimo", "PagoTotal", "Col11",
  ];
  const BLOQUES = [
    { key: "efectivo_detalle", titulo: "Egresos - Efectivo", esTarjeta: false },
    { key: "visa_detalle", titulo: "Egresos - Tarjeta Visa 7497", esTarjeta: true },
    { key: "mc_detalle", titulo: "Egresos - Mastercard 5922", esTarjeta: true },
  ];
  // Puerto de TARJETA_BLOCKS (sheets_backend.py) — filas/hoja de cada
  // bloque, para first_blank_row()/write_row_segments()/clear_rows_by_key()
  // a mano (esta versión no tiene esas funciones genéricas, solo lo que
  // necesita cada formulario puntual de acá).
  const TARJETAS = {
    visa_detalle: {
      label: "Visa ****7497", sheet: "Egresos - Tarjeta Visa 7497",
      detallePrimeraFila: 15, resumenRango: "visa_resumen", resumenPrimeraFila: 5621,
      tieneUsd: false,
    },
    mc_detalle: {
      label: "Mastercard ****5922", sheet: "Egresos - Mastercard 5922",
      detallePrimeraFila: 15, resumenRango: "mc_resumen", resumenPrimeraFila: 5608,
      tieneUsd: true, detalleUsdRango: "mc_detalle_usd", detalleUsdPrimeraFila: 5698,
    },
  };
  const charts = {}; // bloqueKey -> {periodo: Chart, categoria: Chart} — para destruir antes de re-renderizar
  let chartTendencia = null;

  let datosCache = null;

  async function cargarDatos() {
    if (datosCache) return datosCache;
    const raw = await SheetsApi.batchGet([
      "efectivo_detalle", "visa_detalle", "mc_detalle", "categorias_gasto",
      "visa_resumen", "mc_resumen", "mc_detalle_usd",
    ]);
    datosCache = {
      efectivo_detalle: filasAObjetos(raw.efectivo_detalle, EGRESO_COLS, ["FechaCompra"]),
      visa_detalle: filasAObjetos(raw.visa_detalle, EGRESO_COLS, ["FechaCompra"]),
      mc_detalle: filasAObjetos(raw.mc_detalle, EGRESO_COLS, ["FechaCompra"]),
      mc_detalle_usd: filasAObjetos(raw.mc_detalle_usd, EGRESO_COLS, ["FechaCompra"]),
      visa_resumen: filasAObjetos(raw.visa_resumen, RESUMEN_COLS, ["FechaCorte", "FechaLimitePago"]),
      mc_resumen: filasAObjetos(raw.mc_resumen, RESUMEN_COLS, ["FechaCorte", "FechaLimitePago"]),
      categoriasGasto: (raw.categorias_gasto || []).map((r) => r && r[0]).filter(Boolean),
    };
    return datosCache;
  }

  // Puerto de first_blank_row() (sheets_backend.py) — primera fila libre
  // dentro de un rango con nombre, leyendo solo su columna A.
  async function firstBlankRow(rangoNombre, primeraFila) {
    const raw = await SheetsApi.batchGet([rangoNombre]);
    const filas = raw[rangoNombre] || [];
    let ultimoUsado = 0;
    filas.forEach((r, i) => { if (r && r[0] !== undefined && r[0] !== null && r[0] !== "") ultimoUsado = i + 1; });
    return primeraFila + ultimoUsado;
  }

  // Puerto de clear_rows_by_key() (sheets_backend.py) — borra (deja en
  // blanco) todas las filas de un bloque cuya columna keyCol (1-based)
  // matchee exacto keyValue. keyCol=1 (Periodo Extracto) es el único caso
  // que usa esta versión (eliminar un extracto completo).
  async function clearRowsByKey(rangoNombre, primeraFila, sheetName, keyCol, keyValue) {
    const raw = await SheetsApi.batchGet([rangoNombre]);
    const filas = raw[rangoNombre] || [];
    const filasABorrar = [];
    filas.forEach((r, i) => {
      const val = r && r.length >= keyCol ? r[keyCol - 1] : "";
      if (val === keyValue) filasABorrar.push(primeraFila + i);
    });
    if (!filasABorrar.length) return 0;
    const ranges = filasABorrar.map((fila) => `'${sheetName}'!A${fila}:K${fila}`);
    await SheetsApi.batchClearRanges(ranges);
    return filasABorrar.length;
  }

  function render(container) {
    container.innerHTML = `
      <h1>💳 Egresos</h1>
      <p class="caption">Movimientos de Efectivo, Visa y Mastercard tal como están en el Sheet, con
      búsqueda y filtros.</p>
      <div class="tabs" id="tabs-egresos"></div>
      <div id="panel-egresos">Cargando datos del Sheet…</div>
    `;

    const tabsDiv = container.querySelector("#tabs-egresos");
    const panel = container.querySelector("#panel-egresos");
    const TODAS = [...BLOQUES, { key: "tendencia", titulo: "📊 Tendencia por Tarjeta", esTarjeta: false }];
    let activo = TODAS[0].key;

    TODAS.forEach((b) => {
      const btn = document.createElement("button");
      btn.textContent = b.titulo;
      btn.className = "tab-btn";
      btn.addEventListener("click", () => {
        activo = b.key;
        [...tabsDiv.children].forEach((c) => c.classList.toggle("activo", c === btn));
        renderBloque();
      });
      tabsDiv.appendChild(btn);
    });
    tabsDiv.children[0].classList.add("activo");

    async function renderBloque() {
      panel.innerHTML = "Cargando datos del Sheet…";
      try {
        const datos = await cargarDatos();
        if (activo === "tendencia") {
          renderTendenciaTarjetas(panel, datos);
        } else {
          const bloqueInfo = BLOQUES.find((b) => b.key === activo);
          renderTabla(panel, bloqueInfo, datos[activo], datos, renderBloque);
        }
      } catch (err) {
        panel.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
        console.error(err);
      }
    }

    renderBloque();
  }

  // ---------------------------------------------------------------------
  // ➕ Agregar un gasto en efectivo manualmente
  // ---------------------------------------------------------------------
  function renderFormGastoEfectivo(panel, categoriasGasto, recargar) {
    const div = document.createElement("div");
    div.innerHTML = `
      <details>
        <summary>➕ Agregar un gasto en efectivo manualmente</summary>
        <form id="form_gasto_efectivo">
          <div class="row">
            <div><label>Fecha de compra</label><br><input type="date" id="efec_fecha" required></div>
            <div><label>Categoría</label><br>
              <select id="efec_categoria">${categoriasGasto.map((c) => `<option value="${c}">${c}</option>`).join("")}</select>
            </div>
          </div>
          <div class="campo"><label>Comercio / Concepto</label><br><input type="text" id="efec_comercio" class="input-texto" required></div>
          <div class="row">
            <div><label>Valor</label><br><input type="number" id="efec_valor" min="0" step="any" required></div>
            <div><label class="checkbox-row" style="margin-top:1.8em;"><input type="checkbox" id="efec_reembolsable">
              Reembolsable (es en realidad gasto de tu esposa)</label></div>
          </div>
          <div class="campo"><label>Notas (opcional)</label><br><input type="text" id="efec_notas" class="input-texto"></div>
          <button type="submit" id="efec_guardar">💾 Guardar gasto</button>
        </form>
        <div class="aviso" id="efec_msg" hidden></div>
      </details>
    `;
    panel.appendChild(div);
    div.querySelector("#efec_fecha").valueAsDate = new Date();
    div.querySelector("#form_gasto_efectivo").addEventListener("submit", (ev) => onGuardarGastoEfectivo(ev, div, recargar));
  }

  async function onGuardarGastoEfectivo(ev, div, recargar) {
    ev.preventDefault();
    const g = (id) => div.querySelector(id).value;
    const msg = div.querySelector("#efec_msg");
    const btn = div.querySelector("#efec_guardar");
    const comercio = g("#efec_comercio").trim();
    const valor = Number(g("#efec_valor")) || 0;
    if (!comercio) { mostrarMsg(msg, "Escribí un comercio o concepto.", true); return; }
    if (valor <= 0) { mostrarMsg(msg, "El valor tiene que ser mayor que cero.", true); return; }

    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      const fecha = g("#efec_fecha"); // yyyy-mm-dd
      const categoria = g("#efec_categoria");
      const reembolsable = div.querySelector("#efec_reembolsable").checked;
      const notas = g("#efec_notas").trim();
      // Puerto de as_text() (sheets_backend.py): el apóstrofe adelante
      // fuerza texto literal con USER_ENTERED — si no, Sheets interpreta
      // "2026-07" como fecha y "1/1" como fracción/fecha.
      await SheetsApi.appendRows(RANGOS.efectivo_detalle, [[
        `'${fecha.slice(0, 7)}`, fecha, comercio, "COP", "'1/1", valor, valor, 0, categoria,
        reembolsable ? "Sí" : "No", notas,
      ]]);
      mostrarMsg(msg, `Gasto de ${fmtMoneda(valor)} agregado.`, false);
      datosCache = null;
      await recargar();
    } catch (err) {
      mostrarMsg(msg, `No pude guardar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "💾 Guardar gasto";
    }
  }

  function mostrarMsg(el, texto, esError) {
    el.hidden = false;
    el.textContent = texto;
    el.style.background = esError ? "#f8d7da" : "#d1e7dd";
    el.style.color = esError ? "#842029" : "#0f5132";
  }

  // ---------------------------------------------------------------------
  // 📊 Tendencia por Tarjeta (Visa vs. Mastercard)
  // ---------------------------------------------------------------------
  function renderTendenciaTarjetas(panel, datos) {
    panel.innerHTML = `
      <h4>Tendencia de Tarjetas de Crédito</h4>
      <p class="caption">Visa y Mastercard en pesos, comparadas período a período — no incluye Efectivo (no
      es tarjeta de crédito) ni las compras en USD de Mastercard (moneda distinta, no se puede sumar con
      pesos).</p>
      <div id="tend_contenido"></div>
    `;
    const contenido = panel.querySelector("#tend_contenido");

    const TARJETAS_TENDENCIA = [["visa_detalle", "Visa 7497"], ["mc_detalle", "Mastercard 5922"]];
    const sumaPorPeriodo = {}; // periodo -> { tarjeta -> valor }
    const totalPorTarjeta = {};
    const periodosSet = new Set();
    for (const [blockKey, nombre] of TARJETAS_TENDENCIA) {
      for (const f of datos[blockKey]) {
        if (f.Moneda !== "COP" || esNoPresupuestar(f.Categoria)) continue;
        const periodo = f.PeriodoExtracto;
        if (!periodo) continue;
        const v = toNumber(f.ValorCargado);
        sumaPorPeriodo[periodo] = sumaPorPeriodo[periodo] || {};
        sumaPorPeriodo[periodo][nombre] = (sumaPorPeriodo[periodo][nombre] || 0) + v;
        totalPorTarjeta[nombre] = (totalPorTarjeta[nombre] || 0) + v;
        periodosSet.add(periodo);
      }
    }
    const periodos = [...periodosSet].sort();

    if (chartTendencia) chartTendencia.destroy();
    if (!periodos.length) {
      contenido.innerHTML = "<p>Todavía no hay compras de tarjeta cargadas.</p>";
      return;
    }

    contenido.innerHTML = `
      <canvas id="chart_tendencia_tarjetas" height="110"></canvas>
      <h5>Total por tarjeta (histórico, según lo cargado)</h5>
      <div class="metric-row">${TARJETAS_TENDENCIA.map(([, nombre]) => metric(nombre, fmtMoneda(totalPorTarjeta[nombre] || 0))).join("")}</div>
    `;
    const ctx = contenido.querySelector("#chart_tendencia_tarjetas").getContext("2d");
    chartTendencia = new Chart(ctx, {
      type: "bar",
      data: {
        labels: periodos,
        datasets: TARJETAS_TENDENCIA.map(([, nombre], i) => ({
          label: nombre,
          data: periodos.map((p) => sumaPorPeriodo[p]?.[nombre] || 0),
          backgroundColor: PALETA[i % PALETA.length],
        })),
      },
      options: { responsive: true, scales: { y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
    });
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  function renderTabla(panel, bloqueInfo, filasOriginal, datos, recargar) {
    const { key: blockKey, titulo, esTarjeta } = bloqueInfo;
    const categoriasGasto = datos.categoriasGasto;
    panel.innerHTML = "";
    if (blockKey === "efectivo_detalle") {
      renderFormGastoEfectivo(panel, categoriasGasto, recargar);
    } else if (esTarjeta) {
      renderGestionExtractos(panel, blockKey, categoriasGasto, datos, recargar);
      renderVerExtractoPuntual(panel, blockKey, datos);
    }

    if (!filasOriginal.length) {
      panel.insertAdjacentHTML("beforeend", `<p>Todavía no hay movimientos cargados en ${titulo}.</p>`);
    } else {
      renderTablaMovimientos(panel, blockKey, titulo, esTarjeta, filasOriginal);
    }

    if (blockKey === "mc_detalle") renderComprasUsdMastercard(panel, datos.mc_detalle_usd);
  }

  function renderTablaMovimientos(panel, blockKey, titulo, esTarjeta, filasOriginal) {
    const filas = filasOriginal.map((f) => {
      const [anio, mes] = extraerAnioMes(f.FechaCompra);
      const out = { ...f, _anio: anio, _mes: mes, _presupuestar: !esNoPresupuestar(f.Categoria) };
      if (esTarjeta) {
        const [anioExt, mesExt] = extraerAnioMes(f.PeriodoExtracto);
        out._anioExtracto = anioExt;
        out._mesExtracto = mesExt;
      }
      return out;
    });

    const idp = `eg_${blockKey}`;
    const tablaDiv = document.createElement("div");
    tablaDiv.innerHTML = `
      <h4>${titulo}</h4>
      ${esTarjeta ? `<p class="caption">El filtro de Año/Mes de abajo es por la fecha real de la compra
        ('Fecha Compra'), no por 'Periodo Extracto' del corte.</p>` : ""}
      <label class="checkbox-row"><input type="checkbox" id="${idp}_ocultar" checked>
        Ocultar movimientos de conciliación (no presupuestar)</label>
      ${esTarjeta ? `
        <div class="radio-row">
          <label><input type="radio" name="${idp}_vista" value="consumo" checked> 🛍️ Consumo (mes en que se compra)</label>
          <label><input type="radio" name="${idp}_vista" value="efectivo"> 💳 Efectivo real (mes en que se paga)</label>
        </div>` : ""}
      <input type="text" id="${idp}_busqueda" placeholder="🔍 Buscar en comercio / concepto" class="input-texto" />
      <div class="row">
        <select id="${idp}_cat"></select>
        <select id="${idp}_anio"></select>
        <select id="${idp}_mes"></select>
      </div>
      <p class="caption" id="${idp}_resumen"></p>
      <div class="tabla-scroll"><table class="tabla" id="${idp}_tabla"></table></div>
      <div id="${idp}_graficos"></div>
    `;
    panel.appendChild(tablaDiv);

    const catSel = tablaDiv.querySelector(`#${idp}_cat`);
    const anioSel = tablaDiv.querySelector(`#${idp}_anio`);
    const mesSel = tablaDiv.querySelector(`#${idp}_mes`);
    const ocultarChk = tablaDiv.querySelector(`#${idp}_ocultar`);
    const busquedaInput = tablaDiv.querySelector(`#${idp}_busqueda`);

    const categorias = [...new Set(filas.map((f) => f.Categoria).filter(Boolean))].sort();
    catSel.add(new Option("(todas)", "(todas)"));
    categorias.forEach((c) => catSel.add(new Option(c, c)));
    const anios = [...new Set(filas.map((f) => f._anio).filter(Boolean))].sort((a, b) => b - a);
    anioSel.add(new Option("(todos)", "(todos)"));
    anios.forEach((a) => anioSel.add(new Option(a, a)));
    mesSel.add(new Option("(todos)", "(todos)"));
    for (let m = 1; m <= 12; m++) mesSel.add(new Option(`${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}`, m));

    function actualizar() {
      const ocultar = ocultarChk.checked;
      const busqueda = busquedaInput.value.trim().toLowerCase();
      const catFiltro = catSel.value;
      const anioFiltro = anioSel.value;
      const mesFiltro = mesSel.value;
      const vistaEl = esTarjeta ? panel.querySelector(`input[name="${idp}_vista"]:checked`) : null;
      const efectivoMode = !!vistaEl && vistaEl.value === "efectivo";

      let filtradas = filas;
      if (ocultar) filtradas = filtradas.filter((f) => f._presupuestar);
      if (busqueda) filtradas = filtradas.filter((f) => String(f.Comercio || "").toLowerCase().includes(busqueda));
      if (catFiltro !== "(todas)") filtradas = filtradas.filter((f) => f.Categoria === catFiltro);

      let caption = "";
      if (efectivoMode && anioFiltro !== "(todos)" && mesFiltro !== "(todos)") {
        const corte = shiftMes(`${anioFiltro}-${String(mesFiltro).padStart(2, "0")}`, -1);
        const [anioCorte, mesCorte] = corte.split("-").map(Number);
        filtradas = filtradas.filter((f) => f._anioExtracto === anioCorte && f._mesExtracto === mesCorte);
        caption = `Mostrando el corte de <strong>${MESES_NOMBRE[mesCorte]} ${anioCorte}</strong> — es el que
          se paga en ${MESES_NOMBRE[mesFiltro]} ${anioFiltro}.`;
      } else {
        if (anioFiltro !== "(todos)") filtradas = filtradas.filter((f) => f._anio === Number(anioFiltro));
        if (mesFiltro !== "(todos)") filtradas = filtradas.filter((f) => f._mes === Number(mesFiltro));
      }

      const totalF = filtradas.reduce((s, f) => s + toNumber(f.ValorCargado), 0);
      panel.querySelector(`#${idp}_resumen`).innerHTML =
        `${filtradas.length.toLocaleString("en-US")} de ${filas.length.toLocaleString("en-US")}
         movimientos — suma cargada este período: ${fmtMoneda(totalF)}. ${caption}`;

      renderFilaTabla(panel.querySelector(`#${idp}_tabla`), filtradas);
      renderGraficos(panel.querySelector(`#${idp}_graficos`), blockKey, filtradas, efectivoMode);
    }

    [catSel, anioSel, mesSel, ocultarChk].forEach((el) => el.addEventListener("change", actualizar));
    busquedaInput.addEventListener("input", actualizar);
    if (esTarjeta) {
      panel.querySelectorAll(`input[name="${idp}_vista"]`).forEach((r) => r.addEventListener("change", actualizar));
    }

    actualizar();
  }

  // ---------------------------------------------------------------------
  // 🛠️ Gestionar extractos y compras (Visa / Mastercard)
  // ---------------------------------------------------------------------
  function renderGestionExtractos(panel, blockKey, categoriasGasto, datos, recargar) {
    const tarjeta = TARJETAS[blockKey];
    const titulo = document.createElement("h4");
    titulo.textContent = "🛠️ Gestionar extractos y compras";
    panel.appendChild(titulo);
    renderFormAgregarExtracto(panel, blockKey, tarjeta, datos, recargar);
    renderFormAgregarCompra(panel, blockKey, tarjeta, categoriasGasto, recargar);
    renderFormEliminarExtracto(panel, blockKey, tarjeta, datos, recargar);
  }

  function renderFormAgregarExtracto(panel, blockKey, tarjeta, datos, recargar) {
    const div = document.createElement("div");
    const hoy = new Date();
    const anios = [];
    for (let a = 2023; a <= 2032; a++) anios.push(a);
    const meses = Array.from({ length: 12 }, (_, i) => i + 1);
    div.innerHTML = `
      <details>
        <summary>➕ Agregar extracto</summary>
        <p class="caption">Un renglón por período de corte — si ese período ya tiene un resumen cargado, no
        se puede agregar otro (editalo directo en el Sheet si necesitás corregirlo).</p>
        <form id="form_agregar_extracto_${blockKey}">
          <div class="row">
            <div><label>Año del corte</label><br><select id="ext_anio_${blockKey}">${anios.map((a) => `<option value="${a}" ${a === hoy.getFullYear() ? "selected" : ""}>${a}</option>`).join("")}</select></div>
            <div><label>Mes del corte</label><br><select id="ext_mes_${blockKey}">${meses.map((m) => `<option value="${m}" ${m === hoy.getMonth() + 1 ? "selected" : ""}>${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}</option>`).join("")}</select></div>
          </div>
          <div class="row">
            <div><label>Fecha de Corte</label><br><input type="date" id="ext_fcorte_${blockKey}" required></div>
            <div><label>Fecha Límite de Pago</label><br><input type="date" id="ext_flimite_${blockKey}" required></div>
          </div>
          <div class="row">
            <div><label>Cupo Total</label><br><input type="number" id="ext_cupototal_${blockKey}" min="0" step="any" value="0"></div>
            <div><label>Cupo Disponible</label><br><input type="number" id="ext_cupodisp_${blockKey}" min="0" step="any" value="0"></div>
          </div>
          <div class="campo"><label>Saldo Anterior</label><br><input type="number" id="ext_saldoant_${blockKey}" min="0" step="any" value="0"></div>
          <div class="row">
            <div><label>Pago Mínimo</label><br><input type="number" id="ext_pagomin_${blockKey}" min="0" step="any" value="0"></div>
            <div><label>Pago Total</label><br><input type="number" id="ext_pagototal_${blockKey}" min="0" step="any" value="0"></div>
          </div>
          ${tarjeta.tieneUsd ? `<div class="campo"><label>Saldo a pagar USD</label><br><input type="number" id="ext_saldousd_${blockKey}" min="0" step="any" value="0"></div>` : ""}
          <button type="submit" id="ext_guardar_${blockKey}">💾 Guardar extracto</button>
        </form>
        <div class="aviso" id="ext_msg_${blockKey}" hidden></div>
      </details>
    `;
    panel.appendChild(div);
    div.querySelector(`#ext_fcorte_${blockKey}`).valueAsDate = hoy;
    div.querySelector(`#ext_flimite_${blockKey}`).valueAsDate = hoy;
    div.querySelector(`#form_agregar_extracto_${blockKey}`)
      .addEventListener("submit", (ev) => onGuardarExtracto(ev, div, blockKey, tarjeta, datos, recargar));
  }

  async function onGuardarExtracto(ev, div, blockKey, tarjeta, datos, recargar) {
    ev.preventDefault();
    const g = (id) => div.querySelector(id).value;
    const msg = div.querySelector(`#ext_msg_${blockKey}`);
    const btn = div.querySelector(`#ext_guardar_${blockKey}`);
    const anio = Number(g(`#ext_anio_${blockKey}`));
    const mes = Number(g(`#ext_mes_${blockKey}`));
    const periodo = `${anio}-${String(mes).padStart(2, "0")}`;

    const existentes = datos[tarjeta.resumenRango] || [];
    if (existentes.some((f) => f.PeriodoExtracto === periodo)) {
      mostrarMsg(msg, `Ya existe un resumen para el período ${periodo} — editalo directo en el Sheet si
        necesitás corregirlo, no puedo agregar otro para el mismo período.`, true);
      return;
    }

    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      const fechaCorte = g(`#ext_fcorte_${blockKey}`);
      const fechaLimite = g(`#ext_flimite_${blockKey}`);
      const cupoTotal = Number(g(`#ext_cupototal_${blockKey}`)) || 0;
      const cupoDisponible = Number(g(`#ext_cupodisp_${blockKey}`)) || 0;
      const saldoAnterior = Number(g(`#ext_saldoant_${blockKey}`)) || 0;
      const pagoMinimo = Number(g(`#ext_pagomin_${blockKey}`)) || 0;
      const pagoTotal = Number(g(`#ext_pagototal_${blockKey}`)) || 0;

      const fila = await firstBlankRow(tarjeta.resumenRango, tarjeta.resumenPrimeraFila);
      const sheet = tarjeta.sheet;
      // Puerto de write_row_segments(): "% Cupo Utilizado" (F) y "Compras
      // del Mes" (H) son fórmulas de la hoja — se saltean, nunca se escriben.
      const updates = [
        { range: `'${sheet}'!A${fila}:E${fila}`, values: [[`'${periodo}`, fechaCorte, fechaLimite, cupoTotal, cupoDisponible]] },
        { range: `'${sheet}'!G${fila}`, values: [[saldoAnterior]] },
        { range: `'${sheet}'!I${fila}:J${fila}`, values: [[pagoMinimo, pagoTotal]] },
      ];
      if (tarjeta.tieneUsd) {
        const saldoUsd = Number(g(`#ext_saldousd_${blockKey}`)) || 0;
        if (saldoUsd) updates.push({ range: `'${sheet}'!K${fila}`, values: [[saldoUsd]] });
      }
      await SheetsApi.batchUpdateRanges(updates);
      mostrarMsg(msg, `Extracto de ${periodo} agregado.`, false);
      datosCache = null;
      await recargar();
    } catch (err) {
      mostrarMsg(msg, `No pude guardar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "💾 Guardar extracto";
    }
  }

  function renderFormAgregarCompra(panel, blockKey, tarjeta, categoriasGasto, recargar) {
    const div = document.createElement("div");
    const hoy = new Date();
    const anios = [];
    for (let a = 2023; a <= 2032; a++) anios.push(a);
    const meses = Array.from({ length: 12 }, (_, i) => i + 1);
    div.innerHTML = `
      <details>
        <summary>➕ Agregar compra</summary>
        <form id="form_agregar_compra_${blockKey}">
          <div class="row">
            <div><label>Año del período (corte)</label><br><select id="cmp_anio_${blockKey}">${anios.map((a) => `<option value="${a}" ${a === hoy.getFullYear() ? "selected" : ""}>${a}</option>`).join("")}</select></div>
            <div><label>Mes del período (corte)</label><br><select id="cmp_mes_${blockKey}">${meses.map((m) => `<option value="${m}" ${m === hoy.getMonth() + 1 ? "selected" : ""}>${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}</option>`).join("")}</select></div>
          </div>
          <div class="campo"><label>Fecha de compra</label><br><input type="date" id="cmp_fecha_${blockKey}" required></div>
          <div class="campo"><label>Comercio / Concepto</label><br><input type="text" id="cmp_comercio_${blockKey}" class="input-texto" required></div>
          <div class="row">
            ${tarjeta.tieneUsd ? `<div><label>Moneda</label><br><select id="cmp_moneda_${blockKey}"><option value="COP">COP</option><option value="USD">USD</option></select></div>` : ""}
            <div><label>Cuotas</label><br><input type="text" id="cmp_cuotas_${blockKey}" value="1/1"></div>
          </div>
          <div class="row">
            <div><label>Valor Total Compra</label><br><input type="number" id="cmp_vtotal_${blockKey}" min="0" step="any" required></div>
            <div><label>Valor Cargado Este Período</label><br><input type="number" id="cmp_vperiodo_${blockKey}" min="0" step="any" value="0"></div>
          </div>
          <div class="campo"><label>Saldo Pendiente (cuotas)</label><br><input type="number" id="cmp_spend_${blockKey}" min="0" step="any" value="0"></div>
          <div class="row">
            <div><label>Categoría</label><br><select id="cmp_cat_${blockKey}">${categoriasGasto.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></div>
            <div><label class="checkbox-row" style="margin-top:1.8em;"><input type="checkbox" id="cmp_reemb_${blockKey}"> Reembolsable</label></div>
          </div>
          <div class="campo"><label>Notas (opcional)</label><br><input type="text" id="cmp_notas_${blockKey}" class="input-texto"></div>
          <button type="submit" id="cmp_guardar_${blockKey}">💾 Guardar compra</button>
        </form>
        <div class="aviso" id="cmp_msg_${blockKey}" hidden></div>
      </details>
    `;
    panel.appendChild(div);
    div.querySelector(`#cmp_fecha_${blockKey}`).valueAsDate = hoy;
    div.querySelector(`#form_agregar_compra_${blockKey}`)
      .addEventListener("submit", (ev) => onGuardarCompra(ev, div, blockKey, tarjeta, recargar));
  }

  async function onGuardarCompra(ev, div, blockKey, tarjeta, recargar) {
    ev.preventDefault();
    const g = (id) => div.querySelector(id).value;
    const msg = div.querySelector(`#cmp_msg_${blockKey}`);
    const btn = div.querySelector(`#cmp_guardar_${blockKey}`);
    const comercio = g(`#cmp_comercio_${blockKey}`).trim();
    const valorTotal = Number(g(`#cmp_vtotal_${blockKey}`)) || 0;
    if (!comercio) { mostrarMsg(msg, "Escribí un comercio o concepto.", true); return; }
    if (valorTotal <= 0) { mostrarMsg(msg, "El valor total tiene que ser mayor que cero.", true); return; }

    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      const anio = Number(g(`#cmp_anio_${blockKey}`));
      const mes = Number(g(`#cmp_mes_${blockKey}`));
      const periodo = `${anio}-${String(mes).padStart(2, "0")}`;
      const fecha = g(`#cmp_fecha_${blockKey}`);
      const moneda = tarjeta.tieneUsd ? g(`#cmp_moneda_${blockKey}`) : "COP";
      const cuotas = g(`#cmp_cuotas_${blockKey}`).trim() || "1/1";
      const valorPeriodo = Number(g(`#cmp_vperiodo_${blockKey}`)) || 0;
      const saldoPendiente = Number(g(`#cmp_spend_${blockKey}`)) || 0;
      const categoria = g(`#cmp_cat_${blockKey}`);
      const reembolsable = div.querySelector(`#cmp_reemb_${blockKey}`).checked;
      const notas = g(`#cmp_notas_${blockKey}`).trim();

      const rangoDestino = (moneda === "USD" && tarjeta.detalleUsdRango) ? tarjeta.detalleUsdRango : blockKey;
      const filaVal = valorPeriodo > 0 ? valorPeriodo : valorTotal;
      await SheetsApi.appendRows(RANGOS[rangoDestino], [[
        `'${periodo}`, fecha, comercio, moneda, `'${cuotas}`, valorTotal, filaVal, saldoPendiente, categoria,
        reembolsable ? "Sí" : "No", notas,
      ]]);
      mostrarMsg(msg, `Compra de ${fmtMoneda(valorTotal)} agregada.`, false);
      datosCache = null;
      await recargar();
    } catch (err) {
      mostrarMsg(msg, `No pude guardar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "💾 Guardar compra";
    }
  }

  function renderFormEliminarExtracto(panel, blockKey, tarjeta, datos, recargar) {
    const div = document.createElement("div");
    const resumenRows = datos[tarjeta.resumenRango] || [];
    if (!resumenRows.length) {
      div.innerHTML = `<details><summary>🗑️ Eliminar extracto</summary><p>Todavía no hay extractos cargados.</p></details>`;
      panel.appendChild(div);
      return;
    }
    const periodos = [...resumenRows].map((f) => f.PeriodoExtracto).sort().reverse();
    div.innerHTML = `
      <details>
        <summary>🗑️ Eliminar extracto</summary>
        <div class="campo"><label>Período a eliminar</label><br>
          <select id="del_ext_periodo_${blockKey}">${periodos.map((p) => `<option value="${p}">${p}</option>`).join("")}</select></div>
        <p class="caption" id="del_ext_caption_${blockKey}"></p>
        <label class="checkbox-row"><input type="checkbox" id="del_ext_confirmar_${blockKey}">
          Confirmo que quiero borrar este extracto — no se puede deshacer</label>
        <button type="button" id="del_ext_btn_${blockKey}" disabled>🗑️ Eliminar extracto</button>
        <div class="aviso" id="del_ext_msg_${blockKey}" hidden></div>
      </details>
    `;
    panel.appendChild(div);

    const periodoSel = div.querySelector(`#del_ext_periodo_${blockKey}`);
    const caption = div.querySelector(`#del_ext_caption_${blockKey}`);
    const confirmar = div.querySelector(`#del_ext_confirmar_${blockKey}`);
    const btn = div.querySelector(`#del_ext_btn_${blockKey}`);
    const detalleRows = datos[blockKey] || [];
    const usdRows = tarjeta.detalleUsdRango ? (datos[tarjeta.detalleUsdRango] || []) : [];

    function actualizarCaption() {
      const p = periodoSel.value;
      const fila = resumenRows.find((f) => f.PeriodoExtracto === p);
      const nDetalle = detalleRows.filter((f) => f.PeriodoExtracto === p).length;
      let txt = `Pago total: ${fmtMoneda(toNumber(fila && fila.PagoTotal))} — ${nDetalle} compra(s) en el detalle de este período.`;
      if (tarjeta.detalleUsdRango) {
        const nUsd = usdRows.filter((f) => f.PeriodoExtracto === p).length;
        if (nUsd) txt += ` También tiene ${nUsd} compra(s) en USD para este período — se borran igual.`;
      }
      caption.textContent = txt;
      confirmar.checked = false;
      btn.disabled = true;
    }
    periodoSel.addEventListener("change", actualizarCaption);
    confirmar.addEventListener("change", () => { btn.disabled = !confirmar.checked; });
    btn.addEventListener("click", () => onEliminarExtracto(div, blockKey, tarjeta, periodoSel.value, recargar));
    actualizarCaption();
  }

  async function onEliminarExtracto(div, blockKey, tarjeta, periodo, recargar) {
    const msg = div.querySelector(`#del_ext_msg_${blockKey}`);
    const btn = div.querySelector(`#del_ext_btn_${blockKey}`);
    btn.disabled = true;
    btn.textContent = "Borrando…";
    try {
      const resumenBorradas = await clearRowsByKey(tarjeta.resumenRango, tarjeta.resumenPrimeraFila, tarjeta.sheet, 1, periodo);
      const detalleBorradas = await clearRowsByKey(blockKey, tarjeta.detallePrimeraFila, tarjeta.sheet, 1, periodo);
      let detalleTxt = `${detalleBorradas} compra(s)`;
      if (tarjeta.detalleUsdRango) {
        const usdBorradas = await clearRowsByKey(tarjeta.detalleUsdRango, tarjeta.detalleUsdPrimeraFila, tarjeta.sheet, 1, periodo);
        detalleTxt += ` + ${usdBorradas} en USD`;
      }
      mostrarMsg(msg, `Extracto '${periodo}' eliminado — ${resumenBorradas} fila(s) de resumen, ${detalleTxt}.`, false);
      datosCache = null;
      await recargar();
    } catch (err) {
      mostrarMsg(msg, `No pude borrar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "🗑️ Eliminar extracto";
    }
  }

  // ---------------------------------------------------------------------
  // 🔍 Ver un extracto puntual
  // ---------------------------------------------------------------------
  function renderVerExtractoPuntual(panel, blockKey, datos) {
    const tarjeta = TARJETAS[blockKey];
    const resumenRows = datos[tarjeta.resumenRango] || [];
    const div = document.createElement("div");
    div.innerHTML = `<h4>🔍 Ver un extracto puntual</h4>
      <p class="caption">Elegí un período de corte para ver su resumen (cupo, saldo, pago) junto con el
      detalle de compras de ese extracto — igual que elegir un mes en Colillas de Pago.</p>`;
    panel.appendChild(div);
    if (!resumenRows.length) {
      div.insertAdjacentHTML("beforeend", "<p>Todavía no hay extractos cargados.</p>");
      return;
    }
    const periodos = [...resumenRows].map((f) => f.PeriodoExtracto).sort().reverse();
    const selDiv = document.createElement("div");
    selDiv.innerHTML = `
      <div class="campo"><label>Período</label><br>
        <select id="ver_ext_periodo_${blockKey}">${periodos.map((p) => `<option value="${p}">${p}</option>`).join("")}</select></div>
      <div id="ver_ext_contenido_${blockKey}"></div>
    `;
    div.appendChild(selDiv);
    const sel = selDiv.querySelector(`#ver_ext_periodo_${blockKey}`);
    const contenido = selDiv.querySelector(`#ver_ext_contenido_${blockKey}`);

    function actualizar() {
      const p = sel.value;
      const fila = resumenRows.find((f) => f.PeriodoExtracto === p);
      const detalleRows = (datos[blockKey] || []).filter((f) => f.PeriodoExtracto === p);
      contenido.innerHTML = `
        <div class="metric-row">
          ${metric("Cupo Total", fmtMoneda(toNumber(fila.CupoTotal)))}
          ${metric("Cupo Disponible", fmtMoneda(toNumber(fila.CupoDisponible)))}
          ${metric("% Cupo Utilizado", (toNumber(fila.PctCupoUtilizado) * 100).toFixed(1) + "%")}
        </div>
        <div class="metric-row">
          ${metric("Saldo Anterior", fmtMoneda(toNumber(fila.SaldoAnterior)))}
          ${metric("Pago Mínimo", fmtMoneda(toNumber(fila.PagoMinimo)))}
          ${metric("Pago Total", fmtMoneda(toNumber(fila.PagoTotal)))}
        </div>
        <p class="caption">Fecha de Corte: ${fila.FechaCorte ?? ""} — Fecha Límite de Pago: ${fila.FechaLimitePago ?? ""}</p>
        ${tarjeta.tieneUsd && toNumber(fila.Col11) ? `<p class="caption">Saldo a pagar en USD (aparte, no se
          suma con pesos): ${fmtUsd(toNumber(fila.Col11))}</p>` : ""}
        <p><strong>Compras de este período (${detalleRows.length})</strong></p>
        ${detalleRows.length
          ? `<div class="tabla-scroll"><table class="tabla" id="ver_ext_tabla_${blockKey}"></table></div>`
          : "<p>Sin compras en COP para este período.</p>"}
        ${tarjeta.tieneUsd ? `<div id="ver_ext_usd_${blockKey}"></div>` : ""}
      `;
      if (detalleRows.length) renderFilaTabla(contenido.querySelector(`#ver_ext_tabla_${blockKey}`), detalleRows);
      if (tarjeta.tieneUsd) {
        const usdRows = (datos[tarjeta.detalleUsdRango] || []).filter((f) => f.PeriodoExtracto === p);
        if (usdRows.length) {
          const usdDiv = contenido.querySelector(`#ver_ext_usd_${blockKey}`);
          usdDiv.innerHTML = `<p><strong>Compras en USD de este período (${usdRows.length})</strong></p>
            <div class="tabla-scroll"><table class="tabla" id="ver_ext_tabla_usd_${blockKey}"></table></div>`;
          renderFilaTabla(usdDiv.querySelector(`#ver_ext_tabla_usd_${blockKey}`), usdRows);
        }
      }
    }
    sel.addEventListener("change", actualizar);
    actualizar();
  }

  // ---------------------------------------------------------------------
  // Compras en USD de Mastercard (aparte, al pie de la tab de Mastercard)
  // ---------------------------------------------------------------------
  function renderComprasUsdMastercard(panel, filas) {
    const div = document.createElement("div");
    const suma = (filas || []).reduce((s, f) => s + toNumber(f.ValorCargado), 0);
    div.innerHTML = `
      <hr>
      <h4>Compras en USD (separado de los pesos de arriba — no se suman entre sí)</h4>
      ${filas && filas.length
        ? `<p class="caption">${filas.length.toLocaleString("en-US")} movimientos — suma: ${fmtUsd(suma)}</p>
           <div class="tabla-scroll"><table class="tabla" id="mc_usd_tabla"></table></div>`
        : "<p>Todavía no hay compras en USD cargadas.</p>"}
    `;
    panel.appendChild(div);
    if (filas && filas.length) renderFilaTabla(div.querySelector("#mc_usd_tabla"), filas);
  }

  function renderFilaTabla(tablaEl, filas) {
    const cols = ["PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal",
      "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas"];
    const labels = ["Periodo Extracto", "Fecha Compra", "Comercio / Concepto", "Moneda", "Cuotas",
      "Valor Total", "Valor Cargado", "Saldo Pendiente", "Categoría", "Reembolsable", "Notas"];
    const filasLimitadas = filas.slice(0, 1000);
    tablaEl.innerHTML = `
      <thead><tr>${labels.map((l) => `<th>${l}</th>`).join("")}</tr></thead>
      <tbody>${filasLimitadas.map((f) => `<tr>${cols.map((c) => {
        const v = f[c];
        const esValor = c === "ValorTotal" || c === "ValorCargado" || c === "SaldoPendiente";
        return `<td>${esValor ? fmtMoneda(toNumber(v)) : (v ?? "")}</td>`;
      }).join("")}</tr>`).join("")}</tbody>
    `;
    if (filas.length > filasLimitadas.length) {
      const nota = document.createElement("p");
      nota.className = "caption";
      nota.textContent = `Mostrando los primeros 1.000 de ${filas.length.toLocaleString("en-US")} movimientos — angostá el filtro para ver el resto.`;
      tablaEl.after(nota);
    }
  }

  const PALETA = ["#d64545", "#4573d6", "#45a06a", "#d69a45", "#8a56c9", "#45b8c9", "#c9457e", "#a3a3a3"];

  function renderGraficos(div, blockKey, filas, efectivoMode) {
    const cop = filas.filter((f) => f.Moneda === "COP");
    div.innerHTML = "";
    if (charts[blockKey]?.periodo) charts[blockKey].periodo.destroy();
    if (charts[blockKey]?.categoria) charts[blockKey].categoria.destroy();
    if (!cop.length) return;

    const etiquetaPeriodo = efectivoMode ? "mes de pago" : "mes de compra";
    const periodoDe = (f) => {
      if (efectivoMode) {
        const base = `${f._anioExtracto}-${String(f._mesExtracto).padStart(2, "0")}`;
        return shiftMes(base, 1);
      }
      return `${f._anio}-${String(f._mes).padStart(2, "0")}`;
    };

    const sumaPorPeriodo = {};
    const sumaPorPeriodoCat = {};
    const categoriasSet = new Set();
    for (const f of cop) {
      const p = periodoDe(f);
      const v = toNumber(f.ValorCargado);
      sumaPorPeriodo[p] = (sumaPorPeriodo[p] || 0) + v;
      const cat = f.Categoria || "(sin categoría)";
      categoriasSet.add(cat);
      sumaPorPeriodoCat[p] = sumaPorPeriodoCat[p] || {};
      sumaPorPeriodoCat[p][cat] = (sumaPorPeriodoCat[p][cat] || 0) + v;
    }
    const periodos = Object.keys(sumaPorPeriodo).sort();
    const categorias = [...categoriasSet].sort();

    div.innerHTML = `
      <h5>Tendencia por período (${etiquetaPeriodo})</h5>
      <canvas id="canvas_periodo_${blockKey}" height="90"></canvas>
      <h5>Gasto por categoría y por mes (${etiquetaPeriodo})</h5>
      <canvas id="canvas_categoria_${blockKey}" height="120"></canvas>
    `;

    const ctxP = div.querySelector(`#canvas_periodo_${blockKey}`).getContext("2d");
    const chartPeriodo = new Chart(ctxP, {
      type: "bar",
      data: { labels: periodos, datasets: [{ label: "Valor Cargado", data: periodos.map((p) => sumaPorPeriodo[p]), backgroundColor: "#d64545" }] },
      options: { responsive: true, plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
    });

    const ctxC = div.querySelector(`#canvas_categoria_${blockKey}`).getContext("2d");
    const chartCategoria = new Chart(ctxC, {
      type: "bar",
      data: {
        labels: periodos,
        datasets: categorias.map((cat, i) => ({
          label: cat,
          data: periodos.map((p) => sumaPorPeriodoCat[p]?.[cat] || 0),
          backgroundColor: PALETA[i % PALETA.length],
        })),
      },
      options: {
        responsive: true,
        scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => fmtMoneda(v) } } },
      },
    });

    charts[blockKey] = { periodo: chartPeriodo, categoria: chartCategoria };
  }

  return { render };
})();
