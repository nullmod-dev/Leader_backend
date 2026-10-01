/** Attach a request id (echoed as X-Request-Id and as `error.reference`). */
const { ulid } = require('../utils/ids');

module.exports = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : `req_${ulid()}`;
  res.set('X-Request-Id', req.id);
  next();
};
