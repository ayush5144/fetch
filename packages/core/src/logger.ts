/**
 * Tiny structured logger. Logs are JSON lines so they can be filtered by
 * `job_id` or `lead_id` correlation in any log tool. A child logger carries
 * context fields so a handler doesn't repeat them on every line.
 */
type Fields = Record<string, unknown>;
type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, base: Fields, msg: string, extra?: Fields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...base,
    ...extra,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, extra?: Fields): void;
  info(msg: string, extra?: Fields): void;
  warn(msg: string, extra?: Fields): void;
  error(msg: string, extra?: Fields): void;
  child(fields: Fields): Logger;
}

export function createLogger(base: Fields = {}): Logger {
  return {
    debug: (m, e) => emit('debug', base, m, e),
    info: (m, e) => emit('info', base, m, e),
    warn: (m, e) => emit('warn', base, m, e),
    error: (m, e) => emit('error', base, m, e),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

/** The root logger; most code should derive a child with job_id / lead_id. */
export const logger = createLogger({ app: 'fetch' });
