//! 设备页：设备列表（名称/URL/在线状态/运行时间）+ 在线探测 + /events 事件应用。
//! 2026-08-12：DeviceRow 从单 online 布尔升级为 agent/term 分层（事件驱动设备状态，
//! docs/event-driven-plan.md）——四态显示（在线/仅 Agent/仅终端/离线）的数据源。

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Device {
    pub name: String,
    pub url: String,
    /// 服务端返回 camelCase（machineId/hasAuth），serde 精确匹配会失败取默认值
    #[serde(rename = "machineId", default)]
    pub machine_id: Option<String>,
    #[serde(default)]
    pub transport: String,
    #[serde(rename = "hasAuth", default)]
    pub has_auth: bool,
}

#[derive(Debug, Clone)]
pub struct DeviceRow {
    pub device: Device,
    /// agent 服务在线状态（None = 未确认：尚未探测/事件未到）
    pub agent: Option<bool>,
    /// term 服务在线状态（None = 未确认/未部署——如 Android 无 term）
    pub term: Option<bool>,
    /// 探测/事件时的 agent uptime 基准 + 时刻（epoch 秒）——显示时本地流逝
    /// 叠加（每秒跳动，任务管理器风格），校准由探测/事件驱动（agent 重启归零
    /// 时由事件即时校准）
    pub uptime_base: u64,
    pub probed_at: u64,
}

impl DeviceRow {
    /// 设备级在线 = agent 或 term 任一确认在线（四态判定）
    pub fn online(&self) -> bool {
        self.agent == Some(true) || self.term == Some(true)
    }

    /// 当前 uptime（探测基准 + 本地流逝秒数）
    pub fn display_uptime(&self) -> u64 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.uptime_base + now.saturating_sub(self.probed_at)
    }
}

/// /events 事件载荷（服务状态）
#[derive(Debug, Clone)]
pub struct ServiceState {
    pub online: bool,
    pub uptime: u64,
    /// epoch 秒（server 端 probedAt）
    pub probed_at: u64,
}

/// /events 事件（解析后）
#[derive(Debug, Clone)]
pub enum Evt {
    /// 全量快照（连接/重连对齐）
    Snapshot(Vec<DeviceRow>),
    /// 设备状态变化（device.online/offline/updated 统一载荷）
    State {
        name: String,
        url: String,
        agent: ServiceState,
        term: ServiceState,
    },
    /// 设备移除（device.removed）
    Removed(String),
}

/// JSON number → u64（node process.uptime() 是浮点秒——as_u64 直接解析会失败归零）
fn num_u64(v: &serde_json::Value) -> u64 {
    v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)).unwrap_or(0)
}

/// 解析 /events 帧（event 名 + data JSON）→ Evt；未知事件返回 None
pub fn parse_event(event: &str, body: &str) -> Option<Evt> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    match event {
        "snapshot" => {
            let devices = v.get("devices")?.as_array()?;
            let rows = devices
                .iter()
                .filter_map(|d| {
                    let name = d.get("device")?.as_str()?.to_string();
                    let url = d.get("url")?.as_str()?.to_string();
                    let agent = d.get("agent")?;
                    let term = d.get("term")?;
                    Some(DeviceRow {
                        device: Device {
                            name,
                            url,
                            machine_id: None,
                            transport: String::new(),
                            has_auth: false,
                        },
                        agent: Some(agent.get("online").and_then(|o| o.as_bool()).unwrap_or(false)),
                        term: Some(term.get("online").and_then(|o| o.as_bool()).unwrap_or(false)),
                        uptime_base: num_u64(agent.get("uptime").unwrap_or(&serde_json::Value::Null)),
                        probed_at: num_u64(agent.get("probedAt").unwrap_or(&serde_json::Value::Null)),
                    })
                })
                .collect();
            Some(Evt::Snapshot(rows))
        }
        "device.online" | "device.offline" | "device.updated" => {
            let svc = |s: &serde_json::Value| ServiceState {
                online: s.get("online").and_then(|o| o.as_bool()).unwrap_or(false),
                uptime: num_u64(s.get("uptime").unwrap_or(&serde_json::Value::Null)),
                probed_at: num_u64(s.get("probedAt").unwrap_or(&serde_json::Value::Null)),
            };
            Some(Evt::State {
                name: v.get("device")?.as_str()?.to_string(),
                url: v.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
                agent: svc(v.get("agent")?),
                term: svc(v.get("term")?),
            })
        }
        "device.removed" => v.get("device").and_then(|d| d.as_str()).map(|s| Evt::Removed(s.to_string())),
        _ => None,
    }
}

