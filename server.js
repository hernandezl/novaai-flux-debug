// server.js — NovaAI I2I DEBUG (Render/Local)
// SDXL img2img + IP-Adapter. Acepta imageA/imageB como data URL y las expone como URLs públicas.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Static /tmp for public URLs
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);
app.use('/tmp', express.static(TMP_DIR, { maxAge: '5m' }));

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_TOKEN) console.warn('⚠️  Missing REPLICATE_API_TOKEN');
// Stable SDXL img2img version
const SDXL_VERSION = 'stability-ai/sdxl:1c7d06f4d08e01d75b825ad8f5644c46cd365382';

function dataUrlToBuffer(dataUrl){
  const i = dataUrl.indexOf(',');
  if (i < 0) return null;
  const base64 = dataUrl.slice(i+1);
  return Buffer.from(base64, 'base64');
}
function saveDataUrl(dataUrl, name){
  const buf = dataUrlToBuffer(dataUrl);
  if(!buf) return null;
  const ext = (dataUrl.includes('image/png')?'.png': dataUrl.includes('image/webp')?'.webp':'.jpg');
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}${ext}`;
  const fpath = path.join(TMP_DIR, fname);
  fs.writeFileSync(fpath, buf);
  return fname;
}
function publicUrl(req, filename){
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  return `${proto}://${host}/tmp/${filename}`;
}

async function createPrediction(input){
  const url = 'https://api.replicate.com/v1/predictions';
  const resp = await axios.post(url, { version: SDXL_VERSION, input }, {
    headers: { Authorization: `Token ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 120000,
  });
  return resp.data;
}
async function waitPrediction(pred){
  let url = pred.urls?.get; if(!url) throw new Error('Missing polling URL');
  for(let i=0;i<80;i++){
    await new Promise(r=>setTimeout(r, 1500));
    const r = await axios.get(url, { headers: { Authorization: `Token ${REPLICATE_TOKEN}` }, timeout: 120000 });
    const j = r.data;
    if(j.status==='succeeded') return j;
    if(j.status==='failed' || j.status==='canceled') throw new Error(j.error || 'prediction failed');
  }
  throw new Error('prediction timeout');
}

app.get('/api/health', (_req, res)=> res.json({ ok:true, service:'novaai-i2i-debug', model:'SDXL img2img + IP-Adapter' }));

app.post('/api/generate', async (req, res)=>{
  try{
    const { prompt='', mode='b_to_a', imageA, imageB, params={} } = req.body || {};
    const { strength=0.55, cfg=5.0, steps=30, ip_scale=0.8, width=1024, height=1024, negative='cartoon, cgi, blurry, halo, mismatch, low quality' } = params;

    // Save data URLs to /tmp and expose as URLs (Replicate runners prefer URLs)
    let baseFile = null, refFile = null;
    if(imageA){ baseFile = saveDataUrl(imageA, 'A'); }
    if(imageB){ refFile  = saveDataUrl(imageB, 'B'); }

    const imageUrl = (req) => baseFile ? publicUrl(req, baseFile) : (refFile ? publicUrl(req, refFile) : undefined);
    const refUrl   = (req) => refFile ? publicUrl(req, refFile) : undefined;

    // Build input
    const input = {
      prompt,
      negative_prompt: negative,
      image: imageUrl(req),
      strength,
      cfg_scale: cfg,
      steps,
      width, height,
      ...(mode==='b_to_a' && refUrl(req) ? { ip_adapter_image: refUrl(req), ip_adapter_scale: ip_scale } : {}),
      ...(mode==='overlay' && refUrl(req) ? { ip_adapter_image: refUrl(req), ip_adapter_scale: Math.max(0.1, ip_scale*0.7) } : {}),
    };

    console.log('---- /api/generate ----');
    console.log('mode:', mode, '| hasA:', !!imageA, '| hasB:', !!imageB);
    console.log('input keys:', Object.keys(input));

    const pred = await createPrediction(input);
    const done = await waitPrediction(pred);

    let outUrl = null;
    if (Array.isArray(done.output) && done.output.length > 0) outUrl = done.output[0];
    else if (typeof done.output === 'string') outUrl = done.output;

    if (!outUrl) return res.json({ ok:true, msg:'No output url from model', meta: done });

    return res.json({ ok:true, url: outUrl, meta: { id: done.id, metrics: done.metrics } });
  }catch(err){
    console.error('ERR /api/generate', err?.response?.data || err?.message || err);
    return res.status(500).json({ ok:false, msg:'replicate_failed', detail: err?.response?.data || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ NovaAI I2I server on ${PORT}`));
