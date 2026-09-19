import { createHash, timingSafeEqual } from "node:crypto";
import { next } from "@vercel/functions";

function safeEqual(value, expected) {
  const valueHash = createHash("sha256").update(value).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(valueHash, expectedHash);
}

function unauthorized() {
  return new Response("Usuario o contraseña incorrectos.", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="Presupuesto personal", charset="UTF-8"',
    },
  });
}

export default function proxy(request) {
  const expectedUser = process.env.APP_USERNAME?.trim();
  const expectedPassword = process.env.APP_PASSWORD;

  if (!expectedUser || !expectedPassword) {
    return new Response("El acceso privado todavía no está configurado.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Basic ")) return unauthorized();

  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return unauthorized();
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return unauthorized();

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (!safeEqual(username, expectedUser) || !safeEqual(password, expectedPassword)) {
    return unauthorized();
  }

  return next({
    headers: {
      "Cache-Control": "private, no-store",
      "Set-Cookie": "jmr-server-auth=1; Path=/; Secure; SameSite=Strict; Max-Age=2592000",
    },
  });
}
