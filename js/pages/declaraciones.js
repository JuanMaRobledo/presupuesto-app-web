// Puerto de render_declaraciones_renta() (app_presupuesto.py), YA CON
// ESCRITURA: subir el PDF directo a Google Drive (con la sesión de quien
// usa la app — el archivo queda de su propiedad, la app nunca lo aloja) y
// guardar el registro del año en el Sheet. Guardar el mismo Año reemplaza
// esa fila (mismo comportamiento que guardar_declaracion_renta() en
// sheets_backend.py).

const PaginaDeclaraciones = (() => {
  const COLS = [
    "Anio", "FechaPresentacion", "PatrimonioLiquido", "IngresosBrutos", "RentaLiquidaGravable",
    "ImpuestoACargo", "RetencionesAnticipos", "Saldo", "LinkPDF", "Notas",
  ];
  let chart = null;

  async function cargarDatos() {
    const raw = await SheetsApi.batchGet(["declaraciones_renta"]);
    return filasAObjetos(raw.declaraciones_renta, COLS, ["FechaPresentacion"]);
  }

  async function render(container) {
    container.innerHTML = `
      <h1>📑 Declaraciones de Renta</h1>
      <p class="caption">Un registro por año — el desglose de la declaración y el PDF, subido directo a tu
      Google Drive.</p>
      <div id="dr-contenido">Cargando datos del Sheet…</div>
    `;
    const contenido = container.querySelector("#dr-contenido");
    await renderContenido(contenido);
  }

  async function renderContenido(contenido) {
    try {
      const filas = await cargarDatos();
      const ordenadas = [...filas].sort((a, b) => Number(b.Anio) - Number(a.Anio));

      contenido.innerHTML = `
        ${filas.length ? `
          <div class="tabla-scroll">
            <table class="tabla">
              <thead><tr><th>Año</th><th>Fecha de Presentación</th><th>Patrimonio Líquido</th>
                <th>Ingresos Brutos</th><th>Renta Líquida Gravable</th><th>Impuesto a Cargo</th>
                <th>Retenciones y Anticipos</th><th>Saldo</th><th>PDF</th><th>Notas</th></tr></thead>
              <tbody>${ordenadas.map((f) => `<tr>
                <td>${f.Anio ?? ""}</td><td>${f.FechaPresentacion ?? ""}</td>
                <td>${fmtMoneda(toNumber(f.PatrimonioLiquido))}</td><td>${fmtMoneda(toNumber(f.IngresosBrutos))}</td>
                <td>${fmtMoneda(toNumber(f.RentaLiquidaGravable))}</td><td>${fmtMoneda(toNumber(f.ImpuestoACargo))}</td>
                <td>${fmtMoneda(toNumber(f.RetencionesAnticipos))}</td><td>${fmtMoneda(toNumber(f.Saldo))}</td>
                <td>${f.LinkPDF ? `<a href="${f.LinkPDF}" target="_blank" rel="noopener">Abrir ↗</a>` : ""}</td>
                <td>${f.Notas ?? ""}</td>
              </tr>`).join("")}</tbody>
            </table>
          </div>
          <canvas id="chart_declaraciones" height="90"></canvas>
        ` : "<p>Todavía no hay declaraciones cargadas. Agregá una abajo.</p>"}

        <div class="aviso" id="dr_msg" hidden></div>

        <h4>➕ Agregar / editar una declaración</h4>
        <form id="form_declaracion">
          <div class="row">
            <div><label>Año</label><br><input type="number" id="dr_anio" min="2000" max="2100" required></div>
            <div><label>Fecha de Presentación</label><br><input type="date" id="dr_fecha" required></div>
          </div>
          <div class="row">
            <div><label>Patrimonio Líquido</label><br><input type="number" id="dr_patrimonio" min="0" step="any"></div>
            <div><label>Ingresos Brutos</label><br><input type="number" id="dr_ingresos" min="0" step="any"></div>
          </div>
          <div class="row">
            <div><label>Renta Líquida Gravable</label><br><input type="number" id="dr_renta" min="0" step="any"></div>
            <div><label>Impuesto a Cargo</label><br><input type="number" id="dr_impuesto" min="0" step="any"></div>
          </div>
          <div class="row">
            <div><label>Retenciones y Anticipos</label><br><input type="number" id="dr_retenciones" min="0" step="any"></div>
            <div><label>Saldo (+ a pagar / - a favor)</label><br><input type="number" id="dr_saldo" step="any"></div>
          </div>
          <div class="campo">
            <label>PDF de la declaración (opcional) — se sube directo a tu Google Drive</label><br>
            <input type="file" id="dr_pdf" accept="application/pdf">
          </div>
          <div class="campo">
            <label>...o pegá un link existente en vez de subir el archivo</label><br>
            <input type="text" id="dr_link_manual" class="input-texto" placeholder="https://drive.google.com/...">
          </div>
          <div class="campo">
            <label>Notas (opcional)</label><br>
            <input type="text" id="dr_notas" class="input-texto">
          </div>
          <button type="submit" id="dr_guardar">💾 Guardar declaración</button>
        </form>
      `;

      if (filas.length) {
        const asc = [...filas].sort((a, b) => Number(a.Anio) - Number(b.Anio));
        if (chart) chart.destroy();
        chart = new Chart(contenido.querySelector("#chart_declaraciones").getContext("2d"), {
          type: "line",
          data: {
            labels: asc.map((f) => f.Anio),
            datasets: [
              { label: "Patrimonio Líquido", data: asc.map((f) => toNumber(f.PatrimonioLiquido)), borderColor: "#1d4ed8", backgroundColor: "#1d4ed8", tension: 0.1 },
              { label: "Impuesto a Cargo", data: asc.map((f) => toNumber(f.ImpuestoACargo)), borderColor: "#dc2626", backgroundColor: "#dc2626", tension: 0.1 },
            ],
          },
          options: { responsive: true, scales: { y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
        });
      }

      contenido.querySelector("#form_declaracion").addEventListener("submit", (ev) => onGuardar(ev, contenido));
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  async function onGuardar(ev, contenido) {
    ev.preventDefault();
    const msg = contenido.querySelector("#dr_msg");
    const btn = contenido.querySelector("#dr_guardar");
    const g = (id) => contenido.querySelector(id).value;

    const anio = parseInt(g("#dr_anio"), 10);
    if (!anio) { mostrarMsg(msg, "Ingresá un año válido.", true); return; }

    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      let link = g("#dr_link_manual").trim();
      const archivo = contenido.querySelector("#dr_pdf").files[0];
      if (archivo) {
        btn.textContent = "Subiendo PDF a Drive…";
        const subido = await DriveApi.uploadFile(archivo, `Declaración de Renta ${anio}.pdf`);
        link = subido.webViewLink || `https://drive.google.com/file/d/${subido.id}/view`;
      }

      btn.textContent = "Guardando en el Sheet…";
      const nuevaFila = [
        anio, g("#dr_fecha"), Number(g("#dr_patrimonio")) || 0, Number(g("#dr_ingresos")) || 0,
        Number(g("#dr_renta")) || 0, Number(g("#dr_impuesto")) || 0, Number(g("#dr_retenciones")) || 0,
        Number(g("#dr_saldo")) || 0, link, g("#dr_notas").trim(),
      ];

      const existentes = await cargarDatos();
      const sinEsteAnio = existentes.filter((f) => String(f.Anio) !== String(anio));
      const todas = [...sinEsteAnio.map((f) => COLS.map((c) => f[c] ?? "")), nuevaFila]
        .sort((a, b) => Number(a[0]) - Number(b[0]));

      await SheetsApi.updateRange(`'Declaraciones de Renta'!A2:J${todas.length + 1}`, todas);

      mostrarMsg(msg, `Declaración ${anio} guardada.`, false);
      await renderContenido(contenido);
    } catch (err) {
      mostrarMsg(msg, `No pude guardar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "💾 Guardar declaración";
    }
  }

  function mostrarMsg(el, texto, esError) {
    el.hidden = false;
    el.textContent = texto;
    el.style.background = esError ? "var(--error-bg)" : "var(--success-bg)";
    el.style.color = esError ? "var(--error-text)" : "var(--success-text)";
  }

  return { render };
})();
