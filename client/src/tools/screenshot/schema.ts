/**
 * Zod schema for the screenshot tool input.
 * Captures the virtual screen (all monitors) as JPEG + optional OCR text.
 */

import { z } from 'zod';

export const screenshotInputSchema = {
  quality: z
    .number()
    .int()
    .min(10)
    .max(95)
    .optional()
    .describe('JPEG quality 10-95. Default 70 (smaller payloads for chat channels).'),
  ocr: z
    .boolean()
    .optional()
    .describe('Also run built-in Windows OCR and include recognized text. Default true.'),
};

export type ScreenshotInput = z.infer<ReturnType<typeof z.object<typeof screenshotInputSchema>>>;
