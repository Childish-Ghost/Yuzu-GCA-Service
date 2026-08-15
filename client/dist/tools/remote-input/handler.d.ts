/**
 * remote_input Tool Handler (R-002) - keyboard + mouse control.
 *
 * HIGHEST RISK tool: can type passwords, click anything, control the entire
 * desktop. Privacy model (same as screenshot but separate consent):
 *   - Inside an active input_consent window → execute immediately
 *   - Outside → confirmation_required per action
 */
import { type InputAction } from '../../services/input-simulator.js';
import type { RemoteInputInput } from './schema.js';
export declare function remoteInputHandler(args: RemoteInputInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
} | {
    content: {
        type: "text";
        text: string;
    }[];
}>;
/** Executes the confirmed/consented input action. */
export declare function executeRemoteInput(inputAction: InputAction, confirmedByUser?: boolean): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
} | {
    content: {
        type: "text";
        text: string;
    }[];
}>;
