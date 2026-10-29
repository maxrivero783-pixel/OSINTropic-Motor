// OSINTropic-Motor — servicio de análisis para Render (Node >= 18, sin dependencias).
// Recibe trabajos del worker Infowar (docs + prompts + credenciales efímeras),
// ejecuta la cadena gemini → openrouter → workers_ai con plazos generosos y
// concurrencia, y devuelve el resultado por callback (y por sondeo).
//
// Endpoints:
//   GET  /salud                 → estado del motor
//   POST /trabajos              → encola un trabajo (header X-Clave-Motor)
//   GET  /trabajos/{id}         → estado/resultado de un trabajo
//
// Env: CLAVE_MOTOR (obligatorio), PORT.

import http from "node:http";
import crypto from "node:crypto";

const VERSION = "motor-1.0.0";
const PUERTO = Number(process.env.PORT || 8787);
const CLAVE = process.env.CLAVE_MOTOR || "";

const MAX_DOCS = 40;
const DOC_USER_MAX = 60000; // tope duro por documento para proteger memoria
const MAX_TRABAJOS_EN_MEMORIA = 24;

/** @type {Map<string, any>} */
const trabajos = new Map();

function claveOk(req) {
  return CLAVE.length > 0 && req.headers["x-clave-motor"] === CLAVE;
}

function log(...args) {
  console.log(new Date().toISOString(), "[motor]", ...args);
}

// ── Adaptadores de proveedores ──────────────────────────────────────────────

async function llamarGemini(modelo, doc, cfg, creds, signal) {
  const base = (cfg.gemini_base || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const url = `${base}/models/${encodeURIComponent(modelo)}:generateContent`;
  const hacer = (conThinking) => fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": creds.gemini_key || "",
      // El AI Gateway de CF filtra por firma; un UA reconocible evita el 1010.
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) OSINTropic-Motor/1.0",
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: doc.system }] },
      contents: [{ role: "user", parts: [{ text: doc.user }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        maxOutputTokens: cfg.salida_tokens || 2048,
        ...(conThinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
      },
    }),
  });
  let r = await hacer(true);
  if (r.status === 429 || r.status >= 500) {
    await new Promise((ok) => setTimeout(ok, r.status === 429 ? 1500 : 1000));
    r = await hacer(true);
  }
  if (r.status === 400) {
    // Algunos modelos lite rechazan thinkingConfig (INVALID_ARGUMENT):
    // reintento sin thinking, patrón verificado en Vector y en el motor CF.
    const det = (await r.text()).replace(/\s+/g, " ").slice(0, 160);
    const r2 = await hacer(false);
    if (!r2.ok) {
      const det2 = (await r2.text()).replace(/\s+/g, " ").slice(0, 160);
      throw new Error(`gemini_http_400:${det} | sin_thinking_${r2.status}:${det2}`);
    }
    r = r2;
  }
  if (r.status === 429) throw new Error("gemini_429_cuota");
  if (!r.ok) throw new Error("gemini_http_" + r.status);
  const j = await r.json();
  if (j.promptFeedback?.blockReason) throw new Error("gemini_bloqueado:" + j.promptFeedback.blockReason);
  const texto = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!texto) throw new Error("gemini_sin_candidatos");
  return texto;
}

