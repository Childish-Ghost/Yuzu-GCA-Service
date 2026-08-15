/**
 * Input Simulator (R-002) - keyboard + mouse via Win32 SendInput.
 *
 * Zero dependencies: PowerShell + Add-Type C# P/Invoke of user32.dll.
 * Handles mouse_move, mouse_click, key_type (string of characters).
 *
 * PRIVACY: this controls the entire desktop — the tool layer puts every
 * action behind the input_consent window (or per-action confirmation).
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import { logger } from '../utils/logger.js';
import { executeCommand } from './executor.js';

const isWindows = os.platform() === 'win32';

export type InputAction =
  | { type: 'mouse_move'; x: number; y: number }
  | { type: 'mouse_click'; button: 'left' | 'right' | 'middle'; x?: number; y?: number }
  | { type: 'mouse_scroll'; delta: number; x?: number; y?: number }
  | { type: 'key_type'; text: string };

// C# P/Invoke wrapper compiled once via Add-Type
const CS_CODE = `
using System;
using System.Runtime.InteropServices;

public class GcaInput {
    [DllImport("user32.dll")] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public uint type;
        public MOUSEINPUT mi;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    const uint INPUT_MOUSE = 0;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_WHEEL = 0x0800;

    public static void Move(int x, int y) {
        SetCursorPos(x, y);
    }

    public static void Click(string button) {
        uint down, up;
        switch (button) {
            case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
            case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
            default: down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
        }
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_MOUSE; inputs[0].mi.dwFlags = down;
        inputs[1].type = INPUT_MOUSE; inputs[1].mi.dwFlags = up;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Scroll(int delta) {
        var inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mi.mouseData = (uint)delta;
        inputs[0].mi.dwFlags = MOUSEEVENTF_WHEEL;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void TypeText(string text) {
        foreach (char ch in text) {
            short vk = VkKeyScan(ch);
            // SendInput with KEYBDINPUT would be more robust, but SendWait is simpler
            // for printable characters via System.Windows.Forms.SendKeys
        }
        // Use SendKeys for text typing (simpler than SendInput for printable chars)
        // Caller wraps this in System.Windows.Forms context
    }
}
`;

// For key_type, use System.Windows.Forms.SendKeys (simpler for printable text)
const PS_TYPE_TEXT = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait($env:GCA_INPUT_TEXT);
`;

// For mouse actions, use the C# P/Invoke
const PS_MOUSE = `
Add-Type -Language CSharp -TypeDefinition '${CS_CODE}';
`;

function runPowerShell(script: string, env: Record<string, string> = {}, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('input simulation timed out')); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().substring(0, 300) || `PowerShell exited ${code}`));
    });
  });
}

export async function executeInput(action: InputAction): Promise<string> {
  if (!isWindows) {
    return executeInputLinux(action);
  }
  switch (action.type) {
    case 'mouse_move': {
      const ps = `${PS_MOUSE}[GcaInput]::Move(${action.x}, ${action.y});`;
      await runPowerShell(ps, {}, 5000);
      logger.info('mouse moved', { x: action.x, y: action.y });
      return `moved to (${action.x}, ${action.y})`;
    }
    case 'mouse_click': {
      let ps = '';
      if (action.x !== undefined && action.y !== undefined) {
        ps += `[GcaInput]::Move(${action.x}, ${action.y}); `;
      }
      ps += `[GcaInput]::Click('${action.button}');`;
      await runPowerShell(`${PS_MOUSE}${ps}`, {}, 5000);
      logger.info('mouse clicked', { button: action.button, x: action.x, y: action.y });
      return `clicked ${action.button}${action.x !== undefined ? ` at (${action.x}, ${action.y})` : ''}`;
    }
    case 'mouse_scroll': {
      let ps = '';
      if (action.x !== undefined && action.y !== undefined) {
        ps += `[GcaInput]::Move(${action.x}, ${action.y}); `;
      }
      ps += `[GcaInput]::Scroll(${action.delta});`;
      await runPowerShell(`${PS_MOUSE}${ps}`, {}, 5000);
      logger.info('mouse scrolled', { delta: action.delta });
      return `scrolled ${action.delta > 0 ? 'up' : 'down'} (${action.delta})`;
    }
    case 'key_type': {
      await runPowerShell(PS_TYPE_TEXT, { GCA_INPUT_TEXT: action.text }, 10000);
      logger.info('text typed', { chars: action.text.length });
      return `typed "${action.text.substring(0, 50)}"`;
    }
  }
}

// --- Linux: xdotool (apt install xdotool) ---

async function executeInputLinux(action: InputAction): Promise<string> {
  switch (action.type) {
    case 'mouse_move': {
      const r = await executeCommand(`xdotool mousemove ${action.x} ${action.y}`, { timeout: 5000 });
      if (r.exitCode !== 0) throw new Error(`xdotool mousemove failed: ${r.stderr}`);
      logger.info('mouse moved (linux)', { x: action.x, y: action.y });
      return `moved to (${action.x}, ${action.y})`;
    }
    case 'mouse_click': {
      const btn = action.button === 'right' ? 3 : action.button === 'middle' ? 2 : 1;
      let cmd = '';
      if (action.x !== undefined && action.y !== undefined) {
        cmd += `xdotool mousemove ${action.x} ${action.y} && `;
      }
      cmd += `xdotool click ${btn}`;
      const r = await executeCommand(cmd, { timeout: 5000 });
      if (r.exitCode !== 0) throw new Error(`xdotool click failed: ${r.stderr}`);
      logger.info('mouse clicked (linux)', { button: action.button, x: action.x, y: action.y });
      return `clicked ${action.button}`;
    }
    case 'mouse_scroll': {
      const btn = action.delta > 0 ? 4 : 5;
      let cmd = '';
      if (action.x !== undefined && action.y !== undefined) {
        cmd += `xdotool mousemove ${action.x} ${action.y} && `;
      }
      cmd += `xdotool click ${btn}`;
      const r = await executeCommand(cmd, { timeout: 5000 });
      if (r.exitCode !== 0) throw new Error(`xdotool scroll failed: ${r.stderr}`);
      logger.info('mouse scrolled (linux)', { delta: action.delta });
      return `scrolled ${action.delta > 0 ? 'up' : 'down'}`;
    }
    case 'key_type': {
      // Escape the text for shell safety
      const escaped = action.text.replace(/'/g, "'\''");
      const r = await executeCommand(`xdotool type --clearmodifiers '${escaped}'`, { timeout: 10000 });
      if (r.exitCode !== 0) throw new Error(`xdotool type failed: ${r.stderr}`);
      logger.info('text typed (linux)', { chars: action.text.length });
      return `typed "${action.text.substring(0, 50)}"`;
    }
  }
}
