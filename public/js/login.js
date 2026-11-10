async function checkSession() {
  try {
    const response = await fetch('/api/me', {
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (!response.ok) return;

    const { user_id } = await response.json();
    if (user_id !== null && user_id !== undefined) {
      window.location.replace('/home.html');
    }
  } catch {
    // Stay on the login page if the session check fails.
  }
}

checkSession();

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById('status');
  button.disabled = true;
  status.textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_name: form.elements.user_name.value.trim(),
        password: form.elements.password.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      status.textContent = data.message || 'Đăng nhập không thành công.';
      return;
    }
    window.location.replace('/home.html');
  } catch {
    status.textContent = 'Không thể kết nối máy chủ. Vui lòng thử lại.';
  } finally {
    button.disabled = false;
  }
});
