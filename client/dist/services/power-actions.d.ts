/**
 * Power Actions - executes confirmed power operations.
 *
 * shutdown/restart/sleep/hibernate map to fixed Windows commands;
 * wol builds a magic packet in pure Node (no dependencies).
 * Kept in a service so the confirm dispatcher stays thin.
 */
import type { PowerAction } from '../types/tools.js';
export interface PowerActionInput {
    action: PowerAction;
    delaySec?: number;
    mac?: string;
}
export declare function executePowerAction(input: PowerActionInput): Promise<string>;
