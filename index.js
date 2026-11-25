const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'miso_verify_2026';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Cấu hình thông tin quán & chuyển khoản VietQR
const SHOP_ADDRESS = '85 đường 30 tháng 04, phường Tân Ninh, Tây Ninh';
const SHOP_HOTLINE = '0979757823';
const BANK_ID = process.env.BANK_ID || 'MB'; // Ví dụ: MB, VCB, TCB, ACB, BIDV...
const ACCOUNT_NO = process.env.ACCOUNT_NO || '0979757823';
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || 'MISO TEOKBOKKI';

// Gọi Supabase REST API
async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Gửi tin nhắn qua Facebook Messenger
async function sendMessage(psid, messagePayload) {
  if (!PAGE_ACCESS_TOKEN) return;
  await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: psid },
      message: messagePayload
    })
  });
}

function formatMoney(num) {
  return Number(num).toLocaleString('vi-VN') + 'đ';
}

// Lấy hoặc tạo phiên chat khách hàng
async function getSession(psid) {
  const rows = await sbFetch(`chat_sessions?psid=eq.${psid}`);
  if (rows && rows.length > 0) return rows[0];
  const created = await sbFetch('chat_sessions', {
    method: 'POST',
    body: JSON.stringify({ psid, step: 'START', cart: [], temp_data: {} })
  });
  return created[0];
}

