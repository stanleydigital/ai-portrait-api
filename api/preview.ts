export const config = { runtime: "edge" };

// --- Allow-list of origins that can call your API ---
const ALLOWED_ORIGINS = new Set([
  "https://pawinci.com",
  "https://www.pawinci.com",
  "https://pawincistore.myshopify.com" // Shopify theme editor
]);

function cors(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    headers: {
      "Content-Type": "application/json",
      ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Vary": "Origin"
    }
  };
}

// ---------- Main handler ----------
export default async function handler(req: Request) {
  const origin = req.headers.get("origin");

  // --- CORS preflight ---
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...cors(origin) });
  }

  // --- Optional health check ---
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        ok: true,
        hint: "POST JSON { imageUrl, prompt } to start generation."
      }),
      { status: 200, ...cors(origin) }
    );
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...cors(origin) });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // --- Normalize client input ---
    const imageUrl: string | undefined = body.imageUrl || body.image_url;
    const prompt: string = (body.prompt || body.style || "").trim();

    if (!imageUrl) {
      return new Response(JSON.stringify({ error: "Missing imageUrl" }), {
        status: 400,
        ...cors(origin)
      });
    }

    // --- Build Seedream-4 input exactly as required ---
    const input: Record<string, any> = {
      image_url: imageUrl, // Replicate expects `image_url`
      prompt: prompt.length
        ? prompt
        : "Portrait of a pet, preserve exact identity and details.",
      size: "custom",
      width: 3072,
      height: 4096
    };

    // --- Call Replicate ---
    const replicateUrl =
      "https://api.replicate.com/v1/models/bytedance/seedream-4/predictions";

    const replicateRes = await fetch(replicateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`
      },
      body: JSON.stringify({ input })
    });

    const text = await replicateRes.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Non-JSON response from Replicate:", text);
    }

    // --- Success: return prediction id for polling ---
    if (replicateRes.ok && data?.id) {
      console.log("✅ Started Replicate job", data.id, "with input:", input);
      return new Response(
  JSON.stringify({
    id: data.id,
    status: data.status || "queued",
    echo: input  // 👈 shows what we sent to Replicate
  }),
  { status: 200, ...cors(origin) }
);

    }

    // --- Error: forward Replicate's message to client ---
    const errMsg = data?.error || text || `Replicate error ${replicateRes.status}`;
    console.error("Replicate error:", errMsg);
    return new Response(JSON.stringify({ error: errMsg }), {
      status: replicateRes.status || 500,
      ...cors(origin)
    });
  } catch (err: any) {
    console.error("Server error:", err);
    return new Response(JSON.stringify({ error: err?.message || "preview_failed" }), {
      status: 500,
      ...cors(origin)
    });
  }
}
