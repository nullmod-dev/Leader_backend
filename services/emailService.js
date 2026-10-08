/**
 * Transactional email. With SMTP configured, mail is sent through nodemailer.
 * Outside production every message is ALSO written to the dev mailbox
 * (`GET /api/v1/dev/mailbox`) so OTP codes are readable by Postman, the test
 * suite and the Flutter developer.
 *
 * Rules: a setup/invitation email never contains the Team Code; codes and
 * tokens are never logged in production.
 */
const nodemailer = require('nodemailer');
const config = require('../config');
const { DevMail } = require('../models');

let transport = null;
const getTransport = () => {
  if (!config.smtp.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
};

const send = async ({ to, subject, text, kind, meta }) => {
  if (!config.isProduction) {
    await DevMail.create({ to, subject, text, kind, meta });
    if (!config.isTest) console.log(`[mail:${kind}] → ${to}: ${subject}`);
  }
  const t = getTransport();
  if (t) {
    try {
      await t.sendMail({ from: config.smtp.from, to, subject, text });
    } catch (err) {
      // Delivery failure must not break the API flow; the challenge still exists.
      console.error(`[mail] delivery failed (${kind}):`, err.message);
    }
  }
};

const templates = {
  verificationCode: ({ code, minutes }) => ({
    subject: 'رمز التحقق من بريدك — Leader',
    text: `رمز التحقق الخاص بك هو: ${code}\nصالح لمدة ${minutes} دقيقة.\n\nYour Leader verification code is ${code} (valid ${minutes} min).`,
  }),
  signInCode: ({ code, minutes }) => ({
    subject: 'رمز تسجيل الدخول — Leader',
    text: `رمز تسجيل الدخول إلى ليدر: ${code}\nصالح لمدة ${minutes} دقيقة. إن لم تحاول تسجيل الدخول، تجاهل هذه الرسالة.\n\nYour Leader sign-in code is ${code} (valid ${minutes} min). If you did not try to sign in, ignore this message.`,
  }),
  signupAttemptOnVerified: () => ({
    subject: 'محاولة تسجيل ببريدك — Leader',
    text: 'حاول أحدهم إنشاء حساب ليدر بهذا البريد، وهو مسجّل مسبقاً. إن كنت أنت، سجّل الدخول أو استعد كلمة المرور.\n\nSomeone tried to sign up to Leader with your address. If it was you, sign in or reset your password.',
  }),
  passwordResetCode: ({ code, minutes }) => ({
    subject: 'رمز استعادة كلمة المرور — Leader',
    text: `رمز الاستعادة: ${code} (صالح ${minutes} دقيقة).\n\nYour Leader password reset code is ${code}.`,
  }),
  googleOnlyReset: () => ({
    subject: 'تسجيل الدخول عبر Google — Leader',
    text: 'حسابك في ليدر يستخدم Google لتسجيل الدخول، ولا توجد كلمة مرور لاستعادتها.\n\nYour Leader account signs in with Google; there is no password to reset.',
  }),
  mainAdminSetup: ({ tenantName, expiresAt }) => ({
    subject: `دعوة لإدارة ${tenantName} على ليدر`,
    text: `تمت دعوتك لتكون المدير الرئيسي لفريق «${tenantName}» على تطبيق ليدر.\nثبّت التطبيق، ثم أنشئ حساباً أو تابع باستخدام Google بهذا البريد، وأدخل رمز الفريق الذي ستحصل عليه من فريق ليدر.\n${expiresAt ? `تنتهي الدعوة في ${new Date(expiresAt).toISOString()}.` : ''}\n\nYou were invited as the Main Admin of "${tenantName}". Sign up with this address and enter the Team Code you receive from the Leader team (it is never sent by email).`,
  }),
  simpleAdminInvitation: ({ tenantName, inviterName }) => ({
    subject: `دعوة للانضمام إلى ${tenantName} على ليدر`,
    text: `دعاك ${inviterName || 'مدير الفريق'} لتكون مديراً في «${tenantName}» على تطبيق ليدر.\nثبّت التطبيق، ثم أنشئ حساباً أو تابع باستخدام Google بهذا البريد نفسه — سيُربط حسابك تلقائياً.\n\nYou were invited to administer "${tenantName}" on Leader. Sign up with this same address; your account links automatically.`,
  }),
};

/**
 * Production without an SMTP host mails nothing: every verification, sign-in
 * and reset code is issued and silently lost. Said once, when this module
 * loads at boot, naming the setting but never a value from the config.
 */
const warnIfUndeliverable = ({ isProduction = config.isProduction, host = config.smtp.host, log = console.warn } = {}) => {
  if (!isProduction || host) return false;
  log('[mail] SMTP_HOST is not set: no email is delivered in production — verification, sign-in and reset codes are lost.');
  return true;
};
warnIfUndeliverable();

const sendTemplate = async (to, kind, params = {}, meta = {}) => {
  const tpl = templates[kind];
  if (!tpl) throw new Error(`unknown email template ${kind}`);
  const { subject, text } = tpl(params);
  await send({ to, subject, text, kind, meta });
};

module.exports = { send, sendTemplate, templates, warnIfUndeliverable };
