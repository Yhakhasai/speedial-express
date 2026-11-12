const express = require('express');
const router = express.Router();
const db = require('../db');

const SOLO_RIDER = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'SpeeDial Express Lead Rider',
  company: 'SpeeDial Express (RC: 8937370)',
  vehicle: 'SpeeDial Express Dispatch Rider'
};

function generateTrackingCode(city = 'KD') {
  const prefix = String(city).toUpperCase() === 'KN' ? 'KN-' : 'KD-';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = prefix;
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// 1. Book Order -> Auto-assigns to Solo Rider
router.post('/', async (req, res) => {
  try {
    const {
      city, sender_name, sender_phone, pickup_address,
      recipient_name, recipient_phone, dropoff_address,
      package_description, delivery_fee
    } = req.body;

    const tracking_code = generateTrackingCode(city);
    const pickup_otp = generateOTP();
    const dropoff_otp = generateOTP();

    const result = await db.query(
      `INSERT INTO orders (
        tracking_code, sender_name, sender_phone, pickup_address,
        recipient_name, recipient_phone, dropoff_address,
        package_description, delivery_fee, status,
        pickup_otp, dropoff_otp, courier_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACCEPTED', $10, $11, $12)
      RETURNING *`,
      [
        tracking_code,
        sender_name || 'Customer',
        sender_phone || '',
        pickup_address,
        recipient_name || 'Recipient',
        recipient_phone || '',
        dropoff_address,
        package_description || 'Standard Parcel',
        Number(delivery_fee) || 1500,
        pickup_otp,
        dropoff_otp,
        SOLO_RIDER.id
      ]
    );

    const cityName = String(city).toUpperCase() === 'KN' ? 'Kano' : 'Kaduna';

    res.status(201).json({
      success: true,
      message: `Dispatched in ${cityName} Metro`,
      rider: SOLO_RIDER,
      order: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get Active Queue + Daily Telemetry Stats
router.get('/active', async (req, res) => {
  try {
    const { city } = req.query;
    let query = `
      SELECT id, tracking_code, sender_name, sender_phone, pickup_address,
             recipient_name, recipient_phone, dropoff_address,
             package_description, delivery_fee, status, created_at
      FROM orders
      WHERE status IN ('PENDING', 'ACCEPTED', 'IN_TRANSIT')
    `;
    const params = [];

    if (city === 'KD' || city === 'KN') {
      query += ` AND tracking_code LIKE $1`;
      params.push(`${city}-%`);
    }
    query += ` ORDER BY created_at DESC`;

    const activeRes = await db.query(query, params);

    // Fetch completed summary for revenue & trip counter
    let statsQuery = `
      SELECT COUNT(*)::int AS completed_count,
             COALESCE(SUM(delivery_fee), 0)::numeric AS total_revenue
      FROM orders
      WHERE status = 'DELIVERED'
    `;
    const statsParams = [];
    if (city === 'KD' || city === 'KN') {
      statsQuery += ` AND tracking_code LIKE $1`;
      statsParams.push(`${city}-%`);
    }
    const statsRes = await db.query(statsQuery, statsParams);

    res.json({
      success: true,
      rider: SOLO_RIDER,
      stats: statsRes.rows[0],
      count: activeRes.rows.length,
      orders: activeRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Track Order (Customer View)
router.get('/track/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const result = await db.query(
      `SELECT id, tracking_code, sender_name, pickup_address,
              recipient_name, dropoff_address, package_description,
              delivery_fee, status, created_at
       FROM orders
       WHERE tracking_code = $1 OR id::text = $1
       LIMIT 1`,
      [code.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tracking code not found. Check and try again.' });
    }

    res.json({ success: true, rider: SOLO_RIDER, order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Verify Pickup
router.post('/verify-pickup', async (req, res) => {
  try {
    const { order_id, otp } = req.body;
    const result = await db.query(
      `SELECT id, tracking_code, pickup_otp, status
       FROM orders
       WHERE id::text = $1 OR tracking_code = $1
       LIMIT 1`,
      [String(order_id || '').trim().toUpperCase()]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    const order = result.rows[0];

    if (String(order.pickup_otp).trim() !== String(otp || '').trim()) {
      return res.status(400).json({ error: 'Incorrect Pickup OTP.' });
    }

    const updated = await db.query(
      `UPDATE orders SET status = 'IN_TRANSIT', courier_id = $1 WHERE id = $2 RETURNING id, tracking_code, status`,
      [SOLO_RIDER.id, order.id]
    );

    res.json({
      success: true,
      message: 'Pickup verified! Parcel is now IN TRANSIT.',
      status: 'IN_TRANSIT',
      order: updated.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Verify Dropoff
router.post('/verify-dropoff', async (req, res) => {
  try {
    const { order_id, otp } = req.body;
    const result = await db.query(
      `SELECT id, tracking_code, dropoff_otp, status
       FROM orders
       WHERE id::text = $1 OR tracking_code = $1
       LIMIT 1`,
      [String(order_id || '').trim().toUpperCase()]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    const order = result.rows[0];

    if (String(order.dropoff_otp).trim() !== String(otp || '').trim()) {
      return res.status(400).json({ error: 'Incorrect Dropoff OTP.' });
    }

    const updated = await db.query(
      `UPDATE orders SET status = 'DELIVERED' WHERE id = $1 RETURNING id, tracking_code, status`,
      [order.id]
    );

    res.json({
      success: true,
      message: 'Delivery completed! Waybill settled.',
      status: 'DELIVERED',
      order: updated.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
