/**
 * Device Token（S1 修复，2026-08-12 审查）——设备自铸、服务端只存储。
 *
 * 设备 → gca-server 的认证凭据（heartbeat/audit/clipboard/ops/register 轮询），
 * 与 owner 管理 token 彻底分离（此前配对返回 owner token，设备=owner 授权坍缩）。
 *
 * 解析顺序：
 *   1. GCA_DEVICE_TOKEN env（desktop 拉起时注入——新版 desktop 同时把它作为
 *      GCA_MCP_TOKEN 注入，保证 Gateway 经 openclaw.json 接入设备 MCP 一致）
 *   2. settings.json security.deviceToken（持久化）
 *   3. GCA_MCP_TOKEN env / security.mcpToken（过渡期回退：老部署的 MCP token
 *      即设备 token；服务端 /device/me 会判定未登记 → 触发重新注册）
 *   4. 都没有 → ensureDeviceToken() 铸造并持久化（独立运行/开放模式）
 */
export declare function generateDeviceToken(): string;
/** 取现有设备 token（不铸造）；无 → null */
export declare function getDeviceToken(): Promise<string | null>;
/** 取设备 token；无则铸造并持久化后返回 */
export declare function ensureDeviceToken(): Promise<string>;
