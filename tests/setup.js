const crypto = require('crypto');
const mongoose = require('mongoose');

require('../models'); // register every model so syncIndexes builds unique indexes

beforeAll(async () => {
  const dbName = `leader_test_${crypto.randomBytes(6).toString('hex')}`;
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName });
  await mongoose.syncIndexes();
  require('../services/txn').resetSupportCache();
  require('../services/settingsService').invalidate();
});

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
