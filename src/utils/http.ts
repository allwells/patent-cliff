export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30_000,
  maxRetries = 3
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoffMs(attempt);
        await sleep(delayMs);
        continue;
      }
      return res;
    } catch (err: unknown) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await sleep(backoffMs(attempt));
      }
    }
  }
  throw lastErr;
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
