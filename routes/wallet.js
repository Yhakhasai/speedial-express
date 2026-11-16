const express = require('express');
const router = express.Router();
const db = require('../db');

const ADMIN_PIN = process.env.ADMIN_PIN || '8937';

// Auto-create wallet columns & ledger table on startup
db.query(`
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(12, 2) DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC(12, 2) DEFAULT 2000.00,
    ADD COLUMN IF NOT EXISTS bank_name VARCHAR(80),
    ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
    ADD COLUMN IF NOT EXISTS account_name VARCHAR(120);

  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    user_phone VARCHAR(30) NOT NULL,
    role VARCHAR(20) DEFAULT 'CUSTOMER',
    tx_type VARCHAR(20) NOT NULL,
    method VARCHAR(40) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    reference VARCHAR(80),
    bank_details TEXT,
    status VARCHAR(20) DEFAULT 'COMPLETED',
    created_at TIMESTAMP DEFAULT NOW()
  );
`).catch(() => {});

// 1. GET /api/wallet/:phone — Fetch balance, linked bank & transaction history
router.get('/:phone', async (req, res) => {
  try {
    const phone = String(req.params.phone || '').trim();
    const role = String(req.query.role || 'CUSTOMER').trim().toUpperCase();

    const userRes = await db.query(
      `SELECT id, full_name, email, phone, role,
              COALESCE(wallet_balance, 0) AS wallet_balance,
              COALESCE(bonus_balance, 2000) AS bonus_balance,
              bank_name, account_number, account_name
       FROM users WHERE phone = $1 AND role = $2 LIMIT 1`,
      [phone, role]
    );

    let walletBalance = 0;
    let bonusBalance = role === 'CUSTOMER' ? 2000 : 0;
    let bankInfo = null;

    if (userRes.rows.length > 0) {
      const u = userRes.rows[0];
      walletBalance = Number(u.wallet_balance || 0);
      bonusBalance = Number(u.bonus_balance || 0);
      if (u.account_number) {
        bankInfo = {
          bank_name: u.bank_name,
          account_number: u.account_number,
          account_name: u.account_name
        };
      }
    }

    // For Riders, also include delivered order fares if wallet_balance hasn't been synced
    if (role === 'RIDER') {
      const delivRes = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS earned FROM orders WHERE status = 'DELIVERED'`
      );
      const wdRes = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS withdrawn FROM wallet_transactions
         WHERE user_phone = $1 AND role = 'RIDER' AND tx_type = 'WITHDRAWAL' AND status != 'REJECTED'`,
        [phone]
      );
      walletBalance = Math.max(0, Number(delivRes.rows[0].earned) - Number(wdRes.rows[0].withdrawn));
      bonusBalance = 0;
    }

    const txRes = await db.query(
      `SELECT * FROM wallet_transactions WHERE user_phone = $1 AND role = $2 ORDER BY id DESC LIMIT 30`,
      [phone, role]
    );

    res.json({
      success: true,
      wallet_balance: walletBalance,
      bonus_balance: bonusBalance,
      available_total: walletBalance + bonusBalance,
      bank: bankInfo,
      transactions: txRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. POST /api/wallet/fund — Fund wallet via OPay Transfer or Paystack
router.post('/fund', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    const email = String(req.body.email || 'customer@speedial.ng').trim();
    const amount = Number(req.body.amount || 0);
    const method = String(req.body.method || 'OPAY_TRANSFER').trim().toUpperCase();
    const reference = String(req.body.reference || `FUND-${Date.now()}`).trim();

    if (!phone || amount < 100) {
      return res.status(400).json({ error: 'Valid phone number and minimum amount of ₦100 required.' });
    }

    // Optional Paystack Checkout Initialization if PAYSTACK_SECRET_KEY is configured
    if (method === 'PAYSTACK' && process.env.PAYSTACK_SECRET_KEY) {
      const psRes = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email,
          amount: Math.round(amount * 100), // kobo
          reference,
          callback_url: req.body.callback_url || 'https://speedial-express.onrender.com/'
        })
      });
      const psData = await psRes.json();
      if (psData.status && psData.data?.authorization_url) {
        await db.query(
          `INSERT INTO wallet_transactions (user_phone, role, tx_type, method, amount, reference, status)
           VALUES ($1, 'CUSTOMER', 'FUNDING', 'PAYSTACK', $2, $3, 'PENDING')`,
          [phone, amount, reference]
        );
        return res.json({
          success: true,
          authorization_url: psData.data.authorization_url,
          reference
        });
      }
    }

    // OPay Bank Transfer (6152624923) — Logs as PENDING for Admin confirmation (or instant credit in test mode)
    const autoCredit = process.env.AUTO_CREDIT_WALLET === 'true';
    const txStatus = autoCredit ? 'COMPLETED' : 'PENDING';

    if (autoCredit) {
      await db.query(
        `UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE phone = $2 AND role = 'CUSTOMER'`,
        [amount, phone]
      );
    }

    const tx = await db.query(
      `INSERT INTO wallet_transactions (user_phone, role, tx_type, method, amount, reference, status)
       VALUES ($1, 'CUSTOMER', 'FUNDING', $2, $3, $4, $5)
       RETURNING *`,
      [phone, method, amount, reference, txStatus]
    );

    res.status(201).json({
      success: true,
      message: autoCredit
        ? `₦${amount.toLocaleString()} credited to your wallet!`
        : `Funding of ₦${amount.toLocaleString()} submitted! Admin will confirm OPay Ref: ${reference}.`,
      transaction: tx.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST /api/wallet/withdraw — Request payout to Nigerian Bank Account
router.post('/withdraw', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    const role = String(req.body.role || 'CUSTOMER').trim().toUpperCase();
    const amount = Number(req.body.amount || 0);
    const bank_name = String(req.body.bank_name || '').trim();
    const account_number = String(req.body.account_number || '').trim();
    const account_name = String(req.body.account_name || '').trim();

    if (!phone || amount < 500) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is ₦500.' });
    }
    if (!bank_name || !account_number || !account_name) {
      return res.status(400).json({ error: 'Bank name, account number, and account name are required.' });
    }

    // Save linked withdrawal account on user profile
    await db.query(
      `UPDATE users SET bank_name = $1, account_number = $2, account_name = $3 WHERE phone = $4 AND role = $5`,
      [bank_name, account_number, account_name, phone, role]
    );

    // Check withdrawable cash balance (Welcome bonus is non-withdrawable)
    if (role === 'CUSTOMER') {
      const uRes = await db.query(
        `SELECT COALESCE(wallet_balance, 0) AS bal FROM users WHERE phone = $1 AND role = 'CUSTOMER' LIMIT 1`,
        [phone]
      );
      const cashBal = uRes.rows.length ? Number(uRes.rows[0].bal) : 0;
      if (amount > cashBal) {
        return res.status(400).json({
          error: `Insufficient withdrawable cash (₦${cashBal.toLocaleString()}). Welcome bonus (₦2,000) is for delivery orders only.`
        });
      }
      await db.query(
        `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone = $2 AND role = 'CUSTOMER'`,
        [amount, phone]
      );
    }

    const ref = `WD-${Date.now().toString().slice(-6)}`;
    const bankDetails = `${bank_name} • ${account_number} (${account_name})`;

    const tx = await db.query(
      `INSERT INTO wallet_transactions (user_phone, role, tx_type, method, amount, reference, bank_details, status)
       VALUES ($1, $2, 'WITHDRAWAL', 'BANK_TRANSFER', $3, $4, $5, 'PENDING')
       RETURNING *`,
      [phone, role, amount, ref, bankDetails]
    );

    res.status(201).json({
      success: true,
      message: `Withdrawal request of ₦${amount.toLocaleString()} to ${bank_name} (${account_number}) submitted!`,
      transaction: tx.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. GET /api/wallet/admin/pending — Admin view pending wallet funding & withdrawals
router.get('/admin/pending', async (req, res) => {
  const pin = String(req.headers['x-admin-pin'] || '').trim();
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid Admin PIN.' });

  try {
    const result = await db.query(
      `SELECT * FROM wallet_transactions WHERE status = 'PENDING' ORDER BY id DESC`
    );
    res.json({ success: true, items: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. PATCH /api/wallet/admin/:id/approve — Admin approve or reject funding/withdrawal
router.patch('/admin/:id/approve', async (req, res) => {
  const pin = String(req.headers['x-admin-pin'] || '').trim();
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid Admin PIN.' });

  try {
    const action = String(req.body.action || 'COMPLETED').trim().toUpperCase(); // COMPLETED or REJECTED
    const txRes = await db.query(`SELECT * FROM wallet_transactions WHERE id = $1 LIMIT 1`, [req.params.id]);
    if (txRes.rows.length === 0) return res.status(404).json({ error: 'Transaction not found.' });

    const tx = txRes.rows[0];
    if (tx.status !== 'PENDING') return res.status(400).json({ error: 'Transaction already processed.' });

    if (action === 'COMPLETED' && tx.tx_type === 'FUNDING') {
      await db.query(
        `UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE phone = $2 AND role = $3`,
        [tx.amount, tx.user_phone, tx.role]
      );
    } else if (action === 'REJECTED' && tx.tx_type === 'WITHDRAWAL' && tx.role === 'CUSTOMER') {
      await db.query(
        `UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE phone = $2 AND role = 'CUSTOMER'`,
        [tx.amount, tx.user_phone]
      );
    }

    await db.query(`UPDATE wallet_transactions SET status = $1 WHERE id = $2`, [action, tx.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
