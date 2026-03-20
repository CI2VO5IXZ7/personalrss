function sanitizeFields(fields = {}) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries.map(([key, value]) => {
    if (value instanceof Error) {
      return [key, value.message];
    }
    return [key, value];
  }));
}

export function logEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeFields(fields)
  };

  const message = JSON.stringify(payload);
  if (level === 'error') {
    console.error(message);
  } else if (level === 'warn') {
    console.warn(message);
  } else {
    console.log(message);
  }
}

export function logInfo(event, fields) {
  logEvent('info', event, fields);
}

export function logWarn(event, fields) {
  logEvent('warn', event, fields);
}

export function logError(event, fields) {
  logEvent('error', event, fields);
}
