// Puerto compartido de _ingresos_gastos_periodo() (app_presupuesto.py) —
// usado por 🏠 Resumen y por 🏢 Estados Financieros → Estado de Resultados,
// para no duplicar la parte más intrincada de toda la app (categorización
// de gasto real + el cruce de cada movimiento "Inversiones" contra la
// plataforma real, con neteo de retiros).
const IngresosGastosPeriodo = (() => {
  async function cargarDatosBase() {
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

    return {
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

  function calcular(datos, coincide) {
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

  return { cargarDatosBase, calcular, renderDesgloseInversiones };
})();
