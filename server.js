import express from "express";
import cors from "cors";
import multer from "multer";
import Replicate from "replicate";

// === App base ===
const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: "50mb" }));
const upload = multer({ storage: multer.memoryStorage() });

// === Config ===
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// === Salud (dos rutas por comodidad) ===
app.get("/", (_, res) => res.json({ ok: true, service: "NovaAI Backend v2" }));
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/api/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// === Test del token/modelo en Replicate ===
app.get("/api/replicate-test", async (_, res) => {
  try {
    if (!REPLICATE_API_TOKEN) {
      return res.status(401).json({ ok: false, msg: "REPLICATE_API_TOKEN not set" });
    }
    // Leer info del modelo oficial (no necesita version)
    const r = await fetch("https://api.replicate.com/v1/models/bytedance/seededit-3.0", {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, msg: "Replicate error", data });
    res.json({ ok: true, model: "bytedance/seededit-3.0", data });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err?.message || "unknown error" });
  }
});

// === Generate ===
// Acepta:
// - JSON: { ref, prompt, negative, font, strength }
// - multipart: file (imagen) + campos (ref/prompt/etc.)
app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) {
      return res.status(401).json({ ok: false, msg: "Missing REPLICATE_API_TOKEN" });
    }

    const { ref, prompt, negative, strength } = req.body;
    const useStrength = typeof strength === "number" ? strength : Number(strength) || 0.35;

    // Imagen de entrada: archivo subido o URL/dataURL en "ref"
    let inputImage = ref || null;
    if (req.file?.buffer && req.file?.mimetype) {
      const b64 = req.file.buffer.toString("base64");
      inputImage = `data:${req.file.mimetype};base64,${b64}`;
    }
    if (!inputImage) {
      return res.status(400).json({ ok: false, msg: "Missing input image (ref or file)" });
    }

    // 1) Intentar SeedEdit 3.0 (edición fiel)
    try {
      const out = await replicate.run("bytedance/seededit-3.0", {
        input: {
          image: inputImage,
          prompt: prompt || "Faithful figure/text replacement for acrylic lamp design",
          negative_prompt: negative || "",
          guidance_scale: 5.5 // valor recomendado por BYTEDANCE
        }
      });
      // SeedEdit devuelve un string con URL de imagen
      const image = Array.isArray(out) ? out[0] : out;
      return res.json({ ok: true, engine: "seededit-3.0", image });
    } catch (e) {
      // Si falla, lo registramos y seguimos al fallback
      console.error("SeedEdit error:", e?.message || e);
    }

    // 2) Fallback Flux Schnell (rápido y barato)
    try {
      const out2 = await replicate.run("black-forest-labs/flux-schnell", {
        input: {
          prompt: prompt || "Design for acrylic LED lamp, preserve layout",
          guidance: 3
        }
      });
      const image = Array.isArray(out2) ? out2[0] : out2;
      return res.json({ ok: true, engine: "flux-schnell", image });
    } catch (e2) {
      console.error("Flux error:", e2?.message || e2);
    }

    // Si ambos fallan:
    return res.status(422).json({
      ok: false,
      msg: "All engines failed (SeedEdit and Flux). Check token, inputs or model availability."
    });
  } catch (err) {
    console.error("Generate fatal:", err);
    res.status(500).json({ ok: false, msg: err?.message || "Unknown error" });
  }
});

// === Start ===
app.listen(PORT, () => {
  console.log(`✅ NovaAI backend listening on :${PORT}`);
});
