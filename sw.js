// Service worker mínimo -- necesario en algunos navegadores para ofrecer
// "Instalar" (en computador y celular), además del manifest. Solo cachea el
// shell propio (mismo origen: HTML/CSS/JS) con estrategia network-first +
// fallback a caché -- así abrir la app sin conexión al menos muestra la
// interfaz en vez de una pantalla en blanco (los DATOS siguen necesitando
// red: vienen en vivo de la API de Sheets/Drive, nunca se cachean acá).
// Sin lista de archivos a mano: cachea lo que se vaya pidiendo de verdad,
// para no tener que mantenerla sincronizada cada vez que se agrega una
// página nueva en js/pages/.
const CACHE = "presupuesto-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Nunca cachear la API de Sheets/Drive ni ningún CDN externo -- solo el
  // shell propio, mismo origen que esta página.
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copia));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
