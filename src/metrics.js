const os = require('os');
const config = require('./config');

const metricsConfig = config.metrics || {};
const { source = 'jwt-pizza-service', endpointURL, accountId, apiKey } = metricsConfig;
const exporterEnabled = Boolean(endpointURL && accountId && apiKey);
const authorization = exporterEnabled
  ? `Basic ${Buffer.from(`${accountId}:${apiKey}`).toString('base64')}`
  : null;

const counters = new Map();
const gauges = new Map();
const histograms = new Map();
const activeSessions = new Map();
const processStartUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
const histogramBounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const activeUserWindowMs = 5 * 60 * 1000;

function pointAttributes(labels = {}) {
  const values = { source, ...labels };
  return Object.keys(values)
    .sort()
    .map((key) => ({ key, value: { stringValue: String(values[key]) } }));
}

function seriesKey(name, unit, labels) {
  return JSON.stringify([name, unit, Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))]);
}

function incrementCounter(name, amount = 1, labels = {}, unit = '1') {
  const key = seriesKey(name, unit, labels);
  const series = counters.get(key) || { name, unit, labels, value: 0 };
  series.value += amount;
  counters.set(key, series);
}

function setGauge(name, value, labels = {}, unit = '1') {
  const key = seriesKey(name, unit, labels);
  gauges.set(key, { name, unit, labels, value });
}

function observeHistogram(name, value, labels = {}, unit = 's') {
  const key = seriesKey(name, unit, labels);
  const series = histograms.get(key) || {
    name,
    unit,
    labels,
    count: 0,
    sum: 0,
    bucketCounts: Array(histogramBounds.length + 1).fill(0),
  };

  series.count += 1;
  series.sum += value;
  const bucketIndex = histogramBounds.findIndex((bound) => value <= bound);
  series.bucketCounts[bucketIndex === -1 ? histogramBounds.length : bucketIndex] += 1;
  histograms.set(key, series);
}

function userSessionActivity(userId, token) {
  if (userId !== undefined && token) {
    activeSessions.set(token, { userId: String(userId), lastSeenAt: Date.now() });
  }
}

function userSessionEnded(token) {
  if (token) activeSessions.delete(token);
}

function updateActiveUsersGauge() {
  const cutoff = Date.now() - activeUserWindowMs;
  const activeUserIds = new Set();

  for (const [token, session] of activeSessions) {
    if (session.lastSeenAt < cutoff) {
      activeSessions.delete(token);
    } else {
      activeUserIds.add(session.userId);
    }
  }

  setGauge('active_users', activeUserIds.size);
}

function routeLabel(req) {
  if (!req.route || req.route.path === '*') return 'unmatched';
  return `${req.baseUrl || ''}${req.route.path}`.replace(/\/$/, '') || '/';
}

function requestTracker(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.once('finish', () => {
    const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    const labels = {
      method: req.method,
      route: routeLabel(req),
    };

    incrementCounter(
      'http_requests',
      1,
      { ...labels, status_code: String(res.statusCode) },
      '{request}'
    );
    observeHistogram('http_request_duration', elapsedSeconds, labels, 's');
  });

  next();
}

function authAttempt(success) {
  incrementCounter('auth_attempts', 1, { result: success ? 'success' : 'failure' }, '{attempt}');
}

function pizzaPurchase(success, latencyMs, revenue = 0, pizzaCount = 0) {
  const result = success ? 'success' : 'failure';
  observeHistogram('pizza_creation_duration', latencyMs / 1000, { result }, 's');

  if (success) {
    incrementCounter('pizzas_sold', pizzaCount, {}, '{pizza}');
    incrementCounter('pizza_revenue', revenue, {}, 'USD');
  } else {
    incrementCounter('pizza_creation_failures', 1, {}, '{order}');
  }
}

function readCpuTimes() {
  return os.cpus().reduce(
    (totals, cpu) => {
      for (const [name, value] of Object.entries(cpu.times)) {
        totals[name] = (totals[name] || 0) + value;
      }
      return totals;
    },
    {}
  );
}

