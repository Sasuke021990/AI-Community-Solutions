import { WebhookConfig } from '../domain/types.js';

const MAX_RESPONSE_CHARS = 8000;   // protect model context
const TIMEOUT_MS = 30_000;

export interface WebhookFetchResult {
  ok: boolean;
  status?: number;
  body: string;   // truncated response text, or an error message
}

export async function fetchWebhook(w: WebhookConfig, query?: string): Promise<WebhookFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = w.url;
    const init: RequestInit = { method: w.method, headers: { ...(w.headers ?? {}) }, signal: controller.signal };

    if (w.parameterized) {
      const q = query ?? '';
      if (w.method === 'GET') {
        url = url.includes('{query}')
          ? url.replaceAll('{query}', encodeURIComponent(q))
          : url + (url.includes('?') ? '&' : '?') + 'query=' + encodeURIComponent(q);
      } else {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ query: q });
      }
    } else if (w.method === 'POST') {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = '{}';
    }

    const res = await fetch(url, init);
    const text = await res.text();
    const body = text.length > MAX_RESPONSE_CHARS
      ? text.slice(0, MAX_RESPONSE_CHARS) + `\n...[truncated ${text.length - MAX_RESPONSE_CHARS} chars]`
      : text;
    if (!res.ok) return { ok: false, status: res.status, body: `HTTP ${res.status}: ${body.slice(0, 500)}` };
    return { ok: true, status: res.status, body };
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? `Timed out after ${TIMEOUT_MS}ms` : (e instanceof Error ? e.message : String(e));
    return { ok: false, body: `Fetch failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
