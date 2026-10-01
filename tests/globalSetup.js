const { MongoMemoryReplSet } = require('mongodb-memory-server');

// One single-node replica set (transactions work) shared by every test file;
// each file uses its own database.
module.exports = async () => {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  global.__MONGO_RS__ = rs;
  process.env.TEST_MONGO_URI = rs.getUri();
};
