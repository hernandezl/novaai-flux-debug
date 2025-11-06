import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL = "stability-ai/sdxl:1c7d06f4d08e01d75b825ad8f5644c46cd365382";

async function callReplicate(input) {
  const response = await axios.post(
    "https://api.replicate.com/v1/predictions",
    {
      version: MODEL,
      input
    },
    {
      headers: {
        Authorization: `Token ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
  return response.data;
}

app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, imageA, imageB, mode } = req.body;

    const input = {
      prompt,
      negative_prompt: "cartoon, blurry, CGI, bad texture",
      strength: 0.55,
      cfg_scale: 5,
      image: imageA || imageB,
      ...(mode === "b_to_a" && imageB && {
        ip_adapter_image: imageB,
        ip_adapter_scale: 0.8
      })
    };

    const result = await callReplicate(input);
    return res.json(result);
  } catch (e) {
    console.error(e.response?.data || e);
    res.status(500).json({ error: "replicate failed" });
  }
});

app.listen(3000, () => console.log("✅ Server running 3000"));
