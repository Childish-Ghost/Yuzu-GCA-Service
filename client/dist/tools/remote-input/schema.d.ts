/**
 * Zod schema for the remote_input tool.
 * Sends keyboard + mouse events to the device's desktop.
 */
import { z } from 'zod';
export declare const remoteInputInputSchema: {
    action: z.ZodEnum<["mouse_move", "mouse_click", "mouse_scroll", "key_type"]>;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<["left", "right", "middle"]>>;
    delta: z.ZodOptional<z.ZodNumber>;
    text: z.ZodOptional<z.ZodString>;
};
export type RemoteInputInput = z.infer<ReturnType<typeof z.object<typeof remoteInputInputSchema>>>;
