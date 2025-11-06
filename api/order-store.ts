export const config = { runtime: "edge" };

let kv: any = null;

async function initKV() {
  if (kv) return kv;
  
  try {
    const { kv: kvClient } = await import('@vercel/kv');
    kv = kvClient;
    return kv;
  } catch (err) {
    console.warn("KV not available");
    return null;
  }
}

async function verifyShopifyWebhook(
  body: string,
  hmacHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!hmacHeader || !secret) return false;

  const msgUint8 = new TextEncoder().encode(body);
  const keyUint8 = new TextEncoder().encode(secret);
  
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyUint8,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgUint8);
  const hashArray = Array.from(new Uint8Array(signature));
  const hashBase64 = btoa(String.fromCharCode(...hashArray));
  
  return hashBase64 === hmacHeader;
}

interface LineItemProperty {
  name: string;
  value: string;
}

interface LineItem {
  id: number;
  title: string;
  quantity: number;
  properties?: LineItemProperty[];
}

interface ShopifyOrder {
  id: number;
  order_number: number;
  name: string;
  email: string;
  customer?: {
    first_name?: string;
    last_name?: string;
  };
  line_items: LineItem[];
  created_at: string;
}

export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const kvClient = await initKV();
    if (!kvClient) {
      console.error("KV not available - cannot store order data");
      return new Response(JSON.stringify({ error: "Storage unavailable" }), { 
        status: 500 
      });
    }

    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("Missing SHOPIFY_WEBHOOK_SECRET environment variable");
      return new Response(JSON.stringify({ error: "Configuration error" }), { 
        status: 500 
      });
    }

    const bodyText = await req.text();
    
    const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
    const isValid = await verifyShopifyWebhook(bodyText, hmacHeader, webhookSecret);
    
    if (!isValid) {
      console.error("Invalid webhook signature");
      return new Response(JSON.stringify({ error: "Invalid signature" }), { 
        status: 401 
      });
    }

    const order: ShopifyOrder = JSON.parse(bodyText);
    
    console.log("Received order webhook:", {
      order_number: order.order_number,
      name: order.name,
      email: order.email,
      line_items: order.line_items.length
    });

    const portraits: any[] = [];
    
    for (const item of order.line_items) {
      if (!item.properties || item.properties.length === 0) continue;
      
      const props: Record<string, string> = {};
      for (const prop of item.properties) {
        props[prop.name] = prop.value;
      }
      
      const portraitUrl = props._portrait_url || props._download_url;
      if (!portraitUrl) continue;
      
      const formats: Record<string, string> = {};
      for (const [key, value] of Object.entries(props)) {
        if (key.startsWith('_format_')) {
          const ratio = key.replace('_format_', '');
          formats[ratio] = value;
        }
      }
      
      portraits.push({
        title: item.title,
        quantity: item.quantity,
        portrait_url: portraitUrl,
        preview_url: props._preview_url || null,
        formats: Object.keys(formats).length > 0 ? formats : null
      });
    }

    if (portraits.length === 0) {
      console.log("No portraits found in order", order.order_number);
      return new Response(JSON.stringify({ 
        ok: true, 
        message: "No portraits in order" 
      }), { 
        status: 200 
      });
    }

    const orderData = {
      order_number: order.order_number,
      order_name: order.name,
      email: order.email,
      customer_name: order.customer?.first_name 
        ? `${order.customer.first_name} ${order.customer.last_name || ''}`.trim()
        : null,
      portraits,
      created_at: order.created_at,
      stored_at: new Date().toISOString()
    };

    const orderKey = `order:${order.order_number}`;
    const emailKey = `order:email:${order.email.toLowerCase()}`;
    
    const expirySeconds = 90 * 24 * 60 * 60;
    
    // Store the order data
    await kvClient.set(orderKey, orderData, { ex: expirySeconds });
    
    // Store order numbers for this email as an array (supports multiple orders)
    let emailOrders = await kvClient.get(emailKey) || [];
    if (!Array.isArray(emailOrders)) {
      emailOrders = [emailOrders]; // Convert old single value to array
    }
    
    // Add this order to the array (if not already there)
    if (!emailOrders.includes(order.order_number)) {
      emailOrders.push(order.order_number);
    }
    
    await kvClient.set(emailKey, emailOrders, { ex: expirySeconds });
    
    console.log("Stored order data:", {
      order_number: order.order_number,
      portraits: portraits.length,
      keys: [orderKey, emailKey]
    });

    return new Response(JSON.stringify({ 
      ok: true,
      order_number: order.order_number,
      portraits_count: portraits.length
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err: any) {
    console.error("Order store error:", err);
    
    return new Response(JSON.stringify({ 
      error: err.message || "Internal error",
      ok: false
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
}
