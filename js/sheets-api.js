// Wrapper delgado sobre la API REST de Google Sheets v4 — llamada directa
// desde el navegador con el token de la sesión de Auth, sin cuenta de
// servicio ni backend intermedio. Requiere que quien abre la página tenga
// acceso de lectura al Sheet (es su propio Sheet, así que lo tiene).
const SheetsApi = (() => {
  async function batchGet(nombresRango) {
    const token = Auth.getToken();
    if (!token) throw new Error("No hay sesión activa — iniciá sesión primero.");
    const params = new URLSearchParams();
    nombresRango.forEach((r) => params.append("ranges", RANGOS[r] || r));
    params.append("valueRenderOption", "UNFORMATTED_VALUE");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values:batchGet?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const texto = await res.text();
      throw new Error(`Error ${res.status} leyendo el Sheet: ${texto}`);
    }
    const data = await res.json();
    const porNombre = {};
    (data.valueRanges || []).forEach((vr, i) => {
      porNombre[nombresRango[i]] = vr.values || [];
    });
    return porNombre;
  }

  return { batchGet };
})();
