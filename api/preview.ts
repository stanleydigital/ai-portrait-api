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

// Stronger prompt to avoid generic results
const finalPrompt =
  (prompt ? prompt + " " : "") +
  "Preserve the exact identity from the uploaded photo (same markings, colors, and features). Centered subject, clean background.";

// ✅ Send ALL commonly accepted keys so any Seedream build uses the image & text
const input: Record<string, any> = {
  // image
  image_input: [imageUrl],   // <-- primary key many Seedream-4 builds require
  image_url: imageUrl,       // <-- secondary (harmless backup)
  // text
  prompt: finalPrompt,       // standard
  style: finalPrompt,        // alt
  text_prompt: finalPrompt,  // alt
  // size
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

    // after calling Replicate and parsing `data`
if (replicateRes.ok && data?.id) {
  return new Response(
    JSON.stringify({
      id: data.id,
      status: data.status || "queued",
      get_url: data?.urls?.get || null,   // 👈 add this
      echo: input                          // keep this while debugging
    }),
    { status: 200, ...cors(origin) }
  );
}


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
