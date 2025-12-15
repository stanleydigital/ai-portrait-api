export const config = { runtime: "edge" };

// Allow-list of origins
const ALLOWED_ORIGINS = new Set([
  "https://pawinci.com",
  "https://www.pawinci.com",
  "https://pawincistore.myshopify.com"
]);

function cors(origin: string | null) {
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

// Simple in-memory rate limiting (resets on redeploy, but good enough for free tier)
const uploadCounts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(identifier: string, maxUploads = 10, windowMs = 3600000): boolean {
  const now = Date.now();
  const record = uploadCounts.get(identifier);
  
  if (!record || now > record.resetAt) {
    uploadCounts.set(identifier, { count: 1, resetAt: now + windowMs });
    return true;
  }
  
  if (record.count >= maxUploads) {
    return false;
  }
  
  record.count++;
  return true;
}

// Generate signature for Cloudinary upload
async function generateSignature(paramsToSign: Record<string, any>): Promise<string> {
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiSecret) throw new Error("Missing CLOUDINARY_API_SECRET");

  // Sort params alphabetically and create string to sign
  const sortedParams = Object.keys(paramsToSign)
    .filter(key => paramsToSign[key] !== undefined && paramsToSign[key] !== null)
    .sort()
    .map(key => `${key}=${paramsToSign[key]}`)
    .join("&");

  const stringToSign = sortedParams + apiSecret;

  // Create SHA-1 hash (Cloudinary uses SHA-1)
  const msgUint8 = new TextEncoder().encode(stringToSign);
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return signature;
}

export default async function handler(req: Request) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...cors(origin) });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...cors(origin) });
  }

  try {
    // Rate limiting (10 uploads per hour per IP)
    const ip = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown";
    if (!checkRateLimit(ip, 50, 3600000)) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
        { status: 429, ...cors(origin) }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { fileSize, fileType } = body;

    // Validate file size (max 20MB)
    if (!fileSize || fileSize > 20 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: "File too large. Maximum 20MB allowed." }),
        { status: 400, ...cors(origin) }
      );
    }

    // Validate file type
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"];
    if (!fileType || !allowedTypes.includes(fileType.toLowerCase())) {
      return new Response(
        JSON.stringify({ error: "Invalid file type. Only JPEG, PNG, WebP, and HEIC allowed." }),
        { status: 400, ...cors(origin) }
      );
    }

    // Generate upload signature
    const timestamp = Math.floor(Date.now() / 1000);
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    
    if (!cloudName || !apiKey) {
      throw new Error("Missing Cloudinary credentials");
    }

    const paramsToSign = {
      timestamp,
      folder: "previews/user-uploads",
      upload_preset: undefined // Don't use preset with signature
    };

    const signature = await generateSignature(paramsToSign);

    // Return signature and params to client
    return new Response(
      JSON.stringify({
        signature,
        timestamp,
        cloudName,
        apiKey,
        folder: "previews/user-uploads"
      }),
      { status: 200, ...cors(origin) }
    );

  } catch (err: any) {
    console.error("Upload sign error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to generate upload signature" }),
      { status: 500, ...cors(origin) }
    );
  }
}
