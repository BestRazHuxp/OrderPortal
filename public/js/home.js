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

loadUser();

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
