import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

/** Operator console logger: JSON lines on stderr, so stdout carries only command output. */
export function createLogger(name: string): Logger {
  return pino({ name, level: process.env.PP_LOG_LEVEL ?? 'info' }, pino.destination(2));
}
