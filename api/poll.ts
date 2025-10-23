export const config = { runtime: "edge" };

function cors() {
  return {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://pawincistore.myshopify.com", // change this
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  };
}

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, ...cors() });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, ...cors() });

  const { get_url } = await req.json();
  if (!get_url) return new Response(JSON.stringify({ error: "Missing get_url" }), { status: 400, ...cors() });

  const r = await fetch(get_url, {
    headers: { "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}` }
  });
  const p = await r.json();

  if (p.status === "succeeded" && p.output?.[0]) {
    return new Response(JSON.stringify({ status: "succeeded", result_url: p.output[0] }), { status: 200, ...cors() });
  }
  return new Response(JSON.stringify({ status: p.status }), { status: 200, ...cors() });
}
