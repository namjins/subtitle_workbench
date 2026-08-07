export function createJobEvent(type, fields = {}) {
  return {
    type,
    timestamp: new Date().toISOString(),
    ...fields,
  };
}

export function formatJobEvent(type, fields = {}) {
  return `${JSON.stringify(createJobEvent(type, fields))}\n`;
}
