# 飞书 Bot 配置指南

> GCA POC — OpenClaw 对接飞书聊天通道

---

## 前提

- 已有飞书企业版账号（或开发者账号）
- OpenClaw 已在 Ubuntu VM 上安装并运行
- POC MCP Server 已在 Windows 本机启动（监听 3001 端口）

---

## 一、创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → 点击「创建企业自建应用」

2. 填写应用信息：
   - 应用名称：**GCA Control**
   - 应用描述：跨设备远程控制 AI 助手
   - 应用图标：随意上传一个图标

3. 创建完成后，在「凭证与基础信息」页面记录：
   - **App ID**：`cli_xxxxxxxxxxxxx`
   - **App Secret**：`xxxxxxxxxxxxxxxxxxxxxxxxxx`

---

## 二、配置机器人能力

1. 左侧菜单 → 「应用能力」→ 「机器人」→ 点击「启用机器人」

2. 配置机器人：
   - 机器人名称：GCA Control
   - 描述：通过自然语言控制设备
   - 机器人头像：上传一个图标

---

## 三、配置事件订阅

这一步让 OpenClaw 能收到飞书消息。

### 3.1 获取回调地址

OpenClaw 默认监听 WebSocket 18789 端口。飞书事件回调地址格式：

```
http://<Ubuntu-VM-IP>:18789/webhook/feishu
```

> 如果 VM IP 是 192.168.x.x，回调地址就是 `http://192.168.x.x:18789/webhook/feishu`

### 3.2 在飞书平台配置

1. 左侧菜单 → 「事件与回调」→ 「事件配置」
2. 请求地址填写：`http://<Ubuntu-VM-IP>:18789/webhook/feishu`
3. 点击「验证」— 如果 OpenClaw 在运行，应该验证成功

### 3.3 订阅事件

在「事件与回调」→「事件列表」中添加：

| 事件名称 | Event Key | 说明 |
|----------|-----------|------|
| 接收消息 | `im.message.receive_v1` | 用户发送消息给 Bot |

---

## 四、配置权限

左侧菜单 → 「权限管理」→ 开通以下权限：

### 必需权限

| 权限名称 | 权限标识 | 用途 |
|----------|----------|------|
| 获取与发送单聊、群组消息 | `im:message` | 发送消息给用户 |
| 读取用户发给机器人的单聊消息 | `im:message.receive` | 接收用户消息 |
| 获取群组信息 | `im:chat:readonly` | 读取群聊信息 |

### 可选权限（后续扩展用）

| 权限名称 | 权限标识 | 用途 |
|----------|----------|------|
| 上传图片或文件 | `im:resource` | 发送文件 |
| 获取用户基本信息 | `contact:user.base:readonly` | 识别用户 |

---

## 五、获取加密配置

在「事件与回调」→「加密策略」页面获取：

- **Verification Token**：`xxxxxxxxxxxxxxxxxxxxxxxx`
- **Encrypt Key**：`xxxxxxxxxxxxxxxxxxxxxxxx`

> 这两个值需要在 OpenClaw 配置中填写。

---

## 六、发布应用

1. 左侧菜单 → 「版本管理与发布」→ 创建版本
2. 填写版本号（如 1.0.0）和更新说明
3. 提交审核（企业自建应用通常自动通过）
4. 发布后，在飞书客户端搜索 Bot 名称，可以找到并开始对话

---

## 七、在 OpenClaw 中配置飞书通道

编辑 Ubuntu VM 上的 `~/.openclaw/openclaw.json`：

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
        "Authorization": "Bearer <Android配对token>"
      }
    }
  },
  "channels": {
    "feishu": {
      "appId": "cli_xxxxxxxxxxxxx",
      "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxx",
      "verificationToken": "xxxxxxxxxxxxxxxxxxxxxxxx",
      "encryptKey": "xxxxxxxxxxxxxxxxxxxxxxxx"
    }
  },
  "agent": {
    "model": "openai/gpt-4o"
  }
}
```

> 注意：
> - `appId` / `appSecret` 在飞书应用「凭证与基础信息」页面
> - `verificationToken` / `encryptKey` 在飞书应用「事件与回调」→「加密策略」页面
> - `agent.model` 需要配置一个 AI 模型（OpenClaw 需要 AI 来解析用户意图并调用 Tool）

### AI 模型配置

OpenClaw 需要一个 LLM 来解析用户消息并调用 MCP Tool。配置方式取决于 OpenClaw 版本：

**方式 A（OpenAI API）：**
```json
{
  "agent": {
    "model": "openai/gpt-4o",
    "apiKey": "sk-xxxxxxxxxxxxxx"
  }
}
```

**方式 B（环境变量）：**
```bash
export OPENAI_API_KEY=sk-xxxxxxxxxxxxxx
openclaw start
```

> 如果用其他模型（如 Anthropic、本地 Ollama），参考 OpenClaw 官方文档。

---

## 八、验证

1. **确认 OpenClaw 已启动并加载配置：**
   ```bash
   openclaw restart
   openclaw logs --tail
   # 预期日志：飞书通道已连接、MCP Server home-pc 已注册
   ```

2. **确认 MCP Server 已连接：**
   ```bash
   openclaw mcp list
   # 预期：home-pc  connected
   ```

3. **在飞书中发消息测试：**
   - 打开飞书 → 搜索 "GCA Control" Bot → 发送消息
   - 发送：`在 home-pc 上执行 dir`
   - 预期：Bot 回复目录列表

---

## 九、故障排查

### 飞书验证回调地址失败

```
原因：OpenClaw 没启动 / 端口不对 / VM 防火墙拦截
排查：
  1. 在 VM 上 curl http://localhost:18789 确认 OpenClaw 在跑
  2. 检查 VM 防火墙：sudo ufw allow 18789
  3. 确认飞书能访问 VM 的公网或内网 IP
```

### Bot 不回消息

```
原因：AI 模型未配置 / API Key 无效 / MCP Server 未连接
排查：
  1. openclaw logs --tail 看日志
  2. 确认 OPENAI_API_KEY 已设置
  3. openclaw mcp list 确认 home-pc connected
  4. 尝试发送更明确的指令："请在 home-pc 上执行 echo hello"
```

### AI 不调用 exec tool

```
原因：Tool 未注册 / AI 模型不支持 function calling
排查：
  1. openclaw mcp probe home-pc 确认 exec tool 在列表中
  2. 确认 AI 模型支持 tool use（gpt-4o / claude-3.5 等支持）
  3. 尝试发送："使用 exec 工具在 home-pc 上执行 ls"
```
