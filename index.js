const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const ordersRouter = require('./routes/orders');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/orders', ordersRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`SpeeDial Express Server running on http://localhost:${PORT}`);
});
