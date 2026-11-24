/* Equipo Volta · adaptador para Netlify.
   La página se escribió para funcionar dentro de Claude (window.claude.use(...)).
   Este archivo ofrece la misma interfaz, pero hablando con las funciones de Netlify y Airtable:
   - db         -> /.netlify/functions/api   (tareas, repetitivas, actas, ajustes)
   - assets     -> /.netlify/functions/upload (adjuntos, guardados en Airtable)
   - dictation  -> reconocimiento de voz del navegador (Chrome / Edge)
   - downloads  -> descarga directa del archivo
   - sample     -> /.netlify/functions/ai     (IA opcional con la API de Claude)
*/
(function () {
  "use strict";
  const FN = "/.netlify/functions/";
  const TOKEN_KEY = "volta-token";
  const POLL_MS = 60000;

  /* ---------- sesión ---------- */
  const tok = {
    get() { try { const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null"); return t && t.exp > Date.now() ? t : null; } catch (e) { return null; } },
    set(t) { try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ ...t, exp: Date.now() + 13 * 864e5 })); } catch (e) {} },
    clear() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} },
  };

  async function call(name, { method = "GET", body, signal } = {}) {
    const t = tok.get();
    const res = await fetch(FN + name, {
      method, signal,
      headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {}; try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && name !== "login") { tok.clear(); window.dispatchEvent(new CustomEvent("volta-logout")); }
    if (!res.ok) { const err = new Error(data.error || ("Error " + res.status)); err.status = res.status; err.code = res.status === 403 || res.status === 401 ? "invalid_argument" : res.status === 409 ? "duplicate" : "unavailable"; throw err; }
    return data;
  }

  /* ---------- datos en memoria + suscriptores ---------- */
  const state = { tasks: [], templates: [], meetings: [], config: null, loaded: false, aiEnabled: false, clickupEnabled: false };
  const subs = { tasks: [], templates: [], meetings: [], config: [] };
  const docOf = (id, data) => ({ id, exists: true, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
  function emit(kind) {
    const list = kind === "tasks" ? state.tasks : kind === "templates" ? state.templates : kind === "meetings" ? state.meetings : null;
    for (const cb of subs[kind]) {
      try {
        if (kind === "config") cb(state.config ? docOf("main", state.config) : { id: "main", exists: false, data: () => undefined, metadata: { fromCache: false } });
        else if (kind === "meetings") cb({ docs: list.map(m => docOf(m.date, m)), metadata: { fromCache: false } });
        else cb({ docs: list.map(x => docOf(x.id, x)), metadata: { fromCache: false } });
      } catch (e) { console.error(e); }
    }
  }
  const emitAll = () => ["tasks", "templates", "meetings", "config"].forEach(emit);

  let loading = null;
  async function refresh() {
    if (!tok.get()) { state.tasks = []; state.templates = []; state.meetings = []; state.config = null; emitAll(); return; }
    if (loading) return loading;
    loading = (async () => {
      try {
        const d = await call("api");
        state.tasks = d.tasks || []; state.templates = d.templates || []; state.meetings = d.meetings || [];
        state.config = d.config || null; state.aiEnabled = !!d.aiEnabled; state.clickupEnabled = !!d.clickupEnabled; state.loaded = true;
        emitAll();
        window.dispatchEvent(new CustomEvent("volta-ready", { detail: { aiEnabled: state.aiEnabled, clickupEnabled: state.clickupEnabled, session: d.session } }));
      } catch (e) {
        console.error(e);
        window.dispatchEvent(new CustomEvent("volta-error", { detail: { message: e.message } }));
      } finally { loading = null; }
    })();
    return loading;
  }
  setInterval(() => { if (document.visibilityState === "visible" && tok.get()) refresh(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && tok.get()) refresh(); });

  /* ---------- db: misma forma que el db de Claude, solo lo que usa la página ---------- */
  function docRef(col, id) {
    const ref = {
      id: id || ("tmp_" + Math.random().toString(36).slice(2)),
      path: col + "/" + (id || ""),
      isNew: !id,
      async set(body) {
        if (col === "tasks") {
          const r = await call("api", { method: "POST", body: { action: "saveTask", id: ref.isNew ? null : ref.id, task: body } });
          ref.id = r.id; ref.isNew = false;
          const i = state.tasks.findIndex(t => t.id === r.id); if (i >= 0) state.tasks[i] = r.task; else state.tasks.push(r.task);
          emit("tasks"); refresh();
        } else if (col === "templates") {
          const r = await call("api", { method: "POST", body: { action: "saveTemplate", id: ref.isNew ? null : ref.id, template: body } });
          ref.id = r.id; ref.isNew = false;
          const i = state.templates.findIndex(t => t.id === r.id); if (i >= 0) state.templates[i] = r.template; else state.templates.push(r.template);
          emit("templates");
        } else if (col === "meetings") {
          await call("api", { method: "POST", body: { action: "saveMeeting", date: ref.id, notes: body.notes || "" } });
          const m = { date: ref.id, notes: body.notes || "", updatedAt: new Date().toISOString() };
          const i = state.meetings.findIndex(x => x.date === ref.id); if (i >= 0) state.meetings[i] = m; else state.meetings.push(m);
          emit("meetings");
        } else if (col === "config") {
          const { newCodes, codes, ...config } = body;
          await call("api", { method: "POST", body: { action: "saveConfig", config, newCodes: newCodes || {} } });
          refresh();
        }
      },
      async update(fields) {
        if (col !== "tasks") return ref.set(fields);
        const r = await call("api", { method: "POST", body: { action: "patchTask", id: ref.id, fields } });
        const i = state.tasks.findIndex(t => t.id === r.id); if (i >= 0) state.tasks[i] = r.task;
        emit("tasks");
      },
      async delete() {
        if (col === "tasks") { await call("api", { method: "POST", body: { action: "deleteTask", id: ref.id } }); state.tasks = state.tasks.filter(t => t.id !== ref.id); emit("tasks"); }
        if (col === "templates") { await call("api", { method: "POST", body: { action: "deleteTemplate", id: ref.id } }); state.templates = state.templates.filter(t => t.id !== ref.id); emit("templates"); }
      },
      onSnapshot(cb) { if (col === "config") { subs.config.push(cb); setTimeout(() => emit("config"), 0); } return () => {}; },
    };
    return ref;
  }
  const db = {
    collection(name) {
      return {
        path: name,
        doc: id => docRef(name, id),
        onSnapshot(cb) { (subs[name] || (subs[name] = [])).push(cb); setTimeout(() => emit(name), 0); return () => {}; },
      };
    },
    doc(path) { const [col, id] = String(path).split("/"); return docRef(col, id); },
  };

  /* ---------- adjuntos ---------- */
  const assets = {
    upload(file) {
      return new Promise((resolve, reject) => {
        if (file.size > 4 * 1024 * 1024) { reject({ code: "too_large", message: "Máximo 4 MB por archivo" }); return; }
        const fr = new FileReader();
        fr.onload = async () => {
          try {
            const data = String(fr.result).split(",")[1] || "";
            const r = await call("upload", { method: "POST", body: { filename: file.name, contentType: file.type || "application/octet-stream", data } });
            resolve({ id: r.id, url: r.url, contentType: r.contentType, sizeBytes: r.sizeBytes });
          } catch (e) { reject(e); }
        };
        fr.onerror = () => reject({ code: "read_error" });
        fr.readAsDataURL(file);
      });
    },
  };

  /* ---------- dictado con el reconocimiento de voz del navegador ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function makeDictation() {
    if (!SR) return null;
    const h = { partial: [], final: [], state: [] };
    let rec = null, st = "idle", stopWaiter = null, wantStop = false, hadText = false;
    const setState = (s, reason) => { st = s; h.state.forEach(f => { try { f(reason ? { state: s, reason } : { state: s }); } catch (e) {} }); };
    const fire = (k, v) => h[k].forEach(f => { try { f(v); } catch (e) {} });
    return {
      start() {
        if (st !== "idle") return Promise.resolve();
        return new Promise((resolve, reject) => {
          wantStop = false;
          rec = new SR(); rec.lang = "es-ES"; rec.continuous = true; rec.interimResults = true;
          rec.onstart = () => { setState("listening"); resolve(); };
          rec.onresult = ev => {
            let interim = "";
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
              const r = ev.results[i], txt = r[0].transcript.trim();
              if (r.isFinal) { if (txt) { fire("final", { text: (hadText ? " " : "") + txt }); hadText = true; } }
              else interim += r[0].transcript;
            }
            fire("partial", { text: interim.trim() });
          };
          rec.onerror = ev => {
            const code = ev.error === "not-allowed" || ev.error === "service-not-allowed" ? "not_granted" : ev.error === "no-speech" || ev.error === "aborted" ? null : "upstream_error";
            if (code && st === "starting") reject({ code });
            if (code) rec._reason = code;
          };
          rec.onend = () => {
            fire("partial", { text: "" });
            const reason = rec && rec._reason ? rec._reason : "stopped";
            rec = null; setState("idle", wantStop ? "stopped" : reason);
            if (stopWaiter) { stopWaiter(); stopWaiter = null; }
          };
          setState("starting");
          try { rec.start(); } catch (e) { setState("idle", "upstream_error"); reject({ code: "upstream_error" }); }
        });
      },
      stop() {
        if (!rec) return Promise.resolve();
        wantStop = true; setState("finishing");
        return new Promise(r => { stopWaiter = r; try { rec.stop(); } catch (e) { r(); } });
      },
      active() { return st !== "idle"; },
      onPartial(f) { h.partial.push(f); return () => {}; },
      onFinal(f) { h.final.push(f); return () => {}; },
      onState(f) { h.state.push(f); return () => {}; },
      _resetJoin() { hadText = false; },
    };
  }

  /* ---------- descargas ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
      return { status: "saved" };
    },
  };

  /* ---------- IA (opcional) ---------- */
  function parseJsonLoose(text) {
    const t = String(text || "").trim();
    try { return JSON.parse(t); } catch (e) {}
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) { try { return JSON.parse(fence[1]); } catch (e) {} }
    const a = Math.min(...["{", "["].map(c => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
    const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a !== Infinity && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    throw { code: "invalid_json", text: t };
  }
  async function aiText(prompt, opts = {}) {
    if (!state.aiEnabled) throw { code: "sampling_disabled" };
    try { const r = await call("ai", { method: "POST", body: { prompt }, signal: opts.signal }); return { text: r.text, truncated: false }; }
    catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled" }; throw { code: e.status === 429 ? "rate_limited" : (e.status === 501 ? "sampling_disabled" : "upstream_error"), message: e.message }; }
  }
  const sample = Object.assign((p, o) => aiText(p, o), { json: async (p, o) => parseJsonLoose((await aiText(p, o)).text), limits: async () => ({ maxPromptBytes: 60000 }) });

  /* ---------- window.claude (misma interfaz que en Claude) ---------- */
  const dict = makeDictation();
  window.claude = {
    use: async name => ({ db, assets, dictation: dict, downloads, sample, user: null })[name] ?? null,
  };

  /* ---------- API propia para el acceso con código ---------- */
  window.VoltaAPI = {
    hasSession: () => !!tok.get(),
    session: () => { const t = tok.get(); return t ? { role: t.role, who: t.who } : null; },
    async login(code) { const r = await call("login", { method: "POST", body: { code } }); tok.set(r); await refresh(); return r; },
    logout() { tok.clear(); state.aiEnabled = false; refresh(); },
    refresh,
    clickupEnabled: () => state.clickupEnabled,
    async setStatus(id, status, note) {
      const r = await call("api", { method: "POST", body: { action: "setStatus", id, status, ...(typeof note === "string" ? { note } : {}) } });
      const i = state.tasks.findIndex(t => t.id === r.id); if (i >= 0) state.tasks[i] = r.task;
      emit("tasks"); return r.task;
    },
    clickupSearch: (q, signal, f) => call("clickup?q=" + encodeURIComponent(q || "") + "&f=" + encodeURIComponent(f || "todas"), { signal }).then(r => { const l = r.tasks || []; l.counts = r.counts || null; return l; }),
    clickupTask: id => call("clickup?id=" + encodeURIComponent(id)).then(r => r.task),
  };
  if (tok.get()) refresh();
})();
