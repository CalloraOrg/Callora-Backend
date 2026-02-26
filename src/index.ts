import 'dotenv/config';
import express from "express";
import { fileURLToPath } from 'node:url';
import { config } from "./config/index.js";
import routes from "./routes/index.js";
import { logger } from './logger.js';

const app = express();

app.use(express.json());
app.use("/api", routes);

const PORT = config.port;

// Execute the server only if this file is run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    logger.info(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;
