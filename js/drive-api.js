// Wrapper delgado sobre la API REST de Google Drive v3 — sube el PDF de una
// declaración de renta a Google Drive DIRECTO desde el navegador, con la
// sesión de quien está usando la app (no una cuenta de servicio). El
// archivo queda en SU Drive, de su propiedad — la app nunca lo aloja ni lo
// ve pasar por ningún servidor propio. Requiere el scope
// drive.file (solo da acceso a archivos que la propia app crea, no a todo
// el Drive).
const DriveApi = (() => {
  async function uploadFile(file, nombre) {
    const token = Auth.getToken();
    if (!token) throw new Error("No hay sesión activa — iniciá sesión primero.");
    const metadata = { name: nombre, mimeType: file.type || "application/pdf" };
    const boundary = "presupuesto_app_" + Math.random().toString(16).slice(2);
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--`;
    const bodyHead = delimiter + "Content-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata)
      + delimiter + `Content-Type: ${metadata.mimeType}\r\n\r\n`;
    const fileBuf = await file.arrayBuffer();
    const body = new Blob([new TextEncoder().encode(bodyHead), fileBuf, new TextEncoder().encode(closeDelim)]);

    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
    if (!res.ok) {
      const texto = await res.text();
      throw new Error(`Error ${res.status} subiendo el PDF a Drive: ${texto}`);
    }
    return res.json(); // { id, webViewLink }
  }

  return { uploadFile };
})();
