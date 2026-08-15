export declare function mintCode(): string;
export declare function claimCode(code: string, deviceName: string, deviceIp: string, devicePort: number): Promise<{
    ok: boolean;
    error?: string;
    pairingToken?: string;
}>;
