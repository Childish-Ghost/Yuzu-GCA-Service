/**
 * Zod schema for the sysinfo tool input.
 * Takes no parameters — returns a full snapshot of the host.
 */

export const sysinfoInputSchema = {};

export type SysinfoInput = Record<string, never>;
