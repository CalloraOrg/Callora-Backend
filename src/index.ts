import express from "express";
import { config } from "./config/index.js";
import routes from "./routes/index.js";

const app = express();
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { metricsMiddleware, metricsEndpoint } from './metrics.js';

app.use(express.json());
app.use("/api", routes);

if (config.nodeEnv !== "test") {
  app.listen(config.port, () => {
    console.log(`Callora backend listening on http://localhost:${config.port}`);
// Inject the metrics middleware globally to track all incoming requests
app.use(metricsMiddleware);

// Register the securely guarded metrics endpoint
app.get('/api/metrics', metricsEndpoint);

// Execute the server only if this file is run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;