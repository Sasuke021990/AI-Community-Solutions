import { WebhookConfig } from '../domain/types.js';

const MAX_RESPONSE_CHARS = 8000;   // protect model context
const TIMEOUT_MS = 30_000;

export interface WebhookFetchResult {
  ok: boolean;
  status?: number;
  body: string;   // truncated response text, or an error message
}

/**
 * Minifies the body if it's valid JSON (re-stringified with no whitespace,
 * so the 8KB cap holds more signal), otherwise leaves it as-is (HTML, RSS,
 * plain text). Truncation always happens after minification.
 */
function compactAndTruncate(text: string): string {
  let body = text;
  try {
    body = JSON.stringify(JSON.parse(text));
  } catch {
    // Not JSON - use the raw text.
  }
  return body.length > MAX_RESPONSE_CHARS
    ? body.slice(0, MAX_RESPONSE_CHARS) + `\n...[truncated ${body.length - MAX_RESPONSE_CHARS} chars]`
    : body;
}

export async function fetchWebhook(w: WebhookConfig, query?: string): Promise<WebhookFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = w.url;
    const init: RequestInit = { method: w.method, headers: { ...(w.headers ?? {}) }, signal: controller.signal };

    if (w.parameterized) {
      const q = query ?? '';
      // URL substitution and POST-body substitution are independent, not
      // method-gated: a POST to a REST-style path (/search/{query}) needs
      // URL substitution; a POST to a fixed endpoint needs the JSON body;
      // some APIs could want both. GET only ever uses the URL.
      if (url.includes('{query}')) {
        url = url.replaceAll('{query}', encodeURIComponent(q));
      } else if (w.method === 'GET') {
        url = url + (url.includes('?') ? '&' : '?') + 'query=' + encodeURIComponent(q);
      }
      if (w.method === 'POST') {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ query: q });
      }
    } else if (w.method === 'POST') {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = '{}';
    }

    const res = await fetch(url, init);
    const text = await res.text();
    const body = compactAndTruncate(text);
    if (!res.ok) return { ok: false, status: res.status, body: `HTTP ${res.status}: ${body.slice(0, 500)}` };
    return { ok: true, status: res.status, body };
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? `Timed out after ${TIMEOUT_MS}ms` : (e instanceof Error ? e.message : String(e));
    return { ok: false, body: `Fetch failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
