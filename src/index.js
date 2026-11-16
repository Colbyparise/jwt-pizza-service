const app = require('./service.js');
const logger = require('./logger.js');

async function reportFatal(error) {
  try {
    await logger.exception(error instanceof Error ? error : new Error(String(error)));
  } finally {
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => { void reportFatal(error); });
process.on('unhandledRejection', (reason) => { void reportFatal(reason); });

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
