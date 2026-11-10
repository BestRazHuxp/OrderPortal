async function loadUser() {
  try {
    const response = await fetch('/api/me', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Session request failed');
    const user = await response.json();
    if (user.user_id === null || user.user_id === undefined) {
      window.location.replace('/login.html');
      return;
    }
    document.getElementById('greeting').textContent = `Xin chào ${user.user_name}`;
  } catch {
    document.getElementById('status').textContent = 'Không thể tải thông tin tài khoản. Vui lòng tải lại trang.';
  }
}

const orderItems = document.getElementById('order-items');
const addProduct = document.getElementById('add-product');
const template = document.getElementById('order-item-template');

function updateOrderItems() {
  const items = Array.from(orderItems.children);
  document.getElementById('empty-order').hidden = items.length > 0;
  document.getElementById('item-count').textContent = items.length + ' sản phẩm';
  items.forEach((item, index) => {
    item.querySelector('legend').textContent = 'Sản phẩm ' + (index + 1);
    item.querySelector('.remove-product').setAttribute('aria-label', 'Xóa sản phẩm ' + (index + 1));
  });
}

addProduct.addEventListener('click', () => {
  const item = template.content.firstElementChild.cloneNode(true);
  item.querySelector('.remove-product').addEventListener('click', () => {
    const nextItem = item.nextElementSibling || item.previousElementSibling;
    item.remove();
    updateOrderItems();
    if (nextItem) nextItem.querySelector('input').focus();
    else addProduct.focus();
  });
  orderItems.appendChild(item);
  updateOrderItems();
  item.querySelector('input').focus({ preventScroll: true });
  requestAnimationFrame(() => {
    item.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      block: 'center',
    });
  });
});

loadUser();

document.getElementById('order-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('order-status');
  const button = document.getElementById('submit-order');
  const items = Array.from(orderItems.children).map((item) => ({
    product_name: item.querySelector('[name="product_name"]').value.trim(),
    quantity: Number(item.querySelector('[name="quantity"]').value),
    note: item.querySelector('[name="note"]').value.trim(),
  }));
  if (!items.length || items.some((item) => !item.product_name)) {
    status.textContent = 'Vui lòng thêm sản phẩm và nhập tên sản phẩm trước khi gửi.';
    return;
  }
  button.disabled = true;
  status.textContent = 'Đang gửi…';
  try {
    const response = await fetch('/api/orders/analyze', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!response.ok) throw new Error('Order request failed');
    const data = await response.json();
    status.textContent = data.message;
  } catch {
    status.textContent = 'Không thể gửi dữ liệu. Vui lòng thử lại.';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('logout').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const status = document.getElementById('status');
  button.disabled = true;
  status.textContent = '';
  try {
    const response = await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Logout request failed');
    window.location.replace('/login.html');
  } catch {
    status.textContent = 'Không thể đăng xuất. Vui lòng thử lại.';
    button.disabled = false;
  }
});
