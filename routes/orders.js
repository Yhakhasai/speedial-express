const express = require('express');
const router = express.Router();
const db = require('../db');

// Helper: Generate unique waybill code (e.g., SDX-482910)
function generateTrackingCode() {
  const num = Math.floor(100000 + Math.random() * 900000);
  return `SDX-${num}`;
}

// 1. GET /api/orders?city=KD|KN|ALL — Fetch dispatch queue for Rider Terminal
router.get('/', async (req, res) => {
  try {
    const city = String(req.query.city || 'ALL').trim().toUpperCase();
    let result;

    if (city === 'ALL' || !city) {
      result = await db.query(
        `SELECT * FROM orders ORDER BY id DESC LIMIT 100`
      );
    } else {
      result = await db.query(
        `SELECT * FROM orders
         WHERE UPPER(COALESCE(city, 'KD')) = $1
         ORDER BY id DESC LIMIT 100`,
        [city]
      );
    }

    res.json({ success: true, orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET /api/orders/:trackingCode — Customer live waybill lookup
router.get('/:trackingCode', async (req, res) => {
  try {
    const code = String(req.params.trackingCode || '').trim().toUpperCase();
    const result = await db.query(
      `SELECT * FROM orders WHERE UPPER(tracking_code) = $1 LIMIT 1`,
      [code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Waybill not found. Check your tracking code.' });
    }

    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST /api/orders — Create a new customer dispatch booking
router.post('/', async (req, res) => {
  try {
    const {
      city,
      sender_name,
      sender_phone,
      pickup_address,
      recipient_name,
      recipient_phone,
      dropoff_address,
      package_note,
      amount
    } = req.body;

    if (!sender_name || !sender_phone || !pickup_address || !recipient_name || !recipient_phone || !dropoff_address) {
      return res.status(400).json({ error: 'All sender, pickup, recipient, and dropoff fields are required.' });
    }

    const cleanCity = String(city || 'KD').trim().toUpperCase();
    const trackingCode = generateTrackingCode();
    const fare = Number(amount) || (cleanCity === 'KN' ? 1500 : 1200);

    const result = await db.query(
      `INSERT INTO orders (
        tracking_code, city, sender_name, sender_phone, pickup_address,
        recipient_name, recipient_phone, dropoff_address, package_note,
        amount, status, payment_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', 'UNPAID')
      RETURNING *`,
      [
        trackingCode,
        cleanCity,
        String(sender_name).trim(),
        String(sender_phone).trim(),
        String(pickup_address).trim(),
        String(recipient_name).trim(),
        String(recipient_phone).trim(),
        String(dropoff_address).trim(),
        package_note ? String(package_note).trim() : null,
        fare
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Dispatch booked successfully!',
      order: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. PATCH /api/orders/:trackingCode/status — Update order lifecycle status
router.patch('/:trackingCode/status', async (req, res) => {
  try {
    const code = String(req.params.trackingCode || '').trim().toUpperCase();
    const cleanStatus = String(req.body.status || '').trim().toUpperCase();
    const allowed = ['PENDING', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];

    if (!allowed.includes(cleanStatus)) {
      return res.status(400).json({ error: 'Invalid order status.' });
    }

    const result = await db.query(
      `UPDATE orders SET status = $1 WHERE UPPER(tracking_code) = $2 RETURNING *`,
      [cleanStatus, code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. PATCH /api/orders/:trackingCode/verify-payment — Mark OPay transfer confirmed
router.patch('/:trackingCode/verify-payment', async (req, res) => {
  try {
    const code = String(req.params.trackingCode || '').trim().toUpperCase();
    const ref = String(req.body.payment_ref || 'OPAY-CONFIRMED').trim();

    const result = await db.query(
      `UPDATE orders
       SET payment_status = 'PAID', payment_ref = $1
       WHERE UPPER(tracking_code) = $2
       RETURNING *`,
      [ref, code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    res.json({
      success: true,
      message: 'OPay payment verified!',
      order: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
