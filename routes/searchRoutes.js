/**
 * /api/v1/search — docs/api/home-notifications-search.md
 *
 *   GET /?q&types=member,detachment,shift,item&limit   { query, results }
 */
const express = require('express');
const { tenantGuard } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const v = require('../validators/structureValidators');
const ctrl = require('../controllers/tenant/searchController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

router.get('/', validate(v.searchQuery, 'query'), ctrl.search);

module.exports = router;
