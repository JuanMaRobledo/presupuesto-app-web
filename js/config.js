// Configuración pública del sitio — nada de esto es secreto: el Client ID de
// OAuth y el ID del Sheet son datos públicos por diseño (el acceso real lo
// controla el login de Google de quien abre la página, no estos valores).
//
// Para activar el login, creá un OAuth Client ID (tipo "Web application") en
// el mismo proyecto de Google Cloud que ya usa presupuesto-app, con estos
// "Authorized JavaScript origins":
//   - https://<tu-usuario>.github.io   (o el dominio donde publiques esto)
//   - http://localhost:8000            (para probar en local)
// y pegá el Client ID acá abajo.
const CONFIG = {
  CLIENT_ID: "289024704945-jvmttgv33s0h9aqtvghqg1hrmtsftesu.apps.googleusercontent.com"
  SHEET_ID: "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk",
  // Alcance de solo lectura — esta primera versión no escribe nada al Sheet.
  SCOPES: "https://www.googleapis.com/auth/spreadsheets.readonly",
};

// Rangos con nombre que usa cada página ya portada — mismos rangos que
// BLOCKS/_all_ranges() en sheets_backend.py (Python), para que los números
// salgan idénticos a los de la app de Streamlit.
const RANGOS = {
  colillas_resumen: "'Colillas de Pago'!A150:G294",
  otros_ingresos: "'Otros Ingresos'!A4:E5263",
  deudas: "'Deudas - Resumen'!A5:H10",
  resumen_kpis: "'Resumen'!B5:E18",
};
