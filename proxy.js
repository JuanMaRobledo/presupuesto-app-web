import { next } from "@vercel/functions";
import { validSession } from "./sso-session.js";

export default function proxy(request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/sso") return next();
  if (!process.env.APP_PASSWORD) return new Response("El acceso privado todavía no está configurado.", { status: 503, headers: { "Cache-Control": "no-store" } });
  if (validSession(request.headers.get("cookie"))) return next({ headers: { "Cache-Control": "private, no-store" } });
  if (!request.headers.get("accept")?.includes("text/html")) return new Response("No autorizado", { status: 401, headers: { "Cache-Control": "no-store" } });
  const destination = new URL("https://cartera-two-eta.vercel.app/api/sso/start");
  destination.searchParams.set("app", "presupuesto");
  destination.searchParams.set("path", url.pathname + url.search);
  return Response.redirect(destination, 303);
}
