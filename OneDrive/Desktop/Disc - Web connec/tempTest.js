(async()=>{
  try {
    const res = await fetch('http://localhost:3000/api/discord/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'abc' }),
    });
    const text = await res.text();
    console.log('status', res.status);
    console.log('body', text);
  } catch (e) {
    console.error('err', e);
  }
})();
