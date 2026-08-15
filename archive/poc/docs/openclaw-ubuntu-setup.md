# OpenClaw Ubuntu 部署指南

> GCA POC — 在 Ubuntu VM 上安装和配置 OpenClaw Gateway

---

## 一、环境准备

### 1.1 系统要求

- Ubuntu 22.04 / 24.04 Desktop 或 Server
- 至少 2GB RAM（OpenClaw + AI Agent 需要内存）
- 至少 10GB 磁盘空间
- 网络能访问本机 Windows（<本机IP>:3001）

### 1.2 更新系统

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git build-essential
```

---

## 二、安装 Node.js 22

```bash
# 使用 NodeSource 官方仓库安装 Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 验证
node --version   # 预期 v22.x.x
npm --version    # 预期 10.x.x
```

---

## 三、安装 OpenClaw

### 3.1 全局安装

```bash
sudo npm install -g openclaw

# 验证
openclaw --version
openclaw --help
```

### 3.2 初始化配置

```bash
# 初始化 OpenClaw 配置（会在 ~/.openclaw/ 下生成配置文件）
openclaw init

# 检查生成的配置文件
cat ~/.openclaw/openclaw.json
```

---

## 四、配置 MCP Server（连接 Windows 本机）

### 4.1 编辑配置文件

```bash
nano ~/.openclaw/openclaw.json
```

### 4.2 配置内容

> 注意：OpenClaw 不同版本配置格式可能不同。如果以下格式不生效，尝试将 `mcpServers` 改为 `mcp.servers`。

**格式 A（mcpServers — 较新版本）：**

```json
{
  "mcpServers": {
    "home-pc": {
      "url": "http://<本机IP>:3001/mcp",
      "transport": "streamable-http"
    },
    "gca-android": {
      "url": "http://<Android设备IP>:3003/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer REDACTED_GCA_SERVER_TOKEN"
      }
    }
  },
  "agent": {
    "model": "openai/gpt-4o"
  }
}
```

**格式 B（mcp.servers — 较旧版本）：**

```json
{
  "mcp": {
    "servers": {
      "home-pc": {
        "url": "http://<本机IP>:3001/sse",
        "transport": "sse"
      }
    }
  },
  "agent": {
    "model": "openai/gpt-4o"
  }
}
```

> POC 验证步骤：先试格式 A，如果 `openclaw mcp list` 没显示 home-pc，换格式 B。

### 4.3 验证连接

```bash
# 先在 Windows 本机启动 POC Server：
# cd D:/Yuzu-GCA-Service/poc && npm run dev

# 然后在 Ubuntu VM 上验证
openclaw mcp list
# 预期输出：home-pc  connected

openclaw mcp probe home-pc
# 预期输出：列出 exec tool

openclaw mcp doctor
# 预期输出：所有 MCP Server 健康状态
```

---

## 五、配置飞书 Bot 通道

### 5.1 创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/) → 创建企业自建应用
2. 应用名称：GCA Control（或任意名称）
3. 记录以下信息：
   - **App ID**: cli_xxxxxxx
   - **App Secret**: xxxxxxxxxxxxxx

### 5.2 配置机器人能力

1. 在应用管理页面 → 添加「机器人」能力
2. 配置事件订阅：
   - 请求地址：`http://<Ubuntu-VM-IP>:18789/webhook/feishu`（OpenClaw 默认端口）
   - 订阅事件：`im.message.receive_v1`（接收消息）
3. 权限管理 → 开通以下权限：
   - `im:message`（发送消息）
   - `im:message.receive`（接收消息）
   - `im:resource`（读取资源）

### 5.3 在 OpenClaw 中配置飞书通道

编辑 `~/.openclaw/openclaw.json`，添加飞书通道配置：

```json
{
  "mcpServers": {
    "home-pc": {
      "url": "http://<本机IP>:3001/mcp",
      "transport": "streamable-http"
    }
  },
  "channels": {
    "feishu": {
      "appId": "cli_xxxxxxx",
      "appSecret": "xxxxxxxxxxxxxx",
      "verificationToken": "xxxxxxxxxxxxxx",
      "encryptKey": "xxxxxxxxxxxxxx"
    }
  },
  "agent": {
    "model": "openai/gpt-4o"
  }
}
```

> 注意：`verificationToken` 和 `encryptKey` 在飞书开放平台的「事件订阅」页面获取。

### 5.4 启动 OpenClaw

```bash
# 启动 Gateway（前台运行，方便看日志）
openclaw start

# 或后台运行
openclaw start --daemon

# 查看日志
openclaw logs --tail
```

### 5.5 验证飞书 Bot

1. 在飞书中找到你创建的 Bot，发一条消息
2. OpenClaw 日志应该显示收到消息
3. 尝试发送：`在 home-pc 上执行 ls`
4. 预期：AI 解析意图 → 调用 exec tool → 返回目录列表

---

## 六、故障排查

### 6.1 MCP Server 连不上

```bash
# 检查 Windows 本机 POC Server 是否在跑
curl http://<本机IP>:3001/health
# 预期：{"status":"ok",...}

# 检查 MCP 端点
curl -X POST http://<本机IP>:3001/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# 预期：{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":"2025-03-26",...}}

# 如果连不上：
# 1. 确认 Windows 上 npm run dev 已启动
# 2. 确认 VM 和 Windows 在同一网段
# 3. 确认 IP 地址正确（ipconfig 查 Windows IP）
```

### 6.2 配置格式不对

```bash
# 查看 OpenClaw 版本
openclaw --version

# 如果 v3.x 以上，用 mcpServers
# 如果 v2.x 以下，用 mcp.servers
# 不确定就两种都试一遍
```

### 6.3 飞书 Bot 不回消息

```bash
# 检查 OpenClaw 日志
openclaw logs --tail

# 检查飞书事件订阅是否配置成功
# 在飞书开放平台 → 事件订阅页面 → 点击「验证」
# 如果验证失败，检查回调地址是否正确
```

### 6.4 AI 不调用 exec tool

```bash
# 检查 AI Agent 模型是否配置
openclaw config get agent.model

# 尝试更明确的指令
# 不要发"ls"，发"在 home-pc 上执行 ls 命令"

# 检查 tool 是否注册成功
openclaw mcp probe home-pc
```

---

## 七、快速检查清单

- [ ] Ubuntu VM 已安装 Node.js 22
- [ ] OpenClaw 已全局安装
- [ ] `openclaw --version` 能正常输出
- [ ] `~/.openclaw/openclaw.json` 已配置 MCP Server
- [ ] Windows 本机 POC Server 已启动（npm run dev）
- [ ] `openclaw mcp list` 显示 home-pc connected
- [ ] `openclaw mcp probe home-pc` 列出 exec tool
- [ ] 飞书 Bot 已创建并配置
- [ ] 飞书 Bot 能收发消息
- [ ] 发送"在 home-pc 上执行 ls"能返回结果
