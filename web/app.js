const healthPanel = document.querySelector("#health-panel");
const connectGoogleLink = document.querySelector("#connect-google-link");

async function loadHealth() {
  const convexUrl = window.localStorage.getItem("bridgeclaw_convex_url");
  if (!convexUrl) {
    healthPanel.innerHTML = `
      <div><dt>Status</dt><dd>Missing Convex URL</dd></div>
      <div><dt>Action</dt><dd>Set localStorage.bridgeclaw_convex_url in the browser console.</dd></div>
    `;
    return;
  }

  if (connectGoogleLink instanceof HTMLAnchorElement) {
    connectGoogleLink.href = `${convexUrl}/oauth/google/start`;
  }

  try {
    const response = await fetch(`${convexUrl}/health`);
    const json = await response.json();
    healthPanel.innerHTML = `
      <div><dt>Status</dt><dd>${json.ok ? "Healthy" : "Unhealthy"}</dd></div>
      <div><dt>Service</dt><dd>${json.service}</dd></div>
      <div><dt>Timestamp</dt><dd>${json.timestamp}</dd></div>
    `;
  } catch (error) {
    healthPanel.innerHTML = `
      <div><dt>Status</dt><dd>Offline</dd></div>
      <div><dt>Error</dt><dd>${error instanceof Error ? error.message : "Unknown error"}</dd></div>
    `;
  }
}

loadHealth();
