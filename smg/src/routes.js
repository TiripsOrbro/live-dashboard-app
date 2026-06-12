const express = require('express');

const router = express.Router();

router.get('/api/smg/status', (_req, res) => {
    res.json(require('./index'));
});

module.exports = router;
