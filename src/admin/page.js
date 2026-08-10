const adminPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PersonalRSS Admin</title>
  <style>
    :root { color-scheme: dark; --bg: #0f172a; --card: #1e293b; --card-2: #273449; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; --danger: #ef4444; --success: #22c55e; --warning: #f59e0b; --border: #334155; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, input, select { font: inherit; }
    button { border: 0; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .55; }
    .hidden { display: none !important; }
    .login-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .login-card { width: min(100%, 420px); padding: 32px; border: 1px solid var(--border); border-radius: 16px; background: var(--card); box-shadow: 0 20px 50px rgba(0,0,0,.25); }
    h1, h2, p { margin-top: 0; }
    h1 { margin-bottom: 6px; font-size: 25px; }
    h2 { margin-bottom: 18px; font-size: 18px; }
    .muted { color: var(--muted); }
    label { display: block; margin-bottom: 6px; color: #cbd5e1; font-weight: 600; }
    input, select { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; outline: none; background: #0f172a; color: var(--text); }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59,130,246,.18); }
    .btn { padding: 9px 14px; border-radius: 8px; background: var(--accent); color: white; font-weight: 650; }
    .btn-secondary { background: #475569; }
    .btn-danger { background: #b91c1c; }
    .btn-small { padding: 6px 9px; font-size: 12px; }
    .login-card .btn { width: 100%; margin-top: 18px; }
    .app { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 26px; }
    .topbar h1 { margin: 0; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
    .card { padding: 20px; border: 1px solid var(--border); border-radius: 12px; background: var(--card); }
    .stat-label { color: var(--muted); font-size: 13px; }
    .stat-value { display: block; margin-top: 4px; font-size: 28px; font-weight: 750; }
    .add-grid { display: grid; grid-template-columns: 160px 1fr 1fr auto; gap: 12px; align-items: end; }
    .table-card { margin-top: 20px; padding: 0; overflow: hidden; }
    .table-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid var(--border); }
    .table-header h2 { margin: 0; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 14px 16px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
    th { color: var(--muted); background: rgba(15,23,42,.42); font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: rgba(51,65,85,.3); }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 999px; background: var(--card-2); color: #cbd5e1; font-size: 12px; font-weight: 650; }
    .status-active { background: rgba(34,197,94,.16); color: #86efac; }
    .status-paused { background: rgba(245,158,11,.16); color: #fcd34d; }
    .actions { display: flex; gap: 6px; }
    .empty { padding: 42px 20px !important; color: var(--muted); text-align: center; }
    .loading { padding: 32px; color: var(--muted); text-align: center; }
    .toast-wrap { position: fixed; z-index: 20; top: 18px; right: 18px; display: grid; gap: 10px; }
    .toast { min-width: 260px; max-width: 380px; padding: 12px 14px; border: 1px solid var(--border); border-left: 4px solid var(--success); border-radius: 8px; background: var(--card); box-shadow: 0 12px 30px rgba(0,0,0,.3); }
    .toast.error { border-left-color: var(--danger); }
    @media (max-width: 760px) { .stats { grid-template-columns: 1fr; } .add-grid { grid-template-columns: 1fr; } .topbar { align-items: flex-start; } }
  </style>
</head>
<body>
  <section id="loginView" class="login-shell">
    <form id="loginForm" class="login-card">
      <h1>PersonalRSS Admin</h1>
      <p class="muted">Enter the admin token to manage generators.</p>
      <label for="tokenInput">Admin token</label>
      <input id="tokenInput" type="password" required autocomplete="current-password" autofocus>
      <button id="loginButton" class="btn" type="submit">Sign in</button>
    </form>
  </section>

  <main id="dashboard" class="app hidden">
    <header class="topbar">
      <div><h1>Generator Management</h1><span class="muted">PersonalRSS control panel</span></div>
      <button id="logoutButton" class="btn btn-secondary" type="button">Sign out</button>
    </header>

    <section class="stats" aria-label="Generator statistics">
      <div class="card"><span class="stat-label">Total</span><strong id="totalCount" class="stat-value">0</strong></div>
      <div class="card"><span class="stat-label">Active</span><strong id="activeCount" class="stat-value">0</strong></div>
      <div class="card"><span class="stat-label">Paused</span><strong id="pausedCount" class="stat-value">0</strong></div>
    </section>

    <section class="card">
      <h2>Add generator</h2>
      <form id="addForm" class="add-grid">
        <div><label for="typeInput">Type</label><select id="typeInput"><option value="instagram">Instagram</option><option value="stock">Stock</option></select></div>
        <div><label for="keyInput">Key</label><input id="keyInput" required placeholder="username or stock code"></div>
        <div><label for="nameInput">Display name</label><input id="nameInput" placeholder="Optional"></div>
        <button id="addButton" class="btn" type="submit">Add</button>
      </form>
    </section>

    <section class="card table-card">
      <div class="table-header"><h2>Generators</h2><button id="reloadButton" class="btn btn-secondary btn-small" type="button">Reload</button></div>
      <div id="loadingState" class="loading">Loading generators...</div>
      <div id="tableWrap" class="table-wrap hidden">
        <table>
          <thead><tr><th>Type</th><th>Key</th><th>Display Name</th><th>Feed URL</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody id="generatorRows"></tbody>
        </table>
      </div>
    </section>
  </main>

  <div id="toasts" class="toast-wrap" aria-live="polite"></div>

  <script>
    (function () {
      var storageKey = 'personalrss_admin_token';
      var token = localStorage.getItem(storageKey) || '';
      var loginView = document.getElementById('loginView');
      var dashboard = document.getElementById('dashboard');
      var loginForm = document.getElementById('loginForm');
      var loginButton = document.getElementById('loginButton');
      var addForm = document.getElementById('addForm');
      var addButton = document.getElementById('addButton');
      var loadingState = document.getElementById('loadingState');
      var tableWrap = document.getElementById('tableWrap');
      var rows = document.getElementById('generatorRows');

      function toast(message, isError) {
        var item = document.createElement('div');
        item.className = 'toast' + (isError ? ' error' : '');
        item.textContent = message;
        document.getElementById('toasts').appendChild(item);
        setTimeout(function () { item.remove(); }, 3500);
      }

      function showLogin() {
        dashboard.classList.add('hidden');
        loginView.classList.remove('hidden');
        document.getElementById('tokenInput').focus();
      }

      function showDashboard() {
        loginView.classList.add('hidden');
        dashboard.classList.remove('hidden');
      }

      async function api(path, options) {
        var config = options || {};
        config.headers = Object.assign({}, config.headers, { Authorization: 'Bearer ' + token });
        if (config.body) config.headers['Content-Type'] = 'application/json';
        var response = await fetch(path, config);
        var data = await response.json().catch(function () { return {}; });
        if (response.status === 401) {
          token = '';
          localStorage.removeItem(storageKey);
          showLogin();
          throw new Error('Invalid admin token');
        }
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
      }

      function actionButton(label, className, handler) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-small ' + (className || '');
        button.textContent = label;
        button.addEventListener('click', async function () {
          button.disabled = true;
          var original = button.textContent;
          button.textContent = 'Working...';
          try {
            await handler();
          } catch (error) {
            toast(error.message, true);
          } finally {
            button.disabled = false;
            button.textContent = original;
          }
        });
        return button;
      }

      function textCell(value) {
        var cell = document.createElement('td');
        cell.textContent = value || '—';
        return cell;
      }

      function render(generators, total) {
        rows.replaceChildren();
        document.getElementById('totalCount').textContent = String(total);
        document.getElementById('activeCount').textContent = String(generators.filter(function (item) { return item.status === 'active'; }).length);
        document.getElementById('pausedCount').textContent = String(generators.filter(function (item) { return item.status === 'paused'; }).length);

        if (!generators.length) {
          var emptyRow = document.createElement('tr');
          var emptyCell = document.createElement('td');
          emptyCell.colSpan = 6;
          emptyCell.className = 'empty';
          emptyCell.textContent = 'No generators yet.';
          emptyRow.appendChild(emptyCell);
          rows.appendChild(emptyRow);
          return;
        }

        generators.forEach(function (generator) {
          var row = document.createElement('tr');
          var typeCell = document.createElement('td');
          var typeBadge = document.createElement('span');
          typeBadge.className = 'badge';
          typeBadge.textContent = generator.providerType;
          typeCell.appendChild(typeBadge);
          row.appendChild(typeCell);
          row.appendChild(textCell(generator.instanceKey));
          row.appendChild(textCell(generator.displayName));

          var feedCell = document.createElement('td');
          var feedLink = document.createElement('a');
          feedLink.href = location.origin + '/feeds/' + generator.id + '.xml';
          feedLink.target = '_blank';
          feedLink.rel = 'noopener noreferrer';
          feedLink.textContent = '/feeds/' + generator.id + '.xml';
          feedCell.appendChild(feedLink);
          row.appendChild(feedCell);

          var statusCell = document.createElement('td');
          var statusBadge = document.createElement('span');
          statusBadge.className = 'badge status-' + generator.status;
          statusBadge.textContent = generator.status;
          statusCell.appendChild(statusBadge);
          row.appendChild(statusCell);

          var actionsCell = document.createElement('td');
          actionsCell.className = 'actions';
          actionsCell.appendChild(actionButton('Refresh', '', async function () {
            await api('/api/generators/' + generator.id + '/refresh', { method: 'POST' });
            toast('Generator refreshed');
            await loadGenerators();
          }));
          if (generator.status === 'active') {
            actionsCell.appendChild(actionButton('Pause', 'btn-secondary', async function () {
              await api('/api/generators/' + generator.id + '/pause', { method: 'POST' });
              toast('Generator paused');
              await loadGenerators();
            }));
          } else {
            actionsCell.appendChild(actionButton('Resume', 'btn-secondary', async function () {
              await api('/api/generators/' + generator.id + '/resume', { method: 'POST' });
              toast('Generator resumed');
              await loadGenerators();
            }));
          }
          actionsCell.appendChild(actionButton('Delete', 'btn-danger', async function () {
            if (!confirm('Delete this generator?')) return;
            await api('/api/generators/' + generator.id, { method: 'DELETE' });
            toast('Generator deleted');
            await loadGenerators();
          }));
          row.appendChild(actionsCell);
          rows.appendChild(row);
        });
      }

      async function loadGenerators() {
        loadingState.classList.remove('hidden');
        tableWrap.classList.add('hidden');
        try {
          var result = await Promise.all([api('/api/generators'), api('/api/status')]);
          render(result[0], result[1].generators);
          tableWrap.classList.remove('hidden');
        } catch (error) {
          toast(error.message, true);
        } finally {
          loadingState.classList.add('hidden');
        }
      }

      loginForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        token = document.getElementById('tokenInput').value;
        loginButton.disabled = true;
        loginButton.textContent = 'Signing in...';
        try {
          await api('/api/status');
          localStorage.setItem(storageKey, token);
          showDashboard();
          await loadGenerators();
        } catch (error) {
          toast(error.message, true);
        } finally {
          loginButton.disabled = false;
          loginButton.textContent = 'Sign in';
        }
      });

      addForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        addButton.disabled = true;
        addButton.textContent = 'Adding...';
        try {
          await api('/api/generators', {
            method: 'POST',
            body: JSON.stringify({
              type: document.getElementById('typeInput').value,
              instanceKey: document.getElementById('keyInput').value,
              displayName: document.getElementById('nameInput').value
            })
          });
          addForm.reset();
          toast('Generator added');
          await loadGenerators();
        } catch (error) {
          toast(error.message, true);
        } finally {
          addButton.disabled = false;
          addButton.textContent = 'Add';
        }
      });

      document.getElementById('reloadButton').addEventListener('click', loadGenerators);
      document.getElementById('logoutButton').addEventListener('click', function () {
        token = '';
        localStorage.removeItem(storageKey);
        showLogin();
      });

      if (token) {
        showDashboard();
        loadGenerators();
      } else {
        showLogin();
      }
    }());
  </script>
</body>
</html>`;

export default adminPage;
