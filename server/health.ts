import { PROTOCOL_VERSION } from "./protocol";

// Observability-only diagnostics payload returned by GET /health. This must NEVER
// be written to stdout — stdout is reserved for the JSON-line protocol channel.
export interface HealthStatus {
  ok: boolean;
  protocol: number;
  version: number;
  pid: number;
  port: number;
  bind: string;
  sessions: number;
}

export interface HealthInput {
  port: number;
  bind: string;
  sessions: number;
}

export function getHealth(input: HealthInput): HealthStatus {
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    version: PROTOCOL_VERSION,
    pid: process.pid,
    port: input.port,
    bind: input.bind,
    sessions: input.sessions,
  };
}
