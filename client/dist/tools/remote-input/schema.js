/**
 * Zod schema for the remote_input tool.
 * Sends keyboard + mouse events to the device's desktop.
 */
import { z } from 'zod';
export const remoteInputInputSchema = {
    action: z
        .enum(['mouse_move', 'mouse_click', 'mouse_scroll', 'key_type'])
        .describe('mouse_move (x,y absolute) · mouse_click (button + optional x,y) · mouse_scroll (delta) · key_type (text)'),
    x: z.number().int().optional().describe('Absolute X screen coordinate (mouse actions)'),
    y: z.number().int().optional().describe('Absolute Y screen coordinate (mouse actions)'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (mouse_click only). Default left.'),
    delta: z.number().int().optional().describe('Scroll delta (positive=up, negative=down). mouse_scroll only.'),
    text: z.string().max(1024).optional().describe('Text to type (key_type only). Max 1024 chars.'),
};
//# sourceMappingURL=schema.js.map