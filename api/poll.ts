export const config = { runtime: "edge" };

// --- Allow-list of origins that can call your API ---
const ALLOWED_ORIGINS = new Set([
  "https://pawinci.com",
  "https://www.pawinci.com",
  "https://pawincistore.myshopify.com" // Shopify theme editor
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

// ---------- Helper: recursively find a URL in Replicate output ----------
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

// ---------- Cloudinary upload helper ----------
async function uploadResultToCloudinary(fileUrl: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET!;
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

  const fd = new FormData();
  fd.append("file", fileUrl); // remote URL from Replicate
  fd.append("upload_preset", preset);

  const r = await fetch(endpoint, { method: "POST", body: fd });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Cloudinary upload failed: ${r.status} ${txt}`);
  }
  const json = await r.json();
  return json.secure_url as string; // stable CDN URL
}

// ---------- Track uploads to avoid duplicates ----------
const uploadedOnce = new Set<string>();

// ---------- Poll helpers ----------
async function pollById(id: string) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
  });

  if (!r.ok) {
    // transient hiccup → keep client polling
    return { status: "processing", id } as const;
  }

  const pred = await r.json();
  const status = (pred.status || "").toLowerCase();

  if (status === "succeeded") {
    const replicateUrl = pickUrl(pred.output);
    let cdn_url: string | null = null;

    // ✅ upload only once per prediction ID
    if (uploadedOnce.has(id)) {
      console.log("⏩ Skipping duplicate upload for", id);
    } else if (replicateUrl) {
      try {
        cdn_url = await uploadResultToCloudinary(replicateUrl);
        uploadedOnce.add(id);
        console.log("✅ Uploaded once to Cloudinary:", id);
      } catch (e) {
        console.warn("Cloudinary upload failed (fallback to Replicate URL):", e);
      }
    }

    return {
      status: "succeeded",
      id,
      output: replicateUrl ? [replicateUrl] : [],
      cdn_url
    } as const;
  }

  if (status === "failed" || status === "canceled") {
    return { status, id, error: pred.error || null } as const;
  }

  // queued | starting | processing
  return { status: "processing", id } as const;
}

async function pollByGetUrl(get_url: string) {
  const r = await fetch(get_url, {
    headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
  });

  if (!r.ok) return { status: "processing" } as const;

  const pred = await r.json();
  const status = (pred.status || "").toLowerCase();

  if (status === "succeeded") {
    const replicateUrl = pickUrl(pred.output);
    let cdn_url: string | null = null;

    // ✅ one-upload guard for legacy flow too
    const id = pred.id || get_url;
    if (uploadedOnce.has(id)) {
      console.log("⏩ Skipping duplicate upload for", id);
    } else if (replicateUrl) {
      try {
        cdn_url = await uploadResultToCloudinary(replicateUrl);
        uploadedOnce.add(id);
      } catch (e) {
        console.warn("Cloudinary upload failed (fallback to Replicate URL):", e);
      }
    }

    return {
      status: "succeeded",
      output: replicateUrl ? [replicateUrl] : [],
      cdn_url
    } as const;
  }

  if (status === "failed" || status === "canceled") {
    return { status, error: pred.error || null } as const;
  }

  return { status: "processing" } as const;
}

// ---------- Main handler ----------
export default async function handler(req: Request) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...corsWithOrigin(origin) });
  }

  try {
    // Preferred: GET /api/poll?id=...
    if (req.method === "GET") {
      const { searchParams } = new URL(req.url);
      const id = searchParams.get("id");

      if (!id) {
        // Legacy: allow get_url in query
        const get_url = searchParams.get("get_url");
        if (!get_url) {
          return new Response(JSON.stringify({ error: "Missing id" }), {
            status: 200,
            ...corsWithOrigin(origin)
          });
        }
        const data = await pollByGetUrl(get_url);
        return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
      }

      const data = await pollById(id);
      return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
    }

    // Legacy support: POST with { get_url }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const get_url: string | undefined = body.get_url;
      if (!get_url) {
        return new Response(JSON.stringify({ error: "Missing get_url" }), {
          status: 200,
          ...corsWithOrigin(origin)
        });
      }
      const data = await pollByGetUrl(get_url);
      return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
    }

    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  } catch (err: any) {
    console.error("Poll server error:", err);
    // Always return a pollable shape so the client keeps waiting
    return new Response(JSON.stringify({ status: "processing" }), {
      status: 200,
      ...corsWithOrigin(origin)
    });
  }
}
