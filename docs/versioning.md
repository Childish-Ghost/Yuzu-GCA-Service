# GCA 版本号规范（Versioning）

> 2026-08-12 制定 · **手动编号**（无 CI 自动 bump）——版本号只在发版时由人修改
> **双版本模型**：组件版本（源码真值）+ 产品发布号（发版协调快照）

## 1. 版本号格式

- **SemVer 2.0**：`MAJOR.MINOR.PATCH`（如 `0.3.0`）
- **通道**：`V`=正式发布 / `B`=预发布测试 / `D`=开发每日构建
- **0.x 阶段**：MINOR = 功能演进（可含破坏性变更，0.x 语义放宽），PATCH = 修复；组件升 `1.0.0` 条件：其协议/接口稳定 + 正式对外

## 2. 双版本模型

### 2.1 组件版本 = 源码真值（各自独立演进，**永不同步**）

| 组件线 | manifest 位置 | 当前 |
|--------|--------------|------|
| desktop-rs（控制端） | `Cargo.toml` `[workspace.package]`（desktop-rs 继承） | 0.5.0 |
| agent + term（同 crate 双 bin，技术共享一号） | `agent/Cargo.toml` | 0.3.0 |
| server | `server/package.json` | 0.5.0 |
| Android | gradle `versionName`（`versionCode` 单调递增） | 0.3.0 / 3 |

- **agent 没改 → 永远 0.1.0，不随产品走**——"v5.0 客户端里 agent 0.1.0"如实呈现，无说谎

### 2.2 产品发布号 = 发版协调快照号（不进任何 manifest）

- `B0.4.0` 仅用于：**tag、Release 名、多组件包文件名**；按本次发版最重变更升 MINOR/PATCH
- 它不代表任何组件版本，只标识"这一次发版的组合"；**组件矩阵才是真值**（见 §6）

## 3. 产物命名

```
<包名>-<平台>-<通道><X.Y.Z>.<格式>     gca-setup-win-V0.4.0.exe  gca-agent-android-B0.4.0-beta.1.apk
```

| 包 | 文件名版本取谁的号 | 示例 |
|----|-------------------|------|
| Win 客户端安装包（NSIS） | **发布号**（多组件包） | `gca-setup-win-V0.4.0.exe` / `-B0.4.0-beta.1.exe` |
| Ubuntu 客户端单包（debconf 选择安装） | **发布号**（多组件包） | `gca-linux-V0.4.0.deb` |
| Android APK | **agent 组件号**（单组件包） | `gca-agent-android-V0.1.0.apk` |
| 服务端 zip | **server 组件号** | `gca-server-V0.3.0.zip` |
| 服务端 deb | **server 组件号** | `gca-server-linux-V0.3.0.deb` |

**通道语义**：

| 通道 | 含义 | tag | gitea prerelease |
|------|------|-----|------------------|
| V | 正式发布 | `vX.Y.Z`（当前无 V 发布，全部已降级为 B） | false |
| B | 预发布/测试 | **`BX.Y.Z`**（多轮迭代：`BX.Y.Z-beta.1` → `BX.Y.Z-beta.2`） | true |
| D | 开发/每日构建（**不启用**，依赖 CI） | 无 tag（main 构建） | true |

- B 通道文件名与 tag 一致：`B0.4.0`（多轮迭代加 `-beta.N`）；历史 v0.3.0 的"正式 tag + prerelease 标记"做法作废
- **deb 特例**：文件名可有通道，但包内 `Version` 字段**必须纯 SemVer** `0.4.0-1`（Debian 格式 `upstream-打包revision`）——通道进内部字段会破坏 apt 升级排序/依赖解析
- 历史产物名（`gca-setup-0.3.0.exe` 等）保留为历史，新命名自 B0.4.0 起生效

## 4. bump 规则（各组件独立判定）

| 位 | 触发条件（对该组件） | 例子 |
|----|---------|------|
| **MAJOR** | 该组件协议/接口不兼容（MCP 协议破坏、注册表模型重构、代理端点破坏性变更） | server 1.0.0 |
| **MINOR** | 该组件向后兼容新功能 | agent 新工具 0.2.0 |
| **PATCH** | 该组件纯 bug 修复 | 0.1.1 |

