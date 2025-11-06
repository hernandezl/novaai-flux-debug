// server.js — Flux Pro + Fallback
import 'dotenv/config';
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({limit:"18mb"}));

const TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL = "black-forest-labs/flux-1.1-pro";

async function urlToDataURL(url){
 const r = await fetch(url);
 const buf = Buffer.from(await r.arrayBuffer());
 return `data:image/png;base64,${buf.toString("base64")}`;
}

async function build(body){
 let A = "";
 if(body.ref_url) A = await urlToDataURL(body.ref_url);

 let B = "";
 if(body.image_url) B = await urlToDataURL(body.image_url);

 return {
  prompt: body.prompt || "",
  image: B || undefined,
  strength: body.op==="qa-onlyB"?0.0:0.35,
  guidance: body.op==="qa-onlyB"?5.0:4.5,
  ip_adapter_image: A || undefined,
  reference_image: A || undefined,
  width: body.params?.width || 1024,
  height: body.params?.height || 1024
 };
}

async function replicate(inputs){
 const r = await fetch(`https://api.replicate.com/v1/models/${MODEL}/predictions`,{
   method:"POST",
   headers:{Authorization:`Token ${TOKEN}`,"Content-Type":"application/json"},
   body: JSON.stringify({input:inputs})
 });
 const j = await r.json();
 let url = j?.urls?.get;
 for(let i=0;i<80;i++){
  await new Promise(r=>setTimeout(r,1500));
  const st = await fetch(url,{headers:{Authorization:`Token ${TOKEN}`}});
  const sj = await st.json();
  if(sj.status==="succeeded"){
    const out = Array.isArray(sj.output)?sj.output[0]:sj.output;
    return out;
  }
 }
 throw "timeout";
}

app.post("/api/generate",async(req,res)=>{
 try{
   const inputs = await build(req.body);
   const out = await replicate(inputs);
   return res.json({image_url:out});
 }catch(e){
   return res.json({error:true});
 }
});

app.listen(3000,()=>console.log("Flux server READY"));
