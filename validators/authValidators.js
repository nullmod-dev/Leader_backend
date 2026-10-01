/**
 * Joi schemas for /api/v1/auth. Shape checks only — business rules (password
 * policy, display-name bounds, Team Code format) answer their own codes in
 * the controllers/services so the client can branch on them.
 */
const Joi = require('joi');
const { email: normEmail, isEmail } = require('../utils/normalize');

/** A syntactically valid address, normalized (trim + lowercase). */
const emailField = Joi.string()
  .max(320)
  .required()
  .custom((value, helpers) => {
    const v = normEmail(value);
    return isEmail(v) ? v : helpers.error('string.email');
  });

/** Any typed address (sign-in / reset verify): normalized, not format-checked. */
const loginEmail = Joi.string().max(320).required().custom((value) => normEmail(value));

// Passwords are taken EXACTLY as typed (never trimmed); the policy check
// (8–128 → password_rejected) runs in the controller.
const rawPassword = Joi.any();

const code = Joi.string().trim().max(32).required();

module.exports = {
  signUp: Joi.object({ email: emailField, password: rawPassword }),
  signIn: Joi.object({ email: loginEmail, password: Joi.string().max(1024).required() }),
  google: Joi.object({ idToken: Joi.string().max(8192).required() }),

  verify: Joi.object({ challengeId: Joi.string().max(100).required(), code }),
  resend: Joi.object({ challengeId: Joi.string().max(100).required() }),

  link: Joi.object({ teamCode: Joi.string().max(64).required() }),
  complete: Joi.object({ displayName: Joi.string().allow('').max(500).required() }),

  patchMe: Joi.object({ name: Joi.string().allow('').max(500).required() }),
  changePassword: Joi.object({ currentPassword: Joi.string().allow('').max(1024).required(), newPassword: rawPassword }),

  mfaCode: Joi.object({ code }),
  newDevice: Joi.object({ itsMe: Joi.boolean().required() }),

  resetRequest: Joi.object({ email: emailField }),
  resetVerify: Joi.object({ email: loginEmail, code }),
  resetComplete: Joi.object({ password: rawPassword }),
};
