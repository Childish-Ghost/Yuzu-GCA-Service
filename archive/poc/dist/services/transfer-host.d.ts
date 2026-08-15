/**
 * Transfer Host - builds this device's externally reachable base URL for
 * the data plane. TRANSFER_HOST overrides auto-detection (NAT/DDNS cases).
 */
export declare function primaryLanAddress(): Promise<string>;
export declare function transferBaseUrl(): Promise<string>;
