// Test-only PGlite (WASM Postgres) behind its socket server, run as a child process.
// It lives outside Jest's VM because PGlite's Emscripten loader performs a dynamic import
// that Jest's CommonJS runtime rejects without --experimental-vm-modules.
// Protocol: sends { port } over IPC once listening; disconnect or SIGTERM shuts it down.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const requestedPort = process.env.FEE_ABSTRACTION_TEST_PG_PORT;

const engine = await PGlite.create();
const server = new PGLiteSocketServer({
  db: engine,
  host: '127.0.0.1',
  port: requestedPort ? Number(requestedPort) : 0,
});
await server.start();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  await engine.close();
  process.exit(0);
}
process.once('SIGTERM', stop);
process.once('disconnect', stop);

process.send({ port: Number(server.getServerConn().split(':').pop()) });
