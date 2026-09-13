const { chromium } = require("playwright");
const BASE = "http://localhost:8123";

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`OK: ${label}`);
  else { console.log(`FAIL: ${label}`); failures++; }
}

// Este test NO mockea nada de Sheets/Auth -- solo verifica que app.html
// declara el manifest/íconos/service worker correctamente y que el navegador
// puede leerlos y registrarlos, condición necesaria para que Chrome/Edge
// ofrezcan "Instalar" (computador y celular) y para que iOS respete el
// ícono/splash al agregar a la pantalla de inicio.
async function testPWA() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await page.goto(`${BASE}/app.html`);
  await page.waitForTimeout(300);

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  check(manifestHref === "manifest.json", `app.html declara el manifest (vi: "${manifestHref}")`);

  const manifestRes = await page.request.get(`${BASE}/manifest.json`);
  check(manifestRes.ok(), `manifest.json responde 200 (vi: ${manifestRes.status()})`);
  const manifest = await manifestRes.json();
  check(manifest.display === "standalone", `display=standalone (instalable como app propia) (vi: "${manifest.display}")`);
  check(manifest.start_url === "./app.html", `start_url apunta a app.html (vi: "${manifest.start_url}")`);
  check(Array.isArray(manifest.icons) && manifest.icons.length >= 2, `Declara al menos 2 íconos (vi: ${manifest.icons?.length})`);
  check(manifest.icons.some((i) => i.purpose === "maskable"), "Incluye un ícono maskable (para Android adaptativo)");

  for (const icono of manifest.icons) {
    const res = await page.request.get(`${BASE}/${icono.src}`);
    check(res.ok(), `El ícono declarado "${icono.src}" existe y responde 200 (vi: ${res.status()})`);
  }

  const appleTouchHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  const appleTouchRes = await page.request.get(`${BASE}/${appleTouchHref}`);
  check(appleTouchRes.ok(), `apple-touch-icon existe y responde 200 (vi: "${appleTouchHref}" -> ${appleTouchRes.status()})`);

  const themeColor = await page.locator('meta[name="theme-color"]').getAttribute("content");
  check(/^#[0-9a-f]{6}$/i.test(themeColor), `theme-color es un color válido (vi: "${themeColor}")`);

  // El service worker se registra solo (app.html lo hace en window.load).
  await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => !!r), null, { timeout: 5000 })
    .catch(() => {});
  const registrado = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r));
  check(registrado, "El service worker (sw.js) queda registrado");

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
