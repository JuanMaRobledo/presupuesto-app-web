// Copia de seguridad del Sheet completo -- botón en la barra lateral,
// disponible en cualquier página. Lee TODAS las hojas del spreadsheet tal
// como están hoy (valores formateados, como se ven en pantalla) y arma un
// .xlsx con SheetJS del lado del navegador, sin backend ni credenciales
// nuevas -- el scope "spreadsheets" que ya pide el login alcanza para leer
// todo el Sheet, no solo los rangos con nombre que usa cada página.
const Backup = (() => {
  // Los nombres de hoja de Excel no admiten : \ / ? * [ ] y tienen un
  // máximo de 31 caracteres -- los títulos reales del Sheet no usan esos
  // caracteres, pero por si acaso se sanean igual antes de armar el libro.
  function nombreHojaExcel(titulo, usados) {
    let nombre = String(titulo).replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
    let final = nombre;
    let i = 2;
    while (usados.has(final)) { final = `${nombre.slice(0, 28)}~${i}`; i += 1; }
    usados.add(final);
    return final;
  }

  async function descargarExcel(onEstado) {
    onEstado?.("Listando las hojas del Sheet…");
    const titulos = await SheetsApi.listarHojas();
    onEstado?.(`Descargando ${titulos.length} hoja(s)…`);
    const porTitulo = await SheetsApi.batchGetHojasCompletas(titulos);

    onEstado?.("Armando el archivo .xlsx…");
    const wb = XLSX.utils.book_new();
    const usados = new Set();
    for (const titulo of titulos) {
      const filas = porTitulo[titulo] || [];
      const ws = XLSX.utils.aoa_to_sheet(filas.length ? filas : [[""]]);
      XLSX.utils.book_append_sheet(wb, ws, nombreHojaExcel(titulo, usados));
    }

    const hoy = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `presupuesto-backup-${hoy}.xlsx`);
  }

  function render(container) {
    container.innerHTML = `
      <button id="btn-backup" title="Descarga una copia de seguridad de todo el Sheet en un archivo Excel">
        💾 Copia de seguridad
      </button>
      <p id="backup-estado" class="caption" style="margin:4px 0 0;"></p>
    `;
    const btn = container.querySelector("#btn-backup");
    const estado = container.querySelector("#backup-estado");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const textoOriginal = btn.textContent;
      try {
        await descargarExcel((msg) => { estado.textContent = msg; });
        estado.textContent = "Listo — revisá las descargas del navegador.";
      } catch (err) {
        estado.textContent = `Error: ${err.message}`;
        console.error(err);
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    });
  }

  return { render, descargarExcel };
})();
