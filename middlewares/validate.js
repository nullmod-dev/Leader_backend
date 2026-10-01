/**
 * Joi validation → `422 validation` with a flat `fields` map
 * ({ "attendees[0].memberId": "..." }). Validated + converted values REPLACE
 * the request source, so controllers read clean data.
 */
const AppError = require('../utils/appError');

const toFields = (details, source = 'body') => {
  const fields = {};
  details.forEach((d) => {
    const key = d.path.length ? d.path.map((p) => (typeof p === 'number' ? `[${p}]` : p)).join('.').replace(/\.\[/g, '[') : source;
    if (!fields[key]) fields[key] = d.message.replace(/"/g, '');
  });
  return fields;
};

/**
 * @param {import('joi').Schema} schema
 * @param {'body'|'query'|'params'} source
 */
const validate = (schema, source = 'body') => (req, res, next) => {
  const { value, error } = schema.validate(req[source] ?? {}, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
  if (error) return next(AppError.validation(toFields(error.details, source)));
  if (source === 'query') {
    // req.query is a getter in newer Express; replace keys in place.
    Object.keys(req.query).forEach((k) => delete req.query[k]);
    Object.assign(req.query, value);
  } else {
    req[source] = value;
  }
  return next();
};

module.exports = { validate, toFields };
