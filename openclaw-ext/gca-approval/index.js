/**
 * gca-approval — GCA 审批卡片回调中转（2026-08-14）。
 *
 * 飞书授权卡片的按钮点击（card.action.trigger）经 lark 插件的
 * dispatchPluginInteractiveHandler 分发到本扩展（namespace 'gca'）。
 * 本扩展零业务逻辑：解析 action value（gca::approve|reject::opId::signature）
 * → HTTP POST gca-server /ops/card-action（签名/sender 由 gca-server 校验）
 * → 用 ctx.respond.reply 回一句结果（卡片状态回写由 gca-server 直连飞书 API 做）。
 *
 * 注意：registerInteractiveHandler 是同步 API（plugin register must be synchronous）——
 * init 不能 async，不能 await 注册。
 */
const GCA_SERVER = process.env.GCA_CARD_SERVER || 'http://127.0.0.1:18790';

module.exports = function init(api) {
  api.registerInteractiveHandler({
    channel: 'feishu',
    namespace: 'gca',
    handler: async (ctx) => {
      // ctx.payload = "approve:opId:signature"（dispatch 按首个 ':' 切 namespace/payload）
      const parts = String(ctx.payload || '').split(':');
      const verb = parts[0];
      const opId = parts[1];
      const signature = parts[2];
      if ((verb !== 'approve' && verb !== 'reject') || !opId || !signature) {
        try { await ctx.respond.reply({ text: '未知的审批操作' }); } catch {}
        return;
      }
      try {
        const res = await fetch(`${GCA_SERVER}/ops/card-action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opId, action: verb, signature, senderId: ctx.senderId }),
          signal: AbortSignal.timeout(8000),
        });
        const body = await res.json().catch(() => ({}));
        // 成功静默：原卡片由 gca-server 直连飞书 PATCH 原地回写（避免追加 reply 消息）；
        // 仅失败时回复原因
        if (!res.ok) {
          try { await ctx.respond.reply({ text: `审批失败：${body.error || res.status}` }); } catch {}
        }
      } catch (e) {
        try { await ctx.respond.reply({ text: '审批回调失败（gca-server 不可达）' }); } catch {}
      }
    },
  });
};
