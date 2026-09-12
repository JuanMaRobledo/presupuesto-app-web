// Puerto (solo lectura) de render_facturacion_electronica()
// (app_presupuesto.py): registro año a año de facturas/notas electrónicas
// (DIAN), sin conciliación contra Egresos.
//
// TODAVÍA NO portado: el formulario "Agregar una factura electrónica
// manualmente" al pie (escritura).

const PaginaFacturacion = (() => {
  const COLS = ["Fecha", "NitEmisor", "Emisor", "NumeroDocumento", "TipoDocumento", "Valor", "RemitenteCorreo", "Notas"];

  async function render(container) {
    container.innerHTML = `
      <h1>🧾 Facturación Electrónica</h1>
      <p class="caption">Registro de facturas y notas electrónicas (DIAN) recibidas por correo, año a año —
      no se concilia contra Egresos, es solo el archivo de los documentos.</p>
      <div id="fe-contenido">Cargando datos del Sheet…</div>
    `;
    const contenido = container.querySelector("#fe-contenido");
    try {
      const raw = await SheetsApi.batchGet(["facturacion_electronica"]);
      const filasOriginal = filasAObjetos(raw.facturacion_electronica, COLS);
      if (!filasOriginal.length) {
        contenido.innerHTML = "<p>Todavía no hay facturas electrónicas cargadas.</p>";
        return;
      }

      const filas = filasOriginal.map((f) => {
        const [anio, mes] = extraerAnioMes(f.Fecha);
        const m = String(f.Notas || "").match(/thread (\w+)\)/);
        const correo = m ? `https://mail.google.com/mail/u/0/#all/${m[1]}` : null;
        return { ...f, _anio: anio, _mes: mes, _correo: correo };
      });
      const conValor = filas.filter((f) => typeof f.Valor === "number" && f.Valor > 0);

      const porAnio = {};
      for (const f of conValor) {
        porAnio[f._anio] = porAnio[f._anio] || { facturas: 0, total: 0 };
        porAnio[f._anio].facturas += 1;
        porAnio[f._anio].total += f.Valor;
      }
      const aniosResumen = Object.keys(porAnio).sort((a, b) => b - a);

      contenido.innerHTML = `
        <div class="metric-row">
          ${metric("Facturas cargadas", filas.length.toLocaleString("en-US"))}
          ${metric("Con valor identificado", conValor.length.toLocaleString("en-US"))}
        </div>

        <p class="caption">Resumen por año (solo facturas con valor identificado):</p>
        <table class="tabla">
          <thead><tr><th>Año</th><th>Facturas</th><th>Total</th></tr></thead>
          <tbody>${aniosResumen.map((a) => `<tr><td>${a}</td><td>${porAnio[a].facturas}</td>
            <td>${fmtMoneda(porAnio[a].total)}</td></tr>`).join("")}</tbody>
        </table>

        <input type="text" id="fe_busqueda" placeholder="🔍 Buscar por emisor" class="input-texto" />
        <div class="row">
          <select id="fe_anio"></select>
          <select id="fe_mes"></select>
        </div>
        <p class="caption" id="fe_resumen"></p>
        <div class="tabla-scroll"><table class="tabla" id="fe_tabla"></table></div>
      `;

      const anioSel = contenido.querySelector("#fe_anio");
      const mesSel = contenido.querySelector("#fe_mes");
      const busquedaInput = contenido.querySelector("#fe_busqueda");
      const anios = [...new Set(filas.map((f) => f._anio).filter(Boolean))].sort((a, b) => b - a);
      anioSel.add(new Option("(todos)", "(todos)"));
      anios.forEach((a) => anioSel.add(new Option(a, a)));
      mesSel.add(new Option("(todos)", "(todos)"));
      for (let m = 1; m <= 12; m++) mesSel.add(new Option(`${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}`, m));

      function actualizar() {
        let f = filas;
        const busqueda = busquedaInput.value.trim().toLowerCase();
        if (busqueda) f = f.filter((x) => String(x.Emisor || "").toLowerCase().includes(busqueda));
        if (anioSel.value !== "(todos)") f = f.filter((x) => x._anio === Number(anioSel.value));
        if (mesSel.value !== "(todos)") f = f.filter((x) => x._mes === Number(mesSel.value));

        contenido.querySelector("#fe_resumen").textContent =
          `${f.length.toLocaleString("en-US")} de ${filas.length.toLocaleString("en-US")} facturas — Valor y `
          + "Fecha vienen del XML adjunto a cada correo, no del texto del mensaje.";

        const ordenadas = [...f].sort((a, b) => (parseFechaISO(b.Fecha) || "").localeCompare(parseFechaISO(a.Fecha) || ""));
        contenido.querySelector("#fe_tabla").innerHTML = `
          <thead><tr><th>Fecha</th><th>Emisor</th><th>NIT Emisor</th><th>Número Documento</th>
            <th>Tipo Documento</th><th>Valor</th><th>Correo</th></tr></thead>
          <tbody>${ordenadas.map((x) => `<tr>
            <td>${x.Fecha ?? ""}</td><td>${x.Emisor ?? ""}</td><td>${x.NitEmisor ?? ""}</td>
            <td>${x.NumeroDocumento ?? ""}</td><td>${x.TipoDocumento ?? ""}</td>
            <td>${typeof x.Valor === "number" && x.Valor > 0 ? fmtMoneda(x.Valor) : ""}</td>
            <td>${x._correo ? `<a href="${x._correo}" target="_blank" rel="noopener">Abrir ↗</a>` : ""}</td>
          </tr>`).join("")}</tbody>
        `;
      }

      [anioSel, mesSel].forEach((el) => el.addEventListener("change", actualizar));
      busquedaInput.addEventListener("input", actualizar);
      actualizar();
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
