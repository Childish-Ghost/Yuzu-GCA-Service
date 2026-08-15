# 设备唯一标识方案

> 每台设备的唯一身份标识，用于注册判断、设备匹配、跨会话识别。

## 标识来源

| 平台 | 标识来源 | 获取方式 | 稳定性 |
|------|---------|---------|--------|
| Windows | SMBIOS UUID | `Win32_ComputerSystemProduct.UUID` (PowerShell/WMI) | 重装系统不变，换主板才变 |
| Linux | SMBIOS UUID | `/sys/class/dmi/id/product_uuid` | 同上 |
| VM | 虚拟化分配 UUID | 同上（hypervisor 分配） | 每台 VM 唯一 |
| Android | 硬件指纹 | `Build.FINGERPRINT` + `Build.HARDWARE` + `Build.SERIAL` | 工厂重置才变 |
| iOS | Keychain UUID | 首次启动生成 → 存 Keychain | 抹掉所有内容才变 |

## 设备名规则

- 格式：`gca-{hostname}-{machine_id前8位}`
- 示例：`gca-childish-ghost-a1b2c3d4`
- hostname 可改，machine_id 不变
- 注册匹配用 machine_id，不依赖设备名

## 注册判断流程

```
Desktop 启动
  → Rust 层获取 machine_id
  → 前端构建设备名
  → 查询 gca-server /devices
  → 任何设备的 machine_id 匹配 → 已注册，隐藏横幅
  → 不匹配 → 显示未注册横幅 + 注册按钮
```

## API 变更

### POST /register

请求体新增 `machineId` 字段：

```json
{
  "deviceName": "gca-childish-ghost-a1b2c3d4",
  "machineId": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
}
```

### GET /devices

响应中每个设备包含 `machineId` 字段：

```json
{
  "devices": [
    {
      "name": "gca-win11",
      "url": "http://10.1.0.27:3001/mcp",
      "transport": "streamable-http",
      "hasAuth": true,
      "machineId": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
    }
  ],
  "count": 1
}
```

## 存储

- **gca-server**：openclaw.json 中每个设备增加 `machineId` 字段
- **Desktop**：`%APPDATA%\GCA Desktop\config.json` 保存凭据（owner token + device_token，2026-08-12 审查 D6 更正——此前文档误写 localStorage，desktop-rs 为 Rust 原生无浏览器存储）
- **client（gca-poc）**：config.ts 中增加 `machineId` 配置项
