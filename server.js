const express = require('express');
const cors = require('cors');
const stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5500;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const stripeInstance = stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function generateOrderId() {
  return `AETH-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
}

// ========== RESEND EMAIL FUNCTION ==========
async function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from: 'AETHERIC Luxury <onboarding@resend.dev>',
      to: [to],
      subject: subject,
      html: html
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`📧 Resend response: ${res.statusCode} — ${data}`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Resend ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ========== USER SYNC ==========
app.post('/api/sync-user', async (req, res) => {
  try {
    const { authId, email, fullName } = req.body;
    console.log('📝 Syncing user:', { authId, email });

    if (!authId || !email) {
      return res.status(400).json({ success: false, error: "Missing authId or email" });
    }

    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('auth_id', authId)
      .maybeSingle();

    if (existing) {
      console.log('✅ User already exists:', existing.id);
      return res.json({ success: true, user: existing });
    }

    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ auth_id: authId, email: email, full_name: fullName || email.split('@')[0] }])
      .select()
      .single();

    if (insertError) {
      console.error('Insert error:', insertError);
      return res.status(500).json({ success: false, error: insertError.message });
    }

    console.log('✅ New user created:', newUser.id);
    res.json({ success: true, user: newUser });

  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== ADDRESS ENDPOINTS ==========
app.post('/api/addresses', async (req, res) => {
  const { user_id, full_name, address_line, city, state, zip_code, country, phone } = req.body;

  if (!user_id) return res.json({ success: false, error: 'user_id required' });

  try {
    const addressData = {
      user_id,
      full_name: full_name,
      street: address_line,
      city: city,
      state: state,
      zip_code: zip_code,
      country: country,
      phone: phone,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('addresses')
      .upsert(addressData, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) return res.json({ success: false, error: error.message });
    res.json({ success: true, address: data });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/addresses/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('addresses')
      .select('*')
      .eq('user_id', req.params.userId)
      .single();

    if (error || !data) return res.json({ success: false });

    res.json({ success: true, address: {
      fullName: data.full_name,
      addressLine: data.street,
      city: data.city,
      state: data.state,
      zipCode: data.zip_code,
      country: data.country,
      phone: data.phone
    }});
  } catch(e) {
    res.json({ success: false });
  }
});

// ========== CART ENDPOINTS ==========
app.get('/api/cart/:userId', async (req, res) => {
  try {
    const userIdStr = String(req.params.userId);
    const { data, error } = await supabase
      .from('cart')
      .select('*')
      .eq('user_id', userIdStr);

    if (error) throw error;
    console.log(`📦 Cart for user ${userIdStr}: ${data?.length || 0} items`);
    res.json({ success: true, cart: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/cart', async (req, res) => {
  try {
    const { user_id, product_id, product_name, product_price, product_image, quantity } = req.body;
    const qty = quantity || 1;
    const userIdStr = String(user_id);

    console.log("🛒 ADD TO CART:", { user_id: userIdStr, product_name, qty });

    const { data: existing } = await supabase
      .from('cart')
      .select('*')
      .eq('user_id', userIdStr)
      .eq('product_id', product_id)
      .maybeSingle();

    if (existing) {
      const newQuantity = existing.quantity + qty;
      const { error: updateError } = await supabase
        .from('cart')
        .update({ quantity: newQuantity })
        .eq('id', existing.id);

      if (updateError) return res.status(500).json({ success: false, error: updateError.message });

      const { data: updatedCart } = await supabase.from('cart').select('*').eq('user_id', userIdStr);
      return res.json({ success: true, cart: updatedCart });
    }

    const { error: insertError } = await supabase
      .from('cart')
      .insert([{ user_id: userIdStr, product_id, product_name, product_price, product_image, quantity: qty }]);

    if (insertError) return res.status(500).json({ success: false, error: insertError.message });

    const { data: newCart } = await supabase.from('cart').select('*').eq('user_id', userIdStr);
    res.json({ success: true, cart: newCart || [] });

  } catch (e) {
    console.error('Cart POST error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/cart/:cartId', async (req, res) => {
  try {
    const { error } = await supabase.from('cart').delete().eq('id', req.params.cartId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== CONFIRM ORDER ==========
app.post('/api/confirm-order', async (req, res) => {
  try {
    const { user_id, user_email, user_name, items, total, address, cart_item_id } = req.body;
    const orderNumber = generateOrderId();
    const deliveryDate = new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];

    const { data: order, error: oErr } = await supabase
      .from('orders')
      .insert([{
        order_number: orderNumber,
        user_id: String(user_id),
        total_amount: total,
        order_status: 'pending',
        payment_status: 'pending',
        payment_id: null,
        shipping_address: address,
        delivery_date: deliveryDate
      }])
      .select()
      .single();

    if (oErr) throw oErr;

    for (const item of items) {
      await supabase.from('order_items').insert([{
        order_id: order.id,
        product_name: item.name,
        product_price: item.price,
        quantity: item.quantity,
        subtotal: item.price * item.quantity,
        category: item.category || 'General'
      }]);
    }

    if (cart_item_id) {
      await supabase.from('cart').delete().eq('id', cart_item_id);
    }

    console.log("✅ Order created:", orderNumber);
    res.json({ success: true, order: { id: order.id, orderNumber, deliveryDate } });

  } catch (e) {
    console.error('Confirm order error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== GET USER ORDERS ==========
app.get('/api/orders/:userId', async (req, res) => {
  try {
    const userIdStr = String(req.params.userId);
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('user_id', userIdStr)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, orders: orders || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== UPDATE ORDER PAYMENT STATUS ==========
app.put('/api/orders/:id/payment', async (req, res) => {
  try {
    const { payment_status, payment_id, order_status } = req.body;
    const updates = {};
    if (payment_status) updates.payment_status = payment_status;
    if (payment_id) updates.payment_id = payment_id;
    if (order_status) updates.order_status = order_status;

    const { error } = await supabase.from('orders').update(updates).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== CART DELETED LOG ==========
app.post('/api/cart-deleted', async (req, res) => {
  try {
    const { user_id, product_name, product_price, quantity } = req.body;
    const { data, error } = await supabase
      .from('cart_deleted')
      .insert([{ user_id: String(user_id), product_name, product_price, quantity: quantity || 1 }])
      .select();

    if (error) throw error;
    res.json({ success: true, deleted: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/cart-deleted/:userId', async (req, res) => {
  try {
    const userIdStr = String(req.params.userId);
    const { data, error } = await supabase
      .from('cart_deleted')
      .select('*')
      .eq('user_id', userIdStr)
      .order('deleted_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, deleted: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== PAYMENTS ENDPOINT ==========
app.post('/api/payments', async (req, res) => {
  try {
    const { order_id, order_number, user_id, amount, payment_status, stripe_payment_intent_id } = req.body;

    const { data, error } = await supabase
      .from('payments')
      .insert([{ order_id, order_number, user_id: String(user_id), amount, payment_status, stripe_payment_intent_id }])
      .select();

    if (error) throw error;
    res.json({ success: true, payment: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/payments/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payments')
      .select('*, orders(*)')
      .eq('user_id', String(req.params.userId))
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, payments: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== FAVOURITES ENDPOINTS ==========
app.get('/api/favourites/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('favourites')
      .select('*')
      .eq('user_id', String(req.params.userId))
      .order('added_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, favourites: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/favourites', async (req, res) => {
  try {
    const { user_id, product_id, product_name, product_price, product_image } = req.body;

    const { data: existing } = await supabase
      .from('favourites')
      .select('id')
      .eq('user_id', String(user_id))
      .eq('product_id', product_id)
      .maybeSingle();

    if (existing) return res.json({ success: true, exists: true });

    const { data, error } = await supabase
      .from('favourites')
      .insert([{ user_id: String(user_id), product_id, product_name, product_price, product_image, added_at: new Date() }])
      .select();

    if (error) throw error;
    res.json({ success: true, favourite: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/favourites', async (req, res) => {
  try {
    const { user_id, product_id } = req.body;
    const { error } = await supabase
      .from('favourites')
      .delete()
      .eq('user_id', String(user_id))
      .eq('product_id', product_id);

    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== STRIPE PAYMENT INTENT ==========
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, orderId } = req.body;
    const paymentIntent = await stripeInstance.paymentIntents.create({
      amount: Math.round(parseFloat(amount) * 100),
      currency: 'usd',
      metadata: { orderId },
      automatic_payment_methods: { enabled: true }
    });

    res.json({ success: true, clientSecret: paymentIntent.client_secret });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== SEND ORDER EMAIL (RESEND API) - PREMIUM LUXURY TEMPLATE ==========
app.post('/api/send-order-email', async (req, res) => {
  try {
    const { email, orderDetails } = req.body;
    if (!email || !orderDetails) {
      return res.status(400).json({ success: false, error: 'Missing email or orderDetails' });
    }

    const { orderId, items = [], total, address = {}, estimatedDelivery, userName } = orderDetails;

    let subtotal = 0;
    let itemsHtml = '';

    for (const item of items) {
      const qty = item.quantity || 1;
      const price = parseFloat(item.price || item.product_price || 0);
      const line = price * qty;
      subtotal += line;
      itemsHtml += `
        <tr>
          <td><div class="item-name">${item.name || item.product_name || 'Product'}</div><div class="item-qty">Qty: ${qty}</div></td>
          <td>$${line.toFixed(2)}</td>
        </tr>`;
    }

    const grandTotal = parseFloat(total || subtotal);
    const shipping = grandTotal > 500 ? 0 : 25;
    const finalTotal = grandTotal + shipping;
    const shippingHtml = shipping === 0
      ? `<span style="color:#2d6a4f">Complimentary</span>`
      : `$${shipping.toFixed(2)}`;
    const orderDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const deliveryDate = estimatedDelivery || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const emailHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order Confirmed | AETHERIC</title>
<style>
  body{margin:0;padding:0;background:#f5f2ee;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrap{max-width:600px;margin:0 auto;background:#fff}
  .hdr{padding:40px 40px 20px;text-align:center;border-bottom:1px solid #e8e4df}
  .brand{font-family:Georgia,serif;font-size:38px;font-weight:700;letter-spacing:8px;color:#1a1a2e}
  .rule{width:36px;height:1.5px;background:#c4a47c;margin:14px auto 10px}
  .sub{font-size:10px;letter-spacing:3px;color:#9a9a9a;text-transform:uppercase}
  .hero{background:#0f0f1e;padding:52px 40px;text-align:center}
  .badge{width:56px;height:56px;border-radius:50%;border:1px solid rgba(196,164,124,.3);display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px}
  .hero h1{font-family:Georgia,serif;color:#fff;font-size:28px;font-weight:400;margin:0 0 10px;letter-spacing:1px}
  .hero p{color:rgba(255,255,255,.55);font-size:13px;line-height:1.7;margin:0}
  .body{padding:40px}
  .info-row{display:flex;background:#f9f7f5;margin-bottom:32px}
  .info-cell{flex:1;padding:20px;border-right:1px solid #ede9e4}
  .info-cell:last-child{border-right:none}
  .lbl{font-size:10px;color:#9a9a9a;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 6px}
  .val{font-size:14px;font-weight:600;color:#1a1a2e;margin:0}
  .greeting p{font-size:14px;line-height:1.7;color:#4a4a5e;margin:0 0 10px}
  h3{font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#1a1a2e;margin:0 0 16px}
  table.items{width:100%;border-collapse:collapse}
  table.items th{font-size:10px;font-weight:500;color:#9a9a9a;text-transform:uppercase;letter-spacing:1px;padding-bottom:10px;border-bottom:1px solid #eaeaea}
  table.items th:last-child{text-align:right}
  table.items td{padding:14px 0;border-bottom:1px solid #f0eeeb;vertical-align:top}
  table.items td:last-child{text-align:right;font-weight:600;color:#1a1a2e;font-size:14px}
  .item-name{font-weight:600;color:#1a1a2e;font-size:14px;margin-bottom:3px}
  .item-qty{font-size:11px;color:#9a9a9a}
  .tot-row{display:flex;justify-content:space-between;font-size:13px;color:#5a5a6e;margin-bottom:7px}
  .tot-final{display:flex;justify-content:space-between;border-top:2px solid #1a1a2e;padding-top:12px;margin-top:10px}
  .tot-final .tl{font-size:15px;font-weight:600;color:#1a1a2e}
  .tot-final .tr{font-size:20px;font-weight:700;color:#1a1a2e}
  .ship-box{background:#f9f7f5;padding:20px;margin-bottom:28px}
  .ship-box p{font-size:13px;color:#4a4a5e;margin:0 0 4px}
  .delivery{display:flex;align-items:center;gap:16px;background:#f0ede8;padding:20px;margin-bottom:32px}
  .del-icon{width:44px;height:44px;border-radius:50%;background:#1a1a2e;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .del-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#1a1a2e;margin-bottom:4px}
  .del-date{font-size:14px;color:#4a4a5e}
  .step{display:flex;align-items:flex-start;gap:14px;margin-bottom:14px}
  .step-num{width:26px;height:26px;border-radius:50%;background:#1a1a2e;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
  .step-num span{color:#fff;font-size:11px;font-weight:600}
  .step-title{font-size:13px;font-weight:600;color:#1a1a2e;margin-bottom:3px}
  .step-desc{font-size:12px;color:#6a6a7e}
  .contact{text-align:center;border-top:1px solid #eaeaea;padding:24px 0 0}
  .contact p{font-size:12px;color:#8a8a9e;margin:0 0 6px}
  .contact a{color:#c4a47c;text-decoration:none;font-size:13px;font-weight:500}
  .foot{margin-top:28px;padding-top:20px;text-align:center;border-top:1px solid #f0eeeb}
  .foot p{font-size:10px;color:#c0c0cc;margin:0 0 5px}
</style>
</head>
<body>
<div class="wrap">

  <div class="hdr">
    <div class="brand">AETHERIC</div>
    <div class="rule"></div>
    <div class="sub">Luxury Collection</div>
  </div>

  <div class="hero">
    <div class="badge">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#c4a47c" stroke-width="1.5"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <h1>Order Confirmed</h1>
    <p>Thank you for your purchase.<br>Your order has been received and is being processed.</p>
  </div>

  <div class="body">

    <div class="info-row">
      <div class="info-cell">
        <p class="lbl">Order Number</p>
        <p class="val">#${orderId}</p>
      </div>
      <div class="info-cell">
        <p class="lbl">Order Date</p>
        <p class="val">${orderDate}</p>
      </div>
      <div class="info-cell">
        <p class="lbl">Payment</p>
        <p class="val" style="color:#2d6a4f;font-size:12px">✓ CONFIRMED</p>
      </div>
    </div>

    <div class="greeting">
      <p>Dear <strong style="color:#1a1a2e">${userName || 'Valued Customer'}</strong>,</p>
      <p>We are delighted to confirm your recent order from AETHERIC Luxury Collection. Your carefully curated pieces are being prepared for shipment.</p>
    </div>

    <div style="margin-bottom:32px">
      <h3>Order Summary</h3>
      <table class="items">
        <thead><tr><th style="text-align:left">Item</th><th>Total</th></tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <div style="margin-top:18px;padding-top:14px;border-top:1px solid #eaeaea">
        <div class="tot-row"><span>Subtotal</span><span>$${grandTotal.toFixed(2)}</span></div>
        <div class="tot-row"><span>Shipping</span><span>${shippingHtml}</span></div>
        <div class="tot-final"><span class="tl">Total</span><span class="tr">$${finalTotal.toFixed(2)}</span></div>
      </div>
    </div>

    <div style="margin-bottom:28px">
      <h3>Shipping Address</h3>
      <div class="ship-box">
        <p style="font-weight:600;color:#1a1a2e;font-size:14px">${address.fullName || ''}</p>
        <p>${address.addressLine || ''}</p>
        <p>${address.city || ''} ${address.state || ''} ${address.zipCode || ''}</p>
        <p>${address.country || ''}</p>
        <p style="margin-top:8px">&#128222; ${address.phone || ''}</p>
      </div>
    </div>

    <div class="delivery">
      <div class="del-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c4a47c" stroke-width="1.5"><rect x="1" y="3" width="15" height="13"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
      </div>
      <div>
        <div class="del-label">Estimated Delivery</div>
        <div class="del-date">${deliveryDate}</div>
      </div>
    </div>

    <div style="margin-bottom:32px">
      <h3>What Happens Next</h3>
      <div class="step">
        <div class="step-num"><span>1</span></div>
        <div><div class="step-title">Order Processing</div><div class="step-desc">Your items are being prepared for shipment (1–2 business days).</div></div>
      </div>
      <div class="step">
        <div class="step-num"><span>2</span></div>
        <div><div class="step-title">Shipping Confirmation</div><div class="step-desc">You'll receive a tracking number once your order ships.</div></div>
      </div>
      <div class="step">
        <div class="step-num"><span>3</span></div>
        <div><div class="step-title">Delivery</div><div class="step-desc">Your order arrives by ${deliveryDate}, packaged in signature AETHERIC wrapping.</div></div>
      </div>
    </div>

    <div class="contact">
      <p>Need assistance? Our concierge team is here for you.</p>
      <a href="mailto:concierge@aetheric.com">concierge@aetheric.com</a>
    </div>

    <div class="foot">
      <p>This email was sent to ${email}</p>
      <p>&copy; 2024 AETHERIC Luxury Collection &middot; All rights reserved</p>
      <p style="color:#c4a47c;letter-spacing:2px;margin-top:4px">LONDON &middot; PARIS &middot; MILAN &middot; DUBAI</p>
    </div>

  </div>
</div>
</body>
</html>`;

    console.log(`📧 Sending premium email to: ${email}`);
    await sendEmail(email, `Order Confirmed | AETHERIC Luxury #${orderId}`, emailHtml);
    console.log(`✅ Email sent successfully to: ${email}`);

    res.json({ success: true, message: 'Email sent successfully' });

  } catch (e) {
    console.error('❌ Email error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== SERVE FRONTEND ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});