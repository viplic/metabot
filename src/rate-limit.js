const buckets = new Map();

export function checkRateLimit(key, { limit = 120, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  buckets.set(key, bucket);

  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt
  };
}

export function getClientIp(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (forwardedFor) return String(forwardedFor).split(",")[0].trim();
  return request.socket?.remoteAddress || "unknown";
}