#[derive(Default)]
pub struct DevicesState {
    pub rows: Vec<DeviceRow>,
    pub loading: bool,
    pub error: String,
    /// 列表请求已发出（等待响应）
    pub list_pending: bool,
    /// 待探测的设备数（健康检查结果分批回来；SSE 实时模式下为 0）
    pub probes_pending: usize,
    /// true = /events SSE 实时事件源生效（免逐设备探测）；false = 轮询回退
    pub live: bool,
}

impl DevicesState {
    pub fn apply_list(&mut self, body: &str) {
        self.list_pending = false;
        self.loading = false;
        let devices: Vec<Device> = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("devices").cloned())
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        // 保留旧行服务状态与 uptime 基准（探测/事件结果未回来前显示旧值，
        // uptime 本地继续跳动不归零）
        let old: std::collections::HashMap<String, (Option<bool>, Option<bool>, u64, u64)> = self
            .rows
            .iter()
            .map(|r| (r.device.name.clone(), (r.agent, r.term, r.uptime_base, r.probed_at)))
            .collect();
        self.rows = devices
            .into_iter()
            .map(|d| {
                let (agent, term, base, probed) = old.get(&d.name).copied().unwrap_or((None, None, 0, 0));
                DeviceRow {
                    device: d,
                    agent,
                    term,
                    uptime_base: base,
                    probed_at: probed,
                }
            })
            .collect();
    }

    /// 单个设备健康探测结果（tag: probe:<name>，轮询回退路径）——只校准 agent 层，
    /// term 保持（SSE 断开时退化为原有单探测行为）
    pub fn apply_probe(&mut self, name: &str, ok: bool, uptime: u64) {
        if let Some(row) = self.rows.iter_mut().find(|r| r.device.name == name) {
            row.agent = Some(ok);
            row.uptime_base = uptime;
            row.probed_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
        }
        self.probes_pending = self.probes_pending.saturating_sub(1);
    }

    /// 应用 /events 事件（snapshot / 状态变化 / 移除）
    pub fn apply_event(&mut self, e: Evt) {
        match e {
            Evt::Snapshot(rows) => {
                // snapshot 是权威全量（含 uptime/probedAt 校准锚点）——直接替换
                self.rows = rows;
            }
            Evt::State { name, url, agent, term } => {
                if let Some(row) = self.rows.iter_mut().find(|r| r.device.name == name) {
                    row.device.url = url;
                    row.agent = Some(agent.online);
                    row.term = Some(term.online);
                    row.uptime_base = agent.uptime;
                    row.probed_at = agent.probed_at;
                }
                // 未知设备名（列表尚未同步）→ 忽略，等 snapshot/列表刷新
            }
            Evt::Removed(name) => {
                self.rows.retain(|r| r.device.name != name);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str) -> DeviceRow {
        DeviceRow {
            device: Device {
                name: name.to_string(),
                url: format!("http://10.0.0.2:3001/mcp"),
                machine_id: None,
                transport: String::new(),
                has_auth: false,
            },
            agent: None,
            term: None,
            uptime_base: 0,
            probed_at: 0,
        }
    }

    #[test]
    fn parse_snapshot() {
        let body = r#"{"devices":[{"device":"gca-win11","url":"http://10.0.0.2:3001/mcp",
            "agent":{"online":true,"uptime":18057,"probedAt":1786500000},
            "term":{"online":false,"uptime":0,"probedAt":0}}]}"#;
        match parse_event("snapshot", body) {
            Some(Evt::Snapshot(rows)) => {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].device.name, "gca-win11");
                assert_eq!(rows[0].agent, Some(true));
                assert_eq!(rows[0].term, Some(false));
                assert_eq!(rows[0].uptime_base, 18057);
                assert_eq!(rows[0].probed_at, 1786500000);
                // 四态判定：agent 在线 term 离线 → 设备级在线（仅 Agent）
                assert!(rows[0].online());
            }
            other => panic!("expected Snapshot, got {other:?}"),
        }
    }

    #[test]
    fn parse_state_events() {
        let body = r#"{"device":"gca-win11","url":"http://10.0.0.2:3001/mcp",
            "agent":{"online":true,"uptime":99,"probedAt":100},
            "term":{"online":true,"uptime":99,"probedAt":100}}"#;
        for ev in ["device.online", "device.offline", "device.updated"] {
            match parse_event(ev, body) {
                Some(Evt::State { name, agent, term, .. }) => {
                    assert_eq!(name, "gca-win11");
                    assert!(agent.online);
                    assert!(term.online);
                }
                other => panic!("{ev}: expected State, got {other:?}"),
            }
        }
    }

    #[test]
    fn parse_removed_and_unknown() {
        assert!(matches!(parse_event("device.removed", r#"{"device":"gca-win11"}"#), Some(Evt::Removed(n)) if n == "gca-win11"));
        assert!(parse_event("device.unknown", r#"{"device":"x"}"#).is_none());
        assert!(parse_event("snapshot", "not-json").is_none());
    }

    #[test]
    fn apply_state_updates_row() {
        let mut st = DevicesState::default();
        st.rows.push(row("gca-win11"));
        st.apply_event(Evt::State {
            name: "gca-win11".into(),
            url: "http://10.0.0.9:3001/mcp".into(),
            agent: ServiceState { online: true, uptime: 100, probed_at: 200 },
            term: ServiceState { online: false, uptime: 0, probed_at: 0 },
        });
        let r = &st.rows[0];
        assert_eq!(r.agent, Some(true));
        assert_eq!(r.term, Some(false));
        assert_eq!(r.device.url, "http://10.0.0.9:3001/mcp");
        assert_eq!(r.uptime_base, 100);
        assert_eq!(r.probed_at, 200);
        assert!(r.online()); // 仅 Agent → 设备在线
    }

    #[test]
    fn apply_state_ignores_unknown_device() {
        let mut st = DevicesState::default();
        st.rows.push(row("gca-win11"));
        st.apply_event(Evt::State {
            name: "gca-android".into(),
            url: "http://10.0.0.3:3003/mcp".into(),
            agent: ServiceState { online: true, uptime: 7, probed_at: 1 },
            term: ServiceState { online: false, uptime: 0, probed_at: 0 },
        });
        assert_eq!(st.rows.len(), 1);
        assert_eq!(st.rows[0].device.name, "gca-win11");
    }

    #[test]
    fn apply_snapshot_replaces_and_removed_deletes() {
        let mut st = DevicesState::default();
        st.rows.push(row("old-device"));
        st.apply_event(Evt::Removed("old-device".into()));
        assert!(st.rows.is_empty());

        let snap = r#"{"devices":[{"device":"a","url":"u","agent":{"online":true,"uptime":1,"probedAt":1},"term":{"online":true,"uptime":1,"probedAt":1}}]}"#;
        let evt = parse_event("snapshot", snap).unwrap();
        st.apply_event(evt);
        assert_eq!(st.rows.len(), 1);
        assert_eq!(st.rows[0].device.name, "a");
    }

    #[test]
    fn four_state_judgement() {
        // ① 全在线
        let mut r = row("a");
        r.agent = Some(true);
        r.term = Some(true);
        assert!(r.online());
        // ② 仅 Agent（term 不在线/未确认）
        r.term = Some(false);
        assert!(r.online());
        r.term = None;
        assert!(r.online());
        // ③ 仅终端（agent 不在线/未确认）
        r.agent = Some(false);
        r.term = Some(true);
        assert!(r.online());
        // ④ 离线（均确认离线）
        r.term = Some(false);
        assert!(!r.online());
        // 未确认（登录初期）
        r.agent = None;
        r.term = None;
        assert!(!r.online());
    }

    #[test]
    fn apply_probe_fills_agent_layer_only() {
        // 轮询回退路径：probe 只校准 agent，term 保持（不误改）
        let mut st = DevicesState::default();
        st.rows.push(row("gca-win11"));
        st.apply_probe("gca-win11", true, 123);
        assert_eq!(st.rows[0].agent, Some(true));
        assert_eq!(st.rows[0].term, None);
        assert_eq!(st.rows[0].uptime_base, 123);
        st.apply_probe("gca-win11", false, 0);
        assert_eq!(st.rows[0].agent, Some(false));
    }
}
