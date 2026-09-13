const { chromium } = require("playwright");
const BASE = "http://localhost:8123";

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`OK: ${label}`);
  else { console.log(`FAIL: ${label}`); failures++; }
}

// Este test NO mockea nada de Sheets/Auth -- solo verifica que index.html
// (la portada, ahora el start_url) y app.html declaran el manifest/íconos/
// service worker correctamente y que el navegador puede leerlos y
// registrarlos, condición necesaria para que Chrome/Edge ofrezcan
// "Instalar" (computador y celular) y para que iOS respete el ícono/splash
// al agregar a la pantalla de inicio.
async function testDeclaracionPWA(page, ruta) {
  await page.goto(`${BASE}/${ruta}`);
  await page.waitForTimeout(300);

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  check(manifestHref === "manifest.json", `${ruta} declara el manifest (vi: "${manifestHref}")`);

  const appleTouchHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  const appleTouchRes = await page.request.get(`${BASE}/${appleTouchHref}`);
  check(appleTouchRes.ok(), `${ruta}: apple-touch-icon existe y responde 200 (vi: "${appleTouchHref}" -> ${appleTouchRes.status()})`);

  const themeColor = await page.locator('meta[name="theme-color"]').getAttribute("content");
  check(/^#[0-9a-f]{6}$/i.test(themeColor), `${ruta}: theme-color es un color válido (vi: "${themeColor}")`);

  // El service worker se registra solo (tanto index.html como app.html lo hacen en window.load).
  await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => !!r), null, { timeout: 5000 })
    .catch(() => {});
  const registrado = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r));
  check(registrado, `${ruta}: el service worker (sw.js) queda registrado`);
}

async function testPWA() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  const manifestRes = await page.request.get(`${BASE}/manifest.json`);
  check(manifestRes.ok(), `manifest.json responde 200 (vi: ${manifestRes.status()})`);
  const manifest = await manifestRes.json();
  check(manifest.display === "standalone", `display=standalone (instalable como app propia) (vi: "${manifest.display}")`);
  check(manifest.start_url === "./index.html", `start_url apunta a index.html, la portada con las 2 versiones (vi: "${manifest.start_url}")`);
  check(Array.isArray(manifest.icons) && manifest.icons.length >= 2, `Declara al menos 2 íconos (vi: ${manifest.icons?.length})`);
  check(manifest.icons.some((i) => i.purpose === "maskable"), "Incluye un ícono maskable (para Android adaptativo)");

  for (const icono of manifest.icons) {
    const res = await page.request.get(`${BASE}/${icono.src}`);
    check(res.ok(), `El ícono declarado "${icono.src}" existe y responde 200 (vi: ${res.status()})`);
  }

  await testDeclaracionPWA(page, "index.html");
  await testDeclaracionPWA(page, "app.html");

  // La portada tiene que poder llevarte a cada versión, y app.html debe
  // poder volver a la portada (no hay barra de navegador en modo standalone).
  await page.goto(`${BASE}/index.html`);
  const hrefWeb = await page.locator("a.tarjeta.web").getAttribute("href");
  check(hrefWeb === "app.html", `La tarjeta "Versión Web" apunta a app.html (vi: "${hrefWeb}")`);
  const hrefStreamlit = await page.locator("a.tarjeta.streamlit").getAttribute("href");
  check(/^https:\/\/.*streamlit\.app/.test(hrefStreamlit || ""), `La tarjeta "Versión Streamlit" apunta a la URL de Streamlit (vi: "${hrefStreamlit}")`);

  await page.goto(`${BASE}/app.html`);
  const hrefPortada = await page.locator(".link-portada").first().getAttribute("href");
  check(hrefPortada === "index.html", `app.html tiene un link de vuelta a la portada (vi: "${hrefPortada}")`);

  await browser.close();
}

(async () => {
  await testPWA();
  console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
