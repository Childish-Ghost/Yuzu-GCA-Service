/**
 * gca-server — GCA control plane daemon.
 *
 * Endpoints（2026-08-12 审查后鉴权矩阵：owner = 管理 token；device = 设备自铸 token）：
 *   GET  /health                              无
 *   POST /pair/init      owner（限速 30/时/IP）      — 生成 6 位配对码
 *   POST /pair/claim     无（限速 10/分/IP）          — 设备携自铸 deviceToken 注册
 *   GET  /devices        owner
 *   POST /devices/:name/revoke  owner
 *   POST /devices/:name/rename  owner
 *   POST /devices/:name/reurl   owner（SSRF 校验）
 *   POST /devices/:name/retoken owner（换发设备 token）
 *   POST /push            owner
 *   POST /clipboard/push  owner | device（device 时 deviceId 由服务端覆盖）
 *   GET  /clipboard/latest owner | device
 *   POST /ops/request     device（响应不含确认码）    — 高危操作申请
 *   POST /ops/approve     owner（限速 60/分/IP+全局） — 确认码批准
 *   POST /ops/reject      owner
 *   GET  /ops/:id         owner | op 归属设备（响应不含确认码）
 *   POST /register        owner | device（限速 10/时/IP）— 注册审批（设备携 deviceToken）
 *   POST /heartbeat       device（按 machineId/deviceName 定位设备后比对）
 *   POST /audit           owner | device（device 时 deviceId 由服务端覆盖）
 *   GET  /audit?limit=N&device=X  owner
 *   GET  /events          owner
 *   POST /mcp             owner（管理 MCP）
 *
 * Zero dependencies — Node.js built-in http only.
 */
