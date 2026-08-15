export interface DeviceEntry {
    name: string;
    url: string;
    transport: string;
    hasAuth: boolean;
    machineId: string;
}
interface McpServerConfig {
    url: string;
    transport: string;
    headers?: {
        Authorization?: string;
    };
    machineId?: string;
    /** 设备专用 token（设备侧铸造）。三重角色：
     *  1. openclaw.json Authorization → Gateway 调设备 MCP 的凭据
     *  2. 设备 → gca-server 的认证（heartbeat/audit/clipboard/ops）
     *  3. 代理转发时 gca-server 调设备 MCP 的凭据（getDeviceEndpoint） */
    deviceToken?: string;
}
export declare function listDevices(): Promise<DeviceEntry[]>;
/** 设备 MCP 端点信息（url + 网关持有的 Authorization），供代理转发使用。
 *  设备 token 只存在网关侧（openclaw.json），不暴露给 Desktop 客户端。 */
export declare function getDeviceEndpoint(name: string): Promise<{
    url: string;
    auth: string;
} | null>;
export declare function findDeviceByMachineId(machineId: string): Promise<{
    name: string;
    cfg: McpServerConfig;
} | null>;
/** 按名称查设备（/heartbeat 兜底：配对注册未带 machineId 时按名称匹配，S10 修复） */
export declare function findDeviceByName(name: string): Promise<{
    name: string;
    cfg: McpServerConfig;
} | null>;
/** 按设备 token 反查设备名（constant-time 比对）——设备端认证用 */
export declare function findDeviceByToken(token: string): Promise<{
    name: string;
} | null>;
/** 设备 token 最小长度（客户端 generatePairingToken 为 64 hex） */
export declare const DEVICE_TOKEN_MIN_LENGTH = 32;
export declare function isValidDeviceToken(token: unknown): token is string;
/**
 * 注册设备：deviceToken 由设备自己铸造并随注册请求携带，服务端只存储。
 * 不再接受 owner token——杜绝设备=owner 授权坍缩（S1）。
 */
export declare function registerDevice(name: string, ip: string, port: number, deviceToken: string, machineId?: string): Promise<void>;
/** 换发设备 token（owner 端 /devices/:name/retoken）——设备泄露后自助轮换 */
export declare function updateDeviceToken(name: string, newToken: string): Promise<boolean>;
export declare function revokeDevice(name: string): Promise<boolean>;
export declare function renameDevice(oldName: string, newName: string): Promise<boolean>;
export declare function updateDeviceUrl(name: string, newUrl: string): Promise<boolean>;
export {};
