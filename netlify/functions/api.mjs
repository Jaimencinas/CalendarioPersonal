// Datos de la web: GET = cargar todo (filtrado según quién entra); POST = acciones del administrador.
import {
  handler, json, HttpError, requireAuth, listAll, getRecord, createRecord, updateRecord, deleteRecord,
  getConfig, setConfig, codeHash, esc, ENV, T, WORKERS, workerId, STATUS, statusId, PRIO, prioId,
} from "../lib/common.mjs";

const att = a => ({ id: a.id, url: a.url, name: a.filename, contentType: a.type || "", size: a.size || 0 });

function taskOut(r) {
  const f = r.fields || {};
  return {
    id: r.id, title: f["Título"] || "Sin título", worker: workerId(f.Trabajador), status: statusId(f.Estado), priority: prioId(f.Prioridad),
    dateFrom: f.Desde || null, dateTo: f.Hasta || f.Desde || null, hours: Number(f.Horas) || 0, description: f["Descripción"] || "",
    attachments: (f.Adjuntos || []).map(att), meetingDate: f["Reunión"] || null, templateId: f.Repetitiva || null,
  };
}
function tplOut(r) {
  const f = r.fields || {};
  return {
    id: r.id, title: f["Título"] || "Sin título", worker: workerId(f.Trabajador), priority: prioId(f.Prioridad), hours: Number(f.Horas) || 0,
    description: f["Descripción"] || "", attachments: (f.Adjuntos || []).map(att), fromDow: Number(f["Día inicio"]) || 1, spanDays: Number(f["Días de plazo"]) || 0,
  };
}

// Adjuntos: los que ya están en el registro se conservan por id; los nuevos se copian desde su url.
async function attachmentsFor(table, id, list) {
  const keep = new Set();
  if (id) { try { const cur = await getRecord(table, id); (cur.fields?.Adjuntos || []).forEach(a => keep.add(a.id)); } catch {} }
  return (Array.isArray(list) ? list : []).map(a => keep.has(a.id) ? { id: a.id } : (a.url ? { url: a.url, filename: a.name || "archivo" } : null)).filter(Boolean);
}
const date = v => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;

export default handler(async (req) => {
  if (req.method === "GET") {
    const s = requireAuth(req);
    const isAdmin = s.role === "admin";
    const taskParams = isAdmin ? {} : { filterByFormula: `{Trabajador}='${esc(WORKERS[s.who] || "-")}'` };
    const [tasks, meets, cfg, tpls] = await Promise.all([
      listAll(T.tasks, taskParams), listAll(T.meet), getConfig(), isAdmin ? listAll(T.tpl) : Promise.resolve([]),
    ]);
    const codes = cfg.codigos?.value || {};
    return json({
      session: { role: s.role, who: s.who },
      tasks: tasks.map(taskOut),
      templates: tpls.map(tplOut),
      meetings: meets.filter(r => r.fields?.Fecha).map(r => ({ date: r.fields.Fecha, notes: r.fields.Acta || "", updatedAt: r.fields["Actualizada"] || null })),
      config: { meetingDay: 1, meetingTime: "09:00", meetingHours: 1, meetingNote: "", ...(cfg.reunion?.value || {}),
        codes: isAdmin ? Object.fromEntries(Object.keys(codes).map(k => [k, true])) : {} },
      aiEnabled: isAdmin && !!ENV.anthropicKey,
    });
  }
  if (req.method !== "POST") throw new HttpError(405, "Método no permitido");
  requireAuth(req, true);
  const b = await req.json().catch(() => ({}));
  switch (b.action) {
    case "saveTask": {
      const t = b.task || {};
      if (!WORKERS[t.worker]) throw new HttpError(400, "Trabajador no válido");
      const fields = {
        "Título": String(t.title || "").slice(0, 200), Trabajador: WORKERS[t.worker], Estado: STATUS[t.status] || STATUS.pend, Prioridad: PRIO[t.priority] || PRIO.normal,
        Desde: date(t.dateFrom), Hasta: date(t.dateTo), Horas: Math.max(0, Number(t.hours) || 0), "Descripción": String(t.description || ""),
        "Reunión": date(t.meetingDate), Repetitiva: t.templateId ? String(t.templateId) : "",
        Adjuntos: await attachmentsFor(T.tasks, b.id, t.attachments),
      };
      const r = b.id ? await updateRecord(T.tasks, b.id, fields) : await createRecord(T.tasks, fields);
      return json({ id: r.id, task: taskOut(r) });
    }
    case "patchTask": {
      const p = b.fields || {}, fields = {};
      if ("dateFrom" in p) fields.Desde = date(p.dateFrom);
      if ("dateTo" in p) fields.Hasta = date(p.dateTo);
      if ("status" in p) fields.Estado = STATUS[p.status] || STATUS.pend;
      const r = await updateRecord(T.tasks, b.id, fields);
      return json({ id: r.id, task: taskOut(r) });
    }
    case "deleteTask": await deleteRecord(T.tasks, b.id); return json({ ok: true });
    case "saveTemplate": {
      const t = b.template || {};
      const fields = {
        "Título": String(t.title || "").slice(0, 200), Trabajador: WORKERS[t.worker] || null, Prioridad: PRIO[t.priority] || PRIO.normal,
        Horas: Math.max(0, Number(t.hours) || 0), "Descripción": String(t.description || ""),
        "Día inicio": Math.min(7, Math.max(1, Number(t.fromDow) || 1)), "Días de plazo": Math.min(6, Math.max(0, Number(t.spanDays) || 0)),
        Adjuntos: await attachmentsFor(T.tpl, b.id, t.attachments),
      };
      const r = b.id ? await updateRecord(T.tpl, b.id, fields) : await createRecord(T.tpl, fields);
      return json({ id: r.id, template: tplOut(r) });
    }
    case "deleteTemplate": await deleteRecord(T.tpl, b.id); return json({ ok: true });
    case "saveMeeting": {
      const d = date(b.date); if (!d) throw new HttpError(400, "Fecha no válida");
      const found = await listAll(T.meet, { filterByFormula: `{Fecha}='${d}'` });
      const fields = { Fecha: d, Acta: String(b.notes || "") };
      const r = found[0] ? await updateRecord(T.meet, found[0].id, fields) : await createRecord(T.meet, fields);
      return json({ id: r.id });
    }
    case "saveConfig": {
      const c = b.config || {};
      const cfg = await getConfig();
      await setConfig(cfg, "reunion", {
        meetingDay: Math.min(7, Math.max(1, Number(c.meetingDay) || 1)), meetingTime: /^\d{2}:\d{2}$/.test(c.meetingTime) ? c.meetingTime : "09:00",
        meetingHours: Math.max(0.25, Number(c.meetingHours) || 1), meetingNote: String(c.meetingNote || "").slice(0, 300),
      });
      const nc = b.newCodes || {};
      if (Object.keys(nc).length) {
        const codes = { ...(cfg.codigos?.value || {}) };
        for (const [role, code] of Object.entries(nc)) {
          if (role !== "admin" && !WORKERS[role]) continue;
          if (!/^\d{6}$/.test(String(code))) throw new HttpError(400, "Cada código debe tener exactamente 6 números.");
          codes[role] = codeHash(String(code));
        }
        const hs = Object.values(codes);
        if (new Set(hs).size !== hs.length) throw new HttpError(409, "Hay dos personas con el mismo código. Cada código debe ser distinto.");
        await setConfig(cfg, "codigos", codes);
      }
      return json({ ok: true });
    }
    default: throw new HttpError(400, "Acción desconocida");
  }
});
