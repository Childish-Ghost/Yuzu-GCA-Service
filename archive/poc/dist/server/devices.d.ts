interface DeviceEntry {
    name: string;
    url: string;
    transport: string;
    hasAuth: boolean;
}
export declare function listDevices(): Promise<DeviceEntry[]>;
export declare function registerDevice(name: string, ip: string, port: number, token: string): Promise<void>;
export declare function revokeDevice(name: string): Promise<boolean>;
export {};
