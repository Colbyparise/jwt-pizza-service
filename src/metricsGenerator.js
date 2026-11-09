const config = require('./config');

const { source, endpointURL, accountId, apiKey } = config.metrics || {};

if (!source || !endpointURL || !accountId || !apiKey) {
  console.error('Missing metrics settings in config.js.');
  process.exit(1);
}

const authorization = `Basic ${Buffer.from(`${accountId}:${apiKey}`).toString('base64')}`;

let requestCount = 0;
let latencyTotal = 0;

function randomIncrement(max) {
  return Math.floor(Math.random() * max) + 1;
}

async function sendMetricToGrafana(metricName, metricValue, type, unit) {
  const dataPoint = {
    asInt: metricValue,
    timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
    attributes: [
      {
        key: 'source',
        value: { stringValue: source },
      },
    ],
  };

  const metricData = { dataPoints: [dataPoint] };

  if (type === 'sum') {
    metricData.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    metricData.isMonotonic = true;
  }

  const body = JSON.stringify({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: metricName,
                unit,
                [type]: metricData,
              },
            ],
          },
        ],
      },
    ],
  });

  try {
    const response = await fetch(endpointURL, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!response.ok) {
      const responseBody = await response.text();
      console.error(`Failed to push ${metricName}: HTTP ${response.status} ${responseBody}`);
      return;
    }

    console.log(`Pushed ${metricName}`);
  } catch (error) {
    console.error(`Error pushing ${metricName}:`, error.message);
  }
}

const interval = setInterval(() => {
  const cpuValue = randomIncrement(100);
  void sendMetricToGrafana('cpu', cpuValue, 'gauge', '%');

  requestCount += randomIncrement(200);
  void sendMetricToGrafana('requests', requestCount, 'sum', '1');

  latencyTotal += randomIncrement(200);
  void sendMetricToGrafana('latency', latencyTotal, 'sum', 'ms');
}, 1000);

process.on('SIGINT', () => {
  clearInterval(interval);
  console.log('\nStopped metric generation.');
});
