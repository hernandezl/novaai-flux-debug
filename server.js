// server.js — NovaAI (único motor: Flux 1.1 Pro en Replicate)
// ----------------------------------------------------------
// Endpoints:
//   GET  /api/health
//   POST /api/generate
//
// Body esperado (JSON):
// {
//   "op": "qa-useb" | "qa-replace" | "qa-overlay" | "qa-insert" | "" ,
//   "prompt": "texto",
//   "negative": "texto negativo opcional",
//   "ref": "data:image/png;base64,...",         // A (opcional)
//   "image_base64": "data:image/... || base64", // B (opcional)
//   "image": "...", "image_b64": "...", "b64": "...",  // aliases de B
//   "params": { "strength": 0.35, "guidance_scale": 4.5, "seed": 0, "width": 1024, "height": 1024 }
// }
//
// Respuesta:
// { ok: true, engine: "black-forest-labs/flux-1.1-pro", image_url: "...", inputEcho: {...}, ... }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// Node 18+ ya trae fetch nativo
const app = express();
app.use(cors());
app.use(express.json({ limit: '18mb' })); // permite dataURL grandes

// --------- Config ----------
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN || '';
const MODEL = 'black-forest-labs/flux-1.1-pro';
const REPLICATE_BASE = 'https://api.replicate.com/v1';

// --------- Helpers ----------
function stripDataHeader(s = '') {
  if (!s) return '';
  if (s.startsWith('data:image/')) {
    const idx = s.indexOf('base64,');
    return idx > -1 ? s.slice(idx + 'base64,'.length) : s;
  }
  return s; // puede venir ya en base64 “limpio”
}

function pickB(body = {}) {
  const raw =
    body.image_base64 ||
    body.image ||
    body.image_b64 ||
    body.b64 ||
    '';
  return stripDataHeader(raw);
}

function hasSomething(v) {
  return !!(v && String(v).length > 0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Construye los inputs para Flux 1.1 Pro.
// Nota: distintos proveedores usan claves ligeramente diferentes;
// aquí usamos nombres “seguros”: prompt, image, strength, guidance, seed, width, height.
// Si el backend de Replicate ignora alguna, no rompe.
function buildFluxInputs(body) {
  const op = String(body.op || '').toLowerCase();
  const prompt = body.prompt || '';
  const negative = body.negative || '';

  // B (img2img)
  const b64 = pickB(body);
  const imageDataUrl = hasSomething(b64) ? `data:image/png;base64,${b64}` : undefined;

  // A (referencia / ip-adapter). No todos los runners lo exponen como input estándar,
  // pero se incluye cuando esté soportado.
  const ref = hasSomething(body.ref) ? body.ref : undefined;

  // params
  const p = body.params || {};
  let strength =
    typeof p.strength === 'number'
      ? p.strength
      : typeof p.param_strength === 'number'
      ? p.param_strength
      : 0.35;

  let guidance =
    typeof p.guidance_scale === 'number'
      ? p.guidance_scale
      : typeof p.guidance === 'number'
      ? p.guidance
      : 4.5;

  const seed = typeof p.seed === 'number' ? p.seed : undefined;
  const width = typeof p.width === 'number' ? p.width : undefined;
  const height = typeof p.height === 'number' ? p.height : undefined;

  // Caso especial: Use only B ⇒ fidelidad máxima (no añadir ruido a B).
  if (op === 'qa-useb') {
    strength = 0.0;
    // guidance moderado para no “alucinar” detalles fuera de B
    if (typeof p.guidance_scale !== 'number' && typeof p.guidance !== 'number') {
      guidance = 5.0;
    }
  }

  // Construimos inputs “conservadores”
  const inputs = {
    prompt,
    negative_prompt: negative || undefined,
    image: imageDataUrl,            // B (img2img). Si no hay, Flux hará txt2img
    strength,                       // 0.0..1.0
    guidance,                       // 0..~8 aprox
    seed,
    width,
    height,
    // Campos opcionales si el runner los soporta:
    // ip_adapter_image / reference_image / conditioning_image…
    ip_adapter_image: ref,          // A (si el modelo lo ignora, no pasa nada)
    reference_image: ref
  };

  // Limpia undefined
  Object.keys(inputs).forEach((k) => inputs[k] === undefined && delete inputs[k]);
  return { inputs, op, b64len: b64.length, hasRef: !!ref };
}

async function createPrediction(inputs) {
  if (!REPLICATE_TOKEN) {
    const err = new Error('REPLICATE_API_TOKEN missing');
    err.code = 401;
    throw err;
  }

  const res = await fetch(`${REPLICATE_BASE}/models/${MODEL}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${REPLICATE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: inputs })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`Replicate create error: ${res.status} ${t}`);
    err.code = res.status;
    throw err;
  }

  return res.json();
}

async function waitPrediction(getUrl) {
  // Sondear hasta "succeeded" | "failed" | "canceled"
  for (let i = 0; i < 80; i++) { // ~2 min a 1.5s
    await sleep(1500);
    const r = await fetch(getUrl, {
      headers: { Authorization: `Token ${REPLICATE_TOKEN}` }
    });
    const j = await r.json();
    if (j.status === 'succeeded' || j.status === 'failed' || j.status === 'canceled') {
      return j;
    }
  }
  const err = new Error('Timeout waiting prediction');
  err.code = 504;
  throw err;
}

// --------- Routes ----------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    engine: MODEL,
    time: new Date().toISOString()
  });
});

app.post('/api/generate', async (req, res) => {
  try {
    const { inputs, op, b64len, hasRef } = buildFluxInputs(req.body || {});
    const inputEcho = { op, hasA: hasRef, hasB: b64len > 0, lenA: hasRef ? (req.body.ref?.length || 0) : 0, lenB: b64len, params: { strength: inputs.strength, guidance: inputs.guidance, seed: inputs.seed, width: inputs.width, height: inputs.height } };

    // Pequeñas guardas para evitar “genéricas” por configuración imposible
    if (['qa-replace', 'qa-overlay', 'qa-insert'].includes(op) && !hasRef) {
      return res.status(400).json({
        ok: false,
        warning: 'Missing A for AB operation; would fall back to txt2img.',
        inputEcho
      });
    }
    if (op === 'qa-useb' && !inputEcho.hasB) {
      return res.status(400).json({
        ok: false,
        warning: 'Missing B for "use only B".',
        inputEcho
      });
    }

    // Crear predicción
    const created = await createPrediction(inputs);
    const getUrl = created?.urls?.get;
    if (!getUrl) {
      return res.status(502).json({ ok: false, warning: 'No polling URL from Replicate', engine: MODEL, inputEcho, raw: created });
    }

    const done = await waitPrediction(getUrl);
    if (done.status !== 'succeeded') {
      return res.status(502).json({
        ok: false,
        engine: MODEL,
        status: done.status,
        error: done.error || null,
        inputEcho,
        raw: done
      });
    }

    // Replicate suele devolver `output` como URL o array de URLs
    let image_url = null;
    if (Array.isArray(done.output) && done.output.length) image_url = done.output[0];
    else if (typeof done.output === 'string') image_url = done.output;

    return res.json({
      ok: true,
      engine: MODEL,
      image_url,
      inputEcho,
      replicate_id: done.id
    });
  } catch (err) {
    const code = err.code || 500;
    return res.status(code).json({
      ok: false,
      engine: MODEL,
      error: String(err && err.message ? err.message : err),
    });
  }
});

// --------- Listen ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[NovaAI] Server up on ${PORT} · Engine: ${MODEL}`);
});
