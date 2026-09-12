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
  CLIENT_ID: "289024704945-jvmttgv33s0h9aqtvghqg1hrmtsftesu.apps.googleusercontent.com",
  SHEET_ID: "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk",
  // Lectura/escritura del Sheet (Declaraciones de Renta ya escribe) +
  // drive.file: acceso SOLO a los archivos que esta app crea en Drive
  // (el PDF de cada declaración que subís), nunca al resto de tu Drive.
  SCOPES: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
};

// Rangos con nombre que usa cada página ya portada — mismos rangos que
// BLOCKS/_all_ranges() en sheets_backend.py (Python), para que los números
// salgan idénticos a los de la app de Streamlit.
const RANGOS = {
  colillas_resumen: "'Colillas de Pago'!A150:G294",
  colillas_devengos: "'Colillas de Pago'!A326:D531",
  colillas_descuentos: "'Colillas de Pago'!A545:D2010",
  otros_ingresos: "'Otros Ingresos'!A4:E5263",
  efectivo_detalle: "'Egresos - Efectivo'!A15:K1999",
  visa_detalle: "'Egresos - Tarjeta Visa 7497'!A15:K5614",
  mc_detalle: "'Egresos - Mastercard 5922'!A15:K5601",
  aportes_inversion_pesos: "'Inversiones - Pesos'!A79:D1000",
  aportes_inversion_dolares: "'Inversiones - Dólares'!A79:D1000",
  deudas: "'Deudas - Resumen'!A5:H10",
  deuda_tarjeta_usd: "'Deudas - Resumen'!A12:C12",
  posiciones_pesos: "'Inversiones - Pesos'!A5:H45",
  posiciones_dolares: "'Inversiones - Dólares'!A5:H45",
  facturacion_electronica: "'Facturación Electrónica'!A2:H2000",
  declaraciones_renta: "'Declaraciones de Renta'!A2:J1000",
  resumen_categorias: "'Resumen'!B22:E39",
  conciliacion_efectivo: "'Balance Mensual'!A66:D265",
  presupuesto: "'Presupuesto'!A5:E63",
  resumen_kpis: "'Resumen'!B5:E18",
  mc_detalle_usd: "'Egresos - Mastercard 5922'!A5698:K6697",
  deuda_bancolombia: "'Deuda - Bancolombia'!B6:B17",
  deuda_sufi: "'Deuda - Sufi'!B6:B17",
  deuda_scotiabank: "'Deuda - Scotiabank Colpatria'!B6:B17",
  deuda_fondo_empleados: "'Deuda - Fondo de Empleados'!B6:B17",
  categorias_gasto: "'Categorías'!A2:A25",
  visa_resumen: "'Egresos - Tarjeta Visa 7497'!A5621:K5660",
  mc_resumen: "'Egresos - Mastercard 5922'!A5608:K5647",
  // read_historial_inversion() (Python) lee A2:J hasta el final real de la
  // hoja (sin un límite fijo en BLOCKS) — acá se usa un tope generoso, igual
  // que el resto de los rangos de esta app.
  historial_inversion: "'Historial de Inversiones'!A2:J5000",
  clasificacion_esencial: "'Categorías Esenciales'!A5:B60",
  balance_mensual: "'Balance Mensual'!A6:Q61",
  // Las dos siguientes las escribe (y crea, si no existen) el GitHub Action
  // scripts/actualizar_mercado.py -- no existen en el Sheet hasta que ese
  // Action corre por primera vez, ver el manejo de ese caso en
  // PaginaInversiones.cargarDatos() (js/pages/inversiones.js).
  datos_mercado: "'Datos de Mercado (Auto)'!A1:B10",
  historial_valor_cartera: "'Historial de Valor de Cartera'!A2:E5000",
  // Puerto de ranges["resumen_mensual"] (sheets_backend.py) -- B5:G30, fila 5
  // es el encabezado real de la hoja (confirmado leyendo el Sheet real:
  // Mes | Ingresos ganados | Gastos personales | Deudas y obligaciones |
  // Ahorro e inversiones | Disponible del mes).
  resumen_mensual: "'Resumen Mensual'!B5:G30",
};
