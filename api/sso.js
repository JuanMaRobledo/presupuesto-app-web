import { createSession, sessionCookies } from "../sso-session.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  const code = typeof req.body === "string" ? new URLSearchParams(req.body).get("code") : req.body?.code;
  if (typeof code !== "string" || code.length > 1800 || !process.env.APP_PASSWORD) return res.status(400).end("Código inválido");
  try {
    const response = await fetch("https://cartera-two-eta.vercel.app/api/sso/verify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, app: "presupuesto" }), signal: AbortSignal.timeout(8000), cache: "no-store",
    });
    if (!response.ok) return res.status(401).end("Acceso vencido. Vuelve al Centro Financiero para ingresar.");
    const { path } = await response.json();
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return res.status(400).end("Ruta inválida");
    const session = createSession();
    if (!session) return res.status(503).end("El acceso privado no está configurado.");
    res.setHeader("Set-Cookie", sessionCookies(session));
    res.writeHead(303, { Location: path });
    return res.end();
  } catch {
    return res.status(503).end("No se pudo verificar el acceso. Inténtalo de nuevo.");
  }
}
