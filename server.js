import express from "express";
import cors from "cors";
import multer from "multer";
import Replicate from "replicate";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));
app.use(express.json({ limit: "50mb" }));

// Para soportar multipart si algún día envías archivos directos
const upload = multer({ storage: multer.memoryStorage() });

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const IMAGE_ENGINE = process.env.IMAGE_ENGINE || "black-forest-labs/flux-1.1-pro";
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// -------- utilidades --------
function guidanceFromStrength(s) {
  s = Math.max(0, Math.min(1, Number(s)));
  return 3 + (8 - 3) * s; // 3..8
}
function guidanceText({ keep_background = true, preserve_subject = true, preserve_layout = true, op = "" }) {
  const g = [];
  if (keep_background) g.push("Keep SAME background.");
  if (preserve_subject) g.push("Preserve subject identity, silhouette, materials and colors.");
  if (preserve_layout)  g.push("Preserve layout, composition, camera and framing.");
  if (op === "qa-replace") g.push("Replace A's main figure with B while keeping A's background and camera.");
  if (op === "qa-overlay") g.push("Overlay B on A without changing A's background or camera.");
  if (op === "qa-insert")  g.push("Insert B into A respecting perspective and lighting; do not change background.");
  if (op === "qa-remove")  g.push("Remove figure B; keep background and layout of A.");
  g.push("Apply ONLY the requested change. Avoid style drift.");
  return g.join(" ");
}
async function run(engine, input) {
  const out = await replicate.run(engine, { input });
  return Array.isArray(out) ? out[0] : out;
}

// -------- endpoints --------
app.get("/api/health", (_, res) => {
  res.json({ ok: true, engine: IMAGE_ENGINE, time: new Date().toISOString() });
});

// Este endpoint acepta:
// { ref (A base64), image_base64 (B base64), prompt, negative, op, params, debug }
app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    const body = req.body || {};
    const raw = typeof body.params === "string" ? (() => { try { return JSON.parse(body.params); } catch { return {}; } })() : (body.params || {});
    const keep_background = !!(raw.keep_background ?? true);
    const preserve_subject = !!(raw.preserve_subject ?? true);
    const preserve_layout  = !!(raw.preserve_layout  ?? true);
    const strength         = Number(raw.strength ?? 0.35);
    const op               = (body.op || "").trim();
    const guidance_scale   = guidanceFromStrength(strength);

    // A (catálogo) y B (upload/reference)
    let A = body.ref || null;
    let B = body.image_base64 || body.imageB || null;

    // Si viene archivo multipart, lo convertimos a dataURL base64
    if (req.file?.buffer && req.file?.mimetype) {
      const b64 = req.file.buffer.toString("base64");
      B = `data:${req.file.mimetype};base64,${b64}`;
    }

    const received = {
      hasA: !!A, hasB: !!B, lenA: A?.length || 0, lenB: B?.length || 0, op,
      keep_background, preserve_subject, preserve_layout, guidance_scale
    };

    if (!REPLICATE_API_TOKEN) return res.status(401).json({ ok: false, msg: "Missing REPLICATE_API_TOKEN", received });
    if (!A && !B)           return res.status(400).json({ ok: false, msg: "Missing input image (ref or file)", received });

    const prompt = [
      guidanceText({ keep_background, preserve_subject, preserve_layout, op }),
      (body.prompt?.trim() ? `User: ${body.prompt.trim()}` : "")
    ].filter(Boolean).join(" ");
    const negative = (body.negative || "").trim();

    // Modo diagnóstico: no llama al modelo, solo eco
    if (String(body.debug || "").toLowerCase() === "true") {
      return res.json({ ok: true, engine: IMAGE_ENGINE, received, prompt, negative });
    }

    // Solo A o solo B → img2img simple
    if (!!A ^ !!B) {
      const img = A || B;
      const out = await run(IMAGE_ENGINE, {
        image: img,
        prompt,
        negative_prompt: negative,
        guidance_scale
      });
      return res.json({ ok: true, engine: IMAGE_ENGINE, image: out, customer: out, received });
    }

    // A + B → intentos con parámetros de referencia comunes (IP-Adapter/conditioning)
    const shared = { prompt, negative_prompt: negative, guidance_scale };
    const tries = [
      async () => run(IMAGE_ENGINE, { image: A, reference_image: B,   ...shared }),
      async () => run(IMAGE_ENGINE, { image: A, adapter_image: B,     ...shared }),
      async () => run(IMAGE_ENGINE, { image: A, conditioning_image: B,...shared }),
      async () => run(IMAGE_ENGINE, { image: A, image_b: B,           ...shared }),
    ];
    let final = null, lastErr = null, attempt = -1;
    for (let i = 0; i < tries.length; i++) {
      try { final = await tries[i](); attempt = i; if (final) break; } catch (e) { lastErr = e; }
    }
    if (!final) return res.status(422).json({ ok: false, msg: "Engine does not support A+B with current params", received, attempt, detail: String(lastErr || "") });

    return res.json({ ok: true, engine: IMAGE_ENGINE, image: final, customer: final, received, attempt });
  } catch (e) {
    console.error("Fatal:", e);
    res.status(500).json({ ok: false, msg: e?.message || "Unknown error" });
  }
});

app.listen(PORT, () => console.log(`✅ Debug Flux 1.1 Pro listening on :${PORT}`));
