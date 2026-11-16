const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config.js');

const context = new AsyncLocalStorage();
const logging = config.logging || {};
const enabled = process.env.NODE_ENV !== 'test' && Boolean(logging.endpointUrl && logging.accountId && logging.apiKey);
const secretKeys = /(?:password|passwd|token|jwt|authorization|api[_-]?key|secret|cookie|credential|signature|email)/i;
const privateValues = [config.jwtSecret, config.factory?.apiKey, config.metrics?.apiKey, logging.apiKey].filter(Boolean);

function sanitizeText(value) {
  let text = String(value);
  for (const secret of privateValues) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+\S+/gi, 'Basic [REDACTED]')
    .replace(/\bglc_[A-Za-z0-9_+/=-]+/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(/([?&](?:token|key|secret|password|authorization)=)[^&#\s]+/gi, '$1[REDACTED]');
}

function sanitize(value, depth = 0) {
  if (depth > 12) return '[OMITTED]';
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const safe = {};
    for (const [key, item] of Object.entries(value)) {
      safe[key] = (secretKeys.test(key) && key !== 'hasAuthorizationHeader') || ['stack', 'example'].includes(key.toLowerCase())
        ? '[REDACTED]' : sanitize(item, depth + 1);
    }
    return safe;
  }
  return value;
}

function bodyForLog(body) {
  if (Buffer.isBuffer(body)) return '[binary body omitted]';
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch { return body; }
}

function currentUser() {
  const user = context.getStore()?.req.user;
  return user ? { id: user.id, name: user.name } : null;
}

function log(level, type, details) {
  if (!enabled) return Promise.resolve();
  try {
    const event = sanitize({ ...details, user: details.user ?? currentUser() });
    const payload = {
      streams: [{
        stream: { source: logging.source || 'jwt-pizza-service', level, type },
        values: [[(BigInt(Date.now()) * 1000000n).toString(), JSON.stringify(event)]],
      }],
    };
    return sendLogToGrafana(payload);
  } catch {
    console.error('Failed to prepare Grafana log');
    return Promise.resolve();
  }
}

async function sendLogToGrafana(payload) {
  try {
    const response = await fetch(logging.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${logging.accountId}:${logging.apiKey}`).toString('base64')}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) console.error(`Grafana log push failed with HTTP ${response.status}`);
  } catch {
    console.error('Grafana log push failed');
  }
}

function httpLogger(req, res, next) {
  context.run({ req }, () => {
    const path = req.originalUrl.split('?')[0];
    let responseBody;
    const send = res.send;
    res.send = function (body) {
      responseBody = bodyForLog(body);
      return send.call(this, body);
    };
    res.on('finish', () => {
      log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'http', {
        method: req.method,
        path,
        statusCode: res.statusCode,
        hasAuthorizationHeader: Boolean(req.headers.authorization),
        requestBody: req.body ?? null,
        responseBody: responseBody ?? null,
        user: req.user ? { id: req.user.id, name: req.user.name } : null,
      });
    });
    next();
  });
}

function databaseQuery(sql) {
  // Parameter values are intentionally omitted. Some existing queries interpolate values.
  const query = String(sql).replace(/'(?:''|\\.|[^'])*'|"(?:\\.|[^"])*"/g, "'[REDACTED]'");
  log('info', 'database', { query });
}

function factoryRequest(requestBody, responseBody, statusCode) {
  log(statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info', 'factory', {
    method: 'POST', path: '/api/order', statusCode, requestBody, responseBody,
  });
}

function exception(error) {
  return log('error', 'exception', {
    name: error?.name || 'Error',
    message: error?.message || 'Unhandled exception',
  });
}

module.exports = { httpLogger, databaseQuery, factoryRequest, exception, sanitize, sendLogToGrafana };
