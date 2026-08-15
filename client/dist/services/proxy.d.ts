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
export interface ProxySetting {
    socks?: string;
    https?: string;
    http?: string;
    bypass?: string[];
}
/** Host suffix match: "example.com" covers "api.example.com"; "*" covers all. */
export declare function isBypassed(host: string, bypass: string[]): boolean;
/**
 * Returns the proxy URL to use for a target URL, or null for direct.
 * Settings-file values take precedence over environment variables.
 */
export declare function getProxyForUrl(targetUrl: string): Promise<string | null>;
