// Puerto de render_verificar_datos() (app_presupuesto.py): chequeo de
// tranquilidad para comparar lo cargado en la app contra los extractos
// reales del banco/tarjetas -- no es algo que haga falta usar seguido.
// Tarjetas de crédito es de solo lectura (compará a mano contra el PDF/
// Excel del banco); Efectivo (cuenta de ahorros) SÍ escribe: el extracto no
// trae el saldo de la cuenta, así que el saldo inicial/final de cada mes se
// carga a mano para poder conciliar -- mismo protocolo upsert-por-clave que
// ya usa Estados Financieros → Flujo de Efectivo (guardar_conciliacion_
// efectivo()), reutilizado literalmente acá (misma hoja, misma clave "Mes").
const PaginaVerificarDatos = (() => {
  const TARJETA_RESUMEN_COLS = [
    "PeriodoExtracto", "FechaCorte", "FechaLimitePago", "CupoTotal", "CupoDisponible",
    "PctCupoUtilizado", "SaldoAnterior", "ComprasDelMes", "PagoMinimo", "PagoTotal", "Col11",
  ];
  const EGRESO_COLS = [
    "PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal",
    "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas",
  ];

  async function render(container) {
    container.innerHTML = `
      <h1>✅ Verificar Datos</h1>
      <div class="aviso">Chequeo de tranquilidad, no algo que haga falta usar seguido: confirma que lo
      cargado en la app coincide con los extractos reales del banco y las tarjetas.
      <ul style="margin:6px 0 0 18px;">
        <li><strong>Tarjetas de crédito</strong> (abajo): resumen de cada extracto tal como lo cargaste —
        comparalo contra el PDF/Excel del banco.</li>
        <li><strong>Efectivo (cuenta de ahorros)</strong>: acá sí interactuás — escribís el saldo inicial y
        final que dice tu extracto para un mes, y la app calcula solo cuánto DEBERÍA quedar según lo ya
        cargado (saldo inicial + ingresos − egresos). Si coincide con el saldo final, ese mes está
        completo.</li>
      </ul></div>
      <div id="vd-contenido">Cargando datos del Sheet…</div>
    `;
    const contenido = container.querySelector("#vd-contenido");
    try {
      const [base, rawTarjetas] = await Promise.all([
        IngresosGastosPeriodo.cargarDatosBase(),
        SheetsApi.batchGet(["visa_resumen", "mc_resumen", "mc_detalle_usd"]),
      ]);
      const visaResumen = filasAObjetos(rawTarjetas.visa_resumen, TARJETA_RESUMEN_COLS, ["FechaCorte", "FechaLimitePago"]);
      const mcResumen = filasAObjetos(rawTarjetas.mc_resumen, TARJETA_RESUMEN_COLS, ["FechaCorte", "FechaLimitePago"]);
      const mcDetalleUsd = filasAObjetos(rawTarjetas.mc_detalle_usd, EGRESO_COLS, ["FechaCompra"]);

      contenido.innerHTML = `
        <h4>Tarjetas de crédito — pesos (COP)</h4>
        <p class="caption">"Pago Total" es el pago por la totalidad de la deuda (la opción para cancelar todo
        el saldo pendiente de una vez), no necesariamente lo que pagaste realmente ese corte.</p>
        <div id="vd-tarjetas-cop"></div>

        <h4>Mastercard 5922 — dólares (USD), aparte — nunca se suma con los pesos de arriba</h4>
        <div id="vd-mc-usd"></div>

        <hr>
        <h4>Efectivo (cuenta de ahorros)</h4>
        <p class="caption">El extracto no trae el saldo de la cuenta, así que lo ingresás vos cada mes para
        poder conciliar. Todo lo que se carga desde un extracto de la cuenta cuenta acá (también lo
        "(no presupuestar)"), para que la cadena de saldos cuadre aunque esos movimientos no afecten tu
        presupuesto.</p>
        <div id="vd-efectivo"></div>
      `;

      renderTarjetasCop(contenido.querySelector("#vd-tarjetas-cop"), visaResumen, mcResumen);
      renderMcUsd(contenido.querySelector("#vd-mc-usd"), mcDetalleUsd, mcResumen);
      renderEfectivo(contenido.querySelector("#vd-efectivo"), base, container);
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  function renderTarjetasCop(div, visaResumen, mcResumen) {
    const filas = [
      ...visaResumen.map((f) => ({ ...f, Tarjeta: "Visa 7497" })),
      ...mcResumen.map((f) => ({ ...f, Tarjeta: "Mastercard 5922" })),
    ].filter((f) => f.PeriodoExtracto);
    if (!filas.length) { div.innerHTML = "<p>Todavía no hay resúmenes de tarjeta cargados.</p>"; return; }
    filas.sort((a, b) => a.Tarjeta.localeCompare(b.Tarjeta) || String(b.PeriodoExtracto).localeCompare(String(a.PeriodoExtracto)));
    div.innerHTML = `
      <div class="tabla-scroll" style="max-height:400px;"><table class="tabla">
        <thead><tr><th>Tarjeta</th><th>Periodo</th><th>Cupo Total</th><th>Cupo Disponible</th>
          <th>Saldo Anterior</th><th>Compras del Mes</th><th>Pago Total</th></tr></thead>
        <tbody>${filas.map((f) => `<tr><td>${f.Tarjeta}</td><td>${f.PeriodoExtracto}</td>
          <td>${fmtMoneda(toNumber(f.CupoTotal))}</td><td>${fmtMoneda(toNumber(f.CupoDisponible))}</td>
          <td>${fmtMoneda(toNumber(f.SaldoAnterior))}</td><td>${fmtMoneda(toNumber(f.ComprasDelMes))}</td>
          <td>${fmtMoneda(toNumber(f.PagoTotal))}</td></tr>`).join("")}</tbody>
      </table></div>
    `;
  }

  function renderMcUsd(div, mcDetalleUsd, mcResumen) {
    const porPeriodo = {};
    for (const f of mcDetalleUsd) {
      if (!f.PeriodoExtracto) continue;
      porPeriodo[f.PeriodoExtracto] = (porPeriodo[f.PeriodoExtracto] || 0) + toNumber(f.ValorCargado);
    }
    const saldoUsdPorPeriodo = {};
    for (const f of mcResumen) {
      if (f.PeriodoExtracto) saldoUsdPorPeriodo[f.PeriodoExtracto] = toNumber(f.Col11);
    }
    const periodos = [...new Set([...Object.keys(porPeriodo), ...Object.keys(saldoUsdPorPeriodo)])]
      .sort((a, b) => b.localeCompare(a));
    if (!periodos.length) { div.innerHTML = "<p>Todavía no hay compras en USD de Mastercard cargadas.</p>"; return; }
    div.innerHTML = `
      <div class="tabla-scroll" style="max-height:220px;"><table class="tabla">
        <thead><tr><th>Periodo Extracto</th><th>Compras del Mes (USD)</th><th>Saldo a pagar USD</th></tr></thead>
        <tbody>${periodos.map((p) => `<tr><td>${p}</td>
          <td>${p in porPeriodo ? fmtUsd(porPeriodo[p]) : "-"}</td>
          <td>${p in saldoUsdPorPeriodo ? fmtUsd(saldoUsdPorPeriodo[p]) : "-"}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    `;
  }

  function ingresosEgresosMes(base, mesStr) {
    const egresos = base.efectivoDetalle
      .filter((f) => { const [a, m] = extraerAnioMes(f.FechaCompra); return a && m && `${a}-${String(m).padStart(2, "0")}` === mesStr; })
      .reduce((s, f) => s + toNumber(f.ValorCargado), 0);
    const ingresos = base.otrosIngresos
      .filter((f) => { const [a, m] = extraerAnioMes(f.Fecha); return a && m && `${a}-${String(m).padStart(2, "0")}` === mesStr; })
      .reduce((s, f) => s + toNumber(f.Valor), 0);
    return { ingresos, egresos };
  }

  function renderEfectivo(div, base, container) {
    const hoy = new Date();
    const anios = []; for (let a = 2023; a < 2033; a++) anios.push(a);

    div.innerHTML = `
      <div class="row">
        <div class="campo"><label>Año</label><br><select id="vd_anio"></select></div>
        <div class="campo"><label>Mes</label><br><select id="vd_mes"></select></div>
      </div>
      <div id="vd_ef_form"></div>
    `;
    const selAnio = div.querySelector("#vd_anio");
    const selMes = div.querySelector("#vd_mes");
    anios.forEach((a) => selAnio.add(new Option(a, a, a === hoy.getFullYear(), a === hoy.getFullYear())));
    for (let m = 1; m <= 12; m++) selMes.add(new Option(MESES_NOMBRE[m], m, m === hoy.getMonth() + 1, m === hoy.getMonth() + 1));

    function renderMes() {
      const anio = Number(selAnio.value), mesNum = Number(selMes.value);
      const mesConc = `${anio}-${String(mesNum).padStart(2, "0")}`;
      const mesAnteriorConc = mesNum > 1 ? `${anio}-${String(mesNum - 1).padStart(2, "0")}` : `${anio - 1}-12`;

      const existente = base.conciliacion.find((f) => f.Mes === mesConc);
      let saldoInicialPrev, saldoFinalPrev, avisoSinAncla = "";
      if (existente) {
        saldoInicialPrev = toNumber(existente.SaldoInicial);
        saldoFinalPrev = toNumber(existente.SaldoFinal);
      } else {
        const filaAnterior = base.conciliacion.find((f) => f.Mes === mesAnteriorConc);
        saldoInicialPrev = filaAnterior ? toNumber(filaAnterior.SaldoFinal) : 0;
        saldoFinalPrev = 0;
        if (!filaAnterior) {
          avisoSinAncla = `<p class="aviso">⚠️ No hay un saldo guardado para ${mesAnteriorConc} — el $0 de abajo
            es solo un valor de partida, no un cálculo. Ingresá el saldo real de tu cuenta al cierre de ese mes
            (el saldo al 31 de diciembre si este es el primer mes que cargás) para que la cadena de saldos
            arranque bien.</p>`;
        }
      }

      const formDiv = div.querySelector("#vd_ef_form");
      formDiv.innerHTML = `
        ${avisoSinAncla}
        <div class="row">
          <div class="campo"><label>Saldo inicial del mes</label><br>
            <input type="number" step="any" id="vd_saldo_ini" value="${saldoInicialPrev}"></div>
          <div class="campo"><label>Saldo final del mes</label><br>
            <input type="number" step="any" id="vd_saldo_fin" value="${saldoFinalPrev}"></div>
        </div>
        <button type="button" id="vd_guardar">💾 Guardar saldos de este mes</button>
        <div class="aviso" id="vd_msg" hidden></div>
        <div class="metric-row" id="vd_metrics"></div>
        <div id="vd_estado"></div>
        <details id="vd_hist_det">
          <summary>Ver histórico de conciliación (${base.conciliacion.length} mes(es) con saldos guardados)</summary>
          <div id="vd_hist"></div>
        </details>
      `;
      if (!base.conciliacion.length) formDiv.querySelector("#vd_hist_det").style.display = "none";

      function actualizarCalculo() {
        const saldoInicial = Number(formDiv.querySelector("#vd_saldo_ini").value) || 0;
        const saldoFinal = Number(formDiv.querySelector("#vd_saldo_fin").value) || 0;
        const { ingresos, egresos } = ingresosEgresosMes(base, mesConc);
        const saldoCalculado = saldoInicial + ingresos - egresos;
        const diferencia = saldoCalculado - saldoFinal;
        formDiv.querySelector("#vd_metrics").innerHTML = `
          ${metric("Ingresos del mes", fmtMoneda(ingresos))}
          ${metric("Egresos del mes", fmtMoneda(egresos))}
          ${metric("Saldo calculado", fmtMoneda(saldoCalculado))}
          ${metric("Diferencia vs. saldo final", fmtMoneda(diferencia))}
        `;
        const estadoDiv = formDiv.querySelector("#vd_estado");
        if (saldoInicial === 0 && saldoFinal === 0) {
          estadoDiv.innerHTML = "";
        } else if (Math.abs(diferencia) > 100) {
          estadoDiv.innerHTML = `<div class="aviso">⚠️ La conciliación de ${mesConc} no cuadra — diferencia de
            ${fmtMoneda(diferencia)}. Revisá si falta cargar algún movimiento de ese mes o si el saldo
            ingresado está mal.</div>`;
        } else {
          estadoDiv.innerHTML = `<div class="aviso" style="background:var(--success-bg);color:var(--success-text);">Conciliación de
            ${mesConc} cuadra ✅</div>`;
        }
      }
      formDiv.querySelector("#vd_saldo_ini").addEventListener("input", actualizarCalculo);
      formDiv.querySelector("#vd_saldo_fin").addEventListener("input", actualizarCalculo);
      actualizarCalculo();

      renderHistorico(formDiv.querySelector("#vd_hist"), base);

      formDiv.querySelector("#vd_guardar").addEventListener("click", async () => {
        const btn = formDiv.querySelector("#vd_guardar");
        const msg = formDiv.querySelector("#vd_msg");
        const saldoInicial = Number(formDiv.querySelector("#vd_saldo_ini").value) || 0;
        const saldoFinal = Number(formDiv.querySelector("#vd_saldo_fin").value) || 0;
        btn.disabled = true;
        btn.textContent = "Guardando…";
        try {
          await guardarConciliacionEfectivo(mesConc, saldoInicial, saldoFinal);
          msg.hidden = false;
          msg.textContent = `Saldos de ${mesConc} guardados.`;
          msg.style.background = "var(--success-bg)"; msg.style.color = "var(--success-text)";
          await render(container);
        } catch (err) {
          msg.hidden = false;
          msg.textContent = `No pude guardar: ${err.message}`;
          msg.style.background = "var(--error-bg)"; msg.style.color = "var(--error-text)";
          console.error(err);
          btn.disabled = false;
          btn.textContent = "💾 Guardar saldos de este mes";
        }
      });
    }

    selAnio.addEventListener("change", renderMes);
    selMes.addEventListener("change", renderMes);
    renderMes();
  }

  function renderHistorico(div, base) {
    if (!base.conciliacion.length) { div.innerHTML = ""; return; }
    const filas = [...base.conciliacion].sort((a, b) => a.Mes.localeCompare(b.Mes)).map((f) => {
      const { ingresos, egresos } = ingresosEgresosMes(base, f.Mes);
      const saldoInicial = toNumber(f.SaldoInicial);
      const saldoFinal = toNumber(f.SaldoFinal);
      const calc = saldoInicial + ingresos - egresos;
      const diff = calc - saldoFinal;
      let estado;
      if (saldoInicial === 0 && saldoFinal === 0) estado = "Pendiente saldos";
      else if (Math.abs(diff) <= 100) estado = "✅ Conciliado";
      else estado = "⚠️ Revisar";
      return { Mes: f.Mes, saldoInicial, ingresos, egresos, calc, saldoFinal, diff, estado };
    });
    div.innerHTML = `
      <div class="tabla-scroll" style="max-height:400px;"><table class="tabla">
        <thead><tr><th>Mes</th><th>Saldo Inicial</th><th>Ingresos</th><th>Egresos</th><th>Saldo Esperado</th>
          <th>Saldo Final</th><th>Diferencia</th><th>Estado</th></tr></thead>
        <tbody>${filas.map((f) => `<tr><td>${f.Mes}</td><td>${fmtMoneda(f.saldoInicial)}</td>
          <td>${fmtMoneda(f.ingresos)}</td><td>${fmtMoneda(f.egresos)}</td><td>${fmtMoneda(f.calc)}</td>
          <td>${fmtMoneda(f.saldoFinal)}</td><td>${fmtMoneda(f.diff)}</td><td>${f.estado}</td></tr>`).join("")}</tbody>
      </table></div>
    `;
  }

  // Puerto de guardar_conciliacion_efectivo() -- misma clave/protocolo que
  // ya usa Estados Financieros → Flujo de Efectivo (guardarConciliacionEfectivo()
  // en estados-financieros.js, no exportada, así que se duplica acá).
  async function firstBlankRowConciliacion() {
    const raw = await SheetsApi.batchGet(["conciliacion_efectivo"]);
    const filas = raw.conciliacion_efectivo || [];
    let ultimoUsado = 0;
    filas.forEach((r, i) => { if (r && r[0] !== undefined && r[0] !== null && r[0] !== "") ultimoUsado = i + 1; });
    return 66 + ultimoUsado;
  }
  async function guardarConciliacionEfectivo(mes, saldoInicial, saldoFinal) {
    const raw = await SheetsApi.batchGet(["conciliacion_efectivo"]);
    const filas = raw.conciliacion_efectivo || [];
    let filaExistente = null;
    for (let i = 0; i < filas.length; i++) {
      if (filas[i] && filas[i][0] === mes) { filaExistente = 66 + i; break; }
    }
    const fechaRegistro = new Date().toISOString().slice(0, 10);
    if (filaExistente) {
      await SheetsApi.updateRange(`'Balance Mensual'!B${filaExistente}:D${filaExistente}`, [[saldoInicial, saldoFinal, fechaRegistro]]);
    } else {
      const fila = await firstBlankRowConciliacion();
      await SheetsApi.updateRange(`'Balance Mensual'!A${fila}:D${fila}`, [[`'${mes}`, saldoInicial, saldoFinal, fechaRegistro]]);
    }
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
