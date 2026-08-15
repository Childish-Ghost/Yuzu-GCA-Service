/**
 * Shared MCP tool type definitions (S-001).
 *
 * Single source of truth for:
 *   - the tool registry (names)
 *   - the wire result shape of every tool — result bodies are serialized
 *     as JSON inside MCP text content, and these interfaces are what the
 *     gateway / LLM actually parses
 *
 * Phase 1 covers the 4 implemented tools. Phase 2 adds its 10 tools here
 * BEFORE their handlers are written (type-first).
 */
// --- Tool registry ---
export const TOOL_NAMES = [
    'exec',
    'confirm',
    'file_list',
    'file_read',
    'file_write',
    'file_move',
    'file_delete',
    'exec_background',
    'process_list',
    'power',
    'service',
    'notify_send',
    'sysinfo',
    // C11 修复（2026-08-12 审查）：补齐 20 项（此前只列 13 个，与 register.ts 注册集不符）
    'file_serve',
    'file_fetch',
    'screenshot',
    'screen_consent',
    'remote_input',
    'input_consent',
    'clipboard_sync',
];
//# sourceMappingURL=tools.js.map