async function llamarOpenRouter(modelo, doc, cfg, creds, signal) {
  const claves = creds.openrouter_keys || [];
  if (claves.length === 0) throw new Error("openrouter_sin_claves");
  let ultimo = null;
  for (const k of claves) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${k}` },
        body: JSON.stringify({
          model: modelo,
          max_tokens: cfg.salida_tokens || 2048,
          temperature: 0,
          messages: [
            { role: "system", content: doc.system },
            { role: "user", content: doc.user },
          ],
        }),
      });
      if (r.status === 429) { ultimo = new Error("openrouter_429"); continue; }
      if (!r.ok) { ultimo = new Error("openrouter_http_" + r.status); continue; }
      const j = await r.json();
      const txt = j.choices?.[0]?.message?.content;
      if (!txt) { ultimo = new Error("openrouter_sin_contenido"); continue; }
      return txt;
    } catch (e) {
      ultimo = e;
      if (e?.name === "AbortError") break;
    }
  }
  throw ultimo || new Error("openrouter_fallo");
}

async function llamarWorkersAI(modelo, doc, cfg, creds, signal) {
  if (!creds.cf_token || !creds.cf_account) throw new Error("wa_sin_creds");
  // El modelo es una ruta ("@cf/meta/llama-4-scout-17b-16e-instruct"):
  // codificarla entera rompe la API (400). Codificar solo cada segmento.
  const ruta = modelo.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.cf_account}/ai/run/${ruta}`;
  const r = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.cf_token}` },
    body: JSON.stringify({
      max_tokens: cfg.salida_tokens || 2048,
      messages: [
        { role: "system", content: doc.system },
        { role: "user", content: doc.user },
      ],
    }),
  });
  if (r.status === 429) throw new Error("wa_429");
  if (!r.ok) {
    let det = "";
    try { det = (await r.text()).slice(0, 120); } catch { /* sin cuerpo */ }
    throw new Error(`wa_http_${r.status}${det ? ":" + det : ""}`);
  }
  const j = await r.json();
  if (!j.success) throw new Error("wa_error:" + String(j.errors?.[0] ?? "?").slice(0, 80));
  const res = j.result;
  const txt = typeof res === "string" ? res : (res.response ?? res.choices?.[0]?.message?.content);
  if (!txt) throw new Error("wa_sin_contenido");
  return txt;
}

const LLAMADORES = { gemini: llamarGemini, openrouter: llamarOpenRouter, workers_ai: llamarWorkersAI };

// ── Cadena por documento ────────────────────────────────────────────────────

function escalonesDe(job) {
  const orden = Array.isArray(job.cfg?.orden) && job.cfg.orden.length
    ? job.cfg.orden : ["gemini", "openrouter", "workers_ai"];
  const modelos = job.cfg?.modelos || {};
  const lista = [];
  for (const prov of orden) {
    const ms = modelos[prov] || [];
    if (ms.length === 0) lista.push([prov, null]); // modelo por defecto del adaptador
    else for (const m of ms) lista.push([prov, m]);
  }
  return lista;
}

async function analizarDoc(doc, job) {
  const intentoMs = Math.max(5000, Math.min(300000, Number(job.cfg?.intento_ms) || 90000));
  const errores = [];
  for (const [prov, modelo] of escalonesDe(job)) {
    const t0 = Date.now();
    const ac = new AbortController();
    const reloj = setTimeout(() => ac.abort(new Error("timeout_intento")), intentoMs);
    try {
      const llama = LLAMADORES[prov];
      if (!llama) throw new Error("proveedor_desconocido:" + prov);
      const d = { ...doc, user: String(doc.user || "").slice(0, DOC_USER_MAX) };
      const texto = await llama(modelo, d, job.cfg || {}, job.creds || {}, ac.signal);
      clearTimeout(reloj);
      return {
        id: doc.id, ok: true, proveedor: prov,
        modelo: `${prov}:${modelo ?? "(defecto)"}`,
        ms: Date.now() - t0, analisis: texto, errores,
      };
    } catch (e) {
      clearTimeout(reloj);
      const abort = e?.name === "AbortError" || e?.message === "timeout_intento";
      errores.push(`${prov}${modelo ? ":" + modelo : ""}→${abort ? "timeout_" + intentoMs + "ms" : String(e?.message || e).slice(0, 140)} [${Date.now() - t0}ms]`);
      if (abort && job.cfg?.cancelar_si_timeout) break; // ceder el doc
    }
  }
  return { id: doc.id, ok: false, proveedor: null, modelo: null, ms: 0, analisis: null, errores };
}

// ── Procesamiento con concurrencia ──────────────────────────────────────────

async function procesar(job) {
  const t0 = Date.now();
  const docs = job.docs.slice(0, MAX_DOCS);
  job.total = docs.length;
  job.hechos = 0;
  const resultados = new Array(docs.length);
  const conc = Math.max(1, Math.min(8, Number(job.cfg?.conc) || 4));
  let idx = 0;
  log(`trabajo ${job.id}: ${docs.length} docs, conc=${conc}, orden=${(job.cfg?.orden || []).join(">")}`);

  async function obrera() {
    while (idx < docs.length) {
      const i = idx++;
      resultados[i] = await analizarDoc(docs[i], job);
      job.hechos++;
      const r = resultados[i];
      log(`  doc ${i + 1}/${docs.length} ${r.ok ? "OK " + r.modelo + " " + r.ms + "ms" : "FALLO " + r.errores.join(" | ")}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, docs.length) }, obrera));

  const ok = resultados.filter((r) => r.ok).length;
  const porModelo = {};
  for (const r of resultados) {
    if (!r.ok) continue;
    porModelo[r.modelo] = (porModelo[r.modelo] || 0) + 1;
  }
  job.estado = "listo";
  job.resultados = resultados;
  job.resumen = {
    ms_total: Date.now() - t0, docs: docs.length, ok,
    fallos: docs.length - ok, por_modelo: porModelo,
  };
  log(`trabajo ${job.id} listo: ${ok}/${docs.length} en ${job.resumen.ms_total}ms`, JSON.stringify(porModelo));
  await notificar(job, true);
}

// ── Callback al worker ──────────────────────────────────────────────────────

