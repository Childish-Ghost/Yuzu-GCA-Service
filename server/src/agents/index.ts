/**
 * Agent adapter registry — the single entry point for the active AI backend.
 *
 * Config switch (future): `adapter: 'openclaw' | 'hermes'` picks the
 * implementation; the rest of gca-server never sees the backend.
 */
import { serverConfig } from '../config.js';
import type { AgentAdapter } from './adapter.js';
import { OpenClawWsAdapter } from './openclaw.js';

let agent: AgentAdapter | null = null;

export function getAgent(): AgentAdapter {
  if (!agent) {
    agent = new OpenClawWsAdapter({
      url: serverConfig.gateway.url,
      token: serverConfig.gateway.token || undefined,
    });
  }
  return agent;
}

