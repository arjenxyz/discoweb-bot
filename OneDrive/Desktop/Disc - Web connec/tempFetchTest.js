(async () => {
  try {
    const r = await fetch('https://discord.com/api/v10/gateway');
    console.log('gateway status', r.status);
    const text = await r.text();
    console.log('body', text.slice(0, 100));
  } catch (e) {
    console.error('fetch error', e);
  }
})();
