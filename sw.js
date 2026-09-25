// El service worker conserva la instalación como PWA, pero no guarda HTML,
// JavaScript ni respuestas privadas: cada apertura vuelve a validar la sesión
// en el servidor. El acceso a Sheets/Drive siempre requiere conexión.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
