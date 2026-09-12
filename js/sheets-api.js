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
  // valueInputOption "RAW" evita que Sheets reinterprete el texto (p. ej.
  // "2026-08" como fecha) — usalo cuando el original en Python también usa
  // RAW en vez de USER_ENTERED.
  async function updateRange(range, values, valueInputOption = "USER_ENTERED") {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`;
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

  // Escribe varias celdas/rangos sueltos de una sola vez (p. ej. varias
  // filas no contiguas de una columna) — 'updates' es [{range, values}].
  async function batchUpdateRanges(updates, valueInputOption = "USER_ENTERED") {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values:batchUpdate`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption, data: updates }),
    });
    if (!res.ok) {
      const texto = await res.text();
      throw new Error(`Error ${res.status} escribiendo en el Sheet: ${texto}`);
    }
    return res.json();
  }

  // Agrega filas al final de la tabla que ya tiene datos dentro de 'range'
  // (equivalente a ws.append_rows() de gspread) — Sheets encuentra sola la
  // primera fila vacía dentro del rango dado y agrega ahí.
  async function appendRows(range, values) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    });
    if (!res.ok) {
      const texto = await res.text();
      throw new Error(`Error ${res.status} agregando filas al Sheet: ${texto}`);
    }
    return res.json();
  }

  // Vacía un rango (p. ej. una fila puntual "'Otros Ingresos'!A12:E12") —
  // equivalente a ws.batch_clear() de gspread, usado para "eliminar" una
  // fila puntual sin correr el resto de filas de lugar.
  async function clearRange(range) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(range)}:clear`;
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token()}` } });
    if (!res.ok) {
      const texto = await res.text();
      throw new Error(`Error ${res.status} borrando en el Sheet: ${texto}`);
    }
    return res.json();
  }

  // Vacía varios rangos sueltos de una sola llamada (p. ej. todas las filas
  // que matchean un período al borrar un extracto de tarjeta completo) —
  // equivalente a ws.batch_clear() de gspread con varios rangos a la vez.
  async function batchClearRanges(ranges) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values:batchClear`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ranges }),
    });
    if (!res.ok) {
      const texto = await res.text();
      throw new Error(`Error ${res.status} borrando en el Sheet: ${texto}`);
    }
    return res.json();
  }

  return { batchGet, updateRange, batchUpdateRanges, appendRows, clearRange, batchClearRanges };
})();
