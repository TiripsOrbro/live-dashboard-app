const express = require('express');

const router = express.Router();

router.get('/api/nsf/status', (_req, res) => {
    res.json(require('./index'));
});

module.exports = router;
