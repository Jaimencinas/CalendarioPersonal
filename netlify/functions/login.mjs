// POST {code} -> {token, role, who}
import { handler, json, HttpError, getConfig, codeHash, signToken } from "../lib/common.mjs";

export default handler(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Método no permitido");
  const { code } = await req.json().catch(() => ({}));
  if (!/^\d{6}$/.test(String(code || ""))) throw new HttpError(400, "El código tiene 6 dígitos.");
  const cfg = await getConfig();
  const codes = cfg.codigos?.value || {};
  if (!Object.keys(codes).length) throw new HttpError(400, "Todavía no hay códigos configurados.");
  const h = codeHash(String(code));
  const role = Object.keys(codes).find(k => codes[k] === h);
  if (!role) { await new Promise(r => setTimeout(r, 900)); throw new HttpError(401, "Código incorrecto."); }
  const session = role === "admin" ? { role: "admin", who: null } : { role: "worker", who: role };
  return json({ token: signToken(session), ...session });
});
