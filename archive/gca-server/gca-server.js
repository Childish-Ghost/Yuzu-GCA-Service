/**
 * gca-server — GCA control plane daemon.
 *
 * Endpoints:
 *   GET  /health
 *   POST /pair/init      Bearer token
 *   POST /pair/claim
 *   GET  /devices         Bearer token
 *   POST /devices/:name/revoke  Bearer token
 *   POST /push            Bearer token
 *   POST /clipboard/push  Bearer token
 *   GET  /clipboard/latest
 *   POST /ops/request     Bearer token  — high-risk op authorization
 *   POST /ops/approve     Bearer token  — owner confirms with code
 *   POST /ops/reject      Bearer token  — owner rejects
 *   GET  /ops/:id         Bearer token  — poll op status
 *   POST /register        Bearer token  — device registration with confirmation
 *   POST /audit           Bearer token
 *   GET  /audit?limit=N&device=X  Bearer token
 *
 * Zero dependencies — Node.js built-in http only.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { serverConfig } from './config.js';
import { mintCode, claimCode } from './pairing.js';
import { listDevices, revokeDevice, renameDevice, updateDeviceUrl } from './devices.js';
import { push } from './push.js';
import { pushEntry, query as queryAudit } from './audit.js';
import { createOpRequest, approveOp, rejectOp, getOpStatus } from './ops.js';
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
<div class="sub">Global Control Server · gca-server v0.1.0</div>

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
      </div>
      <div id="pair-result" style="margin-top:8px"></div>
      <table style="margin-top:10px">
        <thead><tr><th>设备</th><th>地址</th><th>认证</th><th>操作</th></tr></thead>
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
  } else {
    msg('loginMsg','连接失败',false);
  }
}

function switchTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  ['dashboard','devices','ops','audit','tools'].forEach(t=>{
    document.getElementById('tab-'+t).classList.toggle('hidden',t!==name);
  });
}

function fmtTime(ts){ return new Date(ts).toLocaleString('zh-CN',{hour12:false}) }
function fmtUptime(s){
  if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';
  if(s<86400)return Math.floor(s/3600)+'h'+Math.floor(s%3600/60)+'m';
  return Math.floor(s/86400)+'d'+Math.floor(s%86400/3600)+'h';
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
  if(aud.ok){
    document.getElementById('s-audit').textContent=aud.data.count;
    auditData=aud.data.entries||[];
    renderAudit(auditData.slice(-5).reverse());
    document.getElementById('recent-audit').innerHTML=auditData.slice(-5).reverse().map(e=>
      '<div style="padding:3px 0"><span style="color:var(--text3)">'+fmtTime(e.ts)+'</span> <b>'+e.deviceId+'</b> '+e.action+' <span class="chip '+(e.status==='ok'||e.status==='approved'?'green':e.status==='pending'?'yellow':'red')+'">'+e.status+'</span></div>'
    ).join('')||'暂无记录';
  }
}

function renderDevices(devs){
  const tb=document.getElementById('device-tbody');
  tb.innerHTML=devs.map(d=>
    '<tr><td><b>'+d.name+'</b></td><td class="mono">'+d.url+'</td><td>'+(d.hasAuth?'<span class="chip green">✓</span>':'<span class="chip red">✗</span>')+'</td><td><button class="btn sm red" onclick="revokeDevice(\\''+d.name+'\\')">撤销</button></td></tr>'
  ).join('')||'<tr><td colspan="4" style="color:var(--text3)">无设备</td></tr>';
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
    '<tr><td>'+fmtTime(e.ts)+'</td><td><b>'+e.deviceId+'</b></td><td>'+e.action+'</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">'+e.detail+'</td><td><span class="chip '+(e.status==='ok'||e.status==='approved'?'green':e.status==='pending'?'yellow':'red')+'">'+e.status+'</span></td></tr>'
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
      document.getElementById('clip-result').innerHTML='<div class="msg ok">'+fmtTime(r.data.updatedAt)+' ['+r.data.deviceId+']</div><div style="margin-top:4px">'+r.data.content+'</div>';
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
function authorized(req) {
    if (!TOKEN)
        return true; // no token configured → open mode
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!presented || presented.length !== TOKEN.length)
        return false;
    return timingSafeEqual(Buffer.from(presented), Buffer.from(TOKEN));
}
function readBody(req, maxBytes = 65536) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > maxBytes)
            req.destroy(); });
        req.on('end', () => resolve(body));
    });
}
function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}
// --- server ---
const startTime = Date.now();
export function startServer(port = serverConfig.port) {
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const method = req.method ?? 'GET';
        // Health
        if (method === 'GET' && url === '/health') {
            return json(res, 200, { ok: true, service: 'gca-server', uptime: Math.round((Date.now() - startTime) / 1000) });
        }
        // Pairing init (owner-only)
        if (method === 'POST' && url === '/pair/init') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const code = mintCode();
            console.log(new Date().toISOString(), 'pairing code:', code);
            return json(res, 200, { code, expiresInSec: 600 });
        }
        // Pairing claim (new device, no auth)
        if (method === 'POST' && url === '/pair/claim') {
            const body = JSON.parse(await readBody(req) || '{}');
            const { code, deviceName, port } = body;
            const deviceIp = req.socket.remoteAddress?.replace('::ffff:', '') || '127.0.0.1';
            const result = await claimCode(code, deviceName, deviceIp, Number(port) || 3001);
            if (!result.ok)
                return json(res, 403, { error: result.error });
            console.log(new Date().toISOString(), 'device paired:', deviceName, 'at', `${deviceIp}:${port}`);
            return json(res, 200, {
                ok: true,
                pairingToken: result.pairingToken,
                deviceIp,
                devicePort: port,
                message: 'Device registered in gateway.',
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
        // Device revoke
        const revokeMatch = url.match(/^\/devices\/([^/]+)\/revoke$/);
        if (method === 'POST' && revokeMatch) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            try {
                const name = revokeMatch[1];
                const removed = await revokeDevice(name);
                if (!removed)
                    return json(res, 404, { error: 'device not found' });
                pushEntry({ ts: Date.now(), deviceId: name, action: 'device_revoked', detail: '', status: 'ok' });
                console.log(new Date().toISOString(), 'device revoked:', name);
                return json(res, 200, { ok: true, revoked: name });
            }
            catch (err) {
                return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
        }
        // Device rename
        const renameMatch = url.match(/^\/devices\/([^/]+)\/rename$/);
        if (method === 'POST' && renameMatch) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = JSON.parse(await readBody(req) || '{}');
            const { newName } = body;
            if (!newName)
                return json(res, 400, { error: 'newName required' });
            try {
                const oldName = decodeURIComponent(renameMatch[1]);
                const renamed = await renameDevice(oldName, String(newName));
                if (!renamed)
                    return json(res, 404, { error: 'device not found' });
                pushEntry({ ts: Date.now(), deviceId: newName, action: 'device_renamed', detail: `${oldName} → ${newName}`, status: 'ok' });
                console.log(new Date().toISOString(), 'device renamed:', oldName, '→', newName);
                return json(res, 200, { ok: true, oldName, newName });
            }
            catch (err) {
                return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
        }
        // Device update URL
        const reurlMatch = url.match(/^\/devices\/([^/]+)\/reurl$/);
        if (method === 'POST' && reurlMatch) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = JSON.parse(await readBody(req) || '{}');
            const { newUrl } = body;
            if (!newUrl)
                return json(res, 400, { error: 'newUrl required' });
            try {
                const name = decodeURIComponent(reurlMatch[1]);
                const updated = await updateDeviceUrl(name, String(newUrl));
                if (!updated)
                    return json(res, 404, { error: 'device not found' });
                pushEntry({ ts: Date.now(), deviceId: name, action: 'device_reurl', detail: `→ ${newUrl}`, status: 'ok' });
                console.log(new Date().toISOString(), 'device reurl:', name, '→', newUrl);
                return json(res, 200, { ok: true, name, newUrl });
            }
            catch (err) {
                return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
        }
        // Approval push
        if (method === 'POST' && url === '/push') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = JSON.parse(await readBody(req) || '{}');
            const text = String(body.text ?? '').slice(0, 500);
            if (!text)
                return json(res, 400, { error: 'missing text' });
            const result = await push(text);
            return json(res, 202, result);
        }
        // Clipboard
        if (method === 'POST' && url === '/clipboard/push') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = JSON.parse(await readBody(req) || '{}');
            const content = String(body.content ?? '').slice(0, MAX_CLIPBOARD_BYTES);
            clipboard = { content, type: body.type === 'image' ? 'image' : 'text', deviceId: String(body.deviceId ?? ''), updatedAt: Date.now() };
            return json(res, 200, { ok: true });
        }
        if (method === 'GET' && url === '/clipboard/latest') {
            return json(res, 200, clipboard);
        }
        // Ops authorization — device requests high-risk operation, owner confirms via code
        if (method === 'POST' && url === '/ops/request') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = JSON.parse(await readBody(req) || '{}');
            const { device, operation, detail } = body;
            if (!device || !operation)
                return json(res, 400, { error: 'device and operation required' });
            const result = createOpRequest(String(device), String(operation), String(detail || ''));
            console.log(new Date().toISOString(), 'ops request:', device, operation, 'code:', result.code);
            return json(res, 200, { id: result.id, code: result.code, expiresInSec: result.expiresInSec, status: 'pending' });
        }
        if (method === 'POST' && url === '/ops/approve') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = JSON.parse(await readBody(req) || '{}');
            const { code } = body;
            if (!code)
                return json(res, 400, { error: 'code required' });
            const result = approveOp(String(code));
            if (!result.ok)
                return json(res, 403, { error: result.error });
            // If this was a device registration, actually register the device
            if (result.op.operation === 'device_registration') {
                const deviceIp = result.op.deviceIp || 'unknown';
                try {
                    const { registerDevice } = await import('./devices.js');
                    await registerDevice(result.op.device, deviceIp, 3003, TOKEN);
                    console.log(new Date().toISOString(), 'device registered:', result.op.device, 'at', deviceIp);
                }
                catch (err) {
                    console.error(new Date().toISOString(), 'registration failed:', err);
                }
            }
            return json(res, 200, { ok: true, operation: result.op.operation, device: result.op.device });
        }
        if (method === 'POST' && url === '/ops/reject') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = JSON.parse(await readBody(req) || '{}');
            const { code } = body;
            const ok = rejectOp(String(code));
            return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'code not found' });
        }
        const opsMatch = url.match(/^\/ops\/([a-z0-9-]+)$/);
        if (method === 'GET' && opsMatch) {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const op = getOpStatus(opsMatch[1]);
            return op ? json(res, 200, op) : json(res, 404, { error: 'not found' });
        }
        // Device registration — generates confirmation code for owner approval
        if (method === 'POST' && url === '/register') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = JSON.parse(await readBody(req) || '{}');
            const { deviceName } = body;
            if (!deviceName)
                return json(res, 400, { error: 'deviceName required' });
            const deviceIp = req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
            const result = createOpRequest(String(deviceName), 'device_registration', `新设备 ${deviceName} 请求注册`, deviceIp);
            console.log(new Date().toISOString(), 'registration request:', deviceName, 'ip:', deviceIp, 'code:', result.code);
            return json(res, 200, { id: result.id, code: result.code, expiresInSec: result.expiresInSec, status: 'pending', note: '等待 owner 回复确认码完成注册' });
        }
        // Audit
        if (method === 'POST' && url === '/audit') {
            if (!authorized(req))
                return json(res, 401, { error: 'unauthorized' });
            const body = JSON.parse(await readBody(req, 16384) || '{}');
            pushEntry({
                ts: body.ts || Date.now(),
                deviceId: body.deviceId || 'unknown',
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