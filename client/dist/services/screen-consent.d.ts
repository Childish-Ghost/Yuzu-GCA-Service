/**
 * Screen Consent - a time-boxed permission window for screenshots.
 *
 * The owner grants once (via the screen_consent tool, itself behind the
 * confirmation flow) and screenshots run freely until the window expires.
 * Outside the window every screenshot needs its own confirmation.
 *
 * Persisted in settings (screen.consentUntil) so restarts don't silently
 * extend or revoke the window.
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
