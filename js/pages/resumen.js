// Puerto de render_resumen() + _ingresos_gastos_periodo() (app_presupuesto.py).
// Ya completo: Ingresos, Gastos, Balance (con tasa de ahorro discriminada),
// Deudas e Inversiones (estado actual) — con el mismo selector "Ver resumen
// de: Total histórico / Un año / Un mes" que la versión de Streamlit.
//
// TODAVÍA NO portado: el gráfico de "Tendencia de los últimos meses" al pie
// de Resumen (usa Resumen Mensual, vista efectivo real — página aparte).

const PaginaResumen = (() => {
  let datosCache = null;

  async function cargarDatos() {
    if (datosCache) return datosCache;
    const raw = await SheetsApi.batchGet([
      "colillas_resumen", "colillas_devengos", "colillas_descuentos", "otros_ingresos",
      "efectivo_detalle", "visa_detalle", "mc_detalle",
      "aportes_inversion_pesos", "aportes_inversion_dolares", "deudas", "resumen_kpis",
    ]);

    const egresoCols = [
      "PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal",
      "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas",
    ];
    const aporteCols = ["Fecha", "Plataforma", "MontoTransferido", "Notas"];

    const kpis = {};
    (raw.resumen_kpis || []).forEach((row) => {
      if (row && row[0]) kpis[row[0]] = toNumber(row.length >= 4 ? row[3] : row[row.length - 1]);
    });

    datosCache = {
      colillas: filasAObjetos(raw.colillas_resumen, ["FechaPago", "Periodo", "DevengosTotales", "DescuentosTotales"]),
      colillasDevengos: filasAObjetos(raw.colillas_devengos, ["Quincena", "Concepto", "Categoria", "Valor"]),
      colillasDescuentos: filasAObjetos(raw.colillas_descuentos, ["Quincena", "Concepto", "Categoria", "Valor"]),
      otrosIngresos: filasAObjetos(raw.otros_ingresos, ["Fecha", "Concepto", "Categoria", "Valor", "Notas"]),
      efectivoDetalle: filasAObjetos(raw.efectivo_detalle, egresoCols),
      visaDetalle: filasAObjetos(raw.visa_detalle, egresoCols),
      mcDetalle: filasAObjetos(raw.mc_detalle, egresoCols),
      aportesPesos: filasAObjetos(raw.aportes_inversion_pesos, aporteCols),
      aportesDolares: filasAObjetos(raw.aportes_inversion_dolares, aporteCols),
      deudas: filasAObjetos(raw.deudas, [
        "Entidad", "TipoCredito", "SaldoActual", "TasaEA", "CuotaMensual", "PctPagado", "MesesRestantes", "FechaEstPago",
      ]),
      kpis,
    };
    return datosCache;
  }

  function construirAportesIndex(aportesPesos, aportesDolares, coincide) {
    const aportesIndex = {};
    const retirosPorPlataforma = {};
    for (const fila of [...aportesPesos, ...aportesDolares]) {
      const fechaISO = parseFechaISO(fila.Fecha);
      const monto = toNumber(fila.MontoTransferido);
      if (!fechaISO || !monto) continue;
      aportesIndex[`${fechaISO}|${Math.round(monto)}`] = fila.Plataforma;
      if (monto < 0) {
        const [anio, mes] = fechaISO.split("-").map(Number);
        if (coincide(anio, mes)) {
          retirosPorPlataforma[fila.Plataforma] = (retirosPorPlataforma[fila.Plataforma] || 0) - monto;
        }
      }
    }
    return { aportesIndex, retirosPorPlataforma };
  }

  function destinoInversion(comercio, notas, fecha, valor, aportesIndex) {
    const c = String(comercio || "").trim();
    const cLower = c.toLowerCase();
    if (cLower.includes("acciones y val")) return "Acciones y Valores";
    if (cLower.includes("fondo de inversion")) return "Fondo de Inversión (banco)";
    const fechaISO = parseFechaISO(fecha);
    if (fechaISO) {
      const plataforma = aportesIndex[`${fechaISO}|${Math.round(valor)}`];
      if (plataforma) return plataforma;
    }
    if (String(notas || "").toLowerCase().includes("no reconocido")) {
      return c ? `Sin identificar (${c})` : "Sin identificar";
    }
    return c || "Otro";
  }

  // Puerto directo de _ingresos_gastos_periodo() (app_presupuesto.py).
  function calcularDatosPeriodo(datos, coincide) {
    let ingresosColillas = 0;
    for (const fila of datos.colillas) {
      const [anio, mes] = extraerAnioMes(fila.Periodo);
      if (coincide(anio, mes)) ingresosColillas += toNumber(fila.DevengosTotales);
    }
    let otrosIngresos = 0;
    const ingresosPorCategoria = {};
    for (const fila of datos.otrosIngresos) {
      const [anio, mes] = extraerAnioMes(fila.Fecha);
      const match = coincide(anio, mes) && !esNoPresupuestar(fila.Categoria);
      if (match) {
        otrosIngresos += toNumber(fila.Valor);
        ingresosPorCategoria[fila.Categoria] = (ingresosPorCategoria[fila.Categoria] || 0) + toNumber(fila.Valor);
      }
    }
    for (const fila of datos.colillasDevengos) {
      const [anio, mes] = extraerAnioMes(fila.Quincena);
      if (coincide(anio, mes) && !esNoPresupuestar(fila.Categoria)) {
        ingresosPorCategoria[fila.Categoria] = (ingresosPorCategoria[fila.Categoria] || 0) + toNumber(fila.Valor);
      }
    }
    const totalIngresos = ingresosColillas + otrosIngresos;

    let gastoReal = 0;
    let gastoSinCategorizar = 0;
    const gastoPorCategoria = {};
    const filasInversiones = [];
    for (const bloque of [datos.efectivoDetalle, datos.visaDetalle, datos.mcDetalle]) {
      for (const fila of bloque) {
        const [anio, mes] = extraerAnioMes(fila.FechaCompra);
        const match = coincide(anio, mes) && fila.Moneda === "COP" && !esNoPresupuestar(fila.Categoria);
        if (!match) continue;
        const valor = toNumber(fila.ValorCargado);
        gastoReal += valor;
        if (fila.Categoria === "Otros") gastoSinCategorizar += valor;
        gastoPorCategoria[fila.Categoria] = (gastoPorCategoria[fila.Categoria] || 0) + valor;
        if (fila.Categoria === "Inversiones") {
          filasInversiones.push({ fecha: fila.FechaCompra, comercio: fila.Comercio, valor, notas: fila.Notas });
        }
      }
    }

    let descuentosNomina = 0;
    for (const fila of datos.colillas) {
      const [anio, mes] = extraerAnioMes(fila.Periodo);
      if (coincide(anio, mes)) descuentosNomina += toNumber(fila.DescuentosTotales);
    }
    let descuentosDetalleSum = 0;
    const descPorCategoria = {};
    for (const fila of datos.colillasDescuentos) {
      const [anio, mes] = extraerAnioMes(fila.Quincena);
      if (!coincide(anio, mes)) continue;
      const valor = toNumber(fila.Valor);
      descuentosDetalleSum += valor;
      descPorCategoria[fila.Categoria] = (descPorCategoria[fila.Categoria] || 0) + valor;
    }
    const seguros_nomina = descPorCategoria["Seguros"] || 0;
    const descuento_ahorro = descPorCategoria["Ahorro"] || 0;
    const descuento_fondo_empleados = descPorCategoria["Fondo de Empleados"] || 0;
    const descuento_deuda_nomina = (descPorCategoria["Deuda (Leasing Habitacional)"] || 0)
      + (descPorCategoria["Deuda (Préstamo Fondo Empleados)"] || 0);
    const descuentos_sin_categorizar = Math.max(0, descuentosNomina - descuentosDetalleSum);

    const gasto_ahorro = gastoPorCategoria["Ahorro"] || 0;
    const ingreso_cesantias = ingresosPorCategoria["Cesantías"] || 0;

    const { aportesIndex, retirosPorPlataforma } = construirAportesIndex(datos.aportesPesos, datos.aportesDolares, coincide);
    let inversionesPorDestinoBruto = {};
    let inversionesPorDestino = {};
    let inversionesSinIdentificar = 0;
    if (filasInversiones.length) {
      for (const f of filasInversiones) {
        const destino = destinoInversion(f.comercio, f.notas, f.fecha, f.valor, aportesIndex);
        inversionesPorDestinoBruto[destino] = (inversionesPorDestinoBruto[destino] || 0) + f.valor;
      }
      inversionesPorDestino = { ...inversionesPorDestinoBruto };
      for (const [plataforma, retiro] of Object.entries(retirosPorPlataforma)) {
        if (plataforma in inversionesPorDestino) {
          inversionesPorDestino[plataforma] = Math.max(0, inversionesPorDestino[plataforma] - retiro);
        }
      }
      inversionesSinIdentificar = Object.entries(inversionesPorDestino)
        .filter(([k]) => k.startsWith("Sin identificar"))
        .reduce((s, [, v]) => s + v, 0);
    }

    const gasto_inversiones_bruto = gastoPorCategoria["Inversiones"] || 0;
    const gasto_inversiones = Object.keys(inversionesPorDestino).length
      ? Object.values(inversionesPorDestino).reduce((a, b) => a + b, 0)
      : gasto_inversiones_bruto;
    const gasto_operativo = gastoReal - gasto_inversiones - gasto_ahorro;

    return {
      ingresosColillas, otrosIngresos, totalIngresos, ingresosPorCategoria, ingreso_cesantias,
      gastoReal, gastoSinCategorizar, gastoPorCategoria, gasto_inversiones, gasto_inversiones_bruto,
      inversionesPorDestino, inversionesPorDestinoBruto, inversionesSinIdentificar,
      gasto_ahorro, gasto_operativo, descuentosNomina, seguros_nomina, descuento_ahorro,
      descuento_fondo_empleados, descuento_deuda_nomina, descuentos_sin_categorizar,
    };
  }

  function render(container) {
    container.innerHTML = `
      <h1>🏠 Resumen</h1>
      <p class="caption">Vista general: cuánto entra, cuánto sale, qué balance queda, cuánta deuda tenés
      pendiente y cuánto llevás aportado a inversiones.</p>

      <div class="campo">
        <label>Ver resumen de:</label>
        <div class="radio-row" id="alcance-radios">
          <label><input type="radio" name="alcance" value="total" checked> Total histórico</label>
          <label><input type="radio" name="alcance" value="anio"> Un año</label>
          <label><input type="radio" name="alcance" value="mes"> Un mes</label>
        </div>
        <div id="selectores-periodo" class="row" style="display:none;">
          <select id="sel-anio"></select>
          <select id="sel-mes" style="display:none;"></select>
        </div>
      </div>

      <div id="resumen-contenido">Cargando datos del Sheet…</div>
    `;

    const hoy = new Date();
    const anios = [];
    for (let a = 2023; a <= 2032; a++) anios.push(a);
    const selAnio = container.querySelector("#sel-anio");
    const selMes = container.querySelector("#sel-mes");
    anios.forEach((a) => selAnio.add(new Option(a, a)));
    selAnio.value = anios.includes(hoy.getFullYear()) ? hoy.getFullYear() : anios[0];
    for (let m = 1; m <= 12; m++) selMes.add(new Option(MESES_NOMBRE[m], m));
    selMes.value = hoy.getMonth() + 1;

    const radios = container.querySelectorAll('input[name="alcance"]');
    const selectoresDiv = container.querySelector("#selectores-periodo");

    function alcanceActual() {
      return [...radios].find((r) => r.checked).value;
    }

    function actualizar() {
      const alcance = alcanceActual();
      selectoresDiv.style.display = alcance === "total" ? "none" : "flex";
      selMes.style.display = alcance === "mes" ? "inline-block" : "none";
      renderContenido();
    }

    radios.forEach((r) => r.addEventListener("change", actualizar));
    selAnio.addEventListener("change", renderContenido);
    selMes.addEventListener("change", renderContenido);

    async function renderContenido() {
      const contenido = container.querySelector("#resumen-contenido");
      try {
        const datos = await cargarDatos();
        const alcance = alcanceActual();
        const anioSel = parseInt(selAnio.value, 10);
        const mesSel = parseInt(selMes.value, 10);
        const coincide = (anio, mes) => {
          if (alcance === "total") return true;
          if (anio === null) return false;
          if (alcance === "anio") return anio === anioSel;
          return anio === anioSel && mes === mesSel;
        };

        const d = calcularDatosPeriodo(datos, coincide);
        const saldoDeudas = datos.deudas.reduce((s, f) => s + toNumber(f.SaldoActual), 0);
        const cuotaDeudas = datos.deudas.reduce((s, f) => s + toNumber(f.CuotaMensual), 0);
        const portafolioPesos = datos.kpis["Valor actual del portafolio de inversiones en pesos"] || 0;
        const portafolioDolares = datos.kpis["Valor actual del portafolio de inversiones en dólares"] || 0;

        const totalEgresos = d.gastoReal + d.descuentosNomina;
        const balance = d.totalIngresos - totalEgresos;
        const ahorroNomina = d.descuento_ahorro + d.descuento_fondo_empleados;
        const ahorroTotal = d.gasto_inversiones + d.gasto_ahorro + ahorroNomina;
        const totalAhorrado = balance + ahorroTotal;
        const tasaAhorro = d.totalIngresos ? (totalAhorrado / d.totalIngresos * 100) : 0;

        contenido.innerHTML = `
          <h4>💰 Ingresos</h4>
          <div class="metric-row">
            ${metric("Colillas de pago", fmtMoneda(d.ingresosColillas))}
            ${metric("Otros ingresos", fmtMoneda(d.otrosIngresos))}
            ${metric("Total ingresos brutos", fmtMoneda(d.totalIngresos))}
          </div>

          <h4>💳 Gastos</h4>
          <div class="metric-row">
            ${metric("Gasto real (efectivo+tarjetas)", fmtMoneda(d.gastoReal))}
            ${metric("Descuentos de nómina", fmtMoneda(d.descuentosNomina))}
            ${metric("Seguros vía nómina", fmtMoneda(d.seguros_nomina))}
          </div>
          ${d.gastoSinCategorizar > 0 ? `
            <div class="aviso">⚠️ ${fmtMoneda(d.gastoSinCategorizar)}
            (${(d.gastoReal ? d.gastoSinCategorizar / d.gastoReal * 100 : 0).toFixed(0)}% del gasto real de
            este alcance) está en la categoría genérica 'Otros'.</div>` : ""}

          <h4>⚖️ Balance</h4>
          <p class="caption">Ingresos brutos menos gasto real y descuentos de nómina (vista devengado).</p>
          <div class="metric-row">
            ${metric("Total ingresos", fmtMoneda(d.totalIngresos))}
            ${metric("Total egresos", fmtMoneda(totalEgresos))}
          </div>
          <div class="metric-row">
            ${metric("Balance (efectivo)", fmtMoneda(balance))}
            ${metric("Tasa de ahorro (efectivo + ahorro + inversión)", tasaAhorro.toFixed(0) + "%")}
          </div>

          ${ahorroTotal > 0 ? `
            <h6>No es gasto de consumo — discriminado por origen</h6>
            <div class="metric-row">
              ${metric("Inversiones", fmtMoneda(d.gasto_inversiones))}
              ${metric("Ahorro (efectivo/tarjeta)", fmtMoneda(d.gasto_ahorro))}
              ${metric("Ahorro vía nómina", fmtMoneda(ahorroNomina))}
            </div>
            ${renderDesgloseInversiones(d)}
          ` : ""}

          ${d.descuento_deuda_nomina > 0 ? `
            <p class="caption">Aparte, ${fmtMoneda(d.descuento_deuda_nomina)} de este alcance se fue a cuotas
            de deuda descontadas directo de la nómina (leasing habitacional / préstamo del Fondo de
            Empleados) — tampoco es consumo, pero no se suma a la tasa de ahorro.</p>` : ""}

          ${d.ingreso_cesantias > 0 ? `
            <p class="caption">De los ingresos, ${fmtMoneda(d.ingreso_cesantias)} son de la categoría
            Cesantías (intereses o retiro del fondo) — ya están incluidos en 'Total ingresos'.</p>` : ""}

          ${totalAhorrado >= 0
            ? `<div class="ok">✅ Con este alcance, no gastaste ${fmtMoneda(totalAhorrado)} (efectivo +
               ahorro + inversión) — una tasa de ahorro de ${tasaAhorro.toFixed(0)}%
               (${tasaAhorro >= 20 ? "saludable: 20% o más" : "referencia: 20% o más se considera saludable"}).</div>`
            : `<div class="aviso">⚠️ Con este alcance, el gasto superó el ingreso por
               ${fmtMoneda(Math.abs(totalAhorrado))} incluso contando lo aportado a ahorro e inversión
               (tasa de ahorro de ${tasaAhorro.toFixed(0)}%).</div>`}

          <h4>🏦 Deudas</h4>
          <p class="caption">Estado actual — no cambia según el selector de arriba.</p>
          <div class="metric-row">
            ${metric("Saldo total pendiente", fmtMoneda(saldoDeudas))}
            ${metric("Cuota mensual total", fmtMoneda(cuotaDeudas))}
          </div>

          <h4>📈 Inversiones</h4>
          <p class="caption">Estado actual — tampoco cambia según el selector de arriba.</p>
          <div class="metric-row">
            ${metric("Portafolio en pesos", fmtMoneda(portafolioPesos))}
            ${metric("Portafolio en dólares", "US$ " + portafolioDolares.toLocaleString("en-US", { minimumFractionDigits: 2 }))}
          </div>

          <div class="aviso">⚠️ El gráfico de "Tendencia de los últimos meses" todavía no está portado —
          usá <a href="https://presupuesto-app-jmr.streamlit.app" target="_blank" rel="noopener">la versión
          de Streamlit</a> para eso mientras tanto.</div>
        `;
      } catch (err) {
        contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
        console.error(err);
      }
    }

    renderContenido();
  }

  function renderDesgloseInversiones(d) {
    const porDestino = d.inversionesPorDestino || {};
    if (!Object.keys(porDestino).length) return "";
    const porDestinoBruto = d.inversionesPorDestinoBruto || {};
    const retirosTotal = d.gasto_inversiones_bruto - d.gasto_inversiones;
    const filas = Object.entries(porDestino)
      .sort((a, b) => b[1] - a[1])
      .map(([destino, neto]) => {
        const bruto = porDestinoBruto[destino] ?? neto;
        return `<tr><td>${destino}</td><td>${fmtMoneda(bruto)}</td>
          <td>${bruto > neto ? fmtMoneda(bruto - neto) : "—"}</td><td>${fmtMoneda(neto)}</td></tr>`;
      }).join("");
    const sinIdentificar = d.inversionesSinIdentificar || 0;
    const pct = d.gasto_inversiones ? (sinIdentificar / d.gasto_inversiones * 100) : 0;
    return `
      <details>
        <summary>Ver los ${Object.keys(porDestino).length} destino(s) de 'Inversiones'</summary>
        <table class="tabla">
          <thead><tr><th>Destino</th><th>Aportado (bruto)</th><th>Retirado</th><th>Sigue invertido (neto)</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
        ${retirosTotal > 0 ? `<p class="caption">'Sigue invertido (neto)' ya descuenta ${fmtMoneda(retirosTotal)}
          en retiros que volvieron a la cuenta corriente y se gastaron bajo otra categoría.</p>` : ""}
      </details>
      ${sinIdentificar > 0 ? `<div class="aviso">⚠️ ${fmtMoneda(sinIdentificar)} (${pct.toFixed(0)}% de
        Inversiones) nunca se conectó con una plataforma concreta.</div>` : ""}
    `;
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
