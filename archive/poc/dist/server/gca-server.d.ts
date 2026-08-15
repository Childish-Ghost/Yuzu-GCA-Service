/**
 * gca-server — GCA control plane daemon.
 *
 * Endpoints:
 *   GET  /health
 *   POST /pair/init      Bearer token
 *   POST /pair/claim
 *   GET  /devices         Bearer token
 *   POST /devices/:name/revoke  Bearer token
 *   POST /push            Bearer token
 *   POST /clipboard/push  Bearer token
 *   GET  /clipboard/latest
 *   POST /ops/request     Bearer token  — high-risk op authorization
 *   POST /ops/approve     Bearer token  — owner confirms with code
 *   POST /ops/reject      Bearer token  — owner rejects
 *   GET  /ops/:id         Bearer token  — poll op status
 *   POST /register        Bearer token  — device registration with confirmation
 *   POST /audit           Bearer token
 *   GET  /audit?limit=N&device=X  Bearer token
 *
 * Zero dependencies — Node.js built-in http only.
 */
import http from 'node:http';
export declare function startServer(port?: number): http.Server;