let previousCpuTimes = readCpuTimes();

function sampleSystemMetrics() {
  const currentCpuTimes = readCpuTimes();
  const previousTotal = Object.values(previousCpuTimes).reduce((total, value) => total + value, 0);
  const currentTotal = Object.values(currentCpuTimes).reduce((total, value) => total + value, 0);
  const totalDelta = currentTotal - previousTotal;
  const idleDelta = (currentCpuTimes.idle || 0) - (previousCpuTimes.idle || 0);
  const cpuUsage = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;

  previousCpuTimes = currentCpuTimes;

  const totalMemory = os.totalmem();
  const memoryUsage = totalMemory > 0 ? ((totalMemory - os.freemem()) / totalMemory) * 100 : 0;

  setGauge('cpu_usage_percent', Number(cpuUsage.toFixed(2)), {}, '%');
  setGauge('memory_usage_percent', Number(memoryUsage.toFixed(2)), {}, '%');
  updateActiveUsersGauge();
}

function addMetricPoint(groups, type, series, point) {
  const groupKey = JSON.stringify([type, series.name, series.unit]);
  let metric = groups.get(groupKey);

  if (!metric) {
    const metricData = { dataPoints: [] };
    if (type === 'sum') {
      metricData.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
      metricData.isMonotonic = true;
    } else if (type === 'histogram') {
      metricData.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    }

    metric = { name: series.name, unit: series.unit, [type]: metricData };
    groups.set(groupKey, metric);
  }

  metric[type].dataPoints.push(point);
}

function collectMetricPoints() {
  const nowUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
  const groups = new Map();

  for (const series of counters.values()) {
    const valueField = Number.isInteger(series.value)
      ? { asInt: series.value }
      : { asDouble: series.value };
    addMetricPoint(groups, 'sum', series, {
      ...valueField,
      startTimeUnixNano: processStartUnixNano,
      timeUnixNano: nowUnixNano,
      attributes: pointAttributes(series.labels),
    });
  }

  for (const series of gauges.values()) {
    const valueField = Number.isInteger(series.value)
      ? { asInt: series.value }
      : { asDouble: series.value };
    addMetricPoint(groups, 'gauge', series, {
      ...valueField,
      timeUnixNano: nowUnixNano,
      attributes: pointAttributes(series.labels),
    });
  }

  for (const series of histograms.values()) {
    addMetricPoint(groups, 'histogram', series, {
      count: String(series.count),
      sum: series.sum,
      bucketCounts: series.bucketCounts.map(String),
      explicitBounds: histogramBounds,
      startTimeUnixNano: processStartUnixNano,
      timeUnixNano: nowUnixNano,
      attributes: pointAttributes(series.labels),
    });
  }

  return [...groups.values()];
}

let flushInProgress = false;

async function flushMetrics() {
  if (!exporterEnabled || flushInProgress) return;

  const metrics = collectMetricPoints();
  if (metrics.length === 0) return;

  flushInProgress = true;
  try {
    const response = await fetch(endpointURL, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        resourceMetrics: [
          {
            resource: {
              attributes: [
                { key: 'service.name', value: { stringValue: 'jwt-pizza-service' } },
              ],
            },
            scopeMetrics: [
              {
                scope: { name: 'jwt-pizza-service.metrics' },
                metrics,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`Grafana metrics export failed: HTTP ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error('Grafana metrics export failed:', error.message);
  } finally {
    flushInProgress = false;
  }
}

if (exporterEnabled) {
  sampleSystemMetrics();
  const systemMetricsTimer = setInterval(sampleSystemMetrics, 10_000);
  const exportTimer = setInterval(() => void flushMetrics(), 5_000);
  systemMetricsTimer.unref();
  exportTimer.unref();
} else {
  console.warn('Grafana metrics export is disabled because metrics credentials are missing from config.js.');
}

module.exports = {
  requestTracker,
  authAttempt,
  userSessionActivity,
  userSessionEnded,
  pizzaPurchase,
  flushMetrics,
};
