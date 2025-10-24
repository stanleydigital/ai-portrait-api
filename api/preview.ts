export const config = { runtime: "edge" };

// --- Allow-list of origins that can call your API ---
const ALLOWED_ORIGINS = new Set([
  "https://pawinci.com",
  "https://www.pawinci.com",
  "https://pawincistore.myshopify.com" // keep for Shopify theme editor
]);

function corsWithOrigin(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    headers: {
      "Content-Type": "application/json",
      ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  };
}

export default async function handler(req: Request) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...corsWithOrigin(origin) });
  }

  if (req.method === "GET") {
    return new Response(
      JSON.stringify({ ok: true, hint: "POST JSON { image_url, style }" }),
      { status: 200, ...corsWithOrigin(origin) }
    );
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  }

  try {
    const { image_url, style } = await req.json();
    if (!image_url) {
      return new Response(JSON.stringify({ error: "Missing image_url" }), {
        status: 400,
        ...corsWithOrigin(origin)
      });
    }

    // ✅ Seedream 4: use 'image_input' (array) for the reference photo
    const input: Record<string, any> = {
      prompt: `${(style || "").trim()} Preserve the exact identity from the uploaded photo (same markings, colors, and features).`,
      image_input: [image_url],       // <-- key fix
      // Optional knobs you can try if supported by the model:
      // aspect_ratio: "1:1",          // or "3:4", "4:3"
      // size: "4K"                     // some builds accept size strings; otherwise omit
      // width: 4096, height: 4096     // if the model accepts numeric dims instead
    };

    const url = "https://api.replicate.com/v1/models/bytedance/seedream-4/predictions";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Prefer": "wait=60"
      },
      body: JSON.stringify({ input })
    });

    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch {}

    if (res.ok && data?.status === "succeeded" && data?.output?.[0]) {
      return new Response(JSON.stringify({ result_url: data.output[0] }), { status: 200, ...corsWithOrigin(origin) });
    }

    if (data?.urls?.get) {
      return new Response(JSON.stringify({ get_url: data.urls.get }), { status: 202, ...corsWithOrigin(origin) });
    }

    console.error("Replicate error:", res.status, text);
    return new Response(JSON.stringify({ error: "Replicate error", status: res.status, details: text }), {
      status: 500, ...corsWithOrigin(origin)
    });

  } catch (err: any) {
    console.error("Server error:", err);
    return new Response(JSON.stringify({ error: "Server error", details: String(err) }), {
      status: 500, ...corsWithOrigin(origin)
    });
  }
}