import http from 'node:http';
import { isIP } from 'node:net';
import { promises as dnsPromises } from 'node:dns';
import { serverConfig } from './config.js';
import { tokenEqual } from './consttime.js';
import { mintCode, claimCode } from './pairing.js';
import { listDevices, revokeDevice, renameDevice, updateDeviceUrl, findDeviceByMachineId, findDeviceByName, findDeviceByToken, updateDeviceToken, registerDevice, isValidDeviceToken } from './devices.js';
import { handleMcp } from './mcp.js';
import { push } from './push.js';
import { pushEntry, query as queryAudit } from './audit.js';
import { createOpRequest, approveOp, rejectOp, getOpStatusPublic, registerPendingDevice, pendingDeviceNameByToken, clearPendingDevice, approveOpById, rejectOpById, listOps, verifyCardAction, updateApprovalCard, getOpByCode } from './ops.js';
import { handleOpsEvents } from './ops_events.js';
import { createEventService } from './events.js';
import { startMdnsAnnouncer } from './mdns.js';
import { pairClaimLimiter, pairInitLimiter, approveLimiter, approveGlobalLimiter, registerLimiter, clientIp } from './rateLimit.js';
const TOKEN = serverConfig.token;
// --- dashboard HTML (inline, zero dependencies) ---
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GCA 控制面板</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d0d0d;--surface:#1a1a19;--border:rgba(255,255,255,.1);--text:#fff;--text2:#c3c2b7;--text3:#898781;--blue:#3987e5;--green:#0ca30c;--red:#e53935;--yellow:#fab219;--green-bg:#12300f;--red-bg:#3a0808;--yellow-bg:#3a2e08}
body{background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:20px}
h1{font-size:20px;font-weight:650;margin-bottom:4px}
.sub{color:var(--text3);font-size:12px;margin-bottom:20px}
.tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:8px}
.tab{background:none;border:none;color:var(--text3);font-size:13px;padding:6px 14px;cursor:pointer;border-radius:6px 6px 0 0}
.tab.active{color:var(--text);background:var(--surface);border:1px solid var(--border);border-bottom-color:var(--surface);margin-bottom:-9px;padding-bottom:13px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px}
.card h3{font-size:14px;font-weight:650;margin-bottom:8px}
.btn{background:var(--blue);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer}
.btn:hover{opacity:.85}
.btn.sm{padding:4px 10px;font-size:12px}
.btn.red{background:var(--red)}
.btn.green{background:var(--green)}
.btn.yellow{background:var(--yellow);color:#000}
.input{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:13px;width:200px}
.input:focus{outline:none;border-color:var(--blue)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
th{color:var(--text3);font-weight:600;font-size:12px}
.chip{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px}
.chip.green{color:var(--green);background:var(--green-bg)}
.chip.red{color:var(--red);background:var(--red-bg)}
.chip.yellow{color:var(--yellow);background:var(--yellow-bg)}
.chip.blue{color:var(--blue);background:rgba(57,135,229,.15)}
.chip.gray{color:var(--text3);background:rgba(255,255,255,.06)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mono{font-family:"Cascadia Code","Fira Code",monospace;font-size:12px}
.hidden{display:none}
.msg{padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:10px}
.msg.ok{background:var(--green-bg);color:var(--green)}
.msg.err{background:var(--red-bg);color:var(--red)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px}
.stat .label{font-size:11px;color:var(--text3)}
.stat .val{font-size:24px;font-weight:700;margin-top:4px}
</style>
</head>
<body>
<div class="wrap">
<h1>GCA 控制面板</h1>
<div class="sub">Global Control Server · gca-server</div>

<div id="login" class="card">
  <h3>🔑 登录</h3>
  <div class="row" style="margin-top:8px">
    <input id="tokenInput" class="input" type="password" placeholder="输入 Bearer Token" style="flex:1">
    <button class="btn" onclick="doLogin()">登录</button>
  </div>
  <div id="loginMsg" style="margin-top:8px"></div>
</div>

<div id="app" class="hidden">
  <div class="tabs">
    <button class="tab active" data-tab="dashboard" onclick="switchTab('dashboard')">📊 概览</button>
    <button class="tab" data-tab="devices" onclick="switchTab('devices')">📱 设备</button>
    <button class="tab" data-tab="ops" onclick="switchTab('ops')">🔐 审批</button>
    <button class="tab" data-tab="audit" onclick="switchTab('audit')">📋 审计</button>
    <button class="tab" data-tab="tools" onclick="switchTab('tools')">🛠 工具</button>
  </div>

  <!-- dashboard -->
  <div id="tab-dashboard">
    <div class="stat-grid">
      <div class="stat"><div class="label">在线设备</div><div class="val" id="s-devices">-</div></div>
      <div class="stat"><div class="label">运行时间</div><div class="val" id="s-uptime">-</div></div>
      <div class="stat"><div class="label">待审批</div><div class="val" id="s-pending">-</div></div>
      <div class="stat"><div class="label">审计条目</div><div class="val" id="s-audit">-</div></div>
    </div>
    <div class="card">
      <h3>最近活动</h3>
      <div id="recent-audit" style="margin-top:8px;color:var(--text2);font-size:13px">加载中...</div>
    </div>
  </div>

  <!-- devices -->
  <div id="tab-devices" class="hidden">
    <div class="card">
      <h3>已注册设备</h3>
      <div style="margin-top:8px">
        <button class="btn sm" onclick="loadDevices()">🔄 刷新</button>
        <button class="btn sm green" onclick="genPairCode()" style="margin-left:4px">➕ 生成配对码</button>
        <span id="ev-ind" class="chip gray" style="margin-left:6px">… 连接中</span>
      </div>
      <div id="pair-result" style="margin-top:8px"></div>
      <table style="margin-top:10px">
        <thead><tr><th>设备</th><th>地址</th><th>状态</th><th>认证</th><th>操作</th></tr></thead>
        <tbody id="device-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- ops -->
  <div id="tab-ops" class="hidden">
    <div class="card">
      <h3>审批操作</h3>
      <div class="row" style="margin-top:8px">
        <input id="approveCode" class="input" placeholder="输入 6 位确认码">
        <button class="btn green sm" onclick="doApprove()">✓ 批准</button>
        <button class="btn red sm" onclick="doReject()">✗ 拒绝</button>
      </div>
      <div id="ops-msg" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <h3>待审批列表</h3>
      <div id="ops-list" style="margin-top:8px">加载中...</div>
    </div>
  </div>

  <!-- audit -->
  <div id="tab-audit" class="hidden">
    <div class="card">
      <h3>审计日志</h3>
      <div class="row" style="margin-top:8px">
        <button class="btn sm" onclick="loadAudit()">🔄 刷新</button>
        <input id="auditFilter" class="input" placeholder="按设备筛选..." oninput="filterAudit()">
      </div>
      <table style="margin-top:10px">
        <thead><tr><th>时间</th><th>设备</th><th>操作</th><th>详情</th><th>状态</th></tr></thead>
        <tbody id="audit-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- tools -->
  <div id="tab-tools" class="hidden">
    <div class="card">
      <h3>推送消息</h3>
      <div class="row" style="margin-top:8px">
        <input id="pushText" class="input" placeholder="推送到飞书+微信..." style="flex:1">
        <button class="btn sm" onclick="doPush()">📤 发送</button>
      </div>
      <div id="push-msg" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <h3>剪贴板同步</h3>
      <div class="row" style="margin-top:8px">
        <input id="clipContent" class="input" placeholder="推送剪贴板内容..." style="flex:1">
        <button class="btn sm" onclick="doClipPush()">📋 推送</button>
        <button class="btn sm" onclick="doClipPull()">📥 拉取</button>
      </div>
      <div id="clip-result" style="margin-top:8px;color:var(--text2);font-size:13px;word-break:break-all;max-height:200px;overflow:auto"></div>
    </div>
    <div class="card">
      <h3>设备注册审批</h3>
      <div class="row" style="margin-top:8px">
        <input id="regDeviceName" class="input" placeholder="设备名称">
        <button class="btn sm yellow" onclick="doRegister()">📝 注册请求</button>
      </div>
      <div id="reg-msg" style="margin-top:8px"></div>
    </div>
  </div>
</div>
</div>
<script>
const API = location.origin;
let TOKEN = localStorage.getItem('gca_token') || '';
let auditData = [];
// 事件驱动设备状态（阶段二）：devStatus = /events 快照与增量事件；regDevices = 最近一次 /devices 列表缓存
let devStatus = {};
let regDevices = [];
let pollTimer = null;
let opsPollTimer = null;

function hdr(){ return {'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'} }

async function api(method, path, body){
  const opts = {method, headers:hdr()};
  if(body) opts.body = JSON.stringify(body);
  const r = await fetch(API+path, opts);
  return {ok:r.ok, data:await r.json()};
}

function msg(id, text, ok){
  const el=document.getElementById(id);
  el.className='msg '+(ok?'ok':'err');
  el.textContent=text;
  setTimeout(()=>el.textContent='',5000);
}

async function doLogin(){
  const t=document.getElementById('tokenInput').value.trim();
  if(t) TOKEN=t;
  const r=await api('GET','/health');
  if(r.ok){
    localStorage.setItem('gca_token',TOKEN);
    document.getElementById('login').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    loadAll();
    startEvents();
  } else {
    msg('loginMsg','连接失败',false);
  }
}

// --- 事件驱动设备状态（阶段二）：/events SSE 订阅 + 断线回退轮询 ---
// 用 fetch 流式读（EventSource 不支持自定义 Bearer header）；断线 3s 重连，
// 断开期间回退 15s 轮询 /devices（状态列保留最近一次事件结果，指示器切换 ○ 轮询）。

function statusCell(name){
  const st = devStatus[name];
  if(!st) return '<td><span class="chip gray" title="尚未收到状态事件">未知</span></td>';
  const a = st.agent && st.agent.online;
  const t = st.term && st.term.online;
  let cls, txt;
  if(a && t){ cls='green'; txt='在线'; }
  else if(a){ cls='yellow'; txt='仅 Agent'; }
  else if(t){ cls='blue'; txt='仅终端'; }
  else { cls='red'; txt='离线'; }
  const detail = 'agent ' + (a ? fmtUptime(st.agent.uptime||0) : '离线')
    + ' · term ' + (t ? fmtUptime(st.term.uptime||0) : '离线');
  return '<td><span class="chip ' + cls + '" title="' + esc(detail) + '">' + txt + '</span></td>';
}

function handleEvent(ev, obj){
  if(ev==='snapshot'){
    devStatus = {};
    (obj.devices || []).forEach(function(d){ devStatus[d.device] = d; });
  } else if(ev==='device.removed'){
    delete devStatus[obj.device];
  } else if(ev==='device.online' || ev==='device.updated' || ev==='device.offline'){
    devStatus[obj.device] = obj;
  }
  renderDevices(regDevices);
}

function setEvState(on){
  const el = document.getElementById('ev-ind');
  el.className = 'chip ' + (on ? 'green' : 'red');
  el.textContent = on ? '● 实时' : '○ 轮询';
  if(on && pollTimer){ clearInterval(pollTimer); pollTimer = null; }
  if(!on && !pollTimer) pollTimer = setInterval(loadDevices, 15000);
  // 审查 M5：ops 列表与设备 SSE 状态解耦——登录后无条件 10s 刷新
  // （此前只在 SSE 断开时启动，正常态列表从不更新）
  if(!opsPollTimer) opsPollTimer = setInterval(loadOps, 10000);
}

function startEvents(){
  fetch(API + '/events', {headers:{'Authorization':'Bearer ' + TOKEN}}).then(async function(r){
    if(r.status === 401){ setEvState(false); return; } // token 失效：停在轮询，不无限重连
    if(!r.ok || !r.body) throw new Error('events ' + r.status);
    setEvState(true);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for(;;){
      const {done, value} = await reader.read();
      if(done) break;
      buf += dec.decode(value, {stream:true});
      let i;
      while((i = buf.indexOf('\\n\\n')) >= 0){
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = 'message', data = '';
        for(const line of frame.split('\\n')){
          if(line.startsWith('event:')) ev = line.slice(6).trim();
          else if(line.startsWith('data:')) data += line.slice(5).trim();
        }
        if(data){
          try { handleEvent(ev, JSON.parse(data)); } catch(e) { /* 畸形帧：忽略 */ }
        }
      }
    }
    throw new Error('stream closed');
  }).catch(function(){
    setEvState(false);
    setTimeout(startEvents, 3000);
  });
}

function switchTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  ['dashboard','devices','ops','audit','tools'].forEach(t=>{
    document.getElementById('tab-'+t).classList.toggle('hidden',t!==name);
  });
}

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmtTime(ts){ return new Date(ts).toLocaleString('zh-CN',{hour12:false}) }
function fmtUptime(s){
  if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';
  if(s<86400)return Math.floor(s/3600)+'h'+Math.floor(s%3600/60)+'m';
  return Math.floor(s/86400)+'d'+Math.floor(s%86400/3600)+'h';
}

async function loadOps(){
  const r=await api('GET','/ops?status=pending');
  const list=document.getElementById('ops-list');
  if(!r.ok||!list){ return; }
  const ops=r.data.ops||[];
  document.getElementById('s-pending').textContent=ops.length;
  if(ops.length===0){ list.innerHTML='<div style="color:var(--muted)">暂无待审批</div>'; return; }
  list.innerHTML=ops.map(function(o){
    return '<div style="padding:6px 0;border-bottom:1px solid var(--line)">'+
      '<b>'+esc(o.device)+'</b> · '+esc(o.operation)+
      (o.detail?'<div style="font-size:12px;color:var(--muted)">'+esc(o.detail)+'</div>':'')+
      '<div style="font-size:12px;color:var(--muted)">'+new Date(o.createdAt).toLocaleTimeString()+' · '+
      '<button onclick="approveOpId(\''+o.id+'\')">授权</button> '+
      '<button onclick="rejectOpId(\''+o.id+'\')">拒绝</button></div></div>';
  }).join('');
}
async function approveOpId(id){
  if(!confirm('确认授权该请求？')) return;
  const r=await api('POST','/ops/'+id+'/approve',{});
  loadOps(); loadDevices();
}
async function rejectOpId(id){
  if(!confirm('确认拒绝该请求？')) return;
  const r=await api('POST','/ops/'+id+'/reject',{});
  loadOps();
}

async function loadAll(){
  const [h,dev,aud]=await Promise.all([
    api('GET','/health'),
    api('GET','/devices'),
    api('GET','/audit?limit=20')
  ]);
  if(h.ok){
    document.getElementById('s-uptime').textContent=fmtUptime(h.data.uptime);
  }
  if(dev.ok){
    document.getElementById('s-devices').textContent=dev.data.count;
    renderDevices(dev.data.devices);
  }
  loadOps();
  if(aud.ok){
    document.getElementById('s-audit').textContent=aud.data.count;
    auditData=aud.data.entries||[];
    renderAudit(auditData.slice(-5).reverse());
    document.getElementById('recent-audit').innerHTML=auditData.slice(-5).reverse().map(e=>
      '<div style="padding:3px 0"><span style="color:var(--text3)">'+fmtTime(e.ts)+'</span> <b>'+esc(e.deviceId)+'</b> '+esc(e.action)+' <span class="chip '+(e.status==='ok'||e.status==='approved'?'green':e.status==='pending'?'yellow':'red')+'">'+esc(e.status)+'</span></div>'
    ).join('')||'暂无记录';
  }
}

function renderDevices(devs){
  regDevices = devs;
  const tb=document.getElementById('device-tbody');
  tb.innerHTML=devs.map(d=>
    '<tr><td><b>'+esc(d.name)+'</b></td><td class="mono">'+esc(d.url)+'</td>'+statusCell(d.name)+'<td>'+(d.hasAuth?'<span class="chip green">✓</span>':'<span class="chip red">✗</span>')+'</td><td><button class="btn sm red" data-name="'+esc(d.name)+'" onclick="revokeDevice(this.dataset.name)">撤销</button></td></tr>'
  ).join('')||'<tr><td colspan="5" style="color:var(--text3)">无设备</td></tr>';
  const total = regDevices.length;
  const online = regDevices.filter(function(d){
    const st = devStatus[d.name];
    return st && ((st.agent && st.agent.online) || (st.term && st.term.online));
  }).length;
  document.getElementById('s-devices').textContent = total ? online + '/' + total : '-';
}

async function loadDevices(){
  const r=await api('GET','/devices');
  if(r.ok) renderDevices(r.data.devices);
}

async function genPairCode(){
  const r=await api('POST','/pair/init');
  const el=document.getElementById('pair-result');
  if(r.ok){
    el.innerHTML='<div class="msg ok">配对码: <b class="mono" style="font-size:16px">'+r.data.code+'</b> （'+Math.floor(r.data.expiresInSec/60)+'分钟有效）</div>';
  } else {
    el.innerHTML='<div class="msg err">生成失败: '+r.data.error+'</div>';
  }
}

async function revokeDevice(name){
  if(!confirm('确定撤销设备 '+name+'？')) return;
  const r=await api('POST','/devices/'+name+'/revoke');
  if(r.ok){ loadDevices(); loadAll(); }
  else alert('撤销失败: '+r.data.error);
}

async function doApprove(){
  const code=document.getElementById('approveCode').value.trim();
  if(!code) return;
  const r=await api('POST','/ops/approve',{code});
  msg('ops-msg', r.ok?'已批准: '+r.data.operation+' ('+r.data.device+')':'失败: '+r.data.error, r.ok);
  if(r.ok) loadAll();
}

async function doReject(){
  const code=document.getElementById('approveCode').value.trim();
  if(!code) return;
  const r=await api('POST','/ops/reject',{code});
  msg('ops-msg', r.ok?'已拒绝':'失败: '+r.data.error, r.ok);
}

function renderAudit(entries){
  const tb=document.getElementById('audit-tbody');
  tb.innerHTML=entries.map(e=>
    '<tr><td>'+fmtTime(e.ts)+'</td><td><b>'+esc(e.deviceId)+'</b></td><td>'+esc(e.action)+'</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">'+esc(e.detail)+'</td><td><span class="chip '+(e.status==='ok'||e.status==='approved'?'green':e.status==='pending'?'yellow':'red')+'">'+esc(e.status)+'</span></td></tr>'
  ).join('')||'<tr><td colspan="5" style="color:var(--text3)">无记录</td></tr>';
}

async function loadAudit(){
  const r=await api('GET','/audit?limit=50');
  if(r.ok){ auditData=r.data.entries||[]; renderAudit(auditData); document.getElementById('s-audit').textContent=r.data.count; }
}

function filterAudit(){
  const q=document.getElementById('auditFilter').value.toLowerCase();
  renderAudit(auditData.filter(e=>!q||e.deviceId.toLowerCase().includes(q)).reverse().slice(0,50));
}

async function doPush(){
  const text=document.getElementById('pushText').value.trim();
  if(!text) return;
  const r=await api('POST','/push',{text});
  msg('push-msg', r.ok?'已推送到 '+r.data.channels.join(', '):'失败', r.ok);
}

async function doClipPush(){
  const content=document.getElementById('clipContent').value.trim();
  if(!content) return;
  const r=await api('POST','/clipboard/push',{content,deviceId:'dashboard'});
  msg('clip-result', r.ok?'已推送':'失败', r.ok);
}

async function doClipPull(){
  const r=await api('GET','/clipboard/latest');
  if(r.ok){
    if(!r.data.updatedAt||!r.data.content){
      document.getElementById('clip-result').innerHTML='<div style="color:var(--text3)">剪贴板为空</div>';
    } else {
      document.getElementById('clip-result').innerHTML='<div class="msg ok">'+fmtTime(r.data.updatedAt)+' ['+esc(r.data.deviceId)+']</div><div style="margin-top:4px">'+esc(r.data.content)+'</div>';
    }
  }
}

async function doRegister(){
  const name=document.getElementById('regDeviceName').value.trim();
  if(!name) return;
  const r=await api('POST','/register',{deviceName:name});
  if(r.ok){
    msg('reg-msg','注册请求已生成，确认码: '+r.data.code+' ('+Math.floor(r.data.expiresInSec/60)+'分钟有效)',true);
  } else {
    msg('reg-msg','失败: '+r.data.error,false);
  }
}

// auto-login if token saved
if(TOKEN){
  document.getElementById('tokenInput').value=TOKEN;
  doLogin();
}
</script>
</body>
</html>`;
const MAX_CLIPBOARD_BYTES = 5 * 1024 * 1024;
// --- clipboard store ---
let clipboard = { content: '', type: 'text', deviceId: '', updatedAt: 0 };
// --- auth ---
/** 提取请求中的 Bearer token（无则空串） */
function bearerToken(req) {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}
/** owner 认证：管理 token（constant-time） */
function authorized(req) {
    if (!TOKEN)
        return true; // no token configured → open mode
    const presented = bearerToken(req);
    return !!presented && tokenEqual(presented, TOKEN);
}
/** owner 或设备认证结果。device = 认证通过的设备名（注册表或待注册登记） */
async function authOwnerOrDevice(req) {
    if (authorized(req))
        return { owner: true, device: null };
    const presented = bearerToken(req);
    if (!presented)
        return { owner: false, device: null };
    const inRegistry = await findDeviceByToken(presented);
    if (inRegistry)
        return { owner: false, device: inRegistry.name };
    const pending = pendingDeviceNameByToken(presented);
    if (pending)
        return { owner: false, device: pending };
    return { owner: false, device: null };
}
/** 设备 term 端点：agent 端口 +10（约定），/mcp → /term<子路径> */
function termUrlFromEndpoint(mcpUrl, subPath) {
    try {
        const u = new URL(mcpUrl);
        u.port = String(Number(u.port) + 10);
        // subPath 可能带 query（/term/sse?cols=..&rows=..——桌面端带网格尺寸
        // 连接）。URL.pathname 赋值会把 '?' 转义成 %3F → 上游收到
        // /term/sse%3Fcols=.. 匹配不到路由 → 404。必须拆出 query 单独设置。
        let path = subPath;
        let qs = '';
        const qi = path.indexOf('?');
        if (qi >= 0) {
            qs = path.slice(qi);
            path = path.slice(0, qi);
        }
        u.pathname = '/term' + path;
        if (qs)
            u.search = qs;
        return u.toString();
    }
    catch {
        return mcpUrl.replace(/\/mcp$/, '/term') + subPath;
    }
}
function readBody(req, maxBytes = 65536) {
    return new Promise((resolve, reject) => {
        let body = '';
        let over = false;
        req.on('data', (c) => {
            body += c;
            if (body.length > maxBytes) {
                over = true;
                req.destroy(); // 超限：断开（handler 侧给 413 需先回写——见 readJson 调用方）
            }
        });
        req.on('end', () => (over ? reject(new Error('body too large')) : resolve(body)));
        req.on('error', reject);
        req.on('aborted', () => reject(new Error('client aborted')));
    });
}
/** 读 body 并解析 JSON——畸形输入返回 null（调用方给 400），不抛异常打死进程 */
async function readJson(req, maxBytes = 65536) {
    try {
        const text = await readBody(req, maxBytes);
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
/** URL 路径段解码（畸形 %-编码返回原串，不抛 URIError 打死进程） */
function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    }
    catch {
        return s;
    }
}
/**
 * SSRF 防护（2026-08-12 审查 S3 重写）：仅 http/https。
 *   1. 字面 IPv4 → 拒绝回环/私网/链路本地/组播/保留段
 *   2. 字面 IPv6 → 拒绝 ::1/::/fe80/fc00/ff00；IPv4-mapped（::ffff: 前缀）
 *      解映射出尾部 IPv4 再判（堵 [::ffff:7f00:1] 绕过）
 *   3. DNS 名 → dns.lookup 解析全部 A/AAAA 逐项校验，解析失败 fail-closed
 * 已知限制：DNS 重绑定 TOCTOU（解析后到连接前 IP 可换）——记入审查报告遗留节。
 */
function isBlockedIpv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
        return true;
    const [a, b] = parts;
    if (a === 0)
        return true; // 0.0.0.0/8
    if (a === 10)
        return true; // 10/8
    if (a === 127)
        return true; // 127/8 loopback
    if (a === 169 && b === 254)
        return true; // 169.254/16 link-local
    if (a === 172 && b >= 16 && b <= 31)
        return true; // 172.16/12
    if (a === 192 && b === 168)
        return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127)
        return true; // 100.64/10 CGNAT
    if (a === 198 && (b === 18 || b === 19))
        return true; // 198.18/15 benchmark
    if (a >= 224)
        return true; // 224/4 multicast + 240/4 reserved
    return false;
}
function isBlockedIpv6(host) {
    if (host === '::' || host === '::1')
        return true;
    if (/^(fe80|f[c-d]|ff)/i.test(host))
        return true; // link-local / ULA / multicast
    // IPv4-mapped（点分形式 ::ffff:127.0.0.1）
    const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (dotted)
        return isBlockedIpv4(dotted[1]);
    // IPv4-mapped（十六进制形式 ::ffff:7f00:1 —— URL 解析后常见形态）
    const hexForm = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexForm) {
        const hi = parseInt(hexForm[1], 16);
        const lo = parseInt(hexForm[2], 16);
        const ip4 = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
        return isBlockedIpv4(ip4);
    }
    return false;
}
export async function safeUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
        return null;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host)
        return null;
    const ipv = isIP(host);
    if (ipv === 4) {
        return isBlockedIpv4(host) ? null : u.toString();
    }
    if (ipv === 6) {
        return isBlockedIpv6(host) ? null : u.toString();
    }
    // DNS 名：解析全部地址逐项校验；解析失败一律拒绝（fail-closed）
    try {
        const addrs = await dnsPromises.lookup(host, { all: true });
        for (const a of addrs) {
            if (a.family === 4 ? isBlockedIpv4(a.address) : isBlockedIpv6(a.address))
                return null;
        }
    }
    catch {
        return null;
    }
    return u.toString();
}
function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}
// --- server ---
const startTime = Date.now();
/** 审批 device_registration 后的注册落地（2026-08-14 从 /ops/approve 抽共享：
 * App 按 id 审批 / 飞书卡片回调共用——避免注册链路断开）。
 * 审查 M1：返回注册结果——失败时调用方回写"已授权但注册失败"，不再误导"已授权"。 */
async function finalizeDeviceRegistration(op) {
    if (op.operation !== 'device_registration')
        return { registered: true };
    const deviceIp = op.deviceIp || 'unknown';
    const devicePort = op.devicePort || 3001;
    try {
        // S1：注册写设备自铸 token，不再写 owner token；缺 deviceToken → 拒绝
        if (!op.deviceToken) {
            console.error(new Date().toISOString(), 'registration rejected: missing deviceToken for', op.device);
            return { registered: false, error: 'registration requires deviceToken (owner 通道无法完成设备注册——需设备侧重新发起)' };
        }
        await registerDevice(op.device, deviceIp, devicePort, op.deviceToken, op.machineId);
        clearPendingDevice(op.device);
        console.log(new Date().toISOString(), 'device registered:', op.device, 'at', `${deviceIp}:${devicePort}`, 'machineId:', op.machineId?.slice(0, 8));
        return { registered: true };
    }
    catch (err) {
        console.error(new Date().toISOString(), 'registration failed:', err);
        return { registered: false, error: `registration failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}
export function startServer(port = serverConfig.port) {
    // 审查（2026-08-14）：open mode（无 token）下审批/设备端点全部无鉴权——启动显式告警
    if (!TOKEN) {
        console.error('!!! WARNING: GCA_SERVER_TOKEN not configured — server is in OPEN MODE (no authentication). 审批/设备端点全部无鉴权，生产部署必须配置 token (GCA_SERVER_TOKEN 或 ~/<服务端token路径>) !!!');
    }
    // 设备状态事件服务（集中探测 + /events SSE 广播）——事件驱动设备状态（docs/event-driven-plan.md）
    const events = createEventService({ listDevices, fetchImpl: fetch, log: console.log });
    events.start();
    // 局域网服务发现（INT-004）：mDNS 发布 _gca-server._tcp.local.，desktop/agent 自动发现
    const mdns = startMdnsAnnouncer({ port, info: { version: 'gca-server' }, log: console.log });
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const method = req.method ?? 'GET';
        // Health
        if (method === 'GET' && url === '/health') {
            return json(res, 200, { ok: true, service: 'gca-server', uptime: Math.round((Date.now() - startTime) / 1000) });
        }
        // Pairing init (owner-only, rate-limited)
        if (method === 'POST' && url === '/pair/init') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            if (!pairInitLimiter.allow(clientIp(req), 30))
                return json(res, 429, { error: 'too many requests' });
            const code = mintCode();
            console.log(new Date().toISOString(), 'pairing code: ****' + code.slice(-2)); // 日志去码（S6）
            return json(res, 200, { code, expiresInSec: 600 });
        }
        // Pairing claim (new device, no auth — rate-limited)。
        // S1 修复：设备携带自己铸造的 deviceToken（≥32 字符）+ machineId，
        // 服务端只存储，不再把 owner 管理 token 发给设备。
        if (method === 'POST' && url === '/pair/claim') {
            if (!pairClaimLimiter.allow(clientIp(req), 10))
                return json(res, 429, { error: 'too many attempts' });
            const body = await readJson(req);
            const { code, deviceName, port, deviceToken, machineId } = body;
            if (!isValidDeviceToken(deviceToken)) {
                return json(res, 400, { error: 'deviceToken required (min 32 chars, minted by device)' });
            }
            const deviceIp = req.socket.remoteAddress?.replace('::ffff:', '') || '127.0.0.1';
            const result = await claimCode(code, deviceName, deviceIp, Number(port) || 3001, deviceToken, machineId ? String(machineId) : undefined);
            if (!result.ok)
                return json(res, 403, { error: result.error });
            console.log(new Date().toISOString(), 'device paired:', deviceName, 'at', `${deviceIp}:${port}`);
            return json(res, 200, {
                ok: true,
                deviceIp,
                devicePort: port,
                message: 'Device registered in gateway with device-scoped token.',
            });
        }
        // Device list
        if (method === 'GET' && url === '/devices') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            try {
                const devices = await listDevices();
                return json(res, 200, { devices, count: devices.length });
            }
            catch (err) {
                return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
        }
        // Device revoke（S9：与 rename/reurl 一致用 safeDecode——此前含空格/中文/
        // % 的设备名经 dashboard 编码后永远 404）
        const revokeMatch = url.match(/^\/devices\/([^/]+)\/revoke$/);
        if (method === 'POST' && revokeMatch) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            try {
                const name = safeDecode(revokeMatch[1]);
                const removed = await revokeDevice(name);
                if (!removed)
                    return json(res, 404, { error: 'device not found' });
                events.notifyRemoved(name); // 立即广播 device.removed
                pushEntry({ ts: Date.now(), deviceId: name, action: 'device_revoked', detail: '', status: 'ok' });
                console.log(new Date().toISOString(), 'device revoked:', name);
                return json(res, 200, { ok: true, revoked: name });
            }
            catch (err) {
                return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
        }
        // Device rename（S15：newName 校验——拒绝路径分隔符/控制字符，长度 ≤64）
        const renameMatch = url.match(/^\/devices\/([^/]+)\/rename$/);
        if (method === 'POST' && renameMatch) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = await readJson(req);
            const { newName } = body;
            const bad = /[\\\u0000-\u001f]/.test(String(newName ?? ''));
            if (!newName || String(newName).length > 64 || bad) {
                return json(res, 400, { error: 'newName required: 1-64 chars, no / \\ or control chars' });
            }
            try {
                const oldName = safeDecode(renameMatch[1]);
                const renamed = await renameDevice(oldName, String(newName));
                if (!renamed)
                    return json(res, 404, { error: 'device not found' });
                // F1 修复（RA6 追溯）：rename 广播 hook——旧名立即移除（避免状态行残留），
                // 新名由下一轮 syncRegistry（≤10s）入表并广播 device.updated/online
                events.notifyRemoved(oldName);
                pushEntry({ ts: Date.now(), deviceId: newName, action: 'device_renamed', detail: `${oldName} → ${newName}`, status: 'ok' });
                console.log(new Date().toISOString(), 'device renamed:', oldName, '→', newName);
                return json(res, 200, { ok: true, oldName, newName });
            }
            catch (err) {
                return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
        }
        // Device update URL（S3：safeUrl 重写——IPv4-mapped/DNS 解析全路径校验）
        const reurlMatch = url.match(/^\/devices\/([^/]+)\/reurl$/);
        if (method === 'POST' && reurlMatch) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = await readJson(req);
            const { newUrl } = body;
            if (!newUrl)
                return json(res, 400, { error: 'newUrl required' });
            // SSRF 防护（2026-08-11 审查 + 08-12 补强）：只接受 http/https + 拒绝
            // 回环/私网/链路本地/组播 + IPv4-mapped 解映射 + DNS 解析逐项校验
            const u = await safeUrl(String(newUrl));
            if (!u)
                return json(res, 400, { error: 'invalid URL: http(s) only, no loopback/private' });
            try {
                const name = safeDecode(reurlMatch[1]);
                const updated = await updateDeviceUrl(name, u);
                if (!updated)
                    return json(res, 404, { error: 'device not found' });
                pushEntry({ ts: Date.now(), deviceId: name, action: 'device_reurl', detail: `→ ${u}`, status: 'ok' });
                console.log(new Date().toISOString(), 'device reurl:', name, '→', u);
                return json(res, 200, { ok: true, name, newUrl: u });
            }
            catch (err) {
                return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
        }
        // Device retoken（S1：owner 换发设备 token——设备泄露后自助轮换）
        const retokenMatch = url.match(/^\/devices\/([^/]+)\/retoken$/);
        if (method === 'POST' && retokenMatch) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = await readJson(req);
            const { token } = body;
            if (!isValidDeviceToken(token)) {
                return json(res, 400, { error: 'token required (min 32 chars)' });
            }
            const name = safeDecode(retokenMatch[1]);
            const updated = await updateDeviceToken(name, String(token));
            if (!updated)
                return json(res, 404, { error: 'device not found' });
            pushEntry({ ts: Date.now(), deviceId: name, action: 'device_retoken', detail: '', status: 'ok' });
            console.log(new Date().toISOString(), 'device retoken:', name);
            return json(res, 200, { ok: true, name });
        }
        // Device MCP proxy: Desktop 经 gca-server 转发到设备 MCP 端点。
        // 设备配对 token 只在网关侧持有，客户端无需也无法直连设备。
        // initialize 响应中的 mcp-session-id 透传回客户端，后续请求由客户端带回。
        // /device/:name/mcp     → 设备 <agent 端口>/mcp（endpoint.url 即设备 3001）
        // /device/:name/term/*  → 设备 <agent 端口+10>/term/*（端口 +10 约定，见 docs/architecture.md）
        const deviceMcpMatch = url.match(/^\/device\/([^/]+)\/mcp$/);
        const deviceTermMatch = url.match(/^\/device\/([^/]+)\/term(\/.*)?$/);
        const deviceProxy = deviceMcpMatch ?? deviceTermMatch;
        // mcp 仅 POST；term 支持 POST（input/resize/shell）与 GET（SSE 输出流）
        const termGet = Boolean(deviceTermMatch) && method === 'GET';
        if ((method === 'POST' || termGet) && deviceProxy) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const name = safeDecode(deviceProxy[1]);
            const body = termGet ? '' : await readBody(req, 65536);
            try {
                const { getDeviceEndpoint } = await import('./devices.js');
                const endpoint = await getDeviceEndpoint(name);
                if (!endpoint)
                    return json(res, 404, { error: 'device not found' });
                const sessionId = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : '';
                const upstreamUrl = deviceTermMatch
                    ? termUrlFromEndpoint(endpoint.url, deviceTermMatch[2] ?? '')
                    : endpoint.url;
                const upstreamHeaders = {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    ...(endpoint.auth ? { Authorization: endpoint.auth } : {}),
                    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
                };
                // 上游 fetch：SSE 长连接不设超时（断开由 abort 控制）；普通请求 30s 超时
                const abort = new AbortController();
                const up = await fetch(upstreamUrl, {
                    method: termGet ? 'GET' : 'POST',
                    headers: upstreamHeaders,
                    ...(termGet ? {} : { body }),
                    ...(termGet ? { signal: abort.signal } : { signal: AbortSignal.timeout(30000) }),
                });
                const headers = {
                    'Content-Type': up.headers.get('content-type') ?? 'application/json',
                };
                const upSession = up.headers.get('mcp-session-id');
                if (upSession)
                    headers['mcp-session-id'] = upSession;
                res.writeHead(up.status, headers);
                // 流式转发（SSE 长连接：逐块转发直到断开；普通响应等价于 text()）。
                // 客户端断开（res 'error'/'close'）→ abort 上游 + 取消 reader——
                // 否则 res.write 触发未处理 'error' 崩溃进程、上游连接泄漏。
                res.on('error', () => abort.abort());
                res.on('close', () => abort.abort());
                if (up.body) {
                    const reader = up.body.getReader();
                    try {
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done)
                                break;
                            if (res.destroyed)
                                break;
                            res.write(Buffer.from(value));
                        }
                    }
                    catch {
                        /* 上游/客户端断开：忽略 */
                    }
                    finally {
                        try {
                            await reader.cancel();
                        }
                        catch {
                            /* 已断开 */
                        }
                    }
                }
                if (!res.destroyed)
                    res.end();
            }
            catch (err) {
                if (!res.destroyed)
                    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
            }
            return;
        }
        // Approval push
        if (method === 'POST' && url === '/push') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = await readJson(req);
            const text = String(body.text ?? '').slice(0, 500);
            if (!text)
                return json(res, 400, { error: 'missing text' });
            const result = await push(text);
            return json(res, 202, result);
        }
        // Clipboard（S2：latest 加鉴权 owner|device；S8：push 专用读取上限，
        // 超限 413 且不触碰现有剪贴板——此前超 64KB 时 readJson 吞错返回 {}
        // → content='' 把原剪贴板清空）
        if (method === 'POST' && url === '/clipboard/push') {
            const auth = await authOwnerOrDevice(req);
            if (!auth.owner && !auth.device)
                return json(res, 401, { error: 'unauthorized' });
            let text;
            try {
                text = await readBody(req, MAX_CLIPBOARD_BYTES + 4096);
            }
            catch {
                return json(res, 413, { error: 'clipboard too large' }); // 超限：拒绝，不清空
            }
            let body;
            try {
                body = JSON.parse(text || '{}');
            }
            catch {
                return json(res, 400, { error: 'invalid JSON' });
            }
            const content = String(body.content ?? '').slice(0, MAX_CLIPBOARD_BYTES);
            // 设备推送时 deviceId 由服务端用认证身份覆盖（防伪造他人设备）
            const deviceId = auth.device ?? String(body.deviceId ?? '');
            clipboard = { content, type: body.type === 'image' ? 'image' : 'text', deviceId, updatedAt: Date.now() };
            return json(res, 200, { ok: true });
        }
        if (method === 'GET' && url === '/clipboard/latest') {
            const auth = await authOwnerOrDevice(req);
            if (!auth.owner && !auth.device)
                return json(res, 401, { error: 'unauthorized' });
            return json(res, 200, clipboard);
        }
        // Ops authorization — device requests high-risk operation, owner confirms via code。
        // S1：设备端认证（device 字段由服务端用认证身份覆盖，防冒充他机）；
        // M6：响应不含确认码——码只走 owner 通道（飞书/微信推送 + dashboard）。
        if (method === 'POST' && url === '/ops/request') {
            const { device } = await authOwnerOrDevice(req);
            if (!device)
                return json(res, 401, { error: 'unauthorized' });
            const body = await readJson(req);
            const { operation, detail } = body;
            if (!operation)
                return json(res, 400, { error: 'operation required' });
            const result = createOpRequest(device, String(operation), String(detail || ''));
            console.log(new Date().toISOString(), 'ops request:', device, operation, 'code: ****' + result.code.slice(-2));
            return json(res, 200, { id: result.id, expiresInSec: result.expiresInSec, status: 'pending' });
        }
        // 确认码批准——owner 专用（S6：限速 60/分/IP + 全局 300/分）
        if (method === 'POST' && url === '/ops/approve') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const ip = clientIp(req);
            if (!approveLimiter.allow(ip, 60) || !approveGlobalLimiter.allow('global', 300)) {
                return json(res, 429, { error: 'too many attempts' });
            }
            const body = await readJson(req);
            const { code } = body;
            if (!code)
                return json(res, 400, { error: 'code required' });
            const result = approveOp(String(code));
            if (!result.ok)
                return json(res, 403, { error: result.error });
            const reg = await finalizeDeviceRegistration(result.op);
            void updateApprovalCard(result.op, reg.registered ? 'approved' : 'expired').catch(() => { }); // 审查 M2：code 通道也回写卡片
            return json(res, 200, { ok: true, operation: result.op.operation, device: result.op.device, registered: reg.registered, ...(reg.error ? { registrationError: reg.error } : {}) });
        }
        // 按 id 批准/拒绝——owner 专用（2026-08-14：App 审批 + 飞书卡片回调）
        // device_registration 注册副作用抽共享（finalizeDeviceRegistration）
        const approveById = url.match(/^\/ops\/([a-z0-9-]+)\/approve$/);
        if (method === 'POST' && approveById) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const ip = clientIp(req);
            if (!approveLimiter.allow(ip, 60) || !approveGlobalLimiter.allow('global', 300)) {
                return json(res, 429, { error: 'too many attempts' });
            }
            const result = approveOpById(approveById[1]);
            if (!result.ok)
                return json(res, 403, { error: result.error });
            const reg = await finalizeDeviceRegistration(result.op);
            void updateApprovalCard(result.op, reg.registered ? 'approved' : 'expired').catch(() => { });
            return json(res, 200, { ok: true, operation: result.op.operation, device: result.op.device, registered: reg.registered, ...(reg.error ? { registrationError: reg.error } : {}) });
        }
        const rejectById = url.match(/^\/ops\/([a-z0-9-]+)\/reject$/);
        if (method === 'POST' && rejectById) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const ip = clientIp(req);
            if (!approveLimiter.allow(ip, 60) || !approveGlobalLimiter.allow('global', 300)) {
                return json(res, 429, { error: 'too many attempts' });
            }
            const result = rejectOpById(rejectById[1]);
            if (!result.ok)
                return json(res, 403, { error: result.error });
            void updateApprovalCard(result.op, 'rejected').catch(() => { });
            return json(res, 200, { ok: true });
        }
        // 飞书卡片按钮回调（OpenClaw 扩展中转）——签名 + owner allowlist + 限速 + loopback
        // 审查 H2/M4：无 token（open mode）时签名盐固定可伪造 → fail-closed；仅接受本机来源；
        // 限速防无背压面
        if (method === 'POST' && url === '/ops/card-action') {
            if (!TOKEN)
                return json(res, 403, { error: 'card-action disabled without owner token (open mode)' });
            const ip = clientIp(req);
            if (ip !== '127.0.0.1' && ip !== '::1')
                return json(res, 403, { error: 'loopback only' });
            if (!approveLimiter.allow(ip, 30) || !approveGlobalLimiter.allow('global', 300)) {
                return json(res, 429, { error: 'too many attempts' });
            }
            const body = await readJson(req);
            const { opId, action, signature, senderId } = body;
            if (!opId || !signature || !senderId)
                return json(res, 400, { error: 'opId/signature/senderId required' });
            if (!verifyCardAction(String(opId), String(signature), String(senderId))) {
                return json(res, 403, { error: 'invalid signature or sender' });
            }
            if (action === 'approve') {
                const result = approveOpById(String(opId));
                if (!result.ok)
                    return json(res, 403, { error: result.error });
                const reg = await finalizeDeviceRegistration(result.op);
                void updateApprovalCard(result.op, reg.registered ? 'approved' : 'expired').catch(() => { });
                return json(res, 200, { ok: true, status: 'approved', registered: reg.registered, ...(reg.error ? { registrationError: reg.error } : {}) });
            }
            if (action === 'reject') {
                const result = rejectOpById(String(opId));
                if (!result.ok)
                    return json(res, 403, { error: result.error });
                void updateApprovalCard(result.op, 'rejected').catch(() => { });
                return json(res, 200, { ok: true, status: 'rejected' });
            }
            return json(res, 400, { error: 'action must be approve/reject' });
        }
        // 审批列表（owner）——App 校验/面板；注意与 /ops/:id 正则区分（url 含 query）
        if (method === 'GET' && (url === '/ops' || url.startsWith('/ops?'))) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const u = new URL(url, 'http://x');
            const status = u.searchParams.get('status') || undefined;
            return json(res, 200, { ops: listOps(status) });
        }
        // 审批事件流（owner，SSE）——App 审批下发（2026-08-14）
        if (method === 'GET' && url === '/ops/events') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            handleOpsEvents(req, res, () => listOps('pending'));
            return;
        }
        if (method === 'POST' && url === '/ops/reject') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = await readJson(req);
            const { code } = body;
            const ok = rejectOp(String(code));
            // 审查 M2：拒绝成功也回写卡片（避免卡片保持可点）
            if (ok) {
                const op = getOpByCode(String(code));
                if (op)
                    void updateApprovalCard(op, 'rejected').catch(() => { });
            }
            return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'code not found' });
        }
        // 轮询 op 状态：owner 或 op 归属设备；响应不含 code（M6/S1）。
        // 设备在审批通过前不在注册表——走待注册登记（pendingDevices）认证。
        const opsMatch = url.match(/^\/ops\/([a-z0-9-]+)$/);
        if (method === 'GET' && opsMatch) {
            const op = getOpStatusPublic(opsMatch[1]);
            if (!op)
                return json(res, 404, { error: 'not found' });
            const auth = await authOwnerOrDevice(req);
            if (!auth.owner && auth.device !== op.device)
                return json(res, 401, { error: 'unauthorized' });
            return json(res, 200, op);
        }
        // Device heartbeat — client reports its current IP, update URL if changed。
        // S1：设备 token 认证（按 machineId 定位设备后 constant-time 比对）；
        // S10：machineId 缺失/查不到时按 deviceName 兜底（配对注册早期不带 machineId）。
        if (method === 'POST' && url === '/heartbeat') {
            const body = await readJson(req);
            const { machineId, port, deviceName } = body;
            if (!machineId && !deviceName)
                return json(res, 400, { error: 'machineId or deviceName required' });
            try {
                let existing = machineId ? await findDeviceByMachineId(String(machineId)) : null;
                if (!existing && deviceName)
                    existing = await findDeviceByName(String(deviceName));
                if (!existing)
                    return json(res, 404, { error: 'device not registered' });
                // 设备自铸 token 认证（constant-time）；老条目无 deviceToken → 401（需重配对）
                const presented = bearerToken(req);
                const stored = existing.cfg.deviceToken ?? '';
                if (!presented || !stored || !tokenEqual(presented, stored)) {
                    return json(res, 401, { error: 'unauthorized' });
                }
                const deviceIp = req.socket.remoteAddress?.replace('::ffff:', '') || '';
                const devicePort = Number(port) || 3001;
                const newUrl = `http://${deviceIp}:${devicePort}/mcp`;
                if (existing.cfg.url !== newUrl) {
                    await updateDeviceUrl(existing.name, newUrl);
                    events.notifyHeartbeat(existing.name, newUrl); // 立即广播 URL 变化（不等下一轮探测）
                    console.log(new Date().toISOString(), 'device IP updated:', existing.name, '→', newUrl);
                    return json(res, 200, { ok: true, name: existing.name, url: newUrl, updated: true });
                }
                return json(res, 200, { ok: true, name: existing.name, url: existing.cfg.url, updated: false });
            }
            catch (err) {
                return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
        }
        // Device self-status（S1：设备 token 认证——客户端注册状态检查用，
        // 替代旧方案让设备带 token 读全量 /devices 列表）
        if (method === 'GET' && url === '/device/me') {
            const { device } = await authOwnerOrDevice(req);
            if (!device)
                return json(res, 401, { error: 'unauthorized' });
            const entry = await findDeviceByName(device);
            if (!entry)
                return json(res, 404, { error: 'not registered yet' });
            return json(res, 200, { name: device, machineId: entry.cfg.machineId ?? '', url: entry.cfg.url });
        }
        // Device events — 集中探测状态 SSE 流（Bearer token 认证；连接即发 snapshot 全量）
        if (method === 'GET' && url === '/events') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            events.handleEvents(req, res);
            return;
        }
        // Device registration — generates confirmation code for owner approval。
        // S1：设备携带自铸 deviceToken（body）；owner（dashboard）调用时响应含确认码，
        // 设备通道不含码（M6）。设备通道认证语义：携带格式合法的 deviceToken
        // （≥32 字符）即受理——信任闸门是 owner 确认码审批（S1 修复后 token 只
        // 认证设备自身端点，不再持有 owner 凭据）。S6：限速 10/时/IP。
        if (method === 'POST' && url === '/register') {
            if (!registerLimiter.allow(clientIp(req), 10))
                return json(res, 429, { error: 'too many registration attempts' });
            const body = await readJson(req);
            const { deviceName, machineId, port } = body;
            if (!deviceName)
                return json(res, 400, { error: 'deviceName required' });
            const bodyDeviceToken = body.deviceToken ? String(body.deviceToken) : '';
            const isDeviceChannel = isValidDeviceToken(bodyDeviceToken);
            const auth = await authOwnerOrDevice(req);
            if (!auth.owner && !isDeviceChannel)
                return json(res, 401, { error: 'unauthorized' });
            // 设备自铸 token：body.deviceToken（设备通道）或认证用的设备 token
            const deviceToken = isDeviceChannel ? bodyDeviceToken : (auth.device ? bearerToken(req) : '');
            // Check if already registered by machineId（已注册 → 直接 approved；
            // code 字段仅 owner 通道携带——dashboard 展示用，设备通道不含）
            if (machineId) {
                const existing = await findDeviceByMachineId(String(machineId));
                if (existing) {
                    const base = { id: '', status: 'approved', note: `设备已注册为 ${existing.name}` };
                    return json(res, 200, auth.owner ? { ...base, code: '' } : base);
                }
            }
            const deviceIp = req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
            const devicePort = Number(port) || 3001;
            const detail = machineId ? `新设备 ${deviceName} 请求注册 (machineId: ${String(machineId).slice(0, 8)}...)` : `新设备 ${deviceName} 请求注册`;
            const result = createOpRequest(String(deviceName), 'device_registration', detail, deviceIp, String(machineId || ''), devicePort, deviceToken);
            if (deviceToken)
                registerPendingDevice(String(deviceName), deviceToken); // 审批前轮询认证用
            console.log(new Date().toISOString(), 'registration request:', deviceName, 'ip:', deviceIp, 'code: ****' + result.code.slice(-2));
            // 设备通道不带确认码（码只走 owner 通道）；owner（dashboard）带码供确认
            if (auth.owner) {
                return json(res, 200, { id: result.id, code: result.code, expiresInSec: result.expiresInSec, status: 'pending', note: '等待 owner 回复确认码完成注册' });
            }
            return json(res, 200, { id: result.id, expiresInSec: result.expiresInSec, status: 'pending', note: '等待 owner 确认完成注册' });
        }
        // Audit（S1：设备通道认证 + deviceId 由服务端用认证身份覆盖——防持 token 者
        // 伪造任意设备审计记录）
        if (method === 'POST' && url === '/audit') {
            const auth = await authOwnerOrDevice(req);
            if (!auth.owner && !auth.device)
                return json(res, 401, { error: 'unauthorized' });
            const body = await readJson(req, 16384);
            const deviceId = auth.device ?? String(body.deviceId || 'unknown');
            pushEntry({
                ts: Number(body.ts) || Date.now(),
                deviceId,
                action: String(body.action || '').slice(0, 200),
                detail: String(body.detail || '').slice(0, 500),
                status: String(body.status || '').slice(0, 50),
            });
            return json(res, 200, { ok: true });
        }
        if (method === 'GET' && url.startsWith('/audit')) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const u = new URL(url, 'http://localhost');
            const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 1000);
            const device = u.searchParams.get('device') || undefined;
            return json(res, 200, queryAudit(limit, device));
        }
        // MCP endpoint (management tools for AI agent)
        if (await handleMcp(req, res, url))
            return;
        // Dashboard UI
        if (method === 'GET' && (url === '/' || url.startsWith('/?'))) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(DASHBOARD_HTML);
            return;
        }
        json(res, 404, { error: 'not found' });
    });
    server.listen(port, '0.0.0.0', () => {
        console.log(`gca-server listening on 0.0.0.0:${port}`);
        console.log(`  pairing: POST /pair/init (Bearer) → POST /pair/claim`);
        console.log(`  devices: GET /devices | POST /devices/:name/revoke`);
        console.log(`  push:    POST /push`);
        console.log(`  audit:   POST /audit | GET /audit?limit=N`);
        console.log(`  clipper: POST /clipboard/push | GET /clipboard/latest`);
    });
    return server;
}
// Direct run: tsx src/server/gca-server.ts
if (process.argv[1]?.endsWith('gca-server.ts') || process.argv[1]?.endsWith('gca-server.js')) {
    startServer();
}
//# sourceMappingURL=gca-server.js.map