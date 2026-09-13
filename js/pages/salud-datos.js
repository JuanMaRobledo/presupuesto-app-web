// Puerto de render_salud_datos() (app_presupuesto.py): chequeos automáticos
// de inconsistencias DENTRO de los datos ya cargados (a diferencia de
// ✅ Verificar Datos, que compara contra los extractos del banco) — quincenas
// duplicadas/faltantes, primas/cesantías mal etiquetadas (con corrección
// automática), y recategorización en bloque de gastos/Otros Ingresos.
const PaginaSaludDatos = (() => {
  const MESES_3LETRAS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

  // "'Hoja'!A150:G294" -> { hoja: "'Hoja'", first: 150, last: 294 }.
  function parseRango(rango) {
    const m = rango.match(/^(.+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    return { hoja: m[1], first: Number(m[3]), last: Number(m[5]) };
  }

  async function render(container) {
    container.innerHTML = `
      <h1>🔍 Salud de los Datos</h1>
      <p class="caption">Chequeos automáticos sobre lo ya cargado en el Sheet, más herramientas para
      recategorizar en bloque — no compara contra tus extractos del banco (para eso está ✅ Verificar Datos),
      sino que busca inconsistencias dentro de los datos mismos.</p>
      <div id="sd-contenido">Cargando datos del Sheet…</div>
    `;
    const contenido = container.querySelector("#sd-contenido");
    try {
      const [base, rawCat] = await Promise.all([
        IngresosGastosPeriodo.cargarDatosBase(),
        SheetsApi.batchGet(["categorias_gasto"]),
      ]);
      const categoriasGasto = (rawCat.categorias_gasto || []).map((r) => r[0]).filter(Boolean);

      contenido.innerHTML = `
        <h4>📅 Quincenas duplicadas en Colillas de Pago</h4>
        <div id="sd-duplicadas"></div>
        <hr>
        <h4>🧾 Comprobantes de colillas faltantes</h4>
        <div id="sd-faltantes"></div>
        <hr>
        <h4>🎁 Primas mal etiquetadas como quincena</h4>
        <div id="sd-primas"></div>
        <hr>
        <h4>💰 Cesantías mal etiquetadas como quincena</h4>
        <div id="sd-cesantias"></div>
        <hr>
        <h4>🗂️ Gasto sin categorizar ("Otros")</h4>
        <div id="sd-gasto-otros"></div>
        <hr>
        <h4>⚠️ Categoría inconsistente por comercio (gastos)</h4>
        <div id="sd-incons-gastos"></div>
        <hr>
        <h4>🔄 Recategorizar Otros Ingresos</h4>
        <div id="sd-recat-oi"></div>
        <hr>
        <h4>⚠️ Categoría inconsistente por concepto (Otros Ingresos)</h4>
        <div id="sd-incons-oi"></div>
      `;
      const recargar = () => render(container);
      renderDuplicadas(contenido.querySelector("#sd-duplicadas"), base.colillas);
      renderFaltantes(contenido.querySelector("#sd-faltantes"), base.colillas);
      renderPrimas(contenido.querySelector("#sd-primas"), base.colillasDevengos, recargar);
      renderCesantias(contenido.querySelector("#sd-cesantias"), base.colillasDevengos, recargar);
      const gastosAll = [
        ...base.efectivoDetalle.map((f) => ({ ...f, _bloque: "efectivo_detalle" })),
        ...base.visaDetalle.map((f) => ({ ...f, _bloque: "visa_detalle" })),
        ...base.mcDetalle.map((f) => ({ ...f, _bloque: "mc_detalle" })),
      ].filter((f) => String(f.Comercio || "").trim() !== "");
      renderGastoOtros(contenido.querySelector("#sd-gasto-otros"), gastosAll, categoriasGasto, recargar);
      renderInconsGastos(contenido.querySelector("#sd-incons-gastos"), gastosAll);
      const otrosIngresosConConcepto = base.otrosIngresos.filter((f) => String(f.Concepto || "").trim() !== "");
      renderRecatOI(contenido.querySelector("#sd-recat-oi"), otrosIngresosConConcepto, recargar);
      renderInconsOI(contenido.querySelector("#sd-incons-oi"), otrosIngresosConConcepto);
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  // ---------------------------------------------------------------------
  function renderDuplicadas(div, colillas) {
    if (!colillas.length) { div.innerHTML = "<p>Todavía no hay colillas cargadas.</p>"; return; }
    const conteo = {};
    for (const f of colillas) conteo[f.Periodo] = (conteo[f.Periodo] || 0) + 1;
    const duplicadas = Object.keys(conteo).filter((p) => conteo[p] > 1);
    if (!duplicadas.length) { div.innerHTML = '<p class="aviso" style="background:#d1e7dd;color:#0f5132;">✅ No hay quincenas repetidas.</p>'; return; }
    const filas = colillas.filter((f) => duplicadas.includes(f.Periodo))
      .sort((a, b) => a.Periodo.localeCompare(b.Periodo) || String(a.FechaPago).localeCompare(String(b.FechaPago)));
    div.innerHTML = `
      <div class="aviso">⚠️ ${duplicadas.length} quincena(s) aparecen más de una vez: ${duplicadas.join(", ")}</div>
      <div class="tabla-scroll" style="max-height:400px;"><table class="tabla">
        <thead><tr><th>Fecha de Pago</th><th>Periodo</th><th>Devengos Totales</th><th>Descuentos Totales</th></tr></thead>
        <tbody>${filas.map((f) => `<tr><td>${f.FechaPago ?? ""}</td><td>${f.Periodo}</td>
          <td>${fmtMoneda(toNumber(f.DevengosTotales))}</td><td>${fmtMoneda(toNumber(f.DescuentosTotales))}</td></tr>`).join("")}</tbody>
      </table></div>
    `;
  }

  function renderFaltantes(div, colillas) {
    if (!colillas.length) { div.innerHTML = "<p>Todavía no hay colillas cargadas.</p>"; return; }
    const periodosPresentes = new Set(colillas.map((f) => String(f.Periodo || "").trim()));
    const aniosConDatos = [...new Set([...periodosPresentes].map((p) => extraerAnioMes(p)[0]).filter(Boolean))].sort();
    const hoy = new Date();
    const faltantesPorAnio = {};
    for (const anio of aniosConDatos) {
      const esperados = [];
      for (let mesNum = 1; mesNum <= 12; mesNum++) {
        if (anio === hoy.getFullYear() && mesNum >= hoy.getMonth() + 1) break;
        const mesAbr = MESES_3LETRAS[mesNum - 1];
        esperados.push(`1a quincena ${mesAbr}-${anio}`, `2a quincena ${mesAbr}-${anio}`);
        if (mesNum === 6) esperados.push(`Prima jun-${anio}`);
        if (mesNum === 12) esperados.push(`Prima dic-${anio}`);
      }
      const faltantes = esperados.filter((p) => !periodosPresentes.has(p));
      if (faltantes.length) faltantesPorAnio[anio] = faltantes;
    }
    if (!Object.keys(faltantesPorAnio).length) {
      div.innerHTML = '<p class="aviso" style="background:#d1e7dd;color:#0f5132;">✅ No falta ningún comprobante esperado (24 quincenas + primas de junio/diciembre por año, hasta el mes anterior al actual).</p>';
      return;
    }
    div.innerHTML = Object.entries(faltantesPorAnio).map(([anio, faltantes]) =>
      `<div class="aviso">⚠️ ${anio}: faltan ${faltantes.length} comprobante(s) — ${faltantes.join(", ")}</div>`).join("")
      + `<p class="caption">Subilos en 📄 Cargar Colillas de Pago si tenés el PDF, o revisá si el nombre del
      período quedó distinto al esperado (por si una Prima quedó etiquetada como si fuera la quincena que
      falta).</p>`;
  }

  function renderPrimas(div, colillasDevengos, recargar) {
    if (!colillasDevengos.length) { div.innerHTML = "<p>Todavía no hay devengos de colillas cargados.</p>"; return; }
    const periodosSospechosos = [...new Set(
      colillasDevengos
        .filter((f) => f.Categoria === "Prima de Servicios" && !String(f.Quincena || "").trim().toLowerCase().startsWith("prima"))
        .map((f) => f.Quincena)
    )].sort();
    if (!periodosSospechosos.length) {
      div.innerHTML = '<p class="aviso" style="background:#d1e7dd;color:#0f5132;">✅ Ninguna "quincena" trae un devengo de Prima de Servicios.</p>';
      return;
    }
    div.innerHTML = `
      <div class="aviso">⚠️ ${periodosSospechosos.length} período(s) etiquetados como quincena traen un devengo de
      Prima de Servicios: ${periodosSospechosos.join(", ")}. Es probable que ese comprobante sea en realidad la
      Prima completa y esté pisando el lugar de la quincena real. El botón de abajo conserva los valores y
      renombra el comprobante como "Prima {mes}-{año}".</div>
      <button type="button" id="sd_corregir_primas">🔧 Corregir ${periodosSospechosos.length} Prima(s) automáticamente</button>
      <div id="sd_primas_msg"></div>
    `;
    div.querySelector("#sd_corregir_primas").addEventListener("click", async () => {
      const btn = div.querySelector("#sd_corregir_primas");
      const msg = div.querySelector("#sd_primas_msg");
      btn.disabled = true;
      btn.textContent = "Corrigiendo…";
      const resultados = [], errores = [];
      for (const p of periodosSospechosos) {
        try { resultados.push(await corregirPrimaMalEtiquetada(p)); }
        catch (err) { errores.push([p, err.message]); }
      }
      msg.innerHTML = resultados.map((r) => `<div class="aviso" style="background:#d1e7dd;color:#0f5132;">'${r.periodoViejo}' → '${r.periodoNuevo}' (${r.devengos} devengo(s), ${r.descuentos} descuento(s))</div>`).join("")
        + errores.map(([p, e]) => `<div class="error">No pude corregir '${p}': ${e}</div>`).join("")
        + (resultados.length ? '<p class="caption">Revisá "🧾 Comprobantes de colillas faltantes" más arriba — la quincena real de ese período probablemente ahora aparezca como faltante.</p>' : "");
      await recargar();
    });
  }

  function renderCesantias(div, colillasDevengos, recargar) {
    if (!colillasDevengos.length) { div.innerHTML = "<p>Todavía no hay devengos de colillas cargados.</p>"; return; }
    const periodosCesantiasMal = [...new Set(
      colillasDevengos
        .filter((f) => f.Concepto === "Cesantías Año Anterior" && !String(f.Quincena || "").trim().toLowerCase().startsWith("cesantías"))
        .map((f) => f.Quincena)
    )].sort();
    if (!periodosCesantiasMal.length) {
      div.innerHTML = '<p class="aviso" style="background:#d1e7dd;color:#0f5132;">✅ Ninguna "quincena" trae un devengo de Cesantías Año Anterior.</p>';
      return;
    }
    div.innerHTML = `
      <div class="aviso">⚠️ ${periodosCesantiasMal.length} período(s) etiquetados como quincena traen en realidad
      la liquidación de cesantías: ${periodosCesantiasMal.join(", ")}. El botón de abajo corrige lo que ya
      estaba cargado de antes: relabels el período a "Cesantías {mes}-{año}", saca el capital de Colillas de
      Pago (no tiene efecto en caja) y manda los intereses, si los hay, a Otros Ingresos como ingreso real.</div>
      <button type="button" id="sd_corregir_cesantias">🔧 Corregir ${periodosCesantiasMal.length} período(s) automáticamente</button>
      <div id="sd_cesantias_msg"></div>
    `;
    div.querySelector("#sd_corregir_cesantias").addEventListener("click", async () => {
      const btn = div.querySelector("#sd_corregir_cesantias");
      const msg = div.querySelector("#sd_cesantias_msg");
      btn.disabled = true;
      btn.textContent = "Corrigiendo…";
      const resultados = [], errores = [];
      for (const p of periodosCesantiasMal) {
        try { resultados.push(await corregirCesantiasMalEtiquetada(p)); }
        catch (err) { errores.push([p, err.message]); }
      }
      msg.innerHTML = resultados.map((r) => {
        const detalle = r.interes ? ` (intereses ${fmtMoneda(r.interes)} → Otros Ingresos)` : "";
        return `<div class="aviso" style="background:#d1e7dd;color:#0f5132;">'${r.periodoViejo}' → '${r.periodoNuevo}'${detalle}</div>`;
      }).join("") + errores.map(([p, e]) => `<div class="error">No pude corregir '${p}': ${e}</div>`).join("")
        + (resultados.length ? '<p class="caption">Revisá "🧾 Comprobantes de colillas faltantes" más arriba.</p>' : "");
      await recargar();
    });
  }

  // ---------------------------------------------------------------------
  async function corregirPrimaMalEtiquetada(periodoViejo) {
    const m = periodoViejo.match(/([a-zA-Z]{3})-(\d{4})$/);
    if (!m) throw new Error(`No pude reconocer mes/año en '${periodoViejo}'.`);
    const periodoNuevo = `Prima ${m[1].toLowerCase()}-${m[2]}`;

    const resR = parseRango(RANGOS.colillas_resumen);
    const resD = parseRango(RANGOS.colillas_devengos);
    const resDs = parseRango(RANGOS.colillas_descuentos);
    const raw = await SheetsApi.batchGet(["colillas_resumen", "colillas_devengos", "colillas_descuentos"]);
    const resumen = raw.colillas_resumen || [];
    const devengos = raw.colillas_devengos || [];
    const descuentos = raw.colillas_descuentos || [];

    if (resumen.some((row) => row && row[1] === periodoNuevo)) {
      throw new Error(`Ya existe el período de destino '${periodoNuevo}'.`);
    }
    const filasResumen = [];
    resumen.forEach((row, i) => { if (row && row[1] === periodoViejo) filasResumen.push(resR.first + i); });
    if (filasResumen.length !== 1) {
      throw new Error(`Esperaba una fila de resumen para '${periodoViejo}' y encontré ${filasResumen.length}.`);
    }
    const filasDevengos = [];
    let esPrima = false;
    devengos.forEach((row, i) => {
      if (row && row[0] === periodoViejo) {
        filasDevengos.push(resD.first + i);
        if (row[2] === "Prima de Servicios") esPrima = true;
      }
    });
    if (!esPrima) throw new Error(`'${periodoViejo}' no contiene un devengo de Prima de Servicios.`);
    const filasDescuentos = [];
    descuentos.forEach((row, i) => { if (row && row[0] === periodoViejo) filasDescuentos.push(resDs.first + i); });

    const data = [{ range: `${resR.hoja}!B${filasResumen[0]}`, values: [[periodoNuevo]] }];
    for (const fila of filasDevengos) data.push({ range: `${resD.hoja}!A${fila}`, values: [[periodoNuevo]] });
    for (const fila of filasDescuentos) data.push({ range: `${resDs.hoja}!A${fila}`, values: [[periodoNuevo]] });
    await SheetsApi.batchUpdateRanges(data);
    return { periodoViejo, periodoNuevo, resumen: filasResumen.length, devengos: filasDevengos.length, descuentos: filasDescuentos.length };
  }

  async function corregirCesantiasMalEtiquetada(periodoViejo) {
    const m = periodoViejo.match(/([a-zA-Z]{3})-(\d{4})$/);
    if (!m) throw new Error(`No pude reconocer mes/año en '${periodoViejo}'.`);
    const periodoNuevo = `Cesantías ${m[1].toLowerCase()}-${m[2]}`;

    const resR = parseRango(RANGOS.colillas_resumen);
    const resD = parseRango(RANGOS.colillas_devengos);
    const resDs = parseRango(RANGOS.colillas_descuentos);
    const raw = await SheetsApi.batchGet(["colillas_resumen", "colillas_devengos", "colillas_descuentos"]);
    const resumen = raw.colillas_resumen || [];
    const devengos = raw.colillas_devengos || [];
    const descuentos = raw.colillas_descuentos || [];

    const filaIdx = resumen.findIndex((row) => row && row[1] === periodoViejo);
    if (filaIdx === -1) throw new Error(`No encontré '${periodoViejo}' en Colillas de Pago → resumen.`);
    const fechaRaw = resumen[filaIdx][0];
    const filaNum = resR.first + filaIdx;

    let interes = 0;
    for (const row of devengos) {
      if (row && row[0] === periodoViejo && row[1] === "Intereses de Cesantías Año Anterior") interes += toNumber(row[3]);
    }

    await SheetsApi.batchUpdateRanges([
      { range: `${resR.hoja}!B${filaNum}`, values: [[periodoNuevo]] },
      { range: `${resR.hoja}!C${filaNum}:D${filaNum}`, values: [[0, 0]] },
    ]);
    const filasDevengosClear = [];
    devengos.forEach((row, i) => { if (row && row[0] === periodoViejo) filasDevengosClear.push(resD.first + i); });
    const filasDescuentosClear = [];
    descuentos.forEach((row, i) => { if (row && row[0] === periodoViejo) filasDescuentosClear.push(resDs.first + i); });
    const rangosClear = [
      ...filasDevengosClear.map((f) => `${resD.hoja}!A${f}:D${f}`),
      ...filasDescuentosClear.map((f) => `${resDs.hoja}!A${f}:D${f}`),
    ];
    if (rangosClear.length) await SheetsApi.batchClearRanges(rangosClear);

    if (interes) {
      const fechaTxt = serialToText(fechaRaw);
      let fechaISO;
      if (fechaTxt && String(fechaTxt).includes("/")) {
        const [d, mo, y] = String(fechaTxt).split("/");
        fechaISO = `${y}-${mo}-${d}`;
      } else {
        fechaISO = fechaTxt ? String(fechaTxt) : new Date().toISOString().slice(0, 10);
      }
      const [y, mo, d] = fechaISO.split("-");
      const fechaDDMM = `${d}/${mo}/${y}`;
      const rawOI = await SheetsApi.batchGet(["otros_ingresos"]);
      const yaRegistrado = (rawOI.otros_ingresos || []).some((row) =>
        row && serialToText(row[0]) === fechaDDMM && row[1] === "Intereses de Cesantías" && row[2] === "Cesantías");
      if (!yaRegistrado) {
        await SheetsApi.appendRows(RANGOS.otros_ingresos, [[fechaISO, "Intereses de Cesantías", "Cesantías", interes,
          `Liquidación de cesantías ${periodoNuevo} — corregido de '${periodoViejo}', no incluye el capital, que se consigna al fondo el mismo día y no es ingreso`]]);
      }
    }
    return { periodoViejo, periodoNuevo, interes };
  }

  async function recategorizarComercios(mapeo, soloOtros) {
    const claves = ["efectivo_detalle", "visa_detalle", "mc_detalle"];
    const raw = await SheetsApi.batchGet(claves);
    const resultado = {};
    for (const key of claves) {
      const r = parseRango(RANGOS[key]);
      const data = [];
      (raw[key] || []).forEach((row, i) => {
        const comercio = (row && row[2]) || "";
        const categoria = (row && row[8]) || "";
        if (Object.prototype.hasOwnProperty.call(mapeo, comercio) && (!soloOtros || categoria === "Otros")) {
          data.push({ range: `${r.hoja}!I${r.first + i}`, values: [[mapeo[comercio]]] });
        }
      });
      if (data.length) await SheetsApi.batchUpdateRanges(data);
      resultado[key] = data.length;
    }
    return resultado;
  }

  async function recategorizarConceptosIngreso(mapeo) {
    const r = parseRango(RANGOS.otros_ingresos);
    const raw = await SheetsApi.batchGet(["otros_ingresos"]);
    const data = [];
    (raw.otros_ingresos || []).forEach((row, i) => {
      const concepto = (row && row[1]) || "";
      if (Object.prototype.hasOwnProperty.call(mapeo, concepto)) {
        data.push({ range: `${r.hoja}!C${r.first + i}`, values: [[mapeo[concepto]]] });
      }
    });
    if (data.length) await SheetsApi.batchUpdateRanges(data);
    return data.length;
  }

  // ---------------------------------------------------------------------
  const SIN_CAMBIAR = "(sin cambiar)";

  function renderGastoOtros(div, gastosAll, categoriasGasto, recargar) {
    const gastosPres = gastosAll.filter((f) => f.Moneda === "COP" && !esNoPresupuestar(f.Categoria));
    if (!gastosPres.length) { div.innerHTML = "<p>Todavía no hay gastos cargados.</p>"; return; }
    const totalGasto = gastosPres.reduce((s, f) => s + toNumber(f.ValorCargado), 0);
    const otros = gastosPres.filter((f) => f.Categoria === "Otros");
    const totalOtros = otros.reduce((s, f) => s + toNumber(f.ValorCargado), 0);
    const pct = totalGasto ? (totalOtros / totalGasto * 100) : 0;

    div.innerHTML = `
      <div class="metric-row">
        ${metric('Total en "Otros"', fmtMoneda(totalOtros))}
        ${metric("% del gasto real total (efectivo+tarjetas, COP)", `${pct.toFixed(0)}%`)}
      </div>
      <label class="checkbox-row"><input type="checkbox" id="sd_mostrar_todos"> Mostrar todos los comercios (no solo "Otros") para recategorizar cualquiera</label>
      <div id="sd_gasto_tabla"></div>
    `;
    const chk = div.querySelector("#sd_mostrar_todos");
    const tablaDiv = div.querySelector("#sd_gasto_tabla");

    function construirTabla() {
      const base = chk.checked ? gastosPres : otros;
      if (!base.length) {
        tablaDiv.innerHTML = chk.checked ? '<p class="caption">Todavía no hay gastos cargados en pesos presupuestables.</p>' : "";
        return;
      }
      const porComercio = {};
      for (const f of base) {
        const c = f.Comercio;
        porComercio[c] = porComercio[c] || { total: 0, n: 0, categoriaActual: f.Categoria };
        porComercio[c].total += toNumber(f.ValorCargado);
        porComercio[c].n += 1;
      }
      const filas = Object.entries(porComercio).sort((a, b) => b[1].total - a[1].total);
      tablaDiv.innerHTML = `
        <p class="caption">${filas.length} comercio(s) — elegí una categoría nueva para los que quieras corregir,
        y guardá con el botón de abajo. Los que dejes en "${SIN_CAMBIAR}" quedan sin tocar. La categoría nueva
        se aplica a TODAS las compras de ese comercio en cualquier mes.</p>
        <div class="tabla-scroll" style="max-height:400px;"><table class="tabla">
          <thead><tr><th>Comercio / Concepto</th><th>Total</th><th>N° compras</th>
            ${chk.checked ? "<th>Categoría Actual</th>" : ""}<th>Nueva Categoría</th></tr></thead>
          <tbody>${filas.map(([c, info]) => `<tr>
            <td>${c}</td><td>${fmtMoneda(info.total)}</td><td>${info.n}</td>
            ${chk.checked ? `<td>${info.categoriaActual}</td>` : ""}
            <td><select class="sd-gasto-nueva-cat" data-comercio="${c.replace(/"/g, "&quot;")}">
              <option value="${SIN_CAMBIAR}">${SIN_CAMBIAR}</option>
              ${categoriasGasto.map((cat) => `<option value="${cat}">${cat}</option>`).join("")}
            </select></td>
          </tr>`).join("")}</tbody>
        </table></div>
        <button type="button" id="sd_gasto_aplicar">💾 Aplicar categoría(s) nueva(s)</button>
        <div id="sd_gasto_msg"></div>
      `;
      tablaDiv.querySelector("#sd_gasto_aplicar").addEventListener("click", async () => {
        const mapeo = {};
        tablaDiv.querySelectorAll(".sd-gasto-nueva-cat").forEach((sel) => {
          if (sel.value !== SIN_CAMBIAR) mapeo[sel.dataset.comercio] = sel.value;
        });
        if (!Object.keys(mapeo).length) return;
        const btn = tablaDiv.querySelector("#sd_gasto_aplicar");
        const msg = tablaDiv.querySelector("#sd_gasto_msg");
        btn.disabled = true;
        btn.textContent = "Guardando…";
        try {
          const resultado = await recategorizarComercios(mapeo, !chk.checked);
          const total = resultado.efectivo_detalle + resultado.visa_detalle + resultado.mc_detalle;
          msg.innerHTML = `<div class="aviso" style="background:#d1e7dd;color:#0f5132;">${total} fila(s)
            recategorizadas — ${resultado.efectivo_detalle} en Efectivo, ${resultado.visa_detalle} en Visa,
            ${resultado.mc_detalle} en Mastercard.</div>`;
          await recargar();
        } catch (err) {
          msg.innerHTML = `<div class="error">No pude guardar: ${err.message}</div>`;
          console.error(err);
          btn.disabled = false;
          btn.textContent = "💾 Aplicar categoría(s) nueva(s)";
        }
      });
    }
    chk.addEventListener("change", construirTabla);
    construirTabla();
  }

  function renderInconsGastos(div, gastosAll) {
    if (!gastosAll.length) { div.innerHTML = "<p>Todavía no hay gastos cargados.</p>"; return; }
    const porComercio = {};
    for (const f of gastosAll) {
      porComercio[f.Comercio] = porComercio[f.Comercio] || {};
      porComercio[f.Comercio][f.Categoria] = (porComercio[f.Comercio][f.Categoria] || 0) + 1;
    }
    const incons = Object.entries(porComercio).filter(([, cats]) => Object.keys(cats).length > 1).sort((a, b) => a[0].localeCompare(b[0]));
    if (!incons.length) { div.innerHTML = '<p class="aviso" style="background:#d1e7dd;color:#0f5132;">✅ Cada comercio de gastos usa siempre la misma categoría.</p>'; return; }
    div.innerHTML = `
      <div class="aviso">⚠️ ${incons.length} comercio(s) de gastos tienen más de una categoría asignada.</div>
      <div class="tabla-scroll" style="max-height:400px;"><table class="tabla">
        <thead><tr><th>Comercio / Concepto</th><th>Categorías usadas</th></tr></thead>
        <tbody>${incons.map(([c, cats]) => `<tr><td>${c}</td><td>${Object.entries(cats).map(([cat, n]) => `${cat} (${n})`).join(", ")}</td></tr>`).join("")}</tbody>
      </table></div>
    `;
  }

  const CATEGORIAS_OTROS_INGRESOS = [
    "Reembolso (esposa/otros)", "Honorarios / Consultoría", "Rendimientos Financieros", "Cesantías",
    "Regalo", "Venta", "Ajustes y Reversiones (no presupuestar)", "Otro",
  ];

  function renderRecatOI(div, otrosIngresos, recargar) {
    if (!otrosIngresos.length) { div.innerHTML = "<p>Todavía no hay Otros Ingresos cargados.</p>"; return; }
    div.innerHTML = `
      <label class="checkbox-row"><input type="checkbox" id="sd_solo_otro" checked> Mostrar solo los conceptos en la categoría genérica "Otro"</label>
      <div id="sd_oi_tabla"></div>
    `;
    const chk = div.querySelector("#sd_solo_otro");
    const tablaDiv = div.querySelector("#sd_oi_tabla");

    function construirTabla() {
      const base = chk.checked ? otrosIngresos.filter((f) => f.Categoria === "Otro") : otrosIngresos;
      if (!base.length) {
        tablaDiv.innerHTML = '<p class="aviso" style="background:#d1e7dd;color:#0f5132;">✅ Ningún concepto está en la categoría genérica "Otro".</p>';
        return;
      }
      const porConcepto = {};
      for (const f of base) {
        const c = f.Concepto;
        porConcepto[c] = porConcepto[c] || { total: 0, n: 0, categoriaActual: f.Categoria };
        porConcepto[c].total += toNumber(f.Valor);
        porConcepto[c].n += 1;
      }
      const filas = Object.entries(porConcepto).sort((a, b) => b[1].total - a[1].total);
      tablaDiv.innerHTML = `
        <p class="caption">${filas.length} concepto(s) — elegí una categoría nueva para los que quieras corregir,
        y guardá con el botón de abajo. La categoría nueva se aplica a TODOS los movimientos de ese concepto en
        cualquier mes.</p>
        <div class="tabla-scroll" style="max-height:400px;"><table class="tabla">
          <thead><tr><th>Concepto</th><th>Total</th><th>N° movimientos</th><th>Categoría Actual</th><th>Nueva Categoría</th></tr></thead>
          <tbody>${filas.map(([c, info]) => `<tr>
            <td>${c}</td><td>${fmtMoneda(info.total)}</td><td>${info.n}</td><td>${info.categoriaActual}</td>
            <td><select class="sd-oi-nueva-cat" data-concepto="${c.replace(/"/g, "&quot;")}">
              <option value="${SIN_CAMBIAR}">${SIN_CAMBIAR}</option>
              ${CATEGORIAS_OTROS_INGRESOS.map((cat) => `<option value="${cat}">${cat}</option>`).join("")}
            </select></td>
          </tr>`).join("")}</tbody>
        </table></div>
        <button type="button" id="sd_oi_aplicar">💾 Aplicar categoría(s) nueva(s)</button>
        <div id="sd_oi_msg"></div>
      `;
      tablaDiv.querySelector("#sd_oi_aplicar").addEventListener("click", async () => {
        const mapeo = {};
        tablaDiv.querySelectorAll(".sd-oi-nueva-cat").forEach((sel) => {
          if (sel.value !== SIN_CAMBIAR) mapeo[sel.dataset.concepto] = sel.value;
        });
        if (!Object.keys(mapeo).length) return;
        const btn = tablaDiv.querySelector("#sd_oi_aplicar");
        const msg = tablaDiv.querySelector("#sd_oi_msg");
        btn.disabled = true;
        btn.textContent = "Guardando…";
        try {
          const total = await recategorizarConceptosIngreso(mapeo);
          msg.innerHTML = `<div class="aviso" style="background:#d1e7dd;color:#0f5132;">${total} fila(s) recategorizadas en Otros Ingresos.</div>`;
          await recargar();
        } catch (err) {
          msg.innerHTML = `<div class="error">No pude guardar: ${err.message}</div>`;
          console.error(err);
          btn.disabled = false;
          btn.textContent = "💾 Aplicar categoría(s) nueva(s)";
        }
      });
    }
    chk.addEventListener("change", construirTabla);
    construirTabla();
  }

  function renderInconsOI(div, otrosIngresos) {
    if (!otrosIngresos.length) { div.innerHTML = "<p>Todavía no hay Otros Ingresos cargados.</p>"; return; }
    const porConcepto = {};
    for (const f of otrosIngresos) {
      porConcepto[f.Concepto] = porConcepto[f.Concepto] || {};
      porConcepto[f.Concepto][f.Categoria] = (porConcepto[f.Concepto][f.Categoria] || 0) + 1;
    }
    const incons = Object.entries(porConcepto).filter(([, cats]) => Object.keys(cats).length > 1).sort((a, b) => a[0].localeCompare(b[0]));
    if (!incons.length) { div.innerHTML = '<p class="aviso" style="background:#d1e7dd;color:#0f5132;">✅ Cada concepto de Otros Ingresos usa siempre la misma categoría.</p>'; return; }
    div.innerHTML = `
      <div class="aviso">⚠️ ${incons.length} concepto(s) de Otros Ingresos tienen más de una categoría asignada.</div>
      <div class="tabla-scroll" style="max-height:400px;"><table class="tabla">
        <thead><tr><th>Concepto</th><th>Categorías usadas</th></tr></thead>
        <tbody>${incons.map(([c, cats]) => `<tr><td>${c}</td><td>${Object.entries(cats).map(([cat, n]) => `${cat} (${n})`).join(", ")}</td></tr>`).join("")}</tbody>
      </table></div>
    `;
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
