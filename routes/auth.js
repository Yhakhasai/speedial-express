const express = require('express');
const router = express.Router();
const db = require('../db');

// 1. Register Customer or Rider
router.post('/register', async (req, res) => {
  try {
    const { role, full_name, phone, pin, city, default_address, vehicle_plate } = req.body;
    const cleanRole = String(role || 'CUSTOMER').trim().toUpperCase();
    const cleanPhone = String(phone || '').trim();
    const cleanPin = String(pin || '').trim();
    const cleanCity = String(city || 'KD').trim().toUpperCase();

    if (!full_name || !cleanPhone || cleanPin.length < 4) {
      return res.status(400).json({ error: 'Name, phone number, and a 4-digit PIN are required.' });
    }

    const existing = await db.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [cleanPhone]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Phone number already registered. Please log in.' });
    }

    const initialStatus = cleanRole === 'RIDER' ? 'PENDING' : 'ACTIVE';

    const result = await db.query(
      `INSERT INTO users (role, full_name, phone, pin, city, default_address, vehicle_plate, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, role, full_name, phone, city, default_address, vehicle_plate, status`,
      [
        cleanRole,
        full_name.trim(),
        cleanPhone,
        cleanPin,
        cleanCity,
        default_address ? default_address.trim() : null,
        vehicle_plate ? vehicle_plate.trim().toUpperCase() : null,
        initialStatus
      ]
    );

    const user = result.rows[0];
    res.json({
      success: true,
      message: cleanRole === 'RIDER'
        ? 'Rider application submitted! Admin will activate your account shortly.'
        : 'Account created! Your sender details are saved.',
      user
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Login (Phone + 4-Digit PIN)
router.post('/login', async (req, res) => {
  try {
    const { phone, pin, role } = req.body;
    const cleanPhone = String(phone || '').trim();
    const cleanPin = String(pin || '').trim();

    const result = await db.query(
      `SELECT id, role, full_name, phone, city, default_address, vehicle_plate, status
       FROM users
       WHERE phone = $1 AND pin = $2
       LIMIT 1`,
      [cleanPhone, cleanPin]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid phone number or 4-digit PIN.' });
    }

    const user = result.rows[0];
    if (role && user.role !== role.toUpperCase()) {
      return res.status(403).json({ error: `This account is registered as a ${user.role}, not ${role}.` });
    }

    if (user.role === 'RIDER' && user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Rider account is pending admin approval. Contact +234 724 066 6600.' });
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Customer Order History by Phone
router.get('/my-orders', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.json({ success: true, orders: [] });

    const result = await db.query(
      `SELECT tracking_code, pickup_address, dropoff_address, delivery_fee, status, payment_method, payment_status, created_at
       FROM orders
       WHERE sender_phone = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [phone]
    );
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// 4. Admin: List All Registered Riders (Protected by Admin PIN)
router.get('/riders', async (req, res) => {
  try {
    const adminPin = String(req.headers['x-admin-pin'] || req.query.admin_pin || '').trim();
    const expectedPin = process.env.ADMIN_PIN || '8937';
    if (adminPin !== expectedPin) {
      return res.status(401).json({ error: 'Invalid Admin PIN.' });
    }

    const result = await db.query(
      `SELECT id, full_name, phone, city, vehicle_plate, status, created_at
       FROM users
       WHERE role = 'RIDER'
       ORDER BY CASE WHEN status = 'PENDING' THEN 0 ELSE 1 END, created_at DESC`
    );
    res.json({ success: true, riders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Admin: Approve or Suspend a Rider
router.patch('/riders/:id/status', async (req, res) => {
  try {
    const adminPin = String(req.headers['x-admin-pin'] || '').trim();
    const expectedPin = process.env.ADMIN_PIN || '8937';
    if (adminPin !== expectedPin) {
      return res.status(401).json({ error: 'Invalid Admin PIN.' });
    }

    const { status } = req.body;
    const cleanStatus = String(status || '').trim().toUpperCase();
    if (!['ACTIVE', 'PENDING', 'SUSPENDED'].includes(cleanStatus)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    const result = await db.query(
      `UPDATE users SET status = $1 WHERE id = $2 AND role = 'RIDER'
       RETURNING id, full_name, phone, city, vehicle_plate, status`,
      [cleanStatus, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rider not found.' });
    }
    res.json({ success: true, rider: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;
