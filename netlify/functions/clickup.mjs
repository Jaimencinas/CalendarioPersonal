// ClickUp (solo lectura, solo administrador).
//   GET ?q=texto  -> busca entre las tareas abiertas del espacio de trabajo
//   GET ?id=xxxx  -> una tarea completa, ya convertida al formato de la web
import { handler, json, HttpError, requireAuth, ENV, CLICKUP_EMAILS, WORKERS } from "../lib/common.mjs";

const API = "https://api.clickup.com/api/v2";
async function cu(path) {
  if (!ENV.clickupToken) throw new HttpError(501, "ClickUp no está configurado (falta CLICKUP_TOKEN en Netlify).");
  const res = await fetch(API + path, { headers: { Authorization: ENV.clickupToken } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new HttpError(502, "ClickUp rechaza el token. Revisa CLICKUP_TOKEN (empieza por pk_).");
  if (!res.ok) throw new HttpError(502, "ClickUp " + res.status + ": " + (data.err || data.error || ""));
  return data;
}
let teamId = null;
async function team() {
  if (ENV.clickupTeam) return ENV.clickupTeam;
  if (teamId) return teamId;
  const d = await cu("/team");
  teamId = d.teams?.[0]?.id; if (!teamId) throw new HttpError(502, "No se encontró el espacio de trabajo de ClickUp");
  return teamId;
}

// fecha de ClickUp (ms) -> AAAA-MM-DD en hora de España
const day = ms => {
  if (!ms) return null;
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Number(ms)));
  return p;
};
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
function workerOf(t) {
  for (const a of t.assignees || []) {
    const w = CLICKUP_EMAILS[String(a.email || "").toLowerCase()];
    if (w && WORKERS[w]) return w;
  }
  return null;
}
function convert(t, full = false) {
  const st = t.status?.type === "closed" || t.status?.type === "done" ? "hecha"
    : /incid|bloq|block/i.test(t.status?.status || "") ? "bloq"
    : t.status?.type === "custom" || /curso|progress|doing|haciendo/i.test(t.status?.status || "") ? "curso" : "pend";
  const pr = t.priority?.priority;
  const priority = pr === "urgent" || pr === "high" ? "alta" : pr === "low" ? "baja" : "normal";
  const desc = (t.text_content || (full ? String(t.markdown_description || "").replace(/[*_`#>]+/g, "") : "") || "");
  return {
    id: t.id, url: t.url || `https://app.clickup.com/t/${t.id}`, title: t.name || "Sin título",
    list: t.list?.name || "", folder: t.folder?.hidden ? "" : (t.folder?.name || ""),
    status: st, statusName: t.status?.status || "", priority,
    worker: workerOf(t), assignees: (t.assignees || []).map(a => a.username || a.email).filter(Boolean),
    dateFrom: day(t.start_date), dateTo: day(t.due_date),
    hours: t.time_estimate ? Math.round(Number(t.time_estimate) / 36000) / 100 : null,
    description: full ? String(desc).slice(0, 20000) : String(desc).slice(0, 160),
    updated: Number(t.date_updated) || 0,
  };
}

// caché corta para no llamar a ClickUp en cada tecla
let cache = { at: 0, tasks: [] };
async function allOpen() {
  if (Date.now() - cache.at < 90000) return cache.tasks;
  const id = await team(); const out = [];
  for (let page = 0; page < 10; page++) {
    const d = await cu(`/team/${id}/task?page=${page}&subtasks=true&include_closed=false&order_by=updated&reverse=false`);
    out.push(...(d.tasks || []));
    if (d.last_page || (d.tasks || []).length < 100) break;
  }
  cache = { at: Date.now(), tasks: out.map(t => convert(t)) };
  return cache.tasks;
}

export default handler(async (req) => {
  requireAuth(req, true);
  const u = new URL(req.url);
  const id = u.searchParams.get("id");
  if (id) {
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) throw new HttpError(400, "Id no válido");
    const t = await cu(`/task/${encodeURIComponent(id)}?include_markdown_description=true`);
    return json({ task: convert(t, true) });
  }
  const q = norm(u.searchParams.get("q") || "").trim();
  const words = q.split(/\s+/).filter(Boolean);
  // filtro de vencimiento: todas | novencidas | vencidas | sinfecha  (comparando con hoy en España)
  const f = u.searchParams.get("f") || "todas";
  const today = day(Date.now());
  const byDue = t => f === "vencidas" ? (t.dateTo && t.dateTo < today)
    : f === "novencidas" ? (t.dateTo && t.dateTo >= today)
    : f === "sinfecha" ? !t.dateTo : true;
  const all = (await allOpen()).filter(t => !words.length || words.every(w => norm([t.title, t.list, t.folder, t.assignees.join(" "), t.description].join(" ")).includes(w)));
  const counts = {
    todas: all.length,
    novencidas: all.filter(t => t.dateTo && t.dateTo >= today).length,
    vencidas: all.filter(t => t.dateTo && t.dateTo < today).length,
    sinfecha: all.filter(t => !t.dateTo).length,
  };
  const list = all.filter(byDue)
    .sort((a, b) => f === "vencidas" || f === "novencidas" ? String(a.dateTo).localeCompare(String(b.dateTo)) : b.updated - a.updated)
    .slice(0, 60)
    .map(t => ({ ...t, overdue: !!(t.dateTo && t.dateTo < today) }));
  return json({ tasks: list, counts });
});
