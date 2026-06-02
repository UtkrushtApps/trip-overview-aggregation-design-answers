const express = require('express');
const router = express.Router();
const { tripOverviewHandler } = require('../controllers/tripController');

// GET /api/trips/:id/overview
router.get('/:id/overview', tripOverviewHandler);

module.exports = router;
