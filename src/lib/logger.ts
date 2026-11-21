type Level = 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...data }));
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
};
