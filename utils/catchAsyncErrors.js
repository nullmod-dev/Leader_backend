/** Wrap an async express handler so a rejected promise reaches the error controller. */
module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
