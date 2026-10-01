/**
 * /platform/plans — the SaaS plan catalogue (screen: platform settings → plans;
 * read by tenant detail → subscription / limits). A plan is a reusable limit
 * definition; tenants reference it by id and it is never copied into them.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const { Plan, SaasTenant } = require('../../models');
const { PLAN_LIMIT_KEYS } = require('../../config/constants');
const auditService = require('../../services/auditService');

const target = (plan) => ({ type: 'plan', id: String(plan._id), displayName: plan.name });

/** GET /platform/plans — ordered by `order`. */
exports.list = catchAsync(async (req, res) => {
  const plans = await Plan.find({}).sort({ order: 1, _id: 1 });
  res.json(plans.map((p) => p.toJSON()));
});

/** POST /platform/plans */
exports.create = catchAsync(async (req, res) => {
  const { id, name, description, recommended, selectable, defaultLimits } = req.body;
  if (await Plan.exists({ _id: id })) throw AppError.conflict('A plan with this id already exists.', { fields: { id: 'This id is already in use.' } });
  const last = await Plan.findOne({}).sort({ order: -1 });
  let plan;
  try {
    plan = await Plan.create({
      _id: id,
      name,
      description,
      recommended,
      selectable,
      defaultLimits,
      order: last ? (last.order || 0) + 1 : 1,
    });
  } catch (err) {
    if (err && err.code === 11000) throw AppError.conflict('A plan with this id already exists.', { fields: { id: 'This id is already in use.' } });
    throw err;
  }
  await auditService.record({ action: 'plan_created', actor: req.auth.account, target: target(plan) });
  res.status(201).json(plan.toJSON());
});

/** PATCH /platform/plans/:planId (partial; defaultLimits may be partial) */
exports.update = catchAsync(async (req, res) => {
  const plan = await Plan.findById(req.params.planId);
  if (!plan) throw AppError.notFound('plan');
  ['name', 'description', 'recommended', 'selectable'].forEach((k) => {
    if (req.body[k] !== undefined) plan[k] = req.body[k];
  });
  if (req.body.defaultLimits) {
    PLAN_LIMIT_KEYS.forEach((k) => {
      if (req.body.defaultLimits[k] !== undefined) plan.defaultLimits[k] = req.body.defaultLimits[k];
    });
    plan.markModified('defaultLimits');
  }
  await plan.save();
  await auditService.record({ action: 'plan_updated', actor: req.auth.account, target: target(plan) });
  res.json(plan.toJSON());
});

/** DELETE /platform/plans/:planId — refused while any tenant references it. */
exports.remove = catchAsync(async (req, res) => {
  const plan = await Plan.findById(req.params.planId);
  if (!plan) throw AppError.notFound('plan');
  if (await SaasTenant.exists({ 'subscription.planId': String(plan._id) })) {
    throw AppError.conflict('This plan is assigned to at least one team.');
  }
  await Plan.deleteOne({ _id: plan._id });
  await auditService.record({ action: 'plan_deleted', actor: req.auth.account, target: target(plan) });
  res.status(204).end();
});
