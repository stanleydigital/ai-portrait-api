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

// ------- Cloudinary upload helper (no caching, KV removed) -------
async function uploadResultToCloudinary(fileUrl: string, predictionId: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const apiKey = process.env.CLOUDINARY_API_KEY!;
  const apiSecret = process.env.CLOUDINARY_API_SECRET!;

  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `results/${predictionId}`;

  // Generate signature for signed upload
  const paramsToSign: Record<string, any> = {
    timestamp,
    public_id: publicId,
    folder: "results"
  };

  const sortedParams = Object.keys(paramsToSign)
    .sort()
    .map(key => `${key}=${paramsToSign[key]}`)
    .join("&");

  const stringToSign = sortedParams + apiSecret;
  const msgUint8 = new TextEncoder().encode(stringToSign);
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  const fd = new FormData();
  fd.append("file", fileUrl);
  fd.append("api_key", apiKey);
  fd.append("timestamp", timestamp.toString());
  fd.append("signature", signature);
  fd.append("public_id", publicId);
  fd.append("folder", "results");

  const r = await fetch(endpoint, { method: "POST", body: fd });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Cloudinary upload failed: ${r.status} ${txt}`);
  }
  const json = await r.json();
  return json.secure_url as string;
}

// ------- Poll by prediction ID -------
async function pollById(id: string, debug = false) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
  });

  if (!r.ok) {
    const txt = await r.text();
    return { status: "failed" as const, id, error: `Replicate fetch failed: ${r.status} ${txt}` };
  }

  const pred = await r.json();

  if (debug) {
    return { status: pred.status, raw: pred };
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
        cdn_url = replicateUrl; // fallback so the frontend still gets a URL
      }
    }

    return {
      status: "succeeded" as const,
      id,
      output: replicateUrl ? [replicateUrl] : [],
      cdn_url
    };
  }

  if (status === "failed" || status === "canceled") {
    return { status: status as "failed" | "canceled", id, error: pred.error || null };
  }

  return { status: "processing" as const, id };
}

// ------- Poll by get_url -------
async function pollByGetUrl(get_url: string, debug = false) {
  const r = await fetch(get_url, {
    headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
  });

  if (!r.ok) return { status: "failed" as const, error: `Replicate fetch failed: ${r.status}` };

  const pred = await r.json();
  const id = pred.id;

  if (debug) {
    return { status: pred.status, raw: pred };
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
        cdn_url = replicateUrl; // fallback so the frontend still gets a URL
      }
    }

    return {
      status: "succeeded" as const,
      output: replicateUrl ? [replicateUrl] : [],
      cdn_url
    };
  }

  if (status === "failed" || status === "canceled") {
    return { status: status as "failed" | "canceled", error: pred.error || null };
  }

  return { status: "processing" as const };
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