- 一次发版每个组件只升一位（MINOR 或 PATCH），**没改的组件一行不动**
- 日常自部署（VM 部署、本机重建重启）**不升号**——版本号只在对外发版时升
- 产品发布号按本版最重变更升位（不影响任何 manifest）

## 5. 同版本重建区分（"都叫一个名字"的三层保证）

| 情况 | 区分机制 |
|------|---------|
| 组件真变了 | 该组件号升 → 其包名变 |
| 每次发版 | 发布号递增 → 多组件包名必变 |
| 同发布号重打（修打包问题） | 文件名加 `-rN`（`gca-setup-win-B0.4.0-r2.exe`）；deb 用 revision `0.4.0-2`；apk 用 `versionCode+1` |

## 6. 组件矩阵（真值入口）

- 安装包内嵌 `components.json`（desktop/agent/term/server 各版本）
- 安装器界面显示组件版本表（NSIS 与 deb 安装过程）
- Release body 记矩阵：`desktop 0.4.0 · agent 0.1.0 · term 0.1.0 · server 0.3.0`

## 7. 发版流程（手动 checklist）

1. **判定**：功能完成 + `cargo test --workspace` 全绿 → 定产品发布号 + 各组件升自己的号（没改的不动）
2. **bump**：只改实际变更组件的 manifest（一个 commit：`chore: bump <组件> 至 x.y.z`）；发布号不进 manifest
3. **构建**：`cargo build --release --workspace` + `cd server && npm run build` + Android `gradlew assembleDebug` + `makensis`（OutFile=新命名）+ `build-deb.sh`
4. **components.json + 回归**：生成组件矩阵、端到端实测
5. **tag**：`git tag -a B<发布号> -m "..."` + push（annotated tag）
6. **Release**：`bash scripts/release-gitea.sh B<发布号> B<发布号> scripts/release-body.B<发布号>.json <全部附件>`——一个 tag 一个 Release 挂全部平台附件；body 含组件矩阵；B 通道 `prerelease=true`
7. **文档同步**：MASTER 版本行/发布行、dashboard

## 8. 边界（不做的事）

- ❌ CI 自动 bump / 自动打 tag / 自动构建（**不搞 CI**，手动编号 + 手动构建）
- ❌ 日常 commit 升版本号（只在发版 commit 改）
- ❌ 组件强同步版本（各自演进；组合关系靠组件矩阵记录）
- ❌ 无 tag 的临时发布（所有发布必须有正式 tag）
- ❌ D 通道当前不启用（依赖 CI；命名定义保留，将来启用无需改规范）

## 9. 历史版本记录

| 版本 | 日期 | 内容 |
|------|------|------|
| B0.2.0 | 2026-08-01 | 项目拆分 + 设备管理 + gca-server ops 统一 + power/service 迁移 |
| B0.3.0 | 2026-08-12 | 真终端全链路 + 安全审查修复 + 心跳自愈 + Windows 安装程序 |
| B0.4.0-beta.1 | 2026-08-13 | 安全审查 44 项修复（S1 设备 token 隔离 CRITICAL）+ INT-004 mDNS + INT-005 审计集中 + 事件驱动阶段二；新命名规范首个应用版本；desktop-rs 0.4.0 · agent+term 0.2.0 · server 0.4.0 |
| B0.4.0-beta.2 | 2026-08-13 | Android 原生化完成（docs/android-native-plan.md P0-P4）：Rust agent JNI 直启、nodejs-mobile 退出、20 工具全链路、S1 设备 token/心跳/审计端到端、高低版本分支、BOOT FGS 修复；新增 Android 0.2.0 |
| B0.4.0-beta.3 | 2026-08-14 | 安装程序组件选择（Desktop/Agent/Term 独立勾选）+ 审批三通道（App 卡片流/飞书卡片/SSE）+ 收尾审查修复（docs/review-report-2026-08-14.md）；server zip/deb 按审查后 dist 重打 |
| B0.5.0 | 2026-08-15 | **测试版（beta）**：Android 原生化 + 审批三通道 + 组件选择安装程序 + 双轮安全审查全量修复 + 敏感信息清理；desktop-rs 0.5.0 · agent+term 0.3.0 · server 0.5.0 · Android 0.3.0；双地址发布（gitea + GitHub） |
