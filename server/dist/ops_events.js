const listeners = new Set();
/** 订阅（SSE 连接建立时）；返回取消函数 */
export function subscribe(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
/** 广播 op 事件（created/resolved） */
export function emitOpEvent(ev) {
    for (const fn of listeners) {
        try {
            fn(ev);
        }
        catch { /* 单订阅者异常不影响其他 */ }
    }
}
/** SSE 连接处理：立即发 snapshot（当前全部 pending），再转发实时事件 */
export function handleOpsEvents(req, res, listPending) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    // 审查 H3：写响应前检查 destroyed + res error 监听——客户端断开后的异步
    // write/end 会 emit error（ERR_STREAM_DESTROYED），无监听 → uncaughtException 炸进程
    const safeWrite = (chunk) => {
        if (res.destroyed)
            return;
        try {
            res.write(chunk);
        }
        catch { /* 忽略——断开竞争 */ }
    };
    const cleanup = () => { unsubscribe(); };
    res.on('error', cleanup);
    res.on('close', cleanup);
    res.write('retry: 3000\n\n');
    // snapshot：当前全部 pending（幂等重连友好——客户端按 id 去重）
    for (const op of listPending()) {
        safeWrite(`event: op.snapshot\ndata: ${JSON.stringify(op)}\n\n`);
    }
    safeWrite('event: ready\ndata: {}\n\n');
    const unsubscribe = subscribe((ev) => {
        safeWrite(`event: op.${ev.status === 'pending' ? 'created' : 'resolved'}\ndata: ${JSON.stringify(ev)}\n\n`);
    });
    // 审查 A-H2（服务端）：周期注释帧 ping——半死连接（NAT/Doze）客户端能感知存活
    const ping = setInterval(() => safeWrite(': ping\n\n'), 25000);
    const teardown = () => {
        clearInterval(ping);
        cleanup();
        try {
            res.end();
        }
        catch { /* 已断开 */ }
    };
    req.on('close', teardown);
    res.on('close', teardown);
}
//# sourceMappingURL=ops_events.js.map