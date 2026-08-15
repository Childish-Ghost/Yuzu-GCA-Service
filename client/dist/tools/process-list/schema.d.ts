/**
 * Zod schema for the process_list tool input.
 * Lists running processes with sorting and an optional name filter.
 */
import { z } from 'zod';
export declare const processListInputSchema: {
    sortBy: z.ZodOptional<z.ZodEnum<["cpu", "memory", "pid", "name"]>>;
    limit: z.ZodOptional<z.ZodNumber>;
    filter: z.ZodOptional<z.ZodString>;
};
export type ProcessListInput = z.infer<ReturnType<typeof z.object<typeof processListInputSchema>>>;
