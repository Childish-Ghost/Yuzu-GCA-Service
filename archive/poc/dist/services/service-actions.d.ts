/**
 * Service Actions - lists and controls system services.
 *
 * Windows: PowerShell Get-Service / *-Service. POSIX: systemctl.
 * Control actions typically need elevation — failures come back as
 * graceful errors, never crashes.
 */
import type { ServiceInfo } from '../types/tools.js';
export declare function listServices(filter?: string, limit?: number): Promise<ServiceInfo[]>;
export declare function executeServiceAction(action: 'start' | 'stop' | 'restart', name: string): Promise<string>;
