// Wrapper delgado sobre la API REST de Google Sheets v4 — llamada directa
// desde el navegador con el token de la sesión de Auth, sin cuenta de
// servicio ni backend intermedio. Requiere que quien abre la página tenga
// acceso al Sheet (es su propio Sheet, así que lo tiene).
const SheetsApi = (() => {
  function token() {
    const t = Auth.getToken();
    if (!t) throw new Error("No hay sesión activa — iniciá sesión primero.");
    return t;
  }

  async function batchGet(nombresRango) {
    const params = new URLSearchParams();
    nombresRango.forEach((r) => params.append("ranges", RANGOS[r] || r));
    params.append("valueRenderOption", "UNFORMATTED_VALUE");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values:batchGet?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
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

  // Sobrescribe un rango completo (p. ej. "'Declaraciones de Renta'!A2:J12")
  // con 'values' (array de arrays, mismo orden de columnas que el rango).
  // Requiere el scope de escritura completo de Sheets (no el .readonly).
  async function updateRange(range, values) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    });
    if (!res.ok) {
      const texto = await res.text();
      throw new Error(`Error ${res.status} escribiendo en el Sheet: ${texto}`);
    }
    return res.json();
  }

  return { batchGet, updateRange };
})();
