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
      "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  }

  try {
    const { get_url } = await req.json();
    if (!get_url) {
      return new Response(JSON.stringify({ error: "Missing get_url" }), {
        status: 400,
        ...corsWithOrigin(origin)
      });
    }

    const r = await fetch(get_url, {
      headers: { "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}` }
    });
    const p = await r.json();

    if (p.status === "succeeded" && p.output?.[0]) {
      return new Response(
        JSON.stringify({ status: "succeeded", result_url: p.output[0] }),
        { status: 200, ...corsWithOrigin(origin) }
      );
    }

    return new Response(JSON.stringify({ status: p.status }), {
      status: 200,
      ...corsWithOrigin(origin)
    });

  } catch (err: any) {
    console.error("Poll server error:", err);
    return new Response(
      JSON.stringify({ error: "Server error", details: String(err) }),
      { status: 500, ...corsWithOrigin(origin) }
    );
  }
}
