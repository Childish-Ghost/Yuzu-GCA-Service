/**
 * Input Simulator (R-002) - keyboard + mouse via Win32 SendInput.
 *
 * Zero dependencies: PowerShell + Add-Type C# P/Invoke of user32.dll.
 * Handles mouse_move, mouse_click, key_type (string of characters).
 *
 * PRIVACY: this controls the entire desktop — the tool layer puts every
 * action behind the input_consent window (or per-action confirmation).
 */
export type InputAction = {
    type: 'mouse_move';
    x: number;
    y: number;
} | {
    type: 'mouse_click';
    button: 'left' | 'right' | 'middle';
    x?: number;
    y?: number;
} | {
    type: 'mouse_scroll';
    delta: number;
    x?: number;
    y?: number;
} | {
    type: 'key_type';
    text: string;
};
export declare function executeInput(action: InputAction): Promise<string>;
