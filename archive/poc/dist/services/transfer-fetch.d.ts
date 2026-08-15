/**
 * Transfer Fetch - the download half of cross-device transfer.
 *
 * Shared by the file_fetch tool (ticket URLs execute immediately) and the
 * confirm dispatcher (foreign URLs run after confirmation).
 */
/** Matches the one-shot transfer URL shape produced by file_serve. */
export declare function isTransferTicketUrl(url: string): boolean;
export interface FetchOutcome {
    bytes: number;
    sizeMatches: boolean;
}
export declare function downloadFile(url: string, targetPath: string): Promise<FetchOutcome>;
