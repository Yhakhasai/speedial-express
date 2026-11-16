const express = require('express');
const router = express.Router();
const db = require('../db');

const ADMIN_PIN = process.env.ADMIN_PIN || '8937';

// Auto-create email verification columns on server boot
db.query(`
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email VARCHAR(160),
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS verification_code VARCHAR(10);
`).catch(() => {});

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationEmail(toEmail, fullName, otp) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return false;
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    await transporter.sendMail({
      from: `"SpeeDial Express" <${process.env.SMTP_USER}>`,
      to: toEmail,
      subject: `${otp} is your SpeeDial Express verification code`,
      html: `<div style="font-family:sans-serif;padding:20px;background:#0f172a;color:#f8fafc;border-radius:12px;">
        <h2 style="color:#f97316;">SpeeDial Express • RC: 8937370</h2>
        <p>Hello ${fullName || 'Customer'},</p>
        <p>Your 6-digit email verification code is:</p>
        <div style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#f97316;margin:16px 0;">${otp}</div>
        <p style="font-size:12px;color:#94a3b8;">Enter this code in the app to verify your email address.</p>
      </div>`
    });
    return true;
  } catch (err) {
    return false;
  }
}

// 1. POST /api/auth/register — Register Rider or Customer (with Email OTP)
router.post('/register', async (req, res) => {
  try {
    const role = String(req.body.role || 'CUSTOMER').trim().toUpperCase();
    const full_name = String(req.body.full_name || '').trim();
    const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
    const phone = String(req.body.phone || '').trim();
    const pin = String(req.body.pin || '').trim();
    const city = String(req.body.city || 'KD').trim().toUpperCase();
    const vehicle_plate = req.body.vehicle_plate ? String(req.body.vehicle_plate).trim().toUpperCase() : null;

    if (!full_name || !phone || !pin) {
      return res.status(400).json({ error: 'Full name, phone number, and PIN are required.' });
    }
    if (role === 'CUSTOMER' && !email) {
      return res.status(400).json({ error: 'Email address is required for verification.' });
    }

    const existing = await db.query(
      `SELECT id FROM users WHERE phone = $1 OR ($2::text IS NOT NULL AND LOWER(email) = $2) LIMIT 1`,
      [phone, email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this phone number or email already exists.' });
    }

    const status = role === 'RIDER' ? 'PENDING' : 'ACTIVE';
    const otp = role === 'CUSTOMER' ? generateOtp() : null;
    const emailVerified = role === 'RIDER';

    const result = await db.query(
      `INSERT INTO users (role, full_name, email, phone, pin, city, vehicle_plate, status, email_verified, verification_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, role, full_name, email, phone, city, vehicle_plate, status, email_verified`,
      [role, full_name, email, phone, pin, city, vehicle_plate, status, emailVerified, otp]
    );

    let emailSent = false;
    if (role === 'CUSTOMER' && email && otp) {
      emailSent = await sendVerificationEmail(email, full_name, otp);
    }

    res.status(201).json({
      success: true,
      requires_verification: role === 'CUSTOMER',
      email_sent: emailSent,
      dev_otp: emailSent ? undefined : otp,
      message: role === 'RIDER'
        ? 'Rider registered! Ask Admin to approve your account.'
        : 'Verification code generated! Enter the 6-digit code to verify your email.',
      user: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. POST /api/auth/verify-email — Confirm 6-digit OTP
router.post('/verify-email', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and 6-digit verification code are required.' });
    }

    const result = await db.query(
      `SELECT id, role, full_name, email, phone, city, status, verification_code
       FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found for this email.' });
    }

    const user = result.rows[0];
    if (user.verification_code !== code) {
      return res.status(400).json({ error: 'Invalid 6-digit verification code.' });
    }

    const updated = await db.query(
      `UPDATE users
       SET email_verified = TRUE, verification_code = NULL
       WHERE id = $1
       RETURNING id, role, full_name, email, phone, city, status, email_verified`,
      [user.id]
    );

    res.json({
      success: true,
      message: 'Email verified successfully!',
      user: updated.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST /api/auth/resend-otp — Resend 6-digit code
router.post('/resend-otp', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const otp = generateOtp();

    const result = await db.query(
      `UPDATE users SET verification_code = $1
       WHERE LOWER(email) = $2
       RETURNING full_name, email`,
      [otp, email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Email not registered.' });
    }

    const emailSent = await sendVerificationEmail(email, result.rows[0].full_name, otp);
    res.json({
      success: true,
      email_sent: emailSent,
      dev_otp: emailSent ? undefined : otp,
      message: emailSent ? 'New verification code sent to your email.' : 'New verification code generated.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. POST /api/auth/login — Login via Email or Phone + PIN
router.post('/login', async (req, res) => {
  try {
    const role = String(req.body.role || 'CUSTOMER').trim().toUpperCase();
    const identifier = String(req.body.identifier || req.body.phone || req.body.email || '').trim().toLowerCase();
    const pin = String(req.body.pin || '').trim();

    if (!identifier || !pin) {
      return res.status(400).json({ error: 'Email/phone and PIN are required.' });
    }

    const result = await db.query(
      `SELECT id, role, full_name, email, phone, city, vehicle_plate, status, email_verified
       FROM users
       WHERE (LOWER(phone) = $1 OR LOWER(COALESCE(email, '')) = $1)
         AND pin = $2
         AND role = $3
       LIMIT 1`,
      [identifier, pin, role]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials or PIN.' });
    }

    const user = result.rows[0];
    if (role === 'RIDER' && user.status !== 'ACTIVE') {
      return res.status(403).json({ error: `Rider account is ${user.status}. Awaiting Admin approval.` });
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. GET /api/auth/riders — Admin list riders
router.get('/riders', async (req, res) => {
  const pin = String(req.headers['x-admin-pin'] || '').trim();
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Invalid Admin PIN.' });
  }
  try {
    const result = await db.query(
      `SELECT id, full_name, phone, city, vehicle_plate, status FROM users WHERE role = 'RIDER' ORDER BY id DESC`
    );
    res.json({ success: true, riders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. PATCH /api/auth/riders/:id/status — Admin approve/suspend rider
router.patch('/riders/:id/status', async (req, res) => {
  const pin = String(req.headers['x-admin-pin'] || '').trim();
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Invalid Admin PIN.' });
  }
  try {
    const status = String(req.body.status || '').trim().toUpperCase();
    const result = await db.query(
      `UPDATE users SET status = $1 WHERE id = $2 AND role = 'RIDER' RETURNING id, full_name, status`,
      [status, req.params.id]
    );
    res.json({ success: true, rider: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