async function updateSession(psid, patch) {
  await sbFetch(`chat_sessions?psid=eq.${psid}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
}

// Hiển thị menu từ Supabase
async function sendMenu(psid) {
  const items = await sbFetch('menu_items?is_available=eq.true&order=id.asc');
  if (!items || items.length === 0) {
    return sendMessage(psid, { text: 'Hiện thực đơn đang được cập nhật, bạn vui lòng thử lại sau nhé!' });
  }

  let lines = ['🍜 MENU MISO TEOKBOKKI 🍜\n(Nhắn số thứ tự món để thêm vào giỏ, ví dụ: 1 hoặc 9x2)\n'];
  let currentCat = '';
  items.forEach((item, idx) => {
    if (item.category !== currentCat) {
      currentCat = item.category;
      lines.push(`\n🔸 ${currentCat.toUpperCase()}`);
    }
    lines.push(`${idx + 1}. ${item.name} - ${formatMoney(item.price)}`);
  });

  lines.push('\n👉 Gõ số món để chọn, hoặc bấm nút bên dưới:');
  await sendMessage(psid, {
    text: lines.join('\n'),
    quick_replies: [
      { content_type: 'text', title: '🛒 Xem giỏ hàng', payload: 'VIEW_CART' },
      { content_type: 'text', title: '✅ Đặt hàng ngay', payload: 'CHECKOUT' }
    ]
  });
}

// Xem giỏ hàng
async function sendCart(psid, cart) {
  if (!cart || cart.length === 0) {
    return sendMessage(psid, {
      text: '🛒 Giỏ hàng của bạn đang trống. Bấm Xem Menu để chọn món ngon nhé!',
      quick_replies: [{ content_type: 'text', title: '📋 Xem Menu', payload: 'MENU' }]
    });
  }
  let total = 0;
  const lines = ['🛒 GIỎ HÀNG CỦA BẠN:\n'];
  cart.forEach((c, i) => {
    const lineTotal = c.price * c.qty;
    total += lineTotal;
    lines.push(`${i + 1}. ${c.name} x${c.qty} = ${formatMoney(lineTotal)}`);
  });
  lines.push(`\n💰 Tạm tính: ${formatMoney(total)}`);

  await sendMessage(psid, {
    text: lines.join('\n'),
    quick_replies: [
      { content_type: 'text', title: '✅ Đặt hàng ngay', payload: 'CHECKOUT' },
      { content_type: 'text', title: '➕ Chọn thêm món', payload: 'MENU' },
      { content_type: 'text', title: '🗑️ Xóa giỏ hàng', payload: 'CLEAR_CART' }
    ]
  });
}

// Xử lý tin nhắn khách hàng
async function handleUserText(psid, rawText) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();
  const session = await getSession(psid);
  let cart = Array.isArray(session.cart) ? session.cart : [];
  let temp = session.temp_data || {};

  // Lệnh chung ở mọi bước
  if (['menu', 'xem menu', '📋 xem menu', 'bắt đầu', 'hi', 'xin chào', 'start'].includes(lower)) {
    await updateSession(psid, { step: 'ORDERING' });
    return sendMenu(psid);
  }
  if (['giỏ hàng', 'xem giỏ hàng', '🛒 xem giỏ hàng'].includes(lower)) {
    return sendCart(psid, cart);
  }
  if (['xóa giỏ hàng', '🗑️ xóa giỏ hàng', 'hủy đơn'].includes(lower)) {
    await updateSession(psid, { step: 'ORDERING', cart: [], temp_data: {} });
    return sendMessage(psid, {
      text: '🗑️ Đã làm trống giỏ hàng. Bạn muốn chọn lại món nào ạ?',
      quick_replies: [{ content_type: 'text', title: '📋 Xem Menu', payload: 'MENU' }]
    });
  }

  // Bước đặt hàng
  if (session.step === 'ASK_NAME') {
    temp.customer_name = text;
    await updateSession(psid, { step: 'ASK_PHONE', temp_data: temp });
    return sendMessage(psid, { text: '📞 Bạn cho MISO xin Số điện thoại liên hệ nhận món nhé:' });
  }

  if (session.step === 'ASK_PHONE') {
    temp.customer_phone = text;
    await updateSession(psid, { step: 'ASK_DELIVERY_TYPE', temp_data: temp });
    return sendMessage(psid, {
      text: '🛵 Bạn muốn nhận món theo hình thức nào ạ?',
      quick_replies: [
        { content_type: 'text', title: '🛵 Giao tận nơi', payload: 'DELIVERY' },
        { content_type: 'text', title: '🏪 Đến quán lấy', payload: 'PICKUP' }
      ]
    });
  }

  if (session.step === 'ASK_DELIVERY_TYPE') {
    if (lower.includes('lấy')) {
      temp.delivery_type = 'pickup';
      temp.delivery_address = `Nhận tại quán (${SHOP_ADDRESS})`;
      temp.shipping_fee = 0;
      await updateSession(psid, { step: 'ASK_PAYMENT', temp_data: temp });
      return sendMessage(psid, {
        text: `🏪 Bạn ghé quán tại: ${SHOP_ADDRESS}\n💳 Bạn chọn hình thức thanh toán nào ạ?`,
        quick_replies: [
          { content_type: 'text', title: '🏦 Chuyển khoản QR', payload: 'VIETQR' },
          { content_type: 'text', title: '💵 Tiền mặt', payload: 'COD' }
        ]
      });
    } else {
      temp.delivery_type = 'delivery';
      await updateSession(psid, { step: 'ASK_ADDRESS', temp_data: temp });
      return sendMessage(psid, { text: '📍 Bạn nhập Địa chỉ giao hàng chi tiết giúp MISO nhé (kèm khoảng cách ước tính nếu có):' });
    }
  }

  if (session.step === 'ASK_ADDRESS') {
    temp.delivery_address = text;
    temp.shipping_fee = 15000; // Phí ship mặc định khu vực Tân Ninh (có thể điều chỉnh)
    await updateSession(psid, { step: 'ASK_PAYMENT', temp_data: temp });
    return sendMessage(psid, {
      text: `🛵 Phí giao hàng dự kiến: ${formatMoney(temp.shipping_fee)}\n💳 Bạn chọn hình thức thanh toán nào ạ?`,
      quick_replies: [
        { content_type: 'text', title: '🏦 Chuyển khoản QR', payload: 'VIETQR' },
        { content_type: 'text', title: '💵 Tiền mặt khi nhận', payload: 'COD' }
      ]
    });
  }

  if (session.step === 'ASK_PAYMENT') {
    const isQR = lower.includes('qr') || lower.includes('chuyển');
    const paymentMethod = isQR ? 'vietqr' : 'cod';
    const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
    const shippingFee = temp.shipping_fee || 0;
    const totalAmount = subtotal + shippingFee;
    const orderCode = 'MISO' + Date.now().toString().slice(-6);

    await sbFetch('orders', {
      method: 'POST',
      body: JSON.stringify({
        order_code: orderCode,
        psid,
        customer_name: temp.customer_name || 'Khách Messenger',
        customer_phone: temp.customer_phone || '',
        delivery_type: temp.delivery_type || 'pickup',
        delivery_address: temp.delivery_address || '',
        items: cart,
        subtotal,
        shipping_fee: shippingFee,
        total_amount: totalAmount,
        payment_method: paymentMethod,
        payment_status: 'unpaid',
        order_status: 'new'
      })
    });

    await updateSession(psid, { step: 'START', cart: [], temp_data: {} });

    const itemSummary = cart.map(c => `- ${c.name} x${c.qty}`).join('\n');
    let confirmMsg =
      `🎉 ĐẶT HÀNG THÀNH CÔNG!\n` +
      `🔖 Mã đơn: ${orderCode}\n` +
      `👤 Khách hàng: ${temp.customer_name} - ${temp.customer_phone}\n` +
      `📍 Nhận hàng: ${temp.delivery_address}\n` +
      `🍜 Món đã đặt:\n${itemSummary}\n` +
      `💵 Tạm tính: ${formatMoney(subtotal)}\n` +
      `🛵 Phí ship: ${formatMoney(shippingFee)}\n` +
      `💰 TỔNG CỘNG: ${formatMoney(totalAmount)}\n` +
      `☎️ Hotline hỗ trợ: ${SHOP_HOTLINE}`;

    await sendMessage(psid, { text: confirmMsg });

    if (isQR) {
      const qrUrl = `https://img.vietqr.io/image/${BANK_ID}-${ACCOUNT_NO}-compact2.png?amount=${totalAmount}&addInfo=${encodeURIComponent(orderCode)}&accountName=${encodeURIComponent(ACCOUNT_NAME)}`;
      await sendMessage(psid, {
        text: `🏦 Bạn quét mã QR bên dưới để thanh toán ${formatMoney(totalAmount)} (Nội dung: ${orderCode}):`
      });
      await sendMessage(psid, {
        attachment: {
          type: 'image',
          payload: { url: qrUrl, is_reusable: true }
        }
      });
    }
    return;
  }

  // Bắt đầu thanh toán
  if (lower.includes('đặt hàng') || lower === 'checkout') {
    if (cart.length === 0) {
      return sendMessage(psid, {
        text: 'Giỏ hàng của bạn đang trống, hãy chọn món trước nhé!',
        quick_replies: [{ content_type: 'text', title: '📋 Xem Menu', payload: 'MENU' }]
      });
    }
    await updateSession(psid, { step: 'ASK_NAME' });
    return sendMessage(psid, { text: '👤 Bạn cho MISO xin Tên người nhận hàng nhé:' });
  }

  // Chọn món theo số thứ tự (ví dụ: "1" hoặc "9x2" hoặc "9*2")
  const match = text.match(/^(\d+)(?:\s*[xX*]\s*(\d+))?$/);
  if (match) {
    const itemIndex = parseInt(match[1], 10) - 1;
    const qty = match[2] ? parseInt(match[2], 10) : 1;
    const items = await sbFetch('menu_items?is_available=eq.true&order=id.asc');

    if (items && items[itemIndex] && qty > 0) {
      const chosen = items[itemIndex];
      const existing = cart.find(c => c.id === chosen.id);
      if (existing) {
        existing.qty += qty;
      } else {
        cart.push({ id: chosen.id, name: chosen.name, price: chosen.price, qty });
      }
      await updateSession(psid, { step: 'ORDERING', cart });

      const sub = cart.reduce((s, c) => s + c.price * c.qty, 0);
      return sendMessage(psid, {
        text: `✅ Đã thêm: ${chosen.name} (x${qty})\n💰 Tạm tính giỏ hàng: ${formatMoney(sub)}\n\nBạn có thể nhắn tiếp số món khác, hoặc bấm nút bên dưới:`,
        quick_replies: [
          { content_type: 'text', title: '✅ Đặt hàng ngay', payload: 'CHECKOUT' },
          { content_type: 'text', title: '🛒 Xem giỏ hàng', payload: 'VIEW_CART' },
          { content_type: 'text', title: '📋 Xem Menu', payload: 'MENU' }
        ]
      });
    }
  }

  // Tin nhắn mặc định khi khách nhắn tự do
  await updateSession(psid, { step: 'ORDERING' });
  return sendMessage(psid, {
    text: `Xin chào bạn đến với MISO TEOKBOKKI (${SHOP_ADDRESS})! 🍜🔥\nBạn bấm "Xem Menu" để chọn món hoặc nhắn số thứ tự món cần đặt nhé!`,
    quick_replies: [
      { content_type: 'text', title: '📋 Xem Menu', payload: 'MENU' },
      { content_type: 'text', title: '🛒 Xem giỏ hàng', payload: 'VIEW_CART' }
    ]
  });
}

// Trang kiểm tra sức khỏe server
app.get('/', (req, res) => {
  res.send('MISO TEOKBOKKI Messenger Bot is running!');
});

// Xác minh Webhook từ Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Nhận sự kiện tin nhắn từ Messenger
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const psid = event.sender && event.sender.id;
        if (!psid) continue;
        if (event.message && event.message.text && !event.message.is_echo) {
          await handleUserText(psid, event.message.text).catch(console.error);
        } else if (event.postback && event.postback.payload) {
          await handleUserText(psid, event.postback.payload).catch(console.error);
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
