/**
 * Clipboard (R-003) - read/write the system clipboard (text + images).
 *
 * Windows: PowerShell + System.Windows.Forms.Clipboard (STA thread)
 * Linux: xclip -selection clipboard (apt install xclip)
 * Headless Linux: file-based virtual clipboard
 *
 * Images: JPEG base64, up to 5MB. The sync watcher pushes/pulls both
 * types; the relay stores type + content so receivers know how to set it.
 */
export type ClipboardType = 'text' | 'image';
export interface ClipboardData {
    type: ClipboardType;
    content: string;
}
export declare function getClipboard(): Promise<string>;
export declare function getClipboardData(): Promise<ClipboardData>;
export declare function setClipboard(text: string): Promise<void>;
export declare function setClipboardData(data: ClipboardData): Promise<void>;
