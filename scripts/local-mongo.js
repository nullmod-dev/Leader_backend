/* eslint-disable no-console */
/**
 * `npm run db` — a real, persistent, local MongoDB for development.
 *
 * No MongoDB installation needed: this uses the mongod binary that
 * `mongodb-memory-server` downloads (MongoDB 7.0) and runs it as a SINGLE-NODE
 * REPLICA SET (`rs0`) on 127.0.0.1:27017 with data in `backend/.mongo-data`,
 * so multi-document transactions work exactly as in production.
 *
 * Leave it running in its own terminal; Ctrl+C stops it cleanly. Data
 * survives restarts. Connection string (config.env):
 *   mongodb://127.0.0.1:27017/leader?replicaSet=rs0&directConnection=true
 *
 * Already have MongoDB (or Docker)? Skip this and point MONGODB_URI at yours.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { MongoBinary } = require('mongodb-memory-server-core');
const { MongoClient } = require('mongoose').mongo;

const PORT = Number(process.env.LOCAL_MONGO_PORT || 27017);
const DB_PATH = path.join(__dirname, '..', '.mongo-data');
const REPL_SET = 'rs0';

const portInUse = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const waitForPort = async (port, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await portInUse(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`mongod did not open port ${port}`);
};

const initiateReplicaSet = async () => {
  const client = new MongoClient(`mongodb://127.0.0.1:${PORT}/?directConnection=true`);
  await client.connect();
  const admin = client.db('admin');
  try {
    await admin.command({ replSetGetStatus: 1 });
    console.log(`Replica set ${REPL_SET} already initialised.`);
  } catch (e) {
    await admin.command({ replSetInitiate: { _id: REPL_SET, members: [{ _id: 0, host: `127.0.0.1:${PORT}` }] } });
    console.log(`Replica set ${REPL_SET} initialised.`);
  }
  // Wait for PRIMARY.
  for (let i = 0; i < 60; i += 1) {
    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await client.close();
};

const main = async () => {
  if (await portInUse(PORT)) {
    console.log(`Something is already listening on 127.0.0.1:${PORT} — assuming it is MongoDB. Nothing to do.`);
    return;
  }
  fs.mkdirSync(DB_PATH, { recursive: true });
  console.log('Resolving the mongod binary (first run downloads MongoDB 7.0, ~70 MB)…');
  const binary = await MongoBinary.getPath();
  console.log(`mongod: ${binary}`);

  const child = spawn(binary, ['--port', String(PORT), '--bind_ip', '127.0.0.1', '--dbpath', DB_PATH, '--replSet', REPL_SET], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  child.on('exit', (code) => {
    console.log(`mongod exited (${code}).`);
    process.exit(code || 0);
  });
  const stop = () => {
    console.log('\nStopping mongod…');
    child.kill('SIGINT');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await waitForPort(PORT);
  await initiateReplicaSet();
  console.log('');
  console.log(`✔ Local MongoDB ready on mongodb://127.0.0.1:${PORT} (replica set ${REPL_SET})`);
  console.log(`  data: ${DB_PATH}`);
  console.log('  Next: `npm run seed` then `npm run dev` in another terminal. Ctrl+C here to stop.');
};

main().catch((err) => {
  console.error('Could not start local MongoDB:', err.message);
  process.exit(1);
});
