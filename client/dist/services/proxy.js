/**
 * Proxy resolution (C-016 plumbing).
 *
 * The current architecture is gateway-dialed (zero outbound calls), so this
 * is the config pipeline that future outbound features (OTA, file_transfer,
 * webhooks) consume — not an active transport today.
 *
 * Resolution order per request URL:
 *   1. NO_PROXY / proxy.bypass settings → direct
 *   2. settings.json keys (proxy.socks / proxy.https / proxy.http)
 *   3. env-derived config (HTTP_PROXY / HTTPS_PROXY / SOCKS_PROXY)
 *   4. null (direct)
 */
import { config } from '../config.js';
import { getSetting } from './settings-store.js';
/** Host suffix match: "example.com" covers "api.example.com"; "*" covers all. */
export function isBypassed(host, bypass) {
    const h = host.toLowerCase();
    return bypass.some((rule) => rule === '*' || h === rule || h.endsWith('.' + rule) || h.endsWith(rule));
}
/**
 * Returns the proxy URL to use for a target URL, or null for direct.
 * Settings-file values take precedence over environment variables.
 */
export async function getProxyForUrl(targetUrl) {
    let host = '';
    try {
        host = new URL(targetUrl).hostname;
    }
    catch {
        return null;
    }
    const fileSocks = await getSetting('proxy.socks');
    const fileHttps = await getSetting('proxy.https');
    const fileHttp = await getSetting('proxy.http');
    const fileBypass = await getSetting('proxy.bypass');
    const bypass = [...(fileBypass ?? []), ...config.proxy.bypass].map((s) => s.toLowerCase());
    if (host && isBypassed(host, bypass)) {
        return null;
    }
    const isHttps = targetUrl.toLowerCase().startsWith('https:');
    return (fileSocks ??
        (isHttps ? fileHttps : fileHttp) ??
        config.proxy.socks ??
        (isHttps ? config.proxy.https : config.proxy.http) ??
        null);
}
//# sourceMappingURL=proxy.js.map