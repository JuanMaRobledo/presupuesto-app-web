// Puerto de render_ingresos() + render_ingresos_colillas() +
// render_ingresos_otros() (app_presupuesto.py): dos sub-tabs, ambos con
// escritura — Colillas de Pago (agregar/eliminar una quincena, con tabla
// editable de devengos/descuentos) y Otros Ingresos (agregar/eliminar).

const PaginaIngresos = (() => {
  const charts = {};

  async function cargarDatos() {
    const raw = await SheetsApi.batchGet(["colillas_resumen", "colillas_devengos", "colillas_descuentos", "otros_ingresos"]);
    return {
      colillas: filasAObjetos(raw.colillas_resumen, ["FechaPago", "Periodo", "DevengosTotales", "DescuentosTotales"], ["FechaPago"]),
      devengos: filasAObjetos(raw.colillas_devengos, ["Quincena", "Concepto", "Categoria", "Valor"]),
      descuentos: filasAObjetos(raw.colillas_descuentos, ["Quincena", "Concepto", "Categoria", "Valor"]),
      otrosIngresos: filasAObjetos(raw.otros_ingresos, ["Fecha", "Concepto", "Categoria", "Valor", "Notas"], ["Fecha"]),
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
        if (activo === "colillas") renderColillas(panel, datos, renderTab);
        else renderOtrosIngresos(panel, datos, renderTab);
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
  function renderColillas(panel, datos, recargar) {
    panel.innerHTML = "";
    renderFormAgregarColilla(panel, datos, recargar);
    renderFormEliminarColilla(panel, datos, recargar);

    if (!datos.colillas.length) {
      panel.insertAdjacentHTML("beforeend", "<p>Todavía no hay colillas cargadas.</p>");
      return;
    }
    const colillasDiv = document.createElement("div");
    panel.appendChild(colillasDiv);
    renderResumenColillas(colillasDiv, datos);
  }

  // ---------------------------------------------------------------------
  // ➕ Agregar una quincena manualmente / 🗑️ Eliminar una quincena
  // ---------------------------------------------------------------------
  const MESES_3LETRAS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const DEVENGOS_CATEGORIAS_MANUAL = [
    "Salario Base", "Recargos y Horas Extra", "Formación Continua", "Prima de Servicios",
    "Vacaciones y Licencias", "Bonificación", "Cesantías (no presupuestar)", "Cesantías (Ingreso)",
  ];
  const DESCUENTOS_CATEGORIAS_MANUAL = [
    "Ahorro", "Fondo de Empleados", "Seguros", "Deuda (Préstamo Fondo Empleados)",
    "Deuda (Leasing Habitacional)", "Impuestos", "Aportes de Ley", "Transporte", "Cesantías (no presupuestar)",
  ];
  // Puerto de BLOCKS (sheets_backend.py) para clear_rows_by_key() a mano.
  const SHEET_CP = "Colillas de Pago";
  const COLILLAS_RESUMEN_PRIMERA_FILA = 150;
  const COLILLAS_DEVENGOS_PRIMERA_FILA = 326;
  const COLILLAS_DESCUENTOS_PRIMERA_FILA = 545;

  function colLetra(n) {
    return String.fromCharCode("A".charCodeAt(0) + n - 1);
  }

  // Puerto de clear_rows_by_key() (sheets_backend.py).
  async function clearRowsByKey(rangoNombre, primeraFila, cols, keyCol, keyValue) {
    const raw = await SheetsApi.batchGet([rangoNombre]);
    const filas = raw[rangoNombre] || [];
    const filasABorrar = [];
    filas.forEach((r, i) => {
      const val = r && r.length >= keyCol ? r[keyCol - 1] : "";
      if (val === keyValue) filasABorrar.push(primeraFila + i);
    });
    if (!filasABorrar.length) return 0;
    const colFin = colLetra(cols);
    const ranges = filasABorrar.map((fila) => `'${SHEET_CP}'!A${fila}:${colFin}${fila}`);
    await SheetsApi.batchClearRanges(ranges);
    return filasABorrar.length;
  }

  function filaEditable(prefijo, categorias, categoriaDefault) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" class="input-texto ${prefijo}-concepto" placeholder="Concepto"></td>
      <td><select class="${prefijo}-categoria">${categorias.map((c) => `<option value="${c}" ${c === categoriaDefault ? "selected" : ""}>${c}</option>`).join("")}</select></td>
      <td><input type="number" step="any" class="${prefijo}-valor" value="0" style="width:100%;"></td>
      <td><button type="button" class="btn-quitar-fila">✕</button></td>
    `;
    tr.querySelector(".btn-quitar-fila").addEventListener("click", () => tr.remove());
    return tr;
  }

  function leerFilasEditable(tbody, prefijo) {
    return [...tbody.querySelectorAll("tr")].map((tr) => ({
      concepto: tr.querySelector(`.${prefijo}-concepto`).value.trim(),
      categoria: tr.querySelector(`.${prefijo}-categoria`).value,
      valor: Number(tr.querySelector(`.${prefijo}-valor`).value) || 0,
    })).filter((r) => r.concepto && r.valor > 0);
  }

  function renderFormAgregarColilla(panel, datos, recargar) {
    const div = document.createElement("div");
    const hoy = new Date();
    const anios = [];
    for (let a = 2023; a <= 2032; a++) anios.push(a);
    const meses = Array.from({ length: 12 }, (_, i) => i + 1);
    div.innerHTML = `
      <details>
        <summary>➕ Agregar una quincena manualmente</summary>
        <p class="caption">Alternativa a subir el PDF: escribí la fecha de pago, la quincena, y cada devengo y
        descuento con su categoría y valor — agregá o quitá filas con los botones de la tabla.</p>
        <form id="form_agregar_colilla">
          <div class="row">
            <div><label>Año</label><br><select id="col_anio">${anios.map((a) => `<option value="${a}" ${a === hoy.getFullYear() ? "selected" : ""}>${a}</option>`).join("")}</select></div>
            <div><label>Mes</label><br><select id="col_mes">${meses.map((m) => `<option value="${m}" ${m === hoy.getMonth() + 1 ? "selected" : ""}>${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}</option>`).join("")}</select></div>
            <div><label>Quincena</label><br><select id="col_quincena"><option value="1a">1a</option><option value="2a">2a</option></select></div>
          </div>
          <div class="campo"><label>Fecha de pago</label><br><input type="date" id="col_fechapago" required></div>
          <p class="caption">Periodo: <strong id="col_periodo_preview"></strong></p>

          <p><strong>Devengos</strong></p>
          <table class="tabla">
            <thead><tr><th>Concepto</th><th>Categoría</th><th>Valor</th><th></th></tr></thead>
            <tbody id="col_dev_tbody"></tbody>
          </table>
          <button type="button" id="col_dev_agregar">+ Agregar fila</button>

          <p><strong>Descuentos</strong></p>
          <table class="tabla">
            <thead><tr><th>Concepto</th><th>Categoría</th><th>Valor</th><th></th></tr></thead>
            <tbody id="col_desc_tbody"></tbody>
          </table>
          <button type="button" id="col_desc_agregar">+ Agregar fila</button>

          <br><br>
          <button type="submit" id="col_guardar">💾 Guardar quincena</button>
        </form>
        <div class="aviso" id="col_msg" hidden></div>
      </details>
    `;
    panel.appendChild(div);

    const anioSel = div.querySelector("#col_anio");
    const mesSel = div.querySelector("#col_mes");
    const quincenaSel = div.querySelector("#col_quincena");
    const periodoPreview = div.querySelector("#col_periodo_preview");
    function actualizarPeriodoPreview() {
      const mesNum = Number(mesSel.value);
      periodoPreview.textContent = `${quincenaSel.value} quincena ${MESES_3LETRAS[mesNum - 1]}-${anioSel.value}`;
    }
    [anioSel, mesSel, quincenaSel].forEach((el) => el.addEventListener("change", actualizarPeriodoPreview));
    actualizarPeriodoPreview();
    div.querySelector("#col_fechapago").valueAsDate = hoy;

    const devTbody = div.querySelector("#col_dev_tbody");
    const descTbody = div.querySelector("#col_desc_tbody");
    devTbody.appendChild(filaEditable("dev", DEVENGOS_CATEGORIAS_MANUAL, "Salario Base"));
    descTbody.appendChild(filaEditable("desc", DESCUENTOS_CATEGORIAS_MANUAL, "Ahorro"));
    div.querySelector("#col_dev_agregar").addEventListener("click", () => devTbody.appendChild(filaEditable("dev", DEVENGOS_CATEGORIAS_MANUAL, "Salario Base")));
    div.querySelector("#col_desc_agregar").addEventListener("click", () => descTbody.appendChild(filaEditable("desc", DESCUENTOS_CATEGORIAS_MANUAL, "Ahorro")));

    div.querySelector("#form_agregar_colilla").addEventListener("submit", (ev) => onGuardarColilla(ev, div, datos, recargar));
  }

  async function onGuardarColilla(ev, div, datos, recargar) {
    ev.preventDefault();
    const msg = div.querySelector("#col_msg");
    const btn = div.querySelector("#col_guardar");
    const anio = Number(div.querySelector("#col_anio").value);
    const mes = Number(div.querySelector("#col_mes").value);
    const quincena = div.querySelector("#col_quincena").value;
    const periodo = `${quincena} quincena ${MESES_3LETRAS[mes - 1]}-${anio}`;
    const fechaPago = div.querySelector("#col_fechapago").value;

    const devengosValidos = leerFilasEditable(div.querySelector("#col_dev_tbody"), "dev");
    const descuentosValidos = leerFilasEditable(div.querySelector("#col_desc_tbody"), "desc");

    if (datos.colillas.some((f) => f.Periodo === periodo)) {
      mostrarMsg(msg, `Ya existe una quincena para '${periodo}' — editala directo en el Sheet si
        necesitás corregirla, no puedo agregar otra para el mismo período.`, true);
      return;
    }
    if (!devengosValidos.length && !descuentosValidos.length) {
      mostrarMsg(msg, "Agregá al menos un devengo o un descuento con concepto y valor.", true);
      return;
    }

    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      const totalDevengos = devengosValidos.reduce((s, r) => s + r.valor, 0);
      const totalDescuentos = descuentosValidos.reduce((s, r) => s + r.valor, 0);
      await SheetsApi.appendRows(RANGOS.colillas_resumen, [[fechaPago, periodo, totalDevengos, totalDescuentos]]);
      if (devengosValidos.length) {
        await SheetsApi.appendRows(RANGOS.colillas_devengos, devengosValidos.map((r) => [periodo, r.concepto, r.categoria, r.valor]));
      }
      if (descuentosValidos.length) {
        await SheetsApi.appendRows(RANGOS.colillas_descuentos, descuentosValidos.map((r) => [periodo, r.concepto, r.categoria, r.valor]));
      }
      mostrarMsg(msg, `Quincena '${periodo}' agregada.`, false);
      await recargar();
    } catch (err) {
      mostrarMsg(msg, `No pude guardar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "💾 Guardar quincena";
    }
  }

  function renderFormEliminarColilla(panel, datos, recargar) {
    const div = document.createElement("div");
    if (!datos.colillas.length) {
      div.innerHTML = `<details><summary>🗑️ Eliminar una quincena</summary><p>Todavía no hay quincenas cargadas.</p></details>`;
      panel.appendChild(div);
      return;
    }
    const periodos = datos.colillas.map((f) => f.Periodo);
    div.innerHTML = `
      <details>
        <summary>🗑️ Eliminar una quincena</summary>
        <div class="campo"><label>Quincena a eliminar</label><br>
          <select id="del_col_periodo">${periodos.map((p) => `<option value="${p}">${p}</option>`).join("")}</select></div>
        <p class="caption" id="del_col_caption"></p>
        <label class="checkbox-row"><input type="checkbox" id="del_col_confirmar">
          Confirmo que quiero borrar esta quincena — no se puede deshacer</label>
        <button type="button" id="del_col_btn" disabled>🗑️ Eliminar quincena</button>
        <div class="aviso" id="del_col_msg" hidden></div>
      </details>
    `;
    panel.appendChild(div);

    const periodoSel = div.querySelector("#del_col_periodo");
    const caption = div.querySelector("#del_col_caption");
    const confirmar = div.querySelector("#del_col_confirmar");
    const btn = div.querySelector("#del_col_btn");

    function actualizarCaption() {
      const p = periodoSel.value;
      const fila = datos.colillas.find((f) => f.Periodo === p);
      const nDev = datos.devengos.filter((d) => d.Quincena === p).length;
      const nDesc = datos.descuentos.filter((d) => d.Quincena === p).length;
      caption.textContent = `Devengos: ${fmtMoneda(toNumber(fila && fila.DevengosTotales))} (${nDev} línea(s)) — `
        + `Descuentos: ${fmtMoneda(toNumber(fila && fila.DescuentosTotales))} (${nDesc} línea(s))`;
      confirmar.checked = false;
      btn.disabled = true;
    }
    periodoSel.addEventListener("change", actualizarCaption);
    confirmar.addEventListener("change", () => { btn.disabled = !confirmar.checked; });
    btn.addEventListener("click", () => onEliminarColilla(div, periodoSel.value, recargar));
    actualizarCaption();
  }

  async function onEliminarColilla(div, periodo, recargar) {
    const msg = div.querySelector("#del_col_msg");
    const btn = div.querySelector("#del_col_btn");
    btn.disabled = true;
    btn.textContent = "Borrando…";
    try {
      const resumenBorradas = await clearRowsByKey("colillas_resumen", COLILLAS_RESUMEN_PRIMERA_FILA, 7, 2, periodo);
      const devengosBorradas = await clearRowsByKey("colillas_devengos", COLILLAS_DEVENGOS_PRIMERA_FILA, 4, 1, periodo);
      const descuentosBorradas = await clearRowsByKey("colillas_descuentos", COLILLAS_DESCUENTOS_PRIMERA_FILA, 4, 1, periodo);
      mostrarMsg(msg, `'${periodo}' eliminada — ${resumenBorradas} fila(s) de resumen, ${devengosBorradas} de
        devengos, ${descuentosBorradas} de descuentos.`, false);
      await recargar();
    } catch (err) {
      mostrarMsg(msg, `No pude borrar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "🗑️ Eliminar quincena";
    }
  }

  function renderResumenColillas(panel, datos) {
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
          { label: "Devengos Totales", data: ultimas24.map((f) => toNumber(f.DevengosTotales)), backgroundColor: "#1d4ed8" },
          { label: "Descuentos Totales", data: ultimas24.map((f) => toNumber(f.DescuentosTotales)), backgroundColor: "#dc2626" },
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
  const CATEGORIAS_OTROS_INGRESOS = [
    "Reembolso (esposa/otros)", "Honorarios / Consultoría", "Rendimientos Financieros", "Cesantías",
    "Regalo", "Venta", "Ajustes y Reversiones (no presupuestar)", "Otro",
  ];

  function renderOtrosIngresos(panel, datos, recargar) {
    panel.innerHTML = `
      <h4>Otros Ingresos</h4>
      <details>
        <summary>➕ Agregar un ingreso manualmente</summary>
        <form id="form_ingreso">
          <div class="row">
            <div><label>Fecha</label><br><input type="date" id="ing_fecha" required></div>
            <div><label>Categoría</label><br>
              <select id="ing_cat">${CATEGORIAS_OTROS_INGRESOS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select>
            </div>
          </div>
          <div class="campo"><label>Concepto</label><br><input type="text" id="ing_concepto" class="input-texto" required></div>
          <div class="campo"><label>Valor</label><br><input type="number" id="ing_valor" min="0" step="any" required></div>
          <div class="campo"><label>Notas (opcional)</label><br><input type="text" id="ing_notas" class="input-texto"></div>
          <button type="submit" id="ing_guardar">💾 Guardar ingreso</button>
        </form>
        <div class="aviso" id="ing_msg" hidden></div>
      </details>
      <div id="oi-dinamico">${datos.otrosIngresos.length ? "" : "<p>Todavía no hay otros ingresos cargados.</p>"}</div>
    `;

    panel.querySelector("#ing_fecha").valueAsDate = new Date();
    panel.querySelector("#form_ingreso").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = panel.querySelector("#ing_msg");
      const btn = panel.querySelector("#ing_guardar");
      const g = (id) => panel.querySelector(id).value;
      const concepto = g("#ing_concepto").trim();
      const valor = Number(g("#ing_valor")) || 0;
      if (!concepto) { mostrarMsg(msg, "Escribí un concepto.", true); return; }
      if (valor <= 0) { mostrarMsg(msg, "El valor tiene que ser mayor que cero.", true); return; }
      btn.disabled = true;
      btn.textContent = "Guardando…";
      try {
        await SheetsApi.appendRows(RANGOS.otros_ingresos, [[g("#ing_fecha"), concepto, g("#ing_cat"), valor, g("#ing_notas").trim()]]);
        mostrarMsg(msg, `Ingreso de ${fmtMoneda(valor)} agregado.`, false);
        await recargar();
      } catch (err) {
        mostrarMsg(msg, `No pude guardar: ${err.message}`, true);
        console.error(err);
        btn.disabled = false;
        btn.textContent = "💾 Guardar ingreso";
      }
    });

    if (!datos.otrosIngresos.length) return;

    const filas = datos.otrosIngresos.map((f) => {
      const [anio, mes] = extraerAnioMes(f.Fecha);
      return { ...f, _anio: anio, _mes: mes, _fechaISO: parseFechaISO(f.Fecha), _presupuestar: !esNoPresupuestar(f.Categoria) };
    });
    const dinamico = panel.querySelector("#oi-dinamico");
    dinamico.innerHTML = `
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

      <details>
        <summary>🗑️ Eliminar un ingreso</summary>
        <p class="caption">Para limpiar un duplicado puntual — elegí la fila exacta de la lista filtrada de
        arriba y borrala. Si hay dos filas idénticas, esto borra una sola por vez.</p>
        <select id="oi_del_select" class="input-texto"></select>
        <label class="checkbox-row"><input type="checkbox" id="oi_del_confirmar">
          Confirmo que quiero borrar esta fila — no se puede deshacer</label>
        <button type="button" id="oi_del_btn" disabled>🗑️ Eliminar ingreso</button>
        <div class="aviso" id="oi_del_msg" hidden></div>
      </details>

      <h5>Ingresos por categoría (según el filtro de arriba)</h5>
      <canvas id="chart_oi_categoria" height="140"></canvas>
    `;

    const catSel = dinamico.querySelector("#oi_cat");
    const anioSel = dinamico.querySelector("#oi_anio");
    const mesSel = dinamico.querySelector("#oi_mes");
    const ocultarChk = dinamico.querySelector("#oi_ocultar");
    const agruparChk = dinamico.querySelector("#oi_agrupar");
    const busquedaInput = dinamico.querySelector("#oi_busqueda");
    const delSelect = dinamico.querySelector("#oi_del_select");
    const delConfirmar = dinamico.querySelector("#oi_del_confirmar");
    const delBtn = dinamico.querySelector("#oi_del_btn");

    const categorias = [...new Set(filas.map((f) => f.Categoria).filter(Boolean))].sort();
    catSel.add(new Option("(todas)", "(todas)"));
    categorias.forEach((c) => catSel.add(new Option(c, c)));
    const anios = [...new Set(filas.map((f) => f._anio).filter(Boolean))].sort((a, b) => b - a);
    anioSel.add(new Option("(todos)", "(todos)"));
    anios.forEach((a) => anioSel.add(new Option(a, a)));
    mesSel.add(new Option("(todos)", "(todos)"));
    for (let m = 1; m <= 12; m++) mesSel.add(new Option(`${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}`, m));

    let filtradasActuales = [];

    function actualizar() {
      let f = filas;
      if (ocultarChk.checked) f = f.filter((x) => x._presupuestar);
      const busqueda = busquedaInput.value.trim().toLowerCase();
      if (busqueda) f = f.filter((x) => String(x.Concepto || "").toLowerCase().includes(busqueda));
      if (catSel.value !== "(todas)") f = f.filter((x) => x.Categoria === catSel.value);
      if (anioSel.value !== "(todos)") f = f.filter((x) => x._anio === Number(anioSel.value));
      if (mesSel.value !== "(todos)") f = f.filter((x) => x._mes === Number(mesSel.value));
      filtradasActuales = [...f].sort((a, b) => (b._fechaISO || "").localeCompare(a._fechaISO || ""));

      const suma = f.reduce((s, x) => s + toNumber(x.Valor), 0);
      dinamico.querySelector("#oi_resumen").textContent =
        `${f.length.toLocaleString("en-US")} de ${filas.length.toLocaleString("en-US")} movimientos — suma: ${fmtMoneda(suma)}`;

      const porCat = {};
      for (const x of f) porCat[x.Categoria] = (porCat[x.Categoria] || 0) + toNumber(x.Valor);
      const catOrdenadas = Object.entries(porCat).sort((a, b) => b[1] - a[1]);
      dinamico.querySelector("#oi_totales_cat").innerHTML = f.length ? `
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

      dinamico.querySelector("#oi_tabla").innerHTML = `
        <thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Valor</th><th>Notas</th><th>Presupuestar</th></tr></thead>
        <tbody>${mostrar.map((x) => `<tr><td>${x.Fecha ?? ""}</td><td>${x.Concepto ?? ""}</td>
          <td>${x.Categoria ?? ""}</td><td>${fmtMoneda(toNumber(x.Valor))}</td><td>${x.Notas ?? ""}</td>
          <td>${x._presupuestar ? "Sí" : "No"}</td></tr>`).join("")}</tbody>
      `;

      delSelect.innerHTML = "";
      filtradasActuales.forEach((x, i) => {
        delSelect.add(new Option(`${i}: ${x.Fecha} — ${x.Concepto} — ${fmtMoneda(toNumber(x.Valor))}`, i));
      });
      delConfirmar.checked = false;
      delBtn.disabled = true;

      if (charts.oiCategoria) charts.oiCategoria.destroy();
      const canvas = dinamico.querySelector("#chart_oi_categoria");
      if (f.length && catOrdenadas.length) {
        charts.oiCategoria = new Chart(canvas.getContext("2d"), {
          type: "bar",
          data: { labels: catOrdenadas.map((c) => c[0]), datasets: [{ label: "Valor", data: catOrdenadas.map((c) => c[1]), backgroundColor: "#1d4ed8" }] },
          options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } },
            scales: { x: { ticks: { callback: (v) => fmtMoneda(v) } } } },
        });
      }
    }

    delConfirmar.addEventListener("change", () => { delBtn.disabled = !delConfirmar.checked; });
    delBtn.addEventListener("click", async () => {
      const msg = dinamico.querySelector("#oi_del_msg");
      const sel = filtradasActuales[Number(delSelect.value)];
      if (!sel) return;
      delBtn.disabled = true;
      delBtn.textContent = "Borrando…";
      try {
        const borrado = await eliminarOtroIngreso(sel.Fecha, sel.Concepto, sel.Categoria, toNumber(sel.Valor));
        mostrarMsg(msg, borrado ? "Ingreso eliminado." : "No encontré esa fila exacta en el Sheet — puede que ya se haya borrado.", !borrado);
        await recargar();
      } catch (err) {
        mostrarMsg(msg, `No pude borrar: ${err.message}`, true);
        console.error(err);
        delBtn.disabled = false;
        delBtn.textContent = "🗑️ Eliminar ingreso";
      }
    });

    [catSel, anioSel, mesSel, ocultarChk, agruparChk].forEach((el) => el.addEventListener("change", actualizar));
    busquedaInput.addEventListener("input", actualizar);
    actualizar();
  }

  // Puerto de eliminar_otro_ingreso() (sheets_backend.py) — borra la
  // primera fila cruda que calce exacto en Fecha (ya convertida)/Concepto/
  // Categoría/Valor (±0.5); si hay duplicados, borra solo la primera.
  async function eliminarOtroIngreso(fechaTexto, concepto, categoria, valor) {
    const raw = await SheetsApi.batchGet(["otros_ingresos"]);
    const filasRaw = raw.otros_ingresos || [];
    for (let i = 0; i < filasRaw.length; i++) {
      const r = filasRaw[i];
      if (!r || !r[0]) continue;
      const fechaCelda = serialToText(r[0]);
      const conceptoCelda = r[1] ?? "";
      const categoriaCelda = r[2] ?? "";
      const valorCelda = toNumber(r[3]);
      if (fechaCelda === fechaTexto && conceptoCelda === concepto && categoriaCelda === categoria
          && Math.abs(valorCelda - valor) < 0.5) {
        const filaSheet = 4 + i; // BLOCKS.otros_ingresos.first = 4
        await SheetsApi.clearRange(`'Otros Ingresos'!A${filaSheet}:E${filaSheet}`);
        return true;
      }
    }
    return false;
  }

  function mostrarMsg(el, texto, esError) {
    el.hidden = false;
    el.textContent = texto;
    el.style.background = esError ? "var(--error-bg)" : "var(--success-bg)";
    el.style.color = esError ? "var(--error-text)" : "var(--success-text)";
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
