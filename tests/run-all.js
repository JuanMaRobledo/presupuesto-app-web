// Corre cada test-*.js (y run-tests.js) de esta carpeta como un proceso
// aparte -- cada archivo ya trae su propio browser.launch()/close() y su
// propio contador de "OK"/"FAIL", así que aislarlos en procesos separados
// evita que un mock/estado que quede mal cerrado en un archivo contamine
// al siguiente. Requiere el servidor estático de la app corriendo en
// BASE (ver package.json / .github/workflows/tests.yml -- "python3 -m
// http.server 8123" desde la raíz del repo) y "npx playwright install
// --with-deps chromium" ya corrido.
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const archivos = fs.readdirSync(__dirname)
  .filter((f) => f.startsWith("test-") && f.endsWith(".js"))
  .sort();
archivos.unshift("run-tests.js"); // regresión general primero

let fallidos = 0;
for (const archivo of archivos) {
  console.log(`\n=== ${archivo} ===`);
  const resultado = spawnSync(process.execPath, [path.join(__dirname, archivo)], { stdio: "inherit" });
  if (resultado.status !== 0) {
    console.log(`FAIL: ${archivo} (exit code ${resultado.status})`);
    fallidos++;
  }
}

console.log(fallidos === 0
  ? `\n✅ Los ${archivos.length} archivo(s) de test pasaron.`
  : `\n❌ ${fallidos} de ${archivos.length} archivo(s) de test fallaron.`);
process.exit(fallidos === 0 ? 0 : 1);
