// Utilidades compartidas por las funciones de Netlify (Airtable, sesiones, respuestas).
import crypto from "node:crypto";

export const ENV = {
  token: (process.env.AIRTABLE_TOKEN || "").trim(),
  base: (process.env.AIRTABLE_BASE_ID || "").trim(),
  secret: (process.env.SESSION_SECRET || "").trim(),
  anthropicKey: (process.env.ANTHROPIC_API_KEY || "").trim(),
  anthropicModel: (process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5").trim(),
};

// id interno <-> nombre en Airtable
export const WORKERS = { angel: "Ángel", fesp: "Fernando", fven: "Fernando Molleja", jaime: "Jaime" };
export const workerId = name => Object.keys(WORKERS).find(k => WORKERS[k] === name) || "";
export const STATUS = { pend: "Pendiente", curso: "En curso", hecha: "Hecha", bloq: "Incidencia" };
export const statusId = name => Object.keys(STATUS).find(k => STATUS[k] === name) || "pend";
export const PRIO = { alta: "Urgente", normal: "Normal", baja: "Baja" };
export const prioId = name => Object.keys(PRIO).find(k => PRIO[k] === name) || "normal";

export const T = { tasks: "Tareas", tpl: "Repetitivas", meet: "Reuniones", files: "Archivos", cfg: "Config" };

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export function checkEnv() {
  const miss = ["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "SESSION_SECRET"].filter(k => !process.env[k]);
  if (miss.length) throw new HttpError(500, "Faltan variables de entorno en Netlify: " + miss.join(", "));
}

/* ---------- Airtable ---------- */
export async function at(path, opts = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${ENV.base}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${ENV.token}`, "content-type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await res.text();
  let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (res.status === 401) throw new HttpError(502, "Airtable rechaza el token (401). Revisa AIRTABLE_TOKEN en Netlify: debe ser el token completo (pat….…) y tener valor en Production.");
  if (res.status === 403 || res.status === 404) throw new HttpError(502, `Airtable ${res.status}: el token no tiene acceso a la base o AIRTABLE_BASE_ID no es correcto.`);
  if (!res.ok) throw new HttpError(502, `Airtable ${res.status}: ${data?.error?.message || data?.error?.type || txt.slice(0, 200)}`);
  return data;
}
export const tbl = name => encodeURIComponent(name);
export async function listAll(table, params = {}) {
  const out = []; let offset;
  do {
    const q = new URLSearchParams({ pageSize: "100", ...params });
    if (offset) q.set("offset", offset);
    const d = await at(`${tbl(table)}?${q}`);
    out.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return out;
}
export const getRecord = (table, id) => at(`${tbl(table)}/${encodeURIComponent(id)}`);
export const createRecord = (table, fields) => at(tbl(table), { method: "POST", body: JSON.stringify({ fields, typecast: true }) });
export const updateRecord = (table, id, fields) => at(`${tbl(table)}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ fields, typecast: true }) });
export const deleteRecord = (table, id) => at(`${tbl(table)}/${encodeURIComponent(id)}`, { method: "DELETE" });
export const esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/* ---------- Config (tabla Config: Clave / Valor JSON) ---------- */
export async function getConfig() {
  const recs = await listAll(T.cfg);
  const map = {};
  for (const r of recs) {
    const k = r.fields?.Clave; if (!k) continue;
    let v = {}; try { v = JSON.parse(r.fields?.Valor || "{}"); } catch { v = {}; }
    map[k] = { id: r.id, value: v };
  }
  return map;
}
export async function setConfig(map, key, value) {
  const Valor = JSON.stringify(value);
  if (map[key]) await updateRecord(T.cfg, map[key].id, { Valor });
  else await createRecord(T.cfg, { Clave: key, Valor });
}

/* ---------- códigos y sesiones ---------- */
export const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
export const codeHash = code => sha256("volta:" + code);
const b64u = buf => Buffer.from(buf).toString("base64url");
export function signToken(payload, days = 14) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + days * 864e5 }));
  const sig = crypto.createHmac("sha256", ENV.secret).update(body).digest("base64url");
  return body + "." + sig;
}
export function readToken(req) {
  const h = req.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [body, sig] = tok.split(".");
  if (!body || !sig) return null;
  const good = crypto.createHmac("sha256", ENV.secret).update(body).digest("base64url");
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
export function requireAuth(req, adminOnly = false) {
  const s = readToken(req);
  if (!s) throw new HttpError(401, "Sesión caducada. Vuelve a entrar con tu código.");
  if (adminOnly && s.role !== "admin") throw new HttpError(403, "Solo el administrador puede hacer esto.");
  return s;
}
export function handler(fn) {
  return async (req, ctx) => {
    try { checkEnv(); return await fn(req, ctx); }
    catch (e) { const st = e.status || 500; if (st >= 500) console.error(e); return json({ error: e.message || "Error" }, st); }
  };
}
