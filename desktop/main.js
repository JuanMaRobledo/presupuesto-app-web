// App de escritorio (Electron): abre la MISMA web estática de este repo
// (app.html + js/ + css/) en una ventana propia, sin barra del navegador
// -- no hay nada nuevo que mantener, es exactamente el mismo código que
// corre en GitHub Pages, servido localmente.
//
// Por qué un servidor HTTP local en vez de cargar app.html con file://:
// Google Identity Services (el login) exige que la página se sirva desde
// un origin http(s) autorizado en el OAuth Client ID -- file:// no
// funciona. Puerto 8000 porque ya es el origin que las instrucciones de
// este repo (ver js/config.js) piden autorizar para "probar en local", así
// que si ya usaste eso alguna vez, la app de escritorio funciona sin tocar
// nada más en Google Cloud Console.
const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

const PORT = 8000;
const WEB_ROOT = path.resolve(
  app.isPackaged ? path.join(process.resourcesPath, "app") : path.join(__dirname, "..")
);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

function iniciarServidorEstatico() {
  return http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/app.html";
    const filePath = path.resolve(path.join(WEB_ROOT, urlPath));
    // Nunca servir nada fuera de WEB_ROOT (path traversal vía "..").
    if (!filePath.startsWith(WEB_ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("No encontrado"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  }).listen(PORT, "127.0.0.1");
}

let mainWindow;
function crearVentana() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 560,
    title: "Presupuesto App",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/app.html`);

  // El popup de login de Google (Identity Services) necesita ser una
  // ventana HIJA de Electron de verdad -- no el navegador del sistema --
  // para que el postMessage de vuelta a esta ventana funcione (así hace
  // el intercambio del token). Cualquier otro link que abra pestaña nueva
  // (p. ej. un "target=_blank" del contenido, como el link a la versión de
  // Streamlit) sí va al navegador del sistema en vez de abrir otra ventana
  // de Electron sin barra de direcciones.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://accounts.google.com/")) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  iniciarServidorEstatico();
  crearVentana();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
