const counters = new Map();
const gauges = new Map();
const recentErrors = [];

export function incrementMetric(name, value = 1) {
  counters.set(name, (counters.get(name) || 0) + value);
}

export function setGauge(name, value) {
  gauges.set(name, value);
}

export function recordError(source, error) {
  incrementMetric(`${source}.errors`);
  recentErrors.unshift({
    source,
    message: error?.message || String(error),
    createdAt: new Date().toISOString()
  });
  recentErrors.length = Math.min(recentErrors.length, 20);
}

export function getMetrics() {
  return {
    counters: Object.fromEntries([...counters.entries()].sort()),
    gauges: Object.fromEntries([...gauges.entries()].sort()),
    recentErrors
  };
}
