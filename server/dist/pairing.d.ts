export declare function mintCode(): string;
export declare function claimCode(code: string, deviceName: string, deviceIp: string, devicePort: number, deviceToken: string, machineId?: string): Promise<{
    ok: boolean;
    error?: string;
}>;
