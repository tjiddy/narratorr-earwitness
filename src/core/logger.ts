// Minimal structural logger. Fastify's request logger (pino) satisfies this, but
// core code stays decoupled from Fastify. Logging is OPT-IN: pass a logger to enable
// narration, omit it and the pipeline runs silent (tests, batch paths that don't care).
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}
