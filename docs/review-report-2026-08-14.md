# 审批功能收尾审查报告（2026-08-14）

> 双 agent 并行审查（server 审批链 + Android 审批代码），覆盖 2026-08-14 新增的
> App 审批/飞书卡片/SSE 下发全链路。基线：git e73460e。全部修复已提交并部署。

## 一、Server 侧（H1/H2/H3 高 · M2-M6 中 · L2 低）

| 编号 | 问题 | 严重度 | 修复 |
|------|------|--------|------|
| H1 | 飞书网络失败 → unhandledRejection 炸进程（token 获取/卡片调用无 catch） | 高 | getTenantAccessToken try/catch + 全部卡片调用 `.catch(() => {})` |
| H2 | open mode（无 token）下 card-action 签名盐固定可伪造——审批门被绕过 | 高 | card-action 无 token 时 fail-closed（403 禁用） |
| H3 | ops_events SSE 缺 res.on('error')——客户端断开时 write/end 崩溃 | 高 | safeWrite（destroyed 检查）+ res error/close 清理 |
| M2 | code 通道审批不回写卡片（三通道不一致）；approveOpById 终态报 expired 语义错 | 中 | code 通道补卡片回写；状态检查提前（already 优先） |
| M3 | 拒绝操作无审计（三通道） | 中 | rejectOp/rejectOpById 补 ops_rejected 审计 |
| M4 | card-action 无限速 + LAN 可达（签名闸门无背压） | 中 | 限速 30/分/IP + loopback-only |
| M5 | dashboard 审批列表与 SSE 状态耦合——正常态从不刷新 | 中 | opsPollTimer 登录后无条件启动 |
| M6 | sweepOps 立即删过期 op（设备轮询 404 无法区分过期）；approveOp 过期不发事件 | 中 | 过期保留 1 小时（与终态一致）+ 补 emitOpEvent |
| L2 | opId 随机熵不足（~13bit） | 低 | randomBytes(8) hex |

## 二、Android 侧（A-H1/A-H2/A-H3 高 · A-M4-M8 中 · A-L12/L16 低）

| 编号 | 问题 | 严重度 | 修复 |
|------|------|--------|------|
| A-H1 | removeAt(pager.currentItem) 决策期间滑动→错删/越界崩溃 | 高 | 按 opId removeAll 删除 + 边界检查 |
| A-H2 | SSE 无限读超时 + 服务端无心跳——静默断连审批通道死亡 | 高 | 客户端 60s 读超时（超时触发重连）+ 服务端 25s ping |
| A-H3 | ensureChannel 无 API 26 保护——Android 7 崩溃 | 高 | Build.VERSION >= O 包裹（低版本无 channel） |
| A-M4 | stop 无法中断 reader（线程/连接泄漏）+ GcaService 无 onDestroy | 中 | conn.disconnect 中断 + onDestroy stop |
| A-M6 | 动画期间 currentItem 旧——快速连滑决策错卡片 | 中 | registerOnPageChangeCallback 稳定索引 |
| A-M7 | 右滑拒绝无确认；斜滑阈值过宽 | 中 | 拒绝加 AlertDialog 确认 + |dx| > 1.5*|dy| |
| A-M8 | singleTop 单条模式忽略新 op 通知 | 中 | onNewIntent 单条模式切新 op |
| A-L12 | loadOp 200+非 JSON body 主线程崩溃 | 低 | try/catch 保护 |
| A-L16 | 已处理/过期 op 按钮仍可点 | 低 | 按 status 禁用 + 显示状态 |

## 三、记录在案（2026-08-14 晚收尾：全部处理）

- ~~M1 注册副作用失败被吞~~ → ✅ 已修（finalizeDeviceRegistration 返回 registered/error，三通道响应区分，卡片回写 expired 态）
- A-M5 Android 12+ 后台启动弹窗被系统拦截（前台服务非豁免）——弹窗在 12+ 退化为通知（产品形态接受，注释已修正）
- ~~A-M9 owner token 明文 prefs~~ → ✅ 已修（OwnerCreds：EncryptedSharedPreferences + Keystore AES256-GCM，明文回退兼容 + token 输入框 password）
- ~~A-M10 无障碍 touch exploration 与卡片手势冲突~~ → ⏳ 待实测（HOVER 事件不进 DOWN/UP 判定，理论不冲突；需真机开无障碍验证手势）
- ~~A-M11 通知权限被拒静默~~ → ✅ 已修（审批空态引导开启）
- ~~A-L17 进程重启 snapshot 全量重通知~~ → ✅ 已修（summary 化：ready 后单条汇总通知）
- ~~部署约束 open mode 告警~~ → ✅ 已修（startServer 启动显式 WARNING）

## 四、验证

- cargo 56 全绿 + 审批端点验证 15 项（verify-approval.mjs）+ Android 编译通过
- server 已部署 VM（systemctl active）
- 真机已装最新 APK（health 通）
