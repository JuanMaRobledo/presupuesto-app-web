// Puerto (solo lectura) de render_ingresos() + render_ingresos_colillas() +
// render_ingresos_otros() (app_presupuesto.py): dos sub-tabs, Colillas de
// Pago y Otros Ingresos.
//
// TODAVÍA NO portado: agregar/eliminar una colilla o un ingreso (escritura).

const PaginaIngresos = (() => {
  const charts = {};

  async function cargarDatos() {
    const raw = await SheetsApi.batchGet(["colillas_resumen", "colillas_devengos", "colillas_descuentos", "otros_ingresos"]);
    return {
      colillas: filasAObjetos(raw.colillas_resumen, ["FechaPago", "Periodo", "DevengosTotales", "DescuentosTotales"]),
      devengos: filasAObjetos(raw.colillas_devengos, ["Quincena", "Concepto", "Categoria", "Valor"]),
      descuentos: filasAObjetos(raw.colillas_descuentos, ["Quincena", "Concepto", "Categoria", "Valor"]),
      otrosIngresos: filasAObjetos(raw.otros_ingresos, ["Fecha", "Concepto", "Categoria", "Valor", "Notas"]),
    };
  }

  function render(container) {
    container.innerHTML = `
      <h1>💰 Ingresos</h1>
      <p class="caption">Todo lo que entró: colillas de pago y cualquier otro ingreso ocasional.</p>
      <div class="tabs" id="tabs-ingresos">
        <button class="tab-btn activo" data-tab="colillas">Colillas de Pago</button>
        <button class="tab-btn" data-tab="otros">Otros Ingresos</button>
      </div>
      <div id="panel-ingresos">Cargando datos del Sheet…</div>
    `;
    const tabsDiv = container.querySelector("#tabs-ingresos");
    const panel = container.querySelector("#panel-ingresos");
    let activo = "colillas";

    tabsDiv.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activo = btn.dataset.tab;
        tabsDiv.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("activo", b === btn));
        renderTab();
      });
    });

    async function renderTab() {
      panel.innerHTML = "Cargando datos del Sheet…";
      try {
        const datos = await cargarDatos();
        if (activo === "colillas") renderColillas(panel, datos);
        else renderOtrosIngresos(panel, datos);
      } catch (err) {
        panel.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
        console.error(err);
      }
    }

    renderTab();
  }

  // ---------------------------------------------------------------------
  // Colillas de Pago
  // ---------------------------------------------------------------------
  function renderColillas(panel, datos) {
    if (!datos.colillas.length) {
      panel.innerHTML = "<p>Todavía no hay colillas cargadas.</p>";
      return;
    }
    const colillas = datos.colillas.map((f) => {
      const [anio, mes] = extraerAnioMes(f.Periodo);
      return { ...f, _anio: anio, _mes: mes };
    });

    panel.innerHTML = `
      <h4>Colillas de Pago</h4>
      <div class="row">
        <select id="cp_anio"></select>
        <select id="cp_mes"></select>
      </div>
      <div class="metric-row">
        ${metric("Devengos totales (histórico)", fmtMoneda(colillas.reduce((s, f) => s + toNumber(f.DevengosTotales), 0)))}
        ${metric("Descuentos totales (histórico)", fmtMoneda(colillas.reduce((s, f) => s + toNumber(f.DescuentosTotales), 0)))}
      </div>
      <h5>Tendencia por quincena (últimas 24)</h5>
      <canvas id="chart_cp_tendencia" height="90"></canvas>
      <div id="cp_detalle"></div>
    `;

    const anioSel = panel.querySelector("#cp_anio");
    const mesSel = panel.querySelector("#cp_mes");
    const anios = [...new Set(colillas.map((f) => f._anio).filter(Boolean))].sort((a, b) => b - a);
    anioSel.add(new Option("(todos)", "(todos)"));
    anios.forEach((a) => anioSel.add(new Option(a, a)));
    mesSel.add(new Option("(todos)", "(todos)"));
    for (let m = 1; m <= 12; m++) mesSel.add(new Option(`${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}`, m));

    const ultimas24 = colillas.slice(-24);
    if (charts.cpTendencia) charts.cpTendencia.destroy();
    charts.cpTendencia = new Chart(panel.querySelector("#chart_cp_tendencia").getContext("2d"), {
      type: "bar",
      data: {
        labels: ultimas24.map((f) => f.Periodo),
        datasets: [
          { label: "Devengos Totales", data: ultimas24.map((f) => toNumber(f.DevengosTotales)), backgroundColor: "#4573d6" },
          { label: "Descuentos Totales", data: ultimas24.map((f) => toNumber(f.DescuentosTotales)), backgroundColor: "#d64545" },
        ],
      },
      options: { responsive: true, scales: { y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
    });

    function actualizarDetalle() {
      const detalle = panel.querySelector("#cp_detalle");
      const av = anioSel.value, mv = mesSel.value;
      if (av === "(todos)" || mv === "(todos)") {
        const filasCol = [...colillas].reverse();
        detalle.innerHTML = `
          <h5>Resumen por quincena</h5>
          <div class="tabla-scroll" style="max-height:350px;">
            <table class="tabla">
              <thead><tr><th>Fecha de Pago</th><th>Periodo</th><th>Devengos Totales</th><th>Descuentos Totales</th></tr></thead>
              <tbody>${filasCol.map((f) => `<tr><td>${f.FechaPago ?? ""}</td><td>${f.Periodo ?? ""}</td>
                <td>${fmtMoneda(toNumber(f.DevengosTotales))}</td><td>${fmtMoneda(toNumber(f.DescuentosTotales))}</td></tr>`).join("")}</tbody>
            </table>
          </div>
          <div class="col-2">
            <div>
              <h5>Devengos</h5>
              ${tablaConceptos(datos.devengos)}
            </div>
            <div>
              <h5>Descuentos</h5>
              ${tablaConceptos(datos.descuentos)}
            </div>
          </div>
        `;
      } else {
        const mesNum = Number(mv);
        const delMes = colillas.filter((f) => f._anio === Number(av) && f._mes === mesNum)
          .sort((a, b) => (a.Periodo || "").localeCompare(b.Periodo || ""));
        if (delMes.length === 0) {
          detalle.innerHTML = `<p>No hay colillas cargadas para ${MESES_NOMBRE[mesNum]} de ${av}.</p>`;
          return;
        }
        detalle.innerHTML = delMes.map((f) => `
          <h5>${f.Periodo} — fecha de pago: ${f.FechaPago ?? ""}</h5>
          <div class="metric-row">
            ${metric("Devengos", fmtMoneda(toNumber(f.DevengosTotales)))}
            ${metric("Descuentos", fmtMoneda(toNumber(f.DescuentosTotales)))}
          </div>
          <div class="col-2">
            <div><p class="caption">Devengos</p>${tablaConceptos(datos.devengos.filter((d) => d.Quincena === f.Periodo))}</div>
            <div><p class="caption">Descuentos</p>${tablaConceptos(datos.descuentos.filter((d) => d.Quincena === f.Periodo))}</div>
          </div>
          <hr>
        `).join("");
      }
    }

    anioSel.addEventListener("change", actualizarDetalle);
    mesSel.addEventListener("change", actualizarDetalle);
    actualizarDetalle();
  }

  function tablaConceptos(filas) {
    if (!filas.length) return "<p class=\"caption\">(sin datos)</p>";
    return `
      <div class="tabla-scroll" style="max-height:400px;">
        <table class="tabla">
          <thead><tr><th>Quincena</th><th>Concepto</th><th>Categoría</th><th>Valor</th></tr></thead>
          <tbody>${filas.map((f) => `<tr><td>${f.Quincena ?? ""}</td><td>${f.Concepto ?? ""}</td>
            <td>${f.Categoria ?? ""}</td><td>${fmtMoneda(toNumber(f.Valor))}</td></tr>`).join("")}</tbody>
        </table>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Otros Ingresos
  // ---------------------------------------------------------------------
  function renderOtrosIngresos(panel, datos) {
    if (!datos.otrosIngresos.length) {
      panel.innerHTML = "<p>Todavía no hay otros ingresos cargados.</p>";
      return;
    }
    const filas = datos.otrosIngresos.map((f) => {
      const [anio, mes] = extraerAnioMes(f.Fecha);
      return { ...f, _anio: anio, _mes: mes, _fechaISO: parseFechaISO(f.Fecha), _presupuestar: !esNoPresupuestar(f.Categoria) };
    });

    panel.innerHTML = `
      <h4>Otros Ingresos</h4>
      <label class="checkbox-row"><input type="checkbox" id="oi_ocultar" checked>
        Ocultar movimientos de conciliación (no presupuestar)</label>
      <label class="checkbox-row"><input type="checkbox" id="oi_agrupar" checked>
        Agrupar 'Rendimientos Financieros' por mes</label>
      <input type="text" id="oi_busqueda" placeholder="🔍 Buscar en concepto" class="input-texto" />
      <div class="row">
        <select id="oi_cat"></select>
        <select id="oi_anio"></select>
        <select id="oi_mes"></select>
      </div>
      <p class="caption" id="oi_resumen"></p>
      <div id="oi_totales_cat"></div>
      <div class="tabla-scroll"><table class="tabla" id="oi_tabla"></table></div>
      <h5>Ingresos por categoría (según el filtro de arriba)</h5>
      <canvas id="chart_oi_categoria" height="140"></canvas>
    `;

    const catSel = panel.querySelector("#oi_cat");
    const anioSel = panel.querySelector("#oi_anio");
    const mesSel = panel.querySelector("#oi_mes");
    const ocultarChk = panel.querySelector("#oi_ocultar");
    const agruparChk = panel.querySelector("#oi_agrupar");
    const busquedaInput = panel.querySelector("#oi_busqueda");

    const categorias = [...new Set(filas.map((f) => f.Categoria).filter(Boolean))].sort();
    catSel.add(new Option("(todas)", "(todas)"));
    categorias.forEach((c) => catSel.add(new Option(c, c)));
    const anios = [...new Set(filas.map((f) => f._anio).filter(Boolean))].sort((a, b) => b - a);
    anioSel.add(new Option("(todos)", "(todos)"));
    anios.forEach((a) => anioSel.add(new Option(a, a)));
    mesSel.add(new Option("(todos)", "(todos)"));
    for (let m = 1; m <= 12; m++) mesSel.add(new Option(`${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}`, m));

    function actualizar() {
      let f = filas;
      if (ocultarChk.checked) f = f.filter((x) => x._presupuestar);
      const busqueda = busquedaInput.value.trim().toLowerCase();
      if (busqueda) f = f.filter((x) => String(x.Concepto || "").toLowerCase().includes(busqueda));
      if (catSel.value !== "(todas)") f = f.filter((x) => x.Categoria === catSel.value);
      if (anioSel.value !== "(todos)") f = f.filter((x) => x._anio === Number(anioSel.value));
      if (mesSel.value !== "(todos)") f = f.filter((x) => x._mes === Number(mesSel.value));

      const suma = f.reduce((s, x) => s + toNumber(x.Valor), 0);
      panel.querySelector("#oi_resumen").textContent =
        `${f.length.toLocaleString("en-US")} de ${filas.length.toLocaleString("en-US")} movimientos — suma: ${fmtMoneda(suma)}`;

      const porCat = {};
      for (const x of f) porCat[x.Categoria] = (porCat[x.Categoria] || 0) + toNumber(x.Valor);
      const catOrdenadas = Object.entries(porCat).sort((a, b) => b[1] - a[1]);
      panel.querySelector("#oi_totales_cat").innerHTML = f.length ? `
        <p><strong>Total por categoría</strong></p>
        <div class="metric-row">${catOrdenadas.map(([cat, val]) => metric(cat, fmtMoneda(val))).join("")}</div>
      ` : "";

      let mostrar = f;
      if (agruparChk.checked) {
        const esRend = f.filter((x) => x.Categoria === "Rendimientos Financieros");
        const resto = f.filter((x) => x.Categoria !== "Rendimientos Financieros");
        if (esRend.length) {
          const porMes = {};
          for (const x of esRend) {
            const key = `${x._anio}-${x._mes}`;
            porMes[key] = porMes[key] || { valor: 0, n: 0, fechaISO: null };
            porMes[key].valor += toNumber(x.Valor);
            porMes[key].n += 1;
            if (!porMes[key].fechaISO || (x._fechaISO && x._fechaISO > porMes[key].fechaISO)) porMes[key].fechaISO = x._fechaISO;
          }
          const resumenRend = Object.values(porMes).map((r) => {
            const [y, mo, d] = (r.fechaISO || "").split("-");
            return {
              Fecha: d ? `${d}/${mo}/${y}` : "", Concepto: "Rendimientos Financieros (resumen del mes)",
              Categoria: "Rendimientos Financieros", Valor: r.valor, Notas: `${r.n} abono(s) de interés este mes`,
              _presupuestar: true, _fechaISO: r.fechaISO,
            };
          });
          mostrar = [...resto, ...resumenRend];
        }
      }
      mostrar = [...mostrar].sort((a, b) => (b._fechaISO || "").localeCompare(a._fechaISO || ""));

      panel.querySelector("#oi_tabla").innerHTML = `
        <thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Valor</th><th>Notas</th><th>Presupuestar</th></tr></thead>
        <tbody>${mostrar.map((x) => `<tr><td>${x.Fecha ?? ""}</td><td>${x.Concepto ?? ""}</td>
          <td>${x.Categoria ?? ""}</td><td>${fmtMoneda(toNumber(x.Valor))}</td><td>${x.Notas ?? ""}</td>
          <td>${x._presupuestar ? "Sí" : "No"}</td></tr>`).join("")}</tbody>
      `;

      if (charts.oiCategoria) charts.oiCategoria.destroy();
      const canvas = panel.querySelector("#chart_oi_categoria");
      if (f.length && catOrdenadas.length) {
        charts.oiCategoria = new Chart(canvas.getContext("2d"), {
          type: "bar",
          data: { labels: catOrdenadas.map((c) => c[0]), datasets: [{ label: "Valor", data: catOrdenadas.map((c) => c[1]), backgroundColor: "#4573d6" }] },
          options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } },
            scales: { x: { ticks: { callback: (v) => fmtMoneda(v) } } } },
        });
      }
    }

    [catSel, anioSel, mesSel, ocultarChk, agruparChk].forEach((el) => el.addEventListener("change", actualizar));
    busquedaInput.addEventListener("input", actualizar);
    actualizar();
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