async function notificar(job, final) {
  const cb = job.callback;
  if (!cb?.url) return;
  const cuerpo = JSON.stringify({
    trabajo_id: job.id,
    estado: job.estado,
    final: Boolean(final),
    resumen: job.resumen || null,
    resultados: job.resultados || null,
  });
  for (let intento = 1; intento <= 3; intento++) {
    const ac = new AbortController();
    const reloj = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(cb.url, {
        method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", "x-clave-motor": cb.clave || "" },
        body: cuerpo,
      });
      clearTimeout(reloj);
      if (r.ok) { log(`callback ${job.id} entregado (intento ${intento})`); return; }
      log(`callback ${job.id} HTTP ${r.status} (intento ${intento})`);
    } catch (e) {
      clearTimeout(reloj);
      log(`callback ${job.id} error: ${String(e?.message || e).slice(0, 80)} (intento ${intento})`);
    }
    await new Promise((res) => setTimeout(res, intento * 2500));
  }
}

// ── Servidor HTTP ───────────────────────────────────────────────────────────

function leerCuerpo(req, limite = 25 * 1024 * 1024) {
  return new Promise((res, rej) => {
    const partes = []; let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limite) { rej(new Error("cuerpo_demasiado_grande")); req.destroy(); return; }
      partes.push(c);
    });
    req.on("end", () => res(Buffer.concat(partes)));
    req.on("error", rej);
  });
}

function responder(res, codigo, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(codigo, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/salud") {
      return responder(res, 200, {
        ok: true, version: VERSION, trabajos_en_memoria: trabajos.size,
        en_curso: [...trabajos.values()].filter((t) => t.estado === "corriendo").length,
      });
    }

    if (url.pathname === "/trabajos" && req.method === "POST") {
      if (!claveOk(req)) return responder(res, 401, { error: "clave_invalida" });
      const bruto = await leerCuerpo(req);
      const cuerpo = JSON.parse(bruto.toString("utf8") || "{}");
      if (!Array.isArray(cuerpo.docs) || cuerpo.docs.length === 0)
        return responder(res, 400, { error: "docs_requeridos" });
      const id = String(cuerpo.trabajo_id || ("trb_" + crypto.randomUUID())).slice(0, 80);
      if (trabajos.has(id)) return responder(res, 409, { error: "trabajo_ya_existe", id });
      if (trabajos.size >= MAX_TRABAJOS_EN_MEMORIA) return responder(res, 503, { error: "motor_saturado" });
      const job = {
        id, estado: "corriendo", docs: cuerpo.docs,
        cfg: cuerpo.cfg || {}, creds: cuerpo.creds || {},
        callback: cuerpo.callback || null,
        creado: Date.now(), total: cuerpo.docs.length, hechos: 0,
        resultados: null, resumen: null,
      };
      trabajos.set(id, job);
      // Modo síncrono (29-10-2026): cfg.sincrono=true hace que la respuesta
      // del POST llegue con el trabajo YA terminado (contrato que consume el
      // escalón motor del worker Infowar). Sin él, el comportamiento de
      // siempre: 202 aceptado + callback + sondeo.
      if (cuerpo.cfg?.sincrono === true) {
        try {
          await procesar(job);
        } catch (e) {
          log(`trabajo ${id} ERROR (sincrono): ${String(e?.message || e)}`);
          job.estado = "error";
          job.resumen = { error: String(e?.message || e).slice(0, 200) };
        }
        return responder(res, 200, {
          trabajo_id: id,
          estado: job.estado === "final" ? "final" : job.estado,
          resumen: job.resumen,
          resultados: job.resultados,
        });
      }
      procesar(job).catch(async (e) => {
        log(`trabajo ${id} ERROR: ${String(e?.message || e)}`);
        job.estado = "error";
        job.resumen = { error: String(e?.message || e).slice(0, 200) };
        await notificar(job, true);
      });
      return responder(res, 202, { aceptado: true, id, total: job.total });
    }

    const mTrabajo = url.pathname.match(/^\/trabajos\/([^/]+)$/);
    if (mTrabajo && req.method === "GET") {
      if (!claveOk(req)) return responder(res, 401, { error: "clave_invalida" });
      const job = trabajos.get(decodeURIComponent(mTrabajo[1]));
      if (!job) return responder(res, 404, { error: "trabajo_desconocido" });
      return responder(res, 200, {
        id: job.id, estado: job.estado, total: job.total, hechos: job.hechos,
        resumen: job.resumen, resultados: job.resultados,
      });
    }

    return responder(res, 404, { error: "ruta_desconocida" });
  } catch (e) {
    return responder(res, 400, { error: String(e?.message || e).slice(0, 200) });
  }
});

servidor.listen(PUERTO, () => log(`OSINTropic-Motor ${VERSION} escuchando en :${PUERTO}`));
