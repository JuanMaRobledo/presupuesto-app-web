import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_NAME = "jmr_sso_session";
const MAX_AGE = 30 * 24 * 60 * 60;

function signature(expires) {
  const secret = process.env.APP_PASSWORD;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`jmr-sso-v1:${expires}`).digest("hex");
}

export function createSession() {
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE;
  const mac = signature(expires);
  return mac ? `${expires}.${mac}` : null;
}

export function validSession(cookie) {
  if (!cookie || !process.env.APP_PASSWORD) return false;
  const match = /(?:^|;\s*)jmr_sso_session=([^;]+)/.exec(cookie);
  const parts = match?.[1]?.split(".");
  if (!parts || parts.length !== 2 || !/^\d{10}$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) return false;
  const expires = Number(parts[0]);
  if (expires <= Date.now() / 1000 || expires > Date.now() / 1000 + MAX_AGE + 60) return false;
  const expected = signature(expires);
  return !!expected && timingSafeEqual(Buffer.from(parts[1], "hex"), Buffer.from(expected, "hex"));
}

export function sessionCookies(session) {
  return [
    `${SESSION_NAME}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`,
    `jmr-server-auth=1; Path=/; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
  ];
}
