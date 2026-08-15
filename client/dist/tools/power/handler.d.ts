/**
 * power Tool Handler — system power control via gca-server ops.
 *
 * All power actions (shutdown/restart/sleep/hibernate/wol) go through
 * gca-server's ops approval system. No local pending-approvals.
 */
import type { PowerInput } from './schema.js';
export declare function powerHandler(args: PowerInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    isError?: undefined;
} | {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
}>;
