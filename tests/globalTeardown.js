module.exports = async () => {
  if (global.__MONGO_RS__) await global.__MONGO_RS__.stop();
};
