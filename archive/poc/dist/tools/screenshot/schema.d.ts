/**
 * Zod schema for the screenshot tool input.
 * Captures the virtual screen (all monitors) as JPEG + optional OCR text.
 */
import { z } from 'zod';
export declare const screenshotInputSchema: {
    quality: z.ZodOptional<z.ZodNumber>;
    ocr: z.ZodOptional<z.ZodBoolean>;
};
export type ScreenshotInput = z.infer<ReturnType<typeof z.object<typeof screenshotInputSchema>>>;
