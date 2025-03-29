import express from 'express';

const router = express.Router();

// Define your routes here
router.get('/', (req, res) => {
  res.send('Welcome to the Node.js server!');
});

// Export the router
export default router;