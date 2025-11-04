export const config = { runtime: "edge" };

// --- Allow-list of origins that can call your API ---
const ALLOWED_ORIGINS = new Set([
  "https://pawinci.com",
  "https://www.pawinci.com",
  "https://pawincistore.myshopify.com"
]);

function corsWithOrigin(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    headers: {
      "Content-Type": "application/json",
      ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  };
}

// ------- KV Storage -------
let kv: any = null;

async function initKV() {
  if (kv) return kv;
  
  try {
    // @ts-ignore
    const { kv: kvClient } = await import('@vercel/kv');
    kv = kvClient;
    return kv;
  } catch (err) {
    console.warn("⚠️ Vercel KV not available");
    return null;
  }
}

// ------- Helper: recursively find a URL in Replicate output -------
function pickUrl(output: any): string | null {
  if (!output) return null;
  if (typeof output === "string" && /^https?:\/\//.test(output)) return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const u = pickUrl(item);
      if (u) return u;
    }
  } else if (typeof output === "object") {
    for (const v of Object.values(output)) {
      const u = pickUrl(v);
      if (u) return u;
    }
  }
  return null;
}

// ------- Cloudinary upload helper with CACHING -------
async function uploadResultToCloudinary(fileUrl: string, predictionId: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET!;
  
  // Check cache first to avoid duplicate uploads
  const kvClient = await initKV();
  if (kvClient) {
    const cacheKey = `cdn:${predictionId}`;
    const cached = await kvClient.get(cacheKey);
    if (cached) {
      console.log("✅ Using cached Cloudinary URL:", predictionId);
      return cached as string;
    }
  }
  
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  
  const fd = new FormData();
  fd.append("file", fileUrl);
  fd.append("upload_preset", preset);
  fd.append("public_id", `results/${predictionId}`);
  fd.append("overwrite", "false");
  
  const r = await fetch(endpoint, { method: "POST", body: fd });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Cloudinary upload failed: ${r.status} ${txt}`);
  }
  const json = await r.json();
  const cdnUrl = json.secure_url as string;
  
  // Cache the result for 7 days
  if (kvClient) {
    await kvClient.set(`cdn:${predictionId}`, cdnUrl, { ex: 604800 });
    console.log("✅ Cached Cloudinary URL:", predictionId);
  }
  
  return cdnUrl;
}

// ------- Poll helpers with webhook cache check -------
async function pollById(id: string, debug = false) {
  // OPTIMIZATION: Check webhook cache first
  const kvClient = await initKV();
  if (kvClient) {
    const cached = await kvClient.get(`prediction:${id}`);
    if (cached) {
      console.log("⚡ Using webhook cache:", id);
      return cached as any;
    }
  }
  
  // If not in cache, poll Replicate
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
  });
  
  if (!r.ok) {
    const txt = await r.text();
    return { status: "failed", id, error: `Replicate fetch failed: ${r.status} ${txt}` } as const;
  }
  
  const pred = await r.json();
  
  if (debug) {
    return { status: pred.status, raw: pred } as const;
  }
  
  const status = (pred.status || "").toLowerCase();
  
  if (status === "succeeded") {
    const replicateUrl = pickUrl(pred.output);
    let cdn_url: string | null = null;
    
    if (replicateUrl) {
      try {
        cdn_url = await uploadResultToCloudinary(replicateUrl, id);
        console.log("✅ Uploaded to Cloudinary:", id);
      } catch (e) {
        console.warn("Cloudinary upload failed (fallback to Replicate URL):", e);
      }
    }
    
    const result = {
      status: "succeeded",
      id,
      output: replicateUrl ? [replicateUrl] : [],
      cdn_url
    };
    
    // Cache for future requests
    if (kvClient) {
      await kvClient.set(`prediction:${id}`, result, { ex: 86400 });
    }
    
    return result as const;
  }
  
  if (status === "failed" || status === "canceled") {
    const result = { status, id, error: pred.error || null };
    
    // Cache errors too
    if (kvClient) {
      await kvClient.set(`prediction:${id}`, result, { ex: 3600 });
    }
    
    return result as const;
  }
  
  // Still processing
  return { status: "processing", id } as const;
}

async function pollByGetUrl(get_url: string, debug = false) {
  const r = await fetch(get_url, {
    headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
  });
  
  if (!r.ok) return { status: "failed", error: `Replicate fetch failed: ${r.status}` } as const;
  
  const pred = await r.json();
  const id = pred.id;
  
  // If we have an ID, check cache
  if (id) {
    const kvClient = await initKV();
    if (kvClient) {
      const cached = await kvClient.get(`prediction:${id}`);
      if (cached) {
        console.log("⚡ Using webhook cache:", id);
        return cached as any;
      }
    }
  }
  
  if (debug) {
    return { status: pred.status, raw: pred } as const;
  }
  
  const status = (pred.status || "").toLowerCase();
  
  if (status === "succeeded") {
    const replicateUrl = pickUrl(pred.output);
    let cdn_url: string | null = null;
    
    if (replicateUrl && id) {
      try {
        cdn_url = await uploadResultToCloudinary(replicateUrl, id);
        console.log("✅ Uploaded to Cloudinary:", id);
      } catch (e) {
        console.warn("Cloudinary upload failed (fallback to Replicate URL):", e);
      }
    }
    
    const result = {
      status: "succeeded",
      output: replicateUrl ? [replicateUrl] : [],
      cdn_url
    };
    
    // Cache for future requests
    if (id) {
      const kvClient = await initKV();
      if (kvClient) {
        await kvClient.set(`prediction:${id}`, result, { ex: 86400 });
      }
    }
    
    return result as const;
  }
  
  if (status === "failed" || status === "canceled") {
    return { status, error: pred.error || null } as const;
  }
  
  return { status: "processing" } as const;
}

// ------- Main handler -------
export default async function handler(req: Request) {
  const origin = req.headers.get("origin");
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...corsWithOrigin(origin) });
  }
  
  try {
    if (req.method === "GET") {
      const { searchParams } = new URL(req.url);
      const id = searchParams.get("id");
      const debug = searchParams.get("debug") === "1";
      
      if (!id) {
        const get_url = searchParams.get("get_url");
        if (!get_url) {
          return new Response(JSON.stringify({ error: "Missing id" }), {
            status: 200, ...corsWithOrigin(origin)
          });
        }
        const data = await pollByGetUrl(get_url, debug);
        return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
      }
      
      const data = await pollById(id, debug);
      return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
    }
    
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const get_url: string | undefined = body.get_url;
      const debug = body.debug === true;
      if (!get_url) {
        return new Response(JSON.stringify({ error: "Missing get_url" }), {
          status: 200, ...corsWithOrigin(origin)
        });
      }
      const data = await pollByGetUrl(get_url, debug);
      return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
    }
    
    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  } catch (err: any) {
    console.error("Poll server error:", err);
    return new Response(JSON.stringify({ status: "processing" }), {
      status: 200, ...corsWithOrigin(origin)
    });
  }
}
