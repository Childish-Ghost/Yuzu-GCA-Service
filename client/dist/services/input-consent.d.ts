/**
 * Input Consent - a time-boxed permission window for remote_input.
 *
 * Same model as screen-consent but separate: controlling the desktop is
 * more dangerous than seeing it. Persisted in settings (input.consentUntil).
 */
export declare function grantConsent(minutes: number): Promise<{
    until: string;
    minutes: number;
}>;
export declare function revokeConsent(): Promise<void>;
export declare function hasConsent(): Promise<boolean>;
export declare function consentStatus(): Promise<{
    active: boolean;
    until: string | null;
}>;